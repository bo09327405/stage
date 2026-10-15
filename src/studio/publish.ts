import { Mp3Encoder } from '@breezystack/lamejs'
import { onValue, push, ref, remove, runTransaction, set, update } from 'firebase/database'
import { useEffect, useRef, useState } from 'react'
import { db } from '../services/firebase'
import { deleteR2, putR2 } from '../services/storage'
import type { ShowRef } from '../types/project'
import type { StudioProject } from '../types/studio'
import { renderMix } from './mixer'

/*
 * Publishing from the DAW Studio:
 *  - a project link: opens this studio in the DAW for anyone who can reach the server;
 *  - a public audio URL: the mix rendered to MP3 in theatre/public/{show}/, served with
 *    Content-Type audio/mpeg, CORS and Range — so Notion (and any site) can embed a player.
 */

export const PUBLIC_PREFIX = 'theatre/public/'

export interface PublishedAudio {
  id: string
  key: string
  name: string
  studioId: string
  studioName: string
  bytes: number
  duration: number
  createdAt: number
}

const publishedPath = (projectId: string) => `projects/${projectId}/published`

/* ---------- where links point ---------- */

const BASE_KEY = 'theatre.shareBase'
/** The address others use to reach this server (an ngrok / LAN / deployed URL); defaults to this page's. */
export function readShareBase(): string {
  try {
    return localStorage.getItem(BASE_KEY) || location.origin
  } catch {
    return location.origin
  }
}
export function writeShareBase(base: string) {
  try {
    localStorage.setItem(BASE_KEY, base.replace(/\/+$/, ''))
  } catch {
    // Not remembered; harmless.
  }
}
/** Whether only this computer (or this local network) can open links on `base`. */
export function isPrivateBase(base: string): boolean {
  try {
    const { hostname } = new URL(base)
    return /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$)/.test(hostname) || hostname.endsWith('.local')
  } catch {
    return true
  }
}

/** Studio share link; the invite token lets the person opening it join the project. */
export const studioShareUrl = (base: string, show: ShowRef, studioId: string, invite?: string | null) =>
  `${base.replace(/\/+$/, '')}/?role=studio&project=${encodeURIComponent(show.projectId)}&version=${encodeURIComponent(show.versionId)}&studio=${encodeURIComponent(studioId)}${invite ? `&invite=${encodeURIComponent(invite)}` : ''}`

let publicBase: Promise<string | null> | null = null
/** R2_PUBLIC_BASE_URL from the server, if configured. */
function serverPublicBase(): Promise<string | null> {
  publicBase ??= fetch('/api/r2/status')
    .then((r) => r.json())
    .then((b: { publicBaseUrl?: string | null }) => b.publicBaseUrl ?? null)
    .catch(() => null)
  return publicBase
}
export const useServerPublicBase = () => {
  const [base, setBase] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    serverPublicBase().then(setBase)
  }, [])
  return base
}

/** The public URL of a published file: the R2 public domain if configured, else this server's /api/r2/pub route. */
export function publicAudioUrl(key: string, shareBase: string, r2Public: string | null | undefined): string {
  const path = key.split('/').map(encodeURIComponent).join('/')
  return r2Public ? `${r2Public}/${path}` : `${shareBase.replace(/\/+$/, '')}/api/r2/pub/${path}`
}

/* ---------- MP3 ---------- */

const toInt16 = (f: Float32Array) => {
  const out = new Int16Array(f.length)
  for (let i = 0; i < f.length; i++) {
    const s = Math.max(-1, Math.min(1, f[i]))
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return out
}

/** Encode to MP3 (stereo when the buffer is), yielding now and then so the page stays responsive. */
export async function encodeMp3(buffer: AudioBuffer, { kbps = 192, onProgress }: { kbps?: number; onProgress?: (fraction: number) => void } = {}): Promise<Blob> {
  const stereo = buffer.numberOfChannels > 1
  const encoder = new Mp3Encoder(stereo ? 2 : 1, buffer.sampleRate, kbps)
  const left = toInt16(buffer.getChannelData(0))
  const right = stereo ? toInt16(buffer.getChannelData(1)) : undefined
  const parts: Uint8Array[] = []
  const block = 1152 * 64
  for (let i = 0; i < left.length; i += block) {
    const chunk = encoder.encodeBuffer(left.subarray(i, i + block), right?.subarray(i, i + block))
    if (chunk.length) parts.push(new Uint8Array(chunk))
    onProgress?.(Math.min(1, (i + block) / left.length))
    await new Promise((r) => setTimeout(r, 0))
  }
  const end = encoder.flush()
  if (end.length) parts.push(new Uint8Array(end))
  return new Blob(parts as BlobPart[], { type: 'audio/mpeg' })
}

/** A URL-safe ASCII file name (Chinese names fall back to "mix"). */
const slug = (name: string) =>
  name
    .normalize('NFKD')
    .replace(/[^\w-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .toLowerCase() || 'mix'

/** Render the studio's mix, encode it to MP3 and publish it. */
export async function publishAudio(
  projectId: string,
  studio: StudioProject,
  name: string,
  onProgress?: (step: string) => void,
): Promise<PublishedAudio> {
  onProgress?.('混音中…')
  const mix = await renderMix(studio)
  if (Object.keys(studio.regions).length === 0) throw new Error('這個 Studio 還沒有任何片段可以發布')
  const mp3 = await encodeMp3(mix, { onProgress: (f) => onProgress?.(`編碼 MP3 ${Math.round(f * 100)}%`) })
  onProgress?.('上傳到 R2…')
  const key = `${PUBLIC_PREFIX}${projectId}/${slug(name)}-${Date.now().toString(36)}.mp3`
  await putR2(key, mp3, 'audio/mpeg')
  const entry = { key, name, studioId: studio.id, studioName: studio.name, bytes: mp3.size, duration: Math.round(mix.duration * 100) / 100, createdAt: Date.now() }
  const node = push(ref(db, publishedPath(projectId)))
  await set(node, entry)
  return { ...entry, id: node.key! }
}

/** Stop publishing: the public file is deleted, so embeds stop playing. */
export async function unpublishAudio(projectId: string, item: PublishedAudio) {
  await deleteR2([item.key])
  await remove(ref(db, `${publishedPath(projectId)}/${item.id}`))
}

export function usePublishedAudio(projectId: string) {
  const [items, setItems] = useState<PublishedAudio[] | null>(null)
  useEffect(
    () =>
      onValue(
        ref(db, publishedPath(projectId)),
        (snap) =>
          setItems(
            Object.entries((snap.val() ?? {}) as Record<string, Omit<PublishedAudio, 'id'>>)
              .map(([id, v]) => ({ ...v, id }))
              .sort((a, b) => b.createdAt - a.createdAt),
          ),
        () => setItems([]),
      ),
    [projectId],
  )
  return items
}

/* ---------- fixed URL (auto-updating) ---------- */

/*
 * One MP3 per studio at a URL that never changes: theatre/public/{show}/live/{studio}.mp3. Each
 * update overwrites the same object, and it is served with "no-cache", so a Notion page shows the
 * current mix after a refresh. With auto-update on, any open copy of the studio re-renders it a
 * while after editing stops (mixing runs in the browser, so someone must have the studio open).
 */

export interface LiveAudio {
  key: string
  studioName: string
  bytes: number
  duration: number
  /** When the file was last rendered (0 = never). */
  updatedAt: number
  /** Content signature of the studio when last rendered. */
  sig: string
  /** Re-render automatically after edits. */
  auto: boolean
  /** Who is rendering right now (so two open tabs don't both do it). */
  lock?: { by: string; at: number } | null
}

const livePath = (projectId: string, studioId: string) => `projects/${projectId}/publishedLive/${studioId}`
export const liveKey = (projectId: string, studioId: string) => `${PUBLIC_PREFIX}${projectId}/live/${studioId.replace(/[^\w-]/g, '_')}.mp3`

/** A short, stable hash of the studio content (FNV-1a), to tell whether the MP3 is current. */
export function contentSig(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36) + text.length.toString(36)
}

const TAB_ID = Math.random().toString(36).slice(2, 10)
const LOCK_MS = 120_000

/** Render the studio and overwrite its fixed-URL MP3. Returns false if another tab is already rendering. */
export async function updateLiveAudio(projectId: string, studio: StudioProject, sig: string, onProgress?: (step: string) => void): Promise<boolean> {
  const path = livePath(projectId, studio.id)
  const lock = await runTransaction(ref(db, `${path}/lock`), (cur: LiveAudio['lock']) => {
    if (cur && cur.by !== TAB_ID && Date.now() - cur.at < LOCK_MS) return undefined
    return { by: TAB_ID, at: Date.now() }
  })
  if (!lock.committed) return false
  try {
    if (Object.keys(studio.regions).length === 0) throw new Error('這個 Studio 還沒有任何片段可以發布')
    onProgress?.('混音中…')
    const mix = await renderMix(studio)
    const mp3 = await encodeMp3(mix, { onProgress: (f) => onProgress?.(`編碼 MP3 ${Math.round(f * 100)}%`) })
    onProgress?.('上傳到 R2…')
    const key = liveKey(projectId, studio.id)
    await putR2(key, mp3, 'audio/mpeg')
    await update(ref(db, path), { key, studioName: studio.name, bytes: mp3.size, duration: Math.round(mix.duration * 100) / 100, updatedAt: Date.now(), sig, lock: null })
    return true
  } catch (err) {
    await set(ref(db, `${path}/lock`), null).catch(() => {})
    throw err
  }
}

/** Turn the fixed URL on (renders it now) — auto-update on by default. */
export async function enableLiveAudio(projectId: string, studio: StudioProject, sig: string, onProgress?: (step: string) => void) {
  await update(ref(db, livePath(projectId, studio.id)), { key: liveKey(projectId, studio.id), studioName: studio.name, auto: true, sig: '', updatedAt: 0, bytes: 0, duration: 0 })
  await updateLiveAudio(projectId, studio, sig, onProgress)
}

export const setLiveAuto = (projectId: string, studioId: string, auto: boolean) => update(ref(db, livePath(projectId, studioId)), { auto })

/** Stop publishing the fixed URL: the file is deleted (embeds stop playing). */
export async function disableLiveAudio(projectId: string, studioId: string) {
  await deleteR2([liveKey(projectId, studioId)])
  await remove(ref(db, livePath(projectId, studioId)))
}

export type LiveState = { phase: 'off' } | { phase: 'current' } | { phase: 'stale' } | { phase: 'updating'; step: string } | { phase: 'error'; message: string }

const AUTO_DELAY_MS = 30_000
const AUTO_MAX_WAIT_MS = 180_000

/**
 * The studio's fixed-URL MP3: its record, whether it matches the studio right now, and — with
 * auto-update on — re-rendering 30 s after editing stops (at most 3 min behind while editing
 * continues). `sig` is the studio content signature (null while loading).
 */
export function useLiveAudio(projectId: string, studio: StudioProject | null | undefined, sig: string | null) {
  const studioId = studio?.id ?? null
  const [entry, setEntry] = useState<LiveAudio | null | undefined>(undefined)
  const [work, setWork] = useState<{ step: string } | { error: string } | null>(null)
  const latest = useRef({ studio, sig })
  useEffect(() => {
    latest.current = { studio, sig }
  })

  useEffect(() => {
    if (!studioId) return
    return onValue(ref(db, livePath(projectId, studioId)), (snap) => setEntry((snap.val() as LiveAudio | null) ?? null))
  }, [projectId, studioId])

  const run = async () => {
    const { studio: s, sig: g } = latest.current
    if (!s || !g) return
    setWork({ step: '準備中…' })
    try {
      await updateLiveAudio(projectId, s, g, (step) => setWork({ step }))
      setWork(null)
    } catch (err) {
      setWork({ error: (err as Error).message })
    }
  }

  // Auto-update: wait for a pause in editing (but don't fall more than a few minutes behind).
  const firstStale = useRef(0)
  const stale = !!entry && !!sig && entry.sig !== sig
  const busy = !!work && 'step' in work
  useEffect(() => {
    if (!entry?.auto || !stale || busy) {
      if (!stale) firstStale.current = 0
      return
    }
    const now = Date.now()
    firstStale.current ||= now
    const wait = Math.max(0, Math.min(AUTO_DELAY_MS, firstStale.current + AUTO_MAX_WAIT_MS - now))
    const timer = window.setTimeout(() => {
      firstStale.current = 0
      run()
    }, wait)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry?.auto, stale, busy, sig])

  const othersRendering = !!entry?.lock && entry.lock.by !== TAB_ID && Date.now() - entry.lock.at < LOCK_MS
  const state: LiveState = !entry
    ? { phase: 'off' }
    : work && 'step' in work
      ? { phase: 'updating', step: work.step }
      : othersRendering
        ? { phase: 'updating', step: '其他人正在更新…' }
        : work && 'error' in work
          ? { phase: 'error', message: work.error }
          : stale || !entry.updatedAt
            ? { phase: 'stale' }
            : { phase: 'current' }

  return {
    entry: entry ?? null,
    loading: entry === undefined,
    state,
    updateNow: run,
    enable: async () => {
      const { studio: s, sig: g } = latest.current
      if (!s || !g) return
      setWork({ step: '準備中…' })
      try {
        await enableLiveAudio(projectId, s, g, (step) => setWork({ step }))
        setWork(null)
      } catch (err) {
        setWork({ error: (err as Error).message })
      }
    },
    disable: () => studioId && disableLiveAudio(projectId, studioId),
    setAuto: (auto: boolean) => studioId && setLiveAuto(projectId, studioId, auto),
  }
}
export type LiveAudioControl = ReturnType<typeof useLiveAudio>
