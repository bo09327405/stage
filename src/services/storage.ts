/*
 * Where the DAW Studio keeps its files: Cloudflare R2, only.
 *
 * Recordings, TTS clips, imported audio, mixdowns and project files all go to R2 through the dev
 * server (the keys never reach the browser: uploads go through /api/r2/upload, files are streamed
 * from /api/r2/o/<key>). Cloudinary is reserved for audience uploads and Set Cue media.
 *
 * Results use the same field names as Cloudinary's (secure_url, public_id…), so the media library
 * index and cue playback treat files from either system the same — a URL plus an id.
 */

/** Where a library file lives: R2 (DAW Studio) or Cloudinary (Set Cue, audience). */
export type StorageBackend = 'r2' | 'cloudinary'

/** An uploaded R2 object. `public_id` is the object key. */
export interface StoredFile {
  storage: 'r2'
  public_id: string
  secure_url: string
  resource_type: 'image' | 'video' | 'raw'
  format: string
  bytes: number
  width?: number
  height?: number
  duration?: number
  is_audio?: boolean
}

let status: Promise<boolean> | null = null
/** Whether this server has R2 set up (asked once per page). */
export function r2Available(): Promise<boolean> {
  status ??= fetch('/api/r2/status')
    .then((r) => r.json())
    .then((b: { configured?: boolean }) => !!b.configured)
    .catch(() => false)
  return status
}

/** A file name safe inside an object key: no path or URL-special characters, no control characters. */
const safeName = (name: string) =>
  [...name.normalize('NFC')]
    .map((c) => (c.charCodeAt(0) < 32 || '\\/:*?"<>|#%'.includes(c) || /\s/.test(c) ? '_' : c))
    .join('')
    .slice(0, 80) || 'file'

/** Upload straight to R2 under `folder/`; the key gets a time prefix so names never collide. */
export async function uploadToR2(file: Blob, { folder, name, signal }: { folder: string; name: string; signal?: AbortSignal }): Promise<StoredFile> {
  const key = `${folder.replace(/\/+$/, '')}/${Date.now().toString(36)}-${safeName(name)}`
  const res = await fetch(`/api/r2/upload?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'content-type': file.type || 'application/octet-stream' },
    body: file,
    signal,
  })
  const raw = await res.text().catch(() => '')
  let body: { url?: string; key?: string; bytes?: number; error?: string } | null = null
  try {
    body = JSON.parse(raw)
  } catch {
    // not JSON: shown below
  }
  if (!res.ok || !body?.url) throw new Error(body?.error ?? `R2 上傳失敗（HTTP ${res.status}）${raw.replace(/\s+/g, ' ').slice(0, 160)}`)
  const type = file.type
  return {
    storage: 'r2',
    public_id: body.key!,
    secure_url: body.url,
    resource_type: type.startsWith('image/') ? 'image' : type.startsWith('audio/') || type.startsWith('video/') ? 'video' : 'raw',
    format: name.split('.').pop()?.toLowerCase() ?? '',
    bytes: body.bytes ?? file.size,
    is_audio: type.startsWith('audio/') || undefined,
  }
}

/** Duration (audio / video) and size (images / video) measured in the browser, before uploading. */
async function probeFile(file: File): Promise<{ duration?: number; width?: number; height?: number }> {
  const url = URL.createObjectURL(file)
  try {
    if (file.type.startsWith('image/')) {
      const img = new Image()
      img.src = url
      await img.decode()
      return { width: img.naturalWidth, height: img.naturalHeight }
    }
    if (file.type.startsWith('audio/') || file.type.startsWith('video/')) {
      const el = document.createElement(file.type.startsWith('video/') ? 'video' : 'audio')
      el.preload = 'metadata'
      el.src = url
      await new Promise<void>((resolve) => {
        el.onloadedmetadata = () => resolve()
        el.onerror = () => resolve()
        setTimeout(resolve, 8000)
      })
      const v = el as HTMLVideoElement
      return { duration: Number.isFinite(el.duration) ? el.duration : undefined, ...(v.videoWidth ? { width: v.videoWidth, height: v.videoHeight } : {}) }
    }
  } catch {
    // Unknown: the editor can still probe the URL later.
  } finally {
    URL.revokeObjectURL(url)
  }
  return {}
}

/**
 * Upload an operator's media file (cue media, hits, Default library) to R2 — Cloudinary is kept for
 * audience uploads only. Duration / size are measured first so cues get their length right away.
 */
export async function uploadMediaFile(file: File, folder: string): Promise<StoredFile> {
  if (!(await r2Available())) throw new Error('伺服器尚未設定 Cloudflare R2（.env.local 的 R2_* 變數）')
  const [probe, result] = await Promise.all([probeFile(file), uploadToR2(file, { folder, name: file.name })])
  return { ...result, ...probe, ...(file.type.startsWith('audio/') ? { is_audio: true } : {}) }
}

export const R2_MISSING = 'DAW Studio 的雲端儲存是 Cloudflare R2，但伺服器尚未設定（.env.local 的 R2_* 變數）'

/**
 * Upload a studio file (recording, TTS clip, mixdown, project JSON, imported audio) to R2.
 * `duration` (seconds) is filled in for audio when known.
 */
export async function uploadStudioFile(file: Blob, { folder, name, duration }: { folder: string; name: string; duration?: number }): Promise<StoredFile> {
  if (!(await r2Available())) throw new Error(R2_MISSING)
  const result = await uploadToR2(file, { folder, name })
  return duration !== undefined ? { ...result, duration } : result
}

/**
 * Copy a Set Cue / audience file from Cloudinary into the studio's R2 folder (server to server),
 * so studio projects never depend on Cloudinary.
 */
export async function importToR2(url: string, { folder, name }: { folder: string; name: string }): Promise<StoredFile> {
  if (!(await r2Available())) throw new Error(R2_MISSING)
  const key = `${folder.replace(/\/+$/, '')}/${Date.now().toString(36)}-${safeName(name)}`
  const res = await fetch(`/api/r2/import?key=${encodeURIComponent(key)}&url=${encodeURIComponent(url)}`, { method: 'POST' })
  const body = (await res.json().catch(() => null)) as { url?: string; key?: string; bytes?: number; contentType?: string; error?: string } | null
  if (!res.ok || !body?.url) throw new Error(body?.error ?? `複製到 R2 失敗（HTTP ${res.status}）`)
  const type = body.contentType ?? ''
  return {
    storage: 'r2',
    public_id: body.key!,
    secure_url: body.url,
    resource_type: type.startsWith('image/') ? 'image' : 'video',
    format: key.split('.').pop()?.toLowerCase() ?? '',
    bytes: body.bytes ?? 0,
    is_audio: type.startsWith('audio/') || undefined,
  }
}

export interface R2Object {
  key: string
  name: string
  size: number
  lastModified: number
  url: string
  contentType: string
}

/** Files under an R2 folder (media or raw/JSON); null when R2 isn't configured. */
export async function listR2(prefix: string, kind: 'media' | 'raw' = 'media'): Promise<R2Object[] | null> {
  if (!(await r2Available())) return null
  const res = await fetch(`/api/r2/list?kind=${kind}&prefix=${encodeURIComponent(prefix.endsWith('/') ? prefix : `${prefix}/`)}`)
  const body = (await res.json().catch(() => null)) as { items?: R2Object[]; error?: string } | null
  if (!res.ok || !body?.items) throw new Error(body?.error ?? `R2 列表失敗（HTTP ${res.status}）`)
  return body.items
}

/** Display name of an object: its file name without the time prefix added on upload. */
export const objectName = (key: string) => key.split('/').pop()!.replace(/^[0-9a-z]{6,10}-/, '')

/** Whether a URL points at R2 through this server. */
export const isR2Url = (url: string) => url.startsWith('/api/r2/o/')

/* ---------- auto-saved project files and deletion ---------- */

/** Folder of auto-saved DAW Studio projects: theatre/projects/{showId}/{studioId}.json. */
export const DAW_PROJECTS_PREFIX = 'theatre/projects/'
/** Folder of auto-saved Set Cue projects: theatre/setcue-projects/{showId}.json. */
export const SETCUE_PROJECTS_PREFIX = 'theatre/setcue-projects/'
/** Studio audio on R2 (recordings, TTS, imports, mixdowns), every show plus Default. */
export const DAW_AUDIO_PREFIX = 'theatre/daw/'

export const dawProjectKey = (showId: string, studioId: string) => `${DAW_PROJECTS_PREFIX}${showId}/${studioId}.json`
export const setCueProjectKey = (showId: string) => `${SETCUE_PROJECTS_PREFIX}${showId}.json`

/** Write (or overwrite) one object at an exact key. */
export async function putR2(key: string, body: Blob | string, contentType = 'application/json', { keepalive = false } = {}) {
  const res = await fetch(`/api/r2/upload?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body,
    keepalive,
  })
  const result = (await res.json().catch(() => null)) as { url?: string; bytes?: number; error?: string } | null
  if (!res.ok || !result?.url) throw new Error(result?.error ?? `R2 儲存失敗（HTTP ${res.status}）`)
  return result as { url: string; bytes: number }
}

/** Permanently delete objects (DAW / Set Cue project files and studio audio only). */
export async function deleteR2(keys: string[]): Promise<string[]> {
  if (keys.length === 0) return []
  const res = await fetch('/api/r2/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ keys }) })
  const body = (await res.json().catch(() => null)) as { deleted?: string[]; error?: string } | null
  if (!res.ok || body?.error) throw new Error(body?.error ?? `R2 刪除失敗（HTTP ${res.status}）`)
  return body?.deleted ?? []
}

/** The object key behind an /api/r2/o/… URL, or null for any other URL. */
export function r2KeyOf(url: string): string | null {
  if (!isR2Url(url)) return null
  try {
    return url.slice('/api/r2/o/'.length).split('/').map(decodeURIComponent).join('/')
  } catch {
    return null
  }
}

/** Read a JSON object from R2. */
export async function readR2Json<T>(key: string): Promise<T> {
  const res = await fetch(`/api/r2/o/${key.split('/').map(encodeURIComponent).join('/')}`, { cache: 'no-store' })
  if (!res.ok) throw new Error(res.status === 404 ? '雲端檔案不存在' : `讀取失敗（HTTP ${res.status}）`)
  return (await res.json()) as T
}
