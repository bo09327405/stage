import type { ConvertOptions } from './ffmpegConvert'

/*
 * The local companion (companion-tool/): a small server on the operator's own computer that converts files with the
 * installed ffmpeg and streams progress. The page only ever talks to it on this computer (localhost); converted
 * files come back to the page, which uploads them to the project like any other file.
 */

const URL_KEY = 'theatre.companion.url'
const TOKEN_KEY = 'theatre.companion.token'
export const DEFAULT_COMPANION_URL = 'http://localhost:3333'
export const START_COMMAND = 'node companion-tool/server.mjs'

const read = (k: string) => {
  try {
    return localStorage.getItem(k) ?? ''
  } catch {
    return ''
  }
}
const write = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v)
  } catch {
    // Not remembered; harmless.
  }
}

export const companionUrl = () => (read(URL_KEY) || DEFAULT_COMPANION_URL).replace(/\/+$/, '')
export const companionToken = () => read(TOKEN_KEY)
export function saveCompanion(url: string, token: string) {
  write(URL_KEY, url.trim())
  write(TOKEN_KEY, token.trim())
}

export type CompanionState = 'offline' | 'needs-token' | 'bad-token' | 'online'
export interface CompanionStatus {
  state: CompanionState
  ffmpeg?: string | null
  watchDir?: string
}

const headers = () => ({ 'x-companion-token': companionToken() })

async function call(path: string, init: RequestInit = {}, timeout = 8000): Promise<Response> {
  const ctl = new AbortController()
  const timer = window.setTimeout(() => ctl.abort(), timeout)
  try {
    return await fetch(`${companionUrl()}${path}`, { ...init, headers: { ...headers(), ...(init.headers ?? {}) }, signal: ctl.signal, mode: 'cors' })
  } finally {
    window.clearTimeout(timer)
  }
}

/** Is the companion running, and does the saved pairing code work? */
export async function companionStatus(): Promise<CompanionStatus> {
  try {
    const health = (await (await call('/health', {}, 1500)).json()) as { ok?: boolean; needsToken?: boolean }
    if (!health.ok) return { state: 'offline' }
    if (health.needsToken && !companionToken()) return { state: 'needs-token' }
    const res = await call('/info', {}, 3000)
    if (res.status === 401) return { state: 'bad-token' }
    const info = (await res.json()) as { ffmpeg?: string | null; watchDir?: string }
    return { state: 'online', ffmpeg: info.ffmpeg, watchDir: info.watchDir }
  } catch {
    return { state: 'offline' }
  }
}

export interface CompanionFile {
  name: string
  bytes: number
  modified: number
}

export async function companionFiles(): Promise<CompanionFile[]> {
  const res = await call('/files')
  if (!res.ok) throw new Error(`讀取檔案清單失敗（HTTP ${res.status}）`)
  return ((await res.json()) as { files: CompanionFile[] }).files
}

/** Put a file from the page's file picker into the companion's watch folder. */
export async function companionUpload(file: File): Promise<void> {
  const res = await call(`/inbox/${encodeURIComponent(file.name)}`, { method: 'PUT', body: file }, 15 * 60 * 1000)
  if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { message?: string } | null)?.message ?? `傳到本機伴侶失敗（HTTP ${res.status}）`)
}

export interface CompanionJob {
  id: string
  file: string
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled'
  percent: number
  out: string | null
  bytes: number
  error: string | null
}

export async function companionConvert(file: string, options: ConvertOptions): Promise<CompanionJob> {
  const res = await call('/convert', { method: 'POST', body: JSON.stringify({ file, options }) })
  const body = (await res.json().catch(() => null)) as (CompanionJob & { message?: string }) | null
  if (!res.ok || !body) throw new Error(body?.message ?? `轉檔指令失敗（HTTP ${res.status}）`)
  return body
}

/** Follow a job with Server-Sent Events; resolves with the final job state (rejects on error / cancel). */
export function companionWatch(id: string, onProgress: (job: CompanionJob) => void): { done: Promise<CompanionJob>; stop: () => void } {
  const source = new EventSource(`${companionUrl()}/jobs/${id}/events?token=${encodeURIComponent(companionToken())}`)
  const done = new Promise<CompanionJob>((resolve, reject) => {
    source.onmessage = (e) => {
      const job = JSON.parse(e.data as string) as CompanionJob & { type: string }
      onProgress(job)
      if (job.type === 'done' || job.status === 'done') {
        source.close()
        resolve(job)
      } else if (job.type === 'error' || job.status === 'error') {
        source.close()
        reject(new Error(job.error ?? '轉檔失敗'))
      } else if (job.type === 'cancelled' || job.status === 'cancelled') {
        source.close()
        reject(new Error('已取消'))
      }
    }
    source.onerror = () => {
      source.close()
      reject(new Error('與本機伴侶的連線中斷'))
    }
  })
  return { done, stop: () => source.close() }
}

export async function companionDownload(job: CompanionJob): Promise<File> {
  const res = await call(`/jobs/${job.id}/file`, {}, 15 * 60 * 1000)
  if (!res.ok) throw new Error(`下載轉好的檔案失敗（HTTP ${res.status}）`)
  const blob = await res.blob()
  return new File([blob], job.out ?? `${job.id}.bin`, { type: blob.type })
}

export async function companionCancel(id: string): Promise<void> {
  await call(`/jobs/${id}`, { method: 'DELETE' }).catch(() => {})
}
