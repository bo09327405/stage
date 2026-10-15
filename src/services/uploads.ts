import { get, onValue, push, ref, serverTimestamp, update } from 'firebase/database'
import { useEffect, useState } from 'react'
import type { AudienceUpload, Cue, ModerationStatus } from '../types/cue'
import { projectUploadsPath, uploadFolderFor, type ShowRef } from '../types/project'
import { resizeImage } from '../utils/resizeImage'
import { uploadMedia, type CloudinaryUploadResult } from './cloudinary'
import { db } from './firebase'

const AUDIENCE_ID_KEY = 'theatre.audienceCode'
// No 0/O/1/I/L so codes are easy to read aloud and type on the console.
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
let sessionId: string | undefined

// crypto.getRandomValues works on plain-http LAN dev (unlike crypto.randomUUID).
function randomCode(length = 4): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('')
}

/**
 * This device's audience code (e.g. "K7Q2"), shown on screen like a seat code and used by the
 * console to target cues. Persisted in localStorage so it survives reloads.
 */
export function getAudienceId(): string {
  try {
    const existing = localStorage.getItem(AUDIENCE_ID_KEY)
    if (existing) return existing
    const id = randomCode()
    localStorage.setItem(AUDIENCE_ID_KEY, id)
    return id
  } catch {
    // Storage blocked (private mode etc.): fall back to a per-session code.
    return (sessionId ??= randomCode())
  }
}

/*
 * Audience uploads live on Cloudinary, permanently.
 *
 * Cloudinary is the app's audience-interaction storage: operators' own media (cue files, hits, the
 * Default library) lives on Cloudflare R2. Every upload is also listed in audienceMedia/{id} (same
 * id as projects/{pid}/uploads/{id}), so every project can use audience material.
 *
 * Retention policy: nothing in this app deletes an audience file or its record. The console can
 * hide an upload (reversible) and approve / reject it, and deleting a project moves its upload
 * records to audienceArchive/{pid} instead of dropping them, so every file stays findable — by
 * record, by folder and by the tags below — for later review or reuse in Set Cue.
 */

/** Tags stored on every audience file, so they can be found in the Cloudinary console later. */
export function audienceTags(show: ShowRef, cueId: string): string[] {
  return ['theatre-audience', `project_${show.projectId}`, `version_${show.versionId}`, `cue_${cueId}`, `audience_${getAudienceId()}`]
}

/** Cloudinary context stored with every audience file. */
export const audienceContext = (show: ShowRef, cueId: string) => ({
  project: show.projectId,
  version: show.versionId,
  cue: cueId,
  audience: getAudienceId(),
  retention: 'permanent',
})

/**
 * Moderation result of an upload. Cloudinary's AI moderation (set on the upload preset) answers
 * approved / rejected, often right away; anything else — no add-on, still queued, manual review
 * — waits for the operator, so nothing unchecked can reach the big screen.
 */
export function moderationOf(result: CloudinaryUploadResult): Pick<AudienceUpload, 'moderation' | 'moderatedBy' | 'moderationKind'> {
  const checks = result.moderation ?? []
  const kind = checks.map((m) => m.kind).join(',') || undefined
  if (checks.some((m) => m.status === 'rejected')) return { moderation: 'rejected', moderatedBy: 'ai', ...(kind ? { moderationKind: kind } : {}) }
  if (checks.length && checks.every((m) => m.status === 'approved')) return { moderation: 'approved', moderatedBy: 'ai', moderationKind: kind }
  return { moderation: 'pending', ...(kind ? { moderationKind: kind } : {}) }
}

/** Photo, recording or video, from what Cloudinary stored. */
export function uploadKindOf(result: CloudinaryUploadResult): AudienceUpload['kind'] {
  if (result.resource_type === 'image') return 'image'
  return result.is_audio || (/^(mp3|wav|m4a|aac|ogg|oga|opus|flac|weba)$/i.test(result.format) && !result.width) ? 'audio' : 'video'
}

/** Add an uploaded file to the project's media pool (projects/{pid}/uploads). */
export async function recordAudienceUpload(
  show: ShowRef,
  cue: Pick<Cue, 'id'>,
  result: CloudinaryUploadResult,
  { folder, kind = uploadKindOf(result), via }: { folder: string; kind?: AudienceUpload['kind']; via: AudienceUpload['via'] },
) {
  const id = push(ref(db, projectUploadsPath(show.projectId))).key!
  const record = {
    cueId: cue.id,
    folder,
    versionId: show.versionId,
    kind,
    url: result.secure_url,
    publicId: result.public_id,
    width: result.width ?? 0,
    height: result.height ?? 0,
    duration: result.duration ?? 0,
    audienceId: getAudienceId(),
    createdAt: serverTimestamp(),
    tags: result.tags?.length ? result.tags : audienceTags(show, cue.id),
    via,
    ...moderationOf(result),
  }
  // The on-air project's name (public) labels the entry in other projects' pickers.
  const live = (await get(ref(db, 'live')).catch(() => null))?.val() as { projectId?: string; projectName?: string } | null
  await update(ref(db), {
    [`${projectUploadsPath(show.projectId)}/${id}`]: record,
    [`audienceMedia/${id}`]: poolEntry(show.projectId, record, live?.projectId === show.projectId ? live.projectName : undefined),
  })
}

/** The cross-project index entry of an upload. */
function poolEntry(projectId: string, u: Partial<Omit<AudienceUpload, 'id' | 'createdAt'>> & { createdAt: unknown }, projectName?: string) {
  return {
    projectId,
    ...(projectName ? { projectName } : {}),
    versionId: u.versionId ?? '',
    cueId: u.cueId ?? '',
    kind: u.kind ?? 'image',
    url: u.url ?? '',
    publicId: u.publicId ?? '',
    width: u.width ?? 0,
    height: u.height ?? 0,
    duration: u.duration ?? 0,
    createdAt: u.createdAt,
    ...(u.moderation ? { moderation: u.moderation } : {}),
    ...(u.hidden ? { hidden: true } : {}),
  }
}

/** Mirror a change of an upload onto its cross-project entry (if it has one). */
async function mirror(uploadId: string, patch: Record<string, unknown>) {
  const entry = ref(db, `audienceMedia/${uploadId}`)
  if ((await get(entry).catch(() => null))?.exists()) await update(entry, patch).catch(() => {})
}

/**
 * Upload an audience photo or recording into the Cloudinary folder the cue specifies, then add it
 * to the project's media pool. Photos are downscaled first to keep uploads fast on venue Wi-Fi.
 */
export async function submitAudienceMedia(
  show: ShowRef,
  cue: Pick<Cue, 'id' | 'uploadFolder'>,
  file: File | Blob,
  kind: AudienceUpload['kind'],
): Promise<string> {
  const payload = kind === 'image' && file instanceof File ? await resizeImage(file) : file
  const folder = uploadFolderFor(show.projectId, cue.uploadFolder)
  const result = await uploadMedia(payload, { folder, tags: audienceTags(show, cue.id), context: audienceContext(show, cue.id) })
  await recordAudienceUpload(show, cue, result, { folder, kind, via: 'direct' })
  return result.secure_url
}

/** Live media pool of a project, newest first. */
export function useProjectUploads(projectId: string) {
  const [uploads, setUploads] = useState<AudienceUpload[] | null>(null)
  const [error, setError] = useState<Error | null>(null)

  useEffect(
    () =>
      onValue(
        ref(db, projectUploadsPath(projectId)),
        (snapshot) => {
          const raw = (snapshot.val() ?? {}) as Record<string, Omit<AudienceUpload, 'id'>>
          setUploads(
            Object.entries(raw)
              .map(([id, upload]) => ({
                ...upload,
                duration: upload.duration ?? 0,
                // Stage 4.5 records predate per-cue folders and went to the project default.
                folder: upload.folder ?? uploadFolderFor(projectId, ''),
                id,
              }))
              .sort((a, b) => b.createdAt - a.createdAt),
          )
        },
        setError,
      ),
    [projectId],
  )

  return { uploads, error }
}

/** Approve or reject an upload (operator review). */
export async function setUploadModeration(projectId: string, uploadId: string, status: ModerationStatus) {
  await update(ref(db, `${projectUploadsPath(projectId)}/${uploadId}`), { moderation: status, moderatedBy: 'operator' })
  await mirror(uploadId, { moderation: status })
}

/**
 * Hide an upload from the inbox, or show it again. Uploads are never deleted — neither the
 * record nor the Cloudinary file — so hiding is always reversible.
 */
export async function setUploadHidden(projectId: string, uploadId: string, hidden: boolean) {
  await update(ref(db, `${projectUploadsPath(projectId)}/${uploadId}`), { hidden: hidden || null })
  await mirror(uploadId, { hidden: hidden || null })
}

/**
 * Ask Cloudinary (through /api/cloudinary/moderation, which needs the Admin API keys) whether a
 * queued AI moderation has finished, and record the verdict. Leaves pending uploads pending.
 */
export async function recheckModeration(projectId: string, upload: AudienceUpload) {
  const res = await fetch(`/api/cloudinary/moderation?type=${upload.kind === 'image' ? 'image' : 'video'}&publicId=${encodeURIComponent(upload.publicId)}`)
  const body = (await res.json().catch(() => null)) as { configured?: boolean; status?: ModerationStatus; error?: string } | null
  if (!body?.configured) throw new Error('伺服器沒有 Cloudinary Admin API 金鑰（CLOUDINARY_API_KEY / SECRET），請直接人工核准或拒絕')
  if (body.error) throw new Error(`查詢審查結果失敗：${body.error}`)
  if (body.status && body.status !== 'pending') {
    await update(ref(db, `${projectUploadsPath(projectId)}/${upload.id}`), { moderation: body.status, moderatedBy: 'ai' })
    await mirror(upload.id, { moderation: body.status })
  }
}

/** An audience upload as every project sees it (audienceMedia/{id}). */
export interface PooledUpload extends Omit<AudienceUpload, 'audienceId' | 'folder' | 'via'> {
  projectId: string
  projectName?: string
}

/**
 * Audience uploads from every project (approved, not hidden), newest first — for pickers in any
 * Set Cue or Studio project. `kind` narrows to photos / recordings / videos.
 */
export function useAudiencePool(kind?: AudienceUpload['kind']) {
  const [items, setItems] = useState<PooledUpload[] | null>(null)
  useEffect(
    () =>
      onValue(
        ref(db, 'audienceMedia'),
        (snap) =>
          setItems(
            Object.entries((snap.val() ?? {}) as Record<string, Omit<PooledUpload, 'id'>>)
              .map(([id, u]) => ({ ...u, id }))
              .filter((u) => (!u.moderation || u.moderation === 'approved') && !u.hidden)
              .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)),
          ),
        () => setItems([]),
      ),
    [],
  )
  return items && kind ? items.filter((u) => u.kind === kind) : items
}

/**
 * Admins: list every project's existing uploads in audienceMedia (uploads made before the index
 * existed). Returns how many entries were added.
 */
export async function syncAudiencePool(): Promise<number> {
  const [projects, index, existing] = await Promise.all([
    get(ref(db, 'projects')).then((s) => (s.val() ?? {}) as Record<string, { uploads?: Record<string, Omit<AudienceUpload, 'id'>> }>),
    get(ref(db, 'projectIndex')).then((s) => (s.val() ?? {}) as Record<string, { name?: string }>),
    get(ref(db, 'audienceMedia')).then((s) => (s.val() ?? {}) as Record<string, unknown>),
  ])
  const updates: Record<string, unknown> = {}
  for (const [pid, p] of Object.entries(projects))
    for (const [id, u] of Object.entries(p.uploads ?? {})) {
      if (existing[id] || typeof u.url !== 'string' || !u.url.startsWith('https://res.cloudinary.com/')) continue
      updates[`audienceMedia/${id}`] = poolEntry(pid, u, index[pid]?.name)
    }
  if (Object.keys(updates).length) await update(ref(db), updates)
  return Object.keys(updates).length
}

/** Insert a Cloudinary transformation right after /upload/ in a delivery URL. */
export function withTransform(url: string, transform: string): string {
  if (!/^https:\/\/res\.cloudinary\.com\//.test(url)) return url
  return url.replace('/upload/', `/upload/${transform}/`)
}

/**
 * URL to use when an upload becomes cue media, transcoded on the fly by Cloudinary:
 *  - photos: best format for the device (f_auto), auto quality, at most 1920 px for the screen;
 *  - recordings (WebM from Chrome, MP4 from Safari): MP3, which every phone plays;
 *  - videos: H.264 MP4 at auto quality, at most 1920 px wide.
 */
export function playableUrl(upload: Pick<AudienceUpload, 'kind' | 'url'>): string {
  if (upload.kind === 'audio') return upload.url.replace(/\.[a-z0-9]+$/i, '.mp3')
  if (upload.kind === 'video') return withTransform(upload.url, 'q_auto,vc_h264,c_limit,w_1920').replace(/\.[a-z0-9]+$/i, '.mp4')
  return withTransform(upload.url, 'f_auto,q_auto,c_limit,w_1920,h_1920')
}

/** Square thumbnail for grid cards (videos get a poster frame). */
export function thumbnailUrl(upload: Pick<AudienceUpload, 'kind' | 'url'>): string {
  const thumb = withTransform(upload.url, 'c_fill,w_360,h_360,q_auto,f_auto')
  return upload.kind === 'video' ? thumb.replace(/\.[a-z0-9]+$/i, '.jpg') : thumb
}
