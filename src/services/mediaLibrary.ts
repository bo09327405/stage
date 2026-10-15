import { currentUser, isAdmin } from './auth'
import { refuseIfReadOnly } from './projectLock'
import { onValue, push, ref, remove, serverTimestamp, set, update } from 'firebase/database'
import { useEffect, useState } from 'react'
import { DEFAULT_MEDIA_FOLDER, SHARED_MEDIA_PATH, STUDIO_DEFAULT_FOLDER, projectMediaPath } from '../types/project'

/** Shared folders listed from R2: Set Cue's Default and the DAW's Default. */
const R2_DEFAULT_FOLDERS = [DEFAULT_MEDIA_FOLDER, STUDIO_DEFAULT_FOLDER]
import type { CloudinaryUploadResult } from './cloudinary'
import { placementFolder, type AssetPlacement } from './assetLibrary'
import { fileTypeOf, logFileActivity } from './fileActivity'
import { db } from './firebase'
import { importToR2, listR2, objectName, type StorageBackend, type StoredFile } from './storage'

/**
 * Index of media the operators uploaded for a project (cue files, hit sounds), at
 * projects/{pid}/media/{id}. Cloudinary folders can't be listed from the browser without an
 * API secret, so this index is what file pickers read to show "this project's files".
 */

export type MediaKind = 'image' | 'audio' | 'video'

export interface ProjectMedia {
  id: string
  kind: MediaKind
  url: string
  publicId: string
  /** Cloudinary folder, e.g. theatre/cues/318. */
  folder: string
  /** Original file name, for display. */
  name: string
  /** Seconds, for audio/video. */
  duration: number
  bytes: number
  /** Where it was uploaded from. */
  source: 'cue' | 'hit' | 'link' | 'studio'
  createdAt: number
  /** Default folder only: listed live from storage (not in the index, so it can't be removed here). */
  fromCloudinary?: boolean
  /** Where the file lives (absent = Cloudinary, for entries made before R2). */
  storage?: StorageBackend
  /** Studio 素材 panel: position within its folder, and the custom folder it's filed in. */
  order?: number
  assetFolder?: string | null
}

export function mediaKindOf(result: CloudinaryUploadResult): MediaKind {
  if (result.resource_type === 'image') return 'image'
  return result.is_audio && !result.width ? 'audio' : 'video'
}

/** Add an upload to the project's library. Failures are reported but never block the upload. */
export async function recordProjectMedia(
  projectId: string,
  result: CloudinaryUploadResult,
  file: File,
  folder: string,
  source: ProjectMedia['source'],
  /** Automatic filing in the Studio 素材 panel: which Studio, which standard folder; none = top level. */
  placement: AssetPlacement | null = null,
) {
  if (refuseIfReadOnly(projectId)) throw new Error('read-only')
  const assetFolder = placementFolder(placement)
  const entry = entryFor(result, file, folder, source)
  const record = push(ref(db, projectMediaPath(projectId)))
  await set(record, { ...entry, ...(assetFolder ? { assetFolder } : {}) })
  void logFileActivity({
    action: 'upload',
    name: file.name,
    fileType: typeOf(file, entry.kind),
    storage: entry.storage,
    url: entry.url,
    key: entry.storage === 'r2' ? entry.publicId : null,
    record: `${projectMediaPath(projectId)}/${record.key}`,
    projectId,
    studioId: placement?.studioId ?? null,
    to: folder,
  })
}

/** File type for the activity log: from the file name (audio uploads come back as "video" from Cloudinary-style results), else the library kind. */
const typeOf = (file: File, kind: MediaKind) => (fileTypeOf(file.name) === 'other' ? kind : fileTypeOf(file.name))

/** Index entry for an upload (shared by the project and the Default indexes). */
const entryFor = (result: CloudinaryUploadResult, file: File, folder: string, source: ProjectMedia['source']) => ({
  kind: mediaKindOf(result),
  url: result.secure_url,
  publicId: result.public_id,
  folder,
  name: file.name,
  duration: result.duration ?? 0,
  bytes: result.bytes ?? 0,
  source,
  storage: ((result as Partial<StoredFile>).storage ?? 'cloudinary') as StorageBackend,
  createdAt: serverTimestamp(),
})

/** Add an upload to the shared Default library (visible from every project). */
export async function recordSharedMedia(result: CloudinaryUploadResult, file: File, source: ProjectMedia['source'], folder = DEFAULT_MEDIA_FOLDER) {
  if (!isAdmin(currentUser())) throw new Error('Default 共用資料夾只有管理員可以新增檔案')
  const entry = entryFor(result, file, folder, source)
  const record = push(ref(db, SHARED_MEDIA_PATH))
  await set(record, entry)
  void logFileActivity({ action: 'upload', name: file.name, fileType: typeOf(file, entry.kind), storage: entry.storage, url: entry.url, key: entry.storage === 'r2' ? entry.publicId : null, record: `${SHARED_MEDIA_PATH}/${record.key}`, projectName: 'Default 共用資源庫', to: folder })
}

/**
 * Copy library records that still point at Cloudinary (from before the move to R2) into the
 * project's R2 folder and repoint them. Cues using the old address keep working.
 */
export async function migrateMediaToR2(projectId: string, folder: string, list: ProjectMedia[]) {
  if (refuseIfReadOnly(projectId)) throw new Error('這個專案目前是唯讀')
  let moved = 0
  const failed: string[] = []
  for (const m of list) {
    try {
      const copy = await importToR2(m.url, { folder, name: m.name })
      await update(ref(db, `${projectMediaPath(projectId)}/${m.id}`), { url: copy.secure_url, publicId: copy.public_id, folder, bytes: copy.bytes || m.bytes || 0, storage: 'r2' })
      void logFileActivity({ action: 'move', name: m.name, fileType: fileTypeOf(m.name, m.kind), storage: 'r2', url: copy.secure_url, key: copy.public_id, record: `${projectMediaPath(projectId)}/${m.id}`, projectId, from: m.url, to: folder })
      moved++
    } catch {
      failed.push(m.name)
    }
  }
  return { moved, failed }
}

export function removeSharedMedia(id: string) {
  return remove(ref(db, `${SHARED_MEDIA_PATH}/${id}`))
}

/** What the server says about listing the Default folders on R2. */
export type R2Listing =
  | { status: 'loading' }
  | { status: 'off' } // R2 isn't configured on the server
  | { status: 'ok'; count: number }
  | { status: 'error'; message: string }

/**
 * The shared Default folders on Cloudflare R2 (theatre/cues/Default, theatre/daw/Default): the
 * live R2 listing merged with the shared index (names, durations). Every project reads them; only
 * admins add, rename or delete. Entries still pointing at Cloudinary (from before the move to R2)
 * aren't shown — `cloudinaryPending` counts them for the admin migration.
 */
export function useDefaultMedia() {
  const [indexed, setIndexed] = useState<ProjectMedia[] | null>(null)
  const [r2Listed, setR2Listed] = useState<ProjectMedia[]>([])
  // Folders the last listing covered: an index entry there that the listing lacks is gone.
  const [listedFolders, setListedFolders] = useState<string[]>([])
  const [r2, setR2] = useState<R2Listing>({ status: 'loading' })
  const [nonce, setNonce] = useState(0)

  // R2 can list folders directly: everything in the Default folders shows, however it got there.
  useEffect(() => {
    let cancelled = false
    Promise.all(R2_DEFAULT_FOLDERS.map((folder) => listR2(folder, 'media')))
      .then((lists) => {
        if (cancelled) return
        if (lists.every((l) => l === null)) return setR2({ status: 'off' })
        const items = lists.flatMap((l) => l ?? [])
        setListedFolders(R2_DEFAULT_FOLDERS.filter((_, i) => lists[i] !== null))
        setR2Listed(
          items.map((o) => ({
            id: `r2:${o.key}`,
            kind: o.contentType.startsWith('image/') ? 'image' : o.contentType.startsWith('video/') ? 'video' : 'audio',
            url: o.url,
            publicId: o.key,
            folder: o.key.slice(0, o.key.lastIndexOf('/')),
            name: objectName(o.key),
            duration: 0,
            bytes: o.size,
            source: 'link',
            createdAt: o.lastModified,
            fromCloudinary: true,
            storage: 'r2',
          })),
        )
        setR2({ status: 'ok', count: items.length })
      })
      .catch((err) => {
        if (cancelled) return
        setListedFolders([])
        setR2({ status: 'error', message: (err as Error).message })
      })
    return () => {
      cancelled = true
    }
  }, [nonce])

  useEffect(
    () =>
      onValue(
        ref(db, SHARED_MEDIA_PATH),
        (snapshot) => {
          const raw = (snapshot.val() ?? {}) as Record<string, Omit<ProjectMedia, 'id'>>
          setIndexed(Object.entries(raw).map(([id, m]) => ({ ...m, id })))
        },
        () => setIndexed([]),
      ),
    [],
  )


  // One entry per R2 file; the index entry wins (it has the upload name and duration). Index
  // entries in a listed folder whose file the listing lacks were deleted: `ghosts`, not shown.
  const allOnR2 = indexed?.filter((m) => m.storage === 'r2') ?? null
  const listedKeys = new Set(r2Listed.map((m) => m.publicId))
  const isGhost = (m: ProjectMedia) => r2.status === 'ok' && listedFolders.includes(m.folder) && !listedKeys.has(m.publicId)
  const ghosts = allOnR2?.filter(isGhost) ?? []
  const onR2 = allOnR2?.filter((m) => !isGhost(m)) ?? null
  const media =
    onR2 === null
      ? null
      : (() => {
          const seen = new Set(onR2.map((m) => m.publicId))
          const live = r2Listed.filter((m) => !seen.has(m.publicId))
          return [...onR2, ...live].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
        })()
  const cloudinaryPending = indexed?.filter((m) => m.storage !== 'r2').length ?? 0

  return { media, ghosts, r2, cloudinaryPending, reload: () => setNonce((n) => n + 1) }
}

export function useProjectMedia(projectId: string) {
  const [media, setMedia] = useState<ProjectMedia[] | null>(null)
  const [error, setError] = useState<Error | null>(null)
  useEffect(
    () =>
      onValue(
        ref(db, projectMediaPath(projectId)),
        (snapshot) => {
          const raw = (snapshot.val() ?? {}) as Record<string, Omit<ProjectMedia, 'id'>>
          setMedia(
            Object.entries(raw)
              .map(([id, m]) => ({ ...m, id }))
              .sort((a, b) => b.createdAt - a.createdAt),
          )
        },
        setError,
      ),
    [projectId],
  )
  return { media, error }
}

/** Remove from the library index (the Cloudinary file itself stays; unsigned uploads can't be deleted). */
export function removeProjectMedia(projectId: string, id: string) {
  if (refuseIfReadOnly(projectId)) return Promise.reject(new Error('read-only'))
  return remove(ref(db, `${projectMediaPath(projectId)}/${id}`))
}
