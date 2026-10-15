import { get, push, ref, serverTimestamp, update } from 'firebase/database'
import { INITIAL_SHOW_STATE } from '../types/cue'
import { describeFirebaseError } from './projects'
import { db } from './firebase'
import { currentUser } from './auth'
import { newInviteToken, ownerOf } from './membership'

/**
 * Project export / import as JSON, in two shapes:
 *
 *  · Set Cue only (format theatre-cue-project): the lobby entry (name, versions) and the Set Cue
 *    part of projects/{pid} — every version's cue list, hits and script, control surfaces, global
 *    triggers, the media library index (without the Studio's entries) and the audience uploads.
 *  · Bundle (format theatre-cue-bundle): the same Set Cue part plus every Studio of the project
 *    (tracks, regions, automation curves, FX / processing, sections, master) and the Studio's media
 *    entries. Importing it rebuilds the Set Cue parent and all its Studios, re-linked to the new
 *    project (parentProjectId, owner, hub entries).
 *
 * Ids inside a project (versions, cues, widgets, triggers, studios, tracks) are kept, so references
 * between them (a cue playing a studio, a fader bound to a studio track) still hold. Media files
 * stay where they are (R2 / Cloudinary); files keep their URLs.
 *
 * Left out: live session state (playback, connected audience, trigger host, intercom, activity)
 * and published MP3 links (they belong to the original project; publish again from the Studio).
 * Older files (theatre-cue-project with a `studio` node inside) are read as bundles.
 */

export const PROJECT_FILE_FORMAT = 'theatre-cue-project'
export const BUNDLE_FILE_FORMAT = 'theatre-cue-bundle'
export const PROJECT_FILE_VERSION = 1

/** Per-version nodes that are live session state, not show data. */
const VERSION_RUNTIME = ['showState', 'presence', 'triggerHost'] as const
/** Project nodes that are live session state. */
const PROJECT_RUNTIME = ['intercom', 'studioPresence', 'activity'] as const
/** Project nodes that belong to the DAW Studio (it auto-saves and versions itself separately). */
const STUDIO_NODES = ['studio', 'studioFiles', 'studioPresets'] as const
/** Published Studio MP3s: links into the original project's public folder, never exported. */
const PUBLISH_NODES = ['published', 'publishedLive'] as const

type Json = Record<string, unknown>

export interface ProjectFile {
  format: typeof PROJECT_FILE_FORMAT | typeof BUNDLE_FILE_FORMAT
  formatVersion: number
  exportedAt: string
  project: {
    name: string
    createdAt: number
    updatedAt: number
    versions: Record<string, { name: string; createdAt: number; parentId: string | null }>
  }
  /** The Set Cue part of projects/{pid}, minus live session state. */
  data: Json
  /** Bundle only: projects/{pid}/studio/{sid} as stored (parentProjectId is re-set on import). */
  studios?: Record<string, Json>
  /** Bundle only: the Studio's media-library entries and its other project nodes. */
  studioData?: { media?: Record<string, Json>; studioFiles?: Json; studioPresets?: Json }
}

export type ExportMode = 'setcue' | 'bundle'
export const isBundle = (file: ProjectFile) => file.format === BUNDLE_FILE_FORMAT

export interface ProjectFileSummary {
  name: string
  exportedAt: string
  kind: ExportMode
  versions: number
  cues: number
  hits: number
  surfaces: number
  triggers: number
  media: number
  uploads: number
  studios: { id: string; name: string; tracks: number; regions: number }[]
}

const count = (v: unknown) => (v && typeof v === 'object' ? Object.keys(v).length : 0)
const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)

export function summarize(file: ProjectFile): ProjectFileSummary {
  const versions = isObject(file.data.versions) ? (file.data.versions as Record<string, Json>) : {}
  const sum = (key: string) => Object.values(versions).reduce((n, v) => n + count(v?.[key]), 0)
  return {
    name: file.project.name,
    exportedAt: file.exportedAt,
    kind: isBundle(file) ? 'bundle' : 'setcue',
    versions: count(file.project.versions),
    cues: sum('cueList'),
    hits: sum('hits'),
    surfaces: count(file.data.surfaces),
    triggers: count(file.data.triggers),
    media: count(file.data.media) + count(file.studioData?.media),
    uploads: count(file.data.uploads),
    studios: Object.entries(file.studios ?? {}).map(([id, st]) => ({ id, name: String(st.name ?? 'Studio'), tracks: count(st.tracks), regions: count(st.regions) })),
  }
}

/** Media-library entries that belong to Set Cue (not the Studio's recordings and imports). */
export const isSetCueMedia = (m: unknown) => !(isObject(m) && m.source === 'studio')

/** Split a project's data into its Set Cue part and its Studio part (both copies). */
function splitData(all: Json) {
  const data = structuredClone(all)
  const studios = (isObject(data.studio) ? data.studio : {}) as Record<string, Json>
  const studioData: NonNullable<ProjectFile['studioData']> = {}
  if (data.studioFiles != null) studioData.studioFiles = data.studioFiles as Json
  if (data.studioPresets != null) studioData.studioPresets = data.studioPresets as Json
  for (const key of STUDIO_NODES) delete data[key]
  if (isObject(data.media)) {
    const entries = Object.entries(data.media as Record<string, Json>)
    const own = Object.fromEntries(entries.filter(([, m]) => isSetCueMedia(m)))
    const studioMedia = Object.fromEntries(entries.filter(([, m]) => !isSetCueMedia(m)))
    if (Object.keys(own).length) data.media = own
    else delete data.media
    if (Object.keys(studioMedia).length) studioData.media = studioMedia
  }
  return { data, studios, studioData }
}

/* ---------- export ---------- */

export async function buildProjectFile(projectId: string): Promise<ProjectFile> {
  const [indexSnap, dataSnap] = await Promise.all([get(ref(db, `projectIndex/${projectId}`)), get(ref(db, `projects/${projectId}`))])
  const index = indexSnap.val() as ProjectFile['project'] | null
  if (!index) throw new Error('找不到這個專案')
  const data = structuredClone((dataSnap.val() ?? {}) as Json)
  for (const key of PROJECT_RUNTIME) delete data[key]
  if (isObject(data.versions)) for (const v of Object.values(data.versions)) if (isObject(v)) for (const key of VERSION_RUNTIME) delete v[key]

  return {
    format: PROJECT_FILE_FORMAT,
    formatVersion: PROJECT_FILE_VERSION,
    exportedAt: new Date().toISOString(),
    project: {
      name: index.name,
      createdAt: index.createdAt ?? 0,
      updatedAt: index.updatedAt ?? 0,
      versions: Object.fromEntries(
        Object.entries(index.versions ?? {}).map(([vid, v]) => [vid, { name: v.name, createdAt: v.createdAt ?? 0, parentId: v.parentId ?? null }]),
      ),
    },
    data,
  }
}

const fileSafe = (name: string) => name.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) || 'project'

/** The file for one export mode: Set Cue only, or the bundle with every Studio. */
export async function buildExport(projectId: string, mode: ExportMode): Promise<ProjectFile> {
  const file = await buildProjectFile(projectId)
  const { data, studios, studioData } = splitData(file.data)
  for (const key of PUBLISH_NODES) delete data[key]
  if (mode === 'setcue') return { ...file, format: PROJECT_FILE_FORMAT, data }
  const clean = Object.fromEntries(Object.entries(studios).map(([sid, st]) => {
    const { parentProjectId: _parent, ...rest } = st
    return [sid, rest]
  }))
  return { ...file, format: BUNDLE_FILE_FORMAT, data, studios: clean, studioData }
}

/**
 * Download a project: theatre-setcue_<name>_<date>.json (Set Cue only) or
 * theatre-bundle_<name>_<date>.json (with its Studios).
 */
export async function exportProject(projectId: string, mode: ExportMode = 'setcue'): Promise<ProjectFileSummary> {
  let file: ProjectFile
  try {
    file = await buildExport(projectId, mode)
  } catch (err) {
    throw new Error(`匯出失敗：${describeFirebaseError(err)}`)
  }
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `theatre-${mode === 'bundle' ? 'bundle' : 'setcue'}_${fileSafe(file.project.name)}_${new Date().toISOString().slice(0, 10)}.json`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return summarize(file)
}

/* ---------- import ---------- */

/** RTDB keys may not contain . # $ [ ] / (or be empty); a file with such keys can't be stored as-is. */
function badKey(value: unknown, depth = 0): string | null {
  if (depth > 32 || !value || typeof value !== 'object') return null
  for (const [key, child] of Object.entries(value)) {
    if (!key || /[.#$[\]/]/.test(key)) return key
    const found = badKey(child, depth + 1)
    if (found) return found
  }
  return null
}

/**
 * Validate an uploaded file (Set Cue only or bundle); throws a readable error for anything else.
 * An older export with Studios inside its data comes back as a bundle.
 */
export function parseProjectFile(text: string): ProjectFile {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('檔案不是有效的 JSON')
  }
  if (!isObject(raw) || (raw.format !== PROJECT_FILE_FORMAT && raw.format !== BUNDLE_FILE_FORMAT)) {
    if (isObject(raw) && Array.isArray(raw.widgets)) throw new Error('這是控台面板檔案，請在控台的「編輯面板 → 匯入面板 JSON」匯入')
    if (isObject(raw) && raw.format === 'theatre-daw-project') throw new Error('這是單一 Studio 專案檔（.daw.json），請在 Studio 頁面的「匯入專案檔」匯入')
    throw new Error('這不是 Theatre Cue 匯出的專案檔')
  }
  if (Number(raw.formatVersion) > PROJECT_FILE_VERSION) throw new Error('此檔案來自較新版本的程式，請先更新')
  const project = raw.project as ProjectFile['project'] | undefined
  if (!isObject(project) || typeof project.name !== 'string' || !isObject(project.versions) || count(project.versions) === 0) {
    throw new Error('專案檔缺少名稱或版本資料')
  }
  if (!isObject(raw.data)) throw new Error('專案檔缺少內容資料')
  if (raw.studios !== undefined && !isObject(raw.studios)) throw new Error('專案包的 Studio 資料格式不正確')
  if (raw.studioData !== undefined && !isObject(raw.studioData)) throw new Error('專案包的 Studio 資料格式不正確')
  const bad = badKey(raw.data) ?? badKey(project.versions) ?? badKey(raw.studios) ?? badKey(raw.studioData)
  if (bad !== null) throw new Error(`專案檔含有無法儲存的欄位名稱「${bad}」`)
  const file = raw as unknown as ProjectFile
  if (file.format === BUNDLE_FILE_FORMAT) {
    for (const [sid, st] of Object.entries(file.studios ?? {})) if (!isObject(st) || (st.tracks !== undefined && !isObject(st.tracks))) throw new Error(`專案包裡的 Studio「${sid}」資料不完整`)
    return { ...file, data: splitData(file.data).data }
  }
  // Older exports carried the Studios inside the project data: read them as a bundle.
  const { data, studios, studioData } = splitData(file.data)
  if (Object.keys(studios).length) {
    const clean = Object.fromEntries(Object.entries(studios).map(([sid, { parentProjectId: _parent, ...rest }]) => [sid, rest]))
    return { ...file, format: BUNDLE_FILE_FORMAT, data, studios: clean, studioData }
  }
  return { ...file, data: studioData.media ? { ...data, media: { ...(data.media as Json), ...studioData.media } } : data }
}

/** A name not already used in the lobby: "名稱", then "名稱（匯入）", "名稱（匯入 2）"… */
export function uniqueName(name: string, existing: string[]) {
  const taken = new Set(existing)
  if (!taken.has(name)) return name
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? `${name}（匯入）` : `${name}（匯入 ${n}）`
    if (!taken.has(candidate)) return candidate
  }
}

/**
 * Create a new project from a file in one atomic write. Ids inside the project (versions, cues,
 * widgets, triggers, studios) are kept, so every reference between them still holds; only the
 * project id is new. A bundle also brings back every Studio: parentProjectId points at the new
 * project, the importer owns each one, and they appear in the importer's Studio hub.
 * Written section by section (as members may), never the whole project node at once.
 * Resolves to the new project id and its newest version.
 */
export async function importProject(file: ProjectFile, name: string, keepId?: string): Promise<{ projectId: string; versionId: string; studios: number }> {
  const projectId = keepId ?? push(ref(db, 'projectIndex')).key!
  // The importer owns the new project (a restore keeps whatever the project had).
  const me = keepId ? null : currentUser()
  const now = serverTimestamp()
  const title = name.trim() || file.project.name
  const versions = file.project.versions
  const newest = Object.entries(versions).sort(([, a], [, b]) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0][0]
  const { data } = splitData(file.data)
  for (const key of PUBLISH_NODES) delete data[key]
  const base = `projects/${projectId}`
  const updates: Record<string, unknown> = {
    [`projectIndex/${projectId}`]: { name: title, createdAt: now, updatedAt: now, versions, ...(me ? { owner: ownerOf(me) } : {}) },
    ...(me ? { [`projectInvites/${projectId}`]: newInviteToken() } : {}),
    ...(me && !keepId ? { [`userProjects/${me.uid}/setcue_${projectId}`]: { kind: 'setcue', projectId, versionId: newest, name: title, role: 'owner', lastOpenedAt: now } } : {}),
  }
  // Every version starts stopped, as a freshly created one would.
  const versionData = isObject(data.versions) ? (data.versions as Record<string, Json>) : {}
  for (const vid of Object.keys(versions)) updates[`${base}/versions/${vid}`] = { ...(isObject(versionData[vid]) ? versionData[vid] : {}), showState: INITIAL_SHOW_STATE }
  delete data.versions
  const media = { ...(isObject(data.media) ? data.media : {}) }
  delete data.media
  // Audience uploads are written one by one (the rules grant them per item).
  for (const [id, u] of Object.entries(isObject(data.uploads) ? data.uploads : {})) updates[`${base}/uploads/${id}`] = u
  delete data.uploads
  for (const [key, value] of Object.entries(data)) if (value != null) updates[`${base}/${key}`] = value

  const studios = isBundle(file) ? (file.studios ?? {}) : {}
  if (isBundle(file)) {
    Object.assign(media, file.studioData?.media ?? {})
    if (file.studioData?.studioFiles != null) updates[`${base}/studioFiles`] = file.studioData.studioFiles
    if (file.studioData?.studioPresets != null) updates[`${base}/studioPresets`] = file.studioData.studioPresets
    for (const [sid, st] of Object.entries(studios)) {
      updates[`${base}/studio/${sid}`] = { ...st, parentProjectId: projectId }
      if (me) {
        updates[`studioMeta/${projectId}/${sid}/owner`] = ownerOf(me)
        updates[`userProjects/${me.uid}/studio_${projectId}_${sid}`] = { kind: 'studio', projectId, versionId: newest, studioId: sid, name: String(st.name ?? 'Studio'), role: 'owner', lastOpenedAt: now }
      }
    }
  }
  if (Object.keys(media).length) updates[`${base}/media`] = media

  try {
    await update(ref(db), updates)
  } catch (err) {
    throw new Error(`匯入失敗：${describeFirebaseError(err)}`)
  }
  return { projectId, versionId: newest, studios: Object.keys(studios).length }
}

/* ---------- R2 auto-save (Set Cue) ---------- */

/** The Set Cue part of a project as one JSON file, for theatre/setcue-projects/{pid}.json. */
export async function buildSetCueFile(projectId: string): Promise<ProjectFile & { projectId: string }> {
  const file = await buildProjectFile(projectId)
  for (const key of STUDIO_NODES) delete file.data[key]
  // The Studio's media entries version with the Studio: a recording there neither makes a Set Cue
  // version nor gets undone by restoring one.
  if (isObject(file.data.media)) {
    const media = Object.fromEntries(Object.entries(file.data.media).filter(([, m]) => isSetCueMedia(m)))
    if (Object.keys(media).length) file.data.media = media
    else delete file.data.media
  }
  // updatedAt moves with every edit anywhere in the show (including the DAW): not content.
  return { ...file, project: { ...file.project, updatedAt: 0 }, projectId }
}
