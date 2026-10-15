import { currentUser, isAdmin } from '../services/auth'
import { onValue, push, ref, remove, set } from 'firebase/database'
import { useEffect, useState } from 'react'
import { deleteR2, listR2, objectName, uploadStudioFile, type StorageBackend } from '../services/storage'
import { db } from '../services/firebase'
import { recordedUpdate } from '../services/history'
import { studioPath } from '../services/studio'
import { SHARED_STUDIO_FILES_PATH, STUDIO_DEFAULT_FOLDER, studioFilesFolder } from '../types/project'
import { normalizeStudio, projectLength, type StudioProject } from '../types/studio'

/*
 * DAW project files: one studio (tracks, regions, automation, sections, master) as JSON — only
 * that studio, never its Set Cue parent (the Set Cue page exports bundles with every studio).
 * Audio stays where it is — regions keep their R2 URLs — so a file opens with all its sound in
 * any show, on any machine.
 *
 * Files can be downloaded / imported locally. In the cloud, every studio auto-saves to
 * theatre/projects/{show}/{studio}.json; copies can also be published to the Default shared
 * library (theatre/daw/Default) for other shows.
 */

export const STUDIO_FILE_FORMAT = 'theatre-daw-project'
export const STUDIO_FILE_VERSION = 1

export interface StudioFile {
  format: typeof STUDIO_FILE_FORMAT
  formatVersion: number
  exportedAt: string
  name: string
  /** Seconds, for listings. */
  length: number
  studio: {
    masterVolume: number
    tracks: Record<string, unknown>
    regions: Record<string, unknown>
    sections: Record<string, unknown>
  }
}

const strip = <T extends { id?: string }>(record: Record<string, T>) =>
  Object.fromEntries(Object.entries(record).map(([id, { id: _id, ...rest }]) => [id, rest]))

export function buildStudioFile(studio: StudioProject): StudioFile {
  return {
    format: STUDIO_FILE_FORMAT,
    formatVersion: STUDIO_FILE_VERSION,
    exportedAt: new Date().toISOString(),
    name: studio.name,
    length: Math.round(projectLength(studio) * 1000) / 1000,
    studio: {
      masterVolume: studio.masterVolume,
      tracks: strip(studio.tracks),
      regions: strip(studio.regions),
      sections: strip(studio.sections),
    },
  }
}

const fileName = (name: string) => `${name.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) || 'studio'}.daw.json`

export function downloadStudioFile(studio: StudioProject) {
  const blob = new Blob([JSON.stringify(buildStudioFile(studio), null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName(studio.name)
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** RTDB keys can't hold . # $ [ ] / — anything else from a file is fine. */
const badKey = (o: unknown): string | null => {
  if (!o || typeof o !== 'object') return null
  for (const [k, v] of Object.entries(o)) {
    if (!k || /[.#$[\]/]/.test(k)) return k
    const inner = badKey(v)
    if (inner !== null) return inner
  }
  return null
}

/** Validate a DAW project file; throws a readable error for anything else. */
export function parseStudioFile(text: string): StudioFile {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('檔案不是有效的 JSON')
  }
  const f = raw as Omit<Partial<StudioFile>, 'format'> & { format?: unknown }
  if (!f || typeof f !== 'object' || f.format !== STUDIO_FILE_FORMAT) {
    if (f && typeof f === 'object' && f.format === 'theatre-cue-project') throw new Error('這是 Set Cue 專案檔，請在大廳或 Set Cue 頁面「匯入專案」')
    if (f && typeof f === 'object' && f.format === 'theatre-cue-bundle') throw new Error('這是含 Set Cue 母專案的完整專案包，請在大廳或 Set Cue 頁面「匯入專案」')
    throw new Error('這不是 DAW Studio 專案檔（.daw.json）')
  }
  if (Number(f.formatVersion) > STUDIO_FILE_VERSION) throw new Error('此檔案來自較新版本的程式，請先更新')
  if (!f.studio || typeof f.studio !== 'object' || typeof f.studio.tracks !== 'object') throw new Error('專案檔缺少音軌資料')
  const bad = badKey(f.studio)
  if (bad !== null) throw new Error(`專案檔含有無法儲存的欄位名稱「${bad}」`)
  // Normalizing drops anything malformed (and regions on tracks that don't exist).
  const clean = normalizeStudio('import', { ...f.studio, name: String(f.name ?? '匯入的專案') } as Parameters<typeof normalizeStudio>[1])
  return {
    format: STUDIO_FILE_FORMAT,
    formatVersion: STUDIO_FILE_VERSION,
    exportedAt: typeof f.exportedAt === 'string' ? f.exportedAt : new Date().toISOString(),
    name: clean.name,
    length: projectLength(clean),
    studio: { masterVolume: clean.masterVolume, tracks: strip(clean.tracks), regions: strip(clean.regions), sections: strip(clean.sections) },
  }
}

/** A name not used by another studio: "名稱", "名稱（2）"… */
export function uniqueStudioName(name: string, taken: string[]) {
  const used = new Set(taken)
  if (!used.has(name)) return name
  for (let n = 2; ; n++) if (!used.has(`${name}（${n}）`)) return `${name}（${n}）`
}

/** Create a new studio in this show from a file (import, Save As). Resolves to its id. */
export async function createStudioFromFile(projectId: string, file: StudioFile, name: string, label: string): Promise<string> {
  const id = push(ref(db, studioPath(projectId))).key!
  const now = Date.now()
  await recordedUpdate({
    label,
    group: 'studio',
    updates: {
      [studioPath(projectId, id)]: { name, createdAt: now, updatedAt: now, length: file.length, masterVolume: file.studio.masterVolume, tracks: file.studio.tracks, regions: file.studio.regions, sections: file.studio.sections },
    },
  })
  return id
}

/** Save As: an independent copy of a studio under a new name. */
export const duplicateStudio = (projectId: string, studio: StudioProject, name: string) => createStudioFromFile(projectId, buildStudioFile(studio), name, `另存為「${name}」`)

/* ---------- cloud ---------- */

/*
 * Where DAW project files live on R2:
 *  - this show's studios: auto-saved to theatre/projects/{show}/{studio}.json (see r2Manage.ts);
 *  - the Default shared library, offered in every show: published copies in theatre/daw/Default,
 *    indexed in Firebase (sharedStudioFiles/default);
 *  - legacy: copies saved with the old "儲存到此演出雲端" button in theatre/daw/{show}/projects,
 *    indexed in projects/{pid}/studioFiles. Still listed so they can be imported or deleted.
 */

export interface CloudStudioFile {
  id: string
  name: string
  url: string
  publicId: string
  length: number
  tracks: number
  regions: number
  bytes: number
  createdAt: number
  /** Listed straight from the R2 folder (not in the index). */
  fromListing?: boolean
  /** Which show published it (Default files). */
  fromShow?: string
  storage?: StorageBackend
}

const legacyIndexPath = (projectId: string) => `projects/${projectId}/studioFiles`

/** Publish a copy of the studio to the Default shared library (every show can open it). */
export async function publishToDefault({ projectName, studio }: { projectName: string; studio: StudioProject }) {
  if (!isAdmin(currentUser())) throw new Error('Default 共用資料夾只有管理員可以發佈')
  const file = buildStudioFile(studio)
  const text = JSON.stringify(file)
  const blob = new File([text], fileName(studio.name), { type: 'application/json' })
  const result = await uploadStudioFile(blob, { folder: STUDIO_DEFAULT_FOLDER, name: fileName(studio.name) })
  const entry = {
    name: studio.name,
    url: result.secure_url,
    publicId: result.public_id,
    length: file.length,
    tracks: Object.keys(file.studio.tracks).length,
    regions: Object.keys(file.studio.regions).length,
    bytes: result.bytes ?? text.length,
    createdAt: Date.now(),
    fromShow: projectName,
    storage: result.storage,
  }
  await set(push(ref(db, SHARED_STUDIO_FILES_PATH)), entry)
  return entry
}

/** Take a file off the Default list (the R2 file stays). */
export const unlistDefaultFile = (id: string) => remove(ref(db, `${SHARED_STUDIO_FILES_PATH}/${id}`))

/** Permanently delete a legacy show file: the R2 object and its index entry. */
export async function deleteLegacyShowFile(projectId: string, file: CloudStudioFile) {
  await deleteR2([file.publicId])
  if (!file.fromListing) await remove(ref(db, `${legacyIndexPath(projectId)}/${file.id}`))
}

export type CloudListing = { status: 'loading' } | { status: 'off' } | { status: 'ok'; count: number } | { status: 'error'; message: string }

/** Files in an R2 folder merged with their Firebase index (R2 entries only). */
function useIndexedFolder(folder: string, indexPath: string) {
  const [indexed, setIndexed] = useState<CloudStudioFile[] | null>(null)
  const [r2Listed, setR2Listed] = useState<CloudStudioFile[]>([])
  const [r2, setR2] = useState<CloudListing>({ status: 'loading' })
  const [nonce, setNonce] = useState(0)

  useEffect(
    () =>
      onValue(
        ref(db, indexPath),
        (snap) =>
          setIndexed(
            Object.entries((snap.val() ?? {}) as Record<string, Omit<CloudStudioFile, 'id'>>)
              .map(([id, f]) => ({ ...f, id }))
              .filter((f) => f.storage === 'r2'),
          ),
        () => setIndexed([]),
      ),
    [indexPath],
  )
  // R2 lists the folder itself: every project file there shows up, indexed or not.
  useEffect(() => {
    let cancelled = false
    listR2(folder, 'raw')
      .then((items) => {
        if (cancelled) return
        if (items === null) return setR2({ status: 'off' })
        setR2Listed(
          items.map((o) => ({
            id: `r2:${o.key}`,
            name: objectName(o.key).replace(/(\.daw)?\.json$/i, ''),
            url: o.url,
            publicId: o.key,
            length: 0,
            tracks: 0,
            regions: 0,
            bytes: o.size,
            createdAt: o.lastModified,
            fromListing: true,
            storage: 'r2',
          })),
        )
        setR2({ status: 'ok', count: items.length })
      })
      .catch((err) => !cancelled && setR2({ status: 'error', message: (err as Error).message }))
    return () => {
      cancelled = true
    }
  }, [folder, nonce])

  // Only files that really exist on R2 (the index can outlive a deleted file).
  const files =
    indexed === null || r2.status === 'loading'
      ? null
      : (() => {
          const onR2 = new Set(r2Listed.map((f) => f.publicId))
          const kept = r2.status === 'ok' ? indexed.filter((f) => onR2.has(f.publicId)) : indexed
          const seen = new Set(kept.map((f) => f.publicId))
          return [...kept, ...r2Listed.filter((f) => !seen.has(f.publicId))].sort((a, b) => b.createdAt - a.createdAt)
        })()
  return { files, r2, folder, reload: () => setNonce((n) => n + 1) }
}

/** The Default shared library of project files. */
export const useDefaultStudioFiles = () => useIndexedFolder(STUDIO_DEFAULT_FOLDER, SHARED_STUDIO_FILES_PATH)

/** Project files saved with the old "儲存到此演出雲端" button (theatre/daw/{show}/projects). */
export const useLegacyShowFiles = (projectId: string, projectName: string) => useIndexedFolder(studioFilesFolder(projectName, projectId), legacyIndexPath(projectId))

/** Download a published project file and validate it. */
export async function fetchStudioFile(url: string): Promise<StudioFile> {
  let res: Response
  try {
    res = await fetch(url)
  } catch {
    throw new Error('無法下載專案檔（網路或 CORS 問題）')
  }
  if (!res.ok) throw new Error(`無法下載專案檔（HTTP ${res.status}）`)
  return parseStudioFile(await res.text())
}
