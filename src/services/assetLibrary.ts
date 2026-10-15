import { get, onValue, push, ref, serverTimestamp, set, update } from 'firebase/database'
import { useEffect, useState } from 'react'
import { SHARED_MEDIA_PATH, SHARED_STUDIO_FILES_PATH, cleanProjectName, projectMediaPath } from '../types/project'
import { isAdmin, type AppUser } from './auth'
import { db } from './firebase'
import { recordedUpdate } from './history'
import type { ProjectMedia } from './mediaLibrary'
import { refuseIfReadOnly } from './projectLock'
import { logFileActivity, projectOfRecord } from './fileActivity'
import { forgetDeletedKeys } from './mediaValidation'
import { deleteR2, r2KeyOf } from './storage'

/*
 * Organising a project's media library from the Studio 素材 panel — open to every member of the
 * project (read-only projects excepted):
 *
 *   projects/{pid}/media/{id}            name (display name), order, assetFolder (where it's filed)
 *   projects/{pid}/assetFolders/{fid}    custom folders: { name, order, createdAt }
 *
 * The tree: the project, then one folder per Studio of the project (named after it, live), each
 * with the standard folders 背景音樂 / 錄音 / 上傳 / 語音; custom folders sit beside the Studios.
 * The Studio and standard folders are derived, not stored — `assetFolder` names them:
 *   "studio:{sid}:{category}"   a standard folder of a Studio
 *   "studio:{sid}"              the Studio folder itself (e.g. mixdowns)
 *   "{fid}"                     a custom folder;  absent → the top level
 * New files are filed automatically into the Studio they were made in, by source: a Default file
 * added → 背景音樂, a recording → 錄音, a manual upload → 上傳, text-to-speech → 語音.
 *
 * Deleting an asset removes its record and, when nothing else uses the file, the file itself on
 * Cloudflare R2 — only files in this project's own folders; shared Default files stay (admins
 * manage those).
 */

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object'

export interface AssetFolder {
  id: string
  name: string
  order: number
  createdAt: number
}

const foldersPath = (projectId: string) => `projects/${projectId}/assetFolders`

/* ---------- Studio folders and automatic filing ---------- */

/** Where a new file comes from, for automatic filing. */
export type AssetCategory = 'bgm' | 'recording' | 'upload' | 'tts'

/** The standard folders inside every Studio folder, in display order. */
export const CATEGORY_FOLDERS: { id: AssetCategory; name: string }[] = [
  { id: 'bgm', name: '背景音樂' },
  { id: 'recording', name: '錄音' },
  { id: 'upload', name: '上傳' },
  { id: 'tts', name: '語音' },
]

/** Where a new file is filed: a Studio of the project, and (optionally) one of its standard folders. */
export interface AssetPlacement {
  studioId: string
  category: AssetCategory | null
}

export const studioFolderId = (studioId: string, category?: AssetCategory | null) => (category ? `studio:${studioId}:${category}` : `studio:${studioId}`)

/** "studio:{sid}[:{category}]" → its parts; null for custom folders / the top level. */
export function parseStudioFolder(id: string | null | undefined): { studioId: string; category: AssetCategory | null } | null {
  const m = /^studio:([^:]+)(?::(\w+))?$/.exec(id ?? '')
  if (!m) return null
  const category = CATEGORY_FOLDERS.some((c) => c.id === m[2]) ? (m[2] as AssetCategory) : null
  return { studioId: m[1], category }
}

/** The assetFolder value for a new file, if it has a placement. */
export const placementFolder = (p: AssetPlacement | null | undefined) => (p ? studioFolderId(p.studioId, p.category) : null)

/**
 * Add an existing file (e.g. from the shared Default folder) to this project's library, filed by
 * `placement` — so it shows up under that Studio (e.g. Q5 / 背景音樂):
 *   · already filed there → nothing to do;
 *   · the project lists it but unfiled (top level, or a folder from before Studio folders existed)
 *     → that record moves there;
 *   · otherwise (filed in another Studio, or in a folder someone chose) → a record of its own for
 *     this Studio, so each Studio lists the files it uses.
 * Without a placement, nothing happens when the project already lists the file.
 */
export async function linkProjectAsset(projectId: string, m: ProjectMedia, placement: AssetPlacement | null) {
  if (refuseIfReadOnly(projectId)) return
  const all = ((await get(ref(db, `projects/${projectId}/media`))).val() ?? {}) as Record<string, { url?: string; assetFolder?: string | null }>
  const existing = Object.entries(all).filter(([, e]) => e?.url === m.url)
  const assetFolder = placementFolder(placement)
  if (!assetFolder) {
    if (existing.length) return
  } else {
    if (existing.some(([, e]) => e.assetFolder === assetFolder)) return
    const loose = existing.find(([, e]) => !e.assetFolder || /^auto_/.test(e.assetFolder))
    if (loose) {
      await update(ref(db, `projects/${projectId}/media/${loose[0]}`), { assetFolder })
      void logFileActivity({ action: 'move', name: m.name, fileType: m.kind, storage: m.storage ?? 'r2', url: m.url, key: m.publicId, record: `projects/${projectId}/media/${loose[0]}`, projectId, studioId: placement?.studioId, from: '（未歸檔）', to: assetFolder })
      return
    }
  }
  const record = push(ref(db, `projects/${projectId}/media`))
  void logFileActivity({ action: 'link', name: m.name, fileType: m.kind, storage: m.storage ?? 'r2', url: m.url, key: m.publicId, record: `projects/${projectId}/media/${record.key}`, projectId, studioId: placement?.studioId, from: m.folder, to: assetFolder })
  await set(record, {
    kind: m.kind,
    url: m.url,
    publicId: m.publicId,
    folder: m.folder,
    name: m.name,
    duration: m.duration ?? 0,
    bytes: m.bytes ?? 0,
    source: 'studio',
    storage: m.storage ?? 'r2',
    createdAt: serverTimestamp(),
    ...(assetFolder ? { assetFolder } : {}),
  })
}

export function useAssetFolders(projectId: string) {
  const [folders, setFolders] = useState<AssetFolder[] | null>(null)
  useEffect(
    () =>
      onValue(
        ref(db, foldersPath(projectId)),
        (snap) =>
          setFolders(
            Object.entries((snap.val() ?? {}) as Record<string, Partial<AssetFolder>>)
              .map(([id, f]) => ({ id, name: String(f.name ?? '資料夾'), order: Number(f.order) || 0, createdAt: Number(f.createdAt) || 0 }))
              .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt),
          ),
        () => setFolders([]),
      ),
    [projectId],
  )
  return folders
}

/** Assets in display order: custom order first, then newest first. */
export const sortAssets = (list: ProjectMedia[]) => [...list].sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || b.createdAt - a.createdAt)

const cleanName = (name: string, what: string) => {
  const t = name.trim()
  if (!t) throw new Error(`${what}名稱不能是空白`)
  if (t.length > 120) throw new Error(`${what}名稱最多 120 個字`)
  return t
}

export async function createAssetFolder(projectId: string, name: string, order: number) {
  const id = push(ref(db, foldersPath(projectId))).key!
  await recordedUpdate({ label: `新增素材資料夾「${name.trim()}」`, group: 'studio', updates: { [`${foldersPath(projectId)}/${id}`]: { name: cleanName(name, '資料夾'), order, createdAt: Date.now() } } })
  return id
}

export const renameAssetFolder = (projectId: string, id: string, name: string) =>
  recordedUpdate({ label: `素材資料夾重新命名為「${name.trim()}」`, group: 'studio', updates: { [`${foldersPath(projectId)}/${id}/name`]: cleanName(name, '資料夾') } })

/** Remove a folder; its assets move back to the top level (nothing is deleted). */
export function deleteAssetFolder(projectId: string, folder: AssetFolder, assets: ProjectMedia[]) {
  const updates: Json = { [`${foldersPath(projectId)}/${folder.id}`]: null }
  for (const m of assets) if (m.assetFolder === folder.id) updates[`${projectMediaPath(projectId)}/${m.id}/assetFolder`] = null
  return recordedUpdate({ label: `刪除素材資料夾「${folder.name}」`, group: 'studio', updates })
}

/** Rename an asset's display name (the file on R2 keeps its key, so every reference still works). */
export async function renameAsset(base: string, id: string, name: string, label = '素材', asset?: ProjectMedia) {
  await recordedUpdate({ label: `${label}重新命名為「${name.trim()}」`, group: 'studio', updates: { [`${base}/${id}/name`]: cleanName(name, label) } })
  const record = `${base}/${id}`
  void logFileActivity({ action: 'rename', name: name.trim(), fileType: asset?.kind, storage: asset?.storage ?? null, url: asset?.url, key: asset?.publicId, record, projectId: projectOfRecord(record), from: asset?.name ?? null, to: name.trim() })
}

/**
 * Put `ids` (in this order) into a folder (null = top level): one undoable step that writes each
 * asset's folder and order.
 */
export function arrangeAssets(projectId: string, folder: string | null, ids: string[], label: string) {
  const updates: Json = {}
  ids.forEach((id, i) => {
    updates[`${projectMediaPath(projectId)}/${id}/order`] = i
    updates[`${projectMediaPath(projectId)}/${id}/assetFolder`] = folder
  })
  return recordedUpdate({ label, group: 'studio', updates })
}

/* ---------- delete ---------- */

const keyOf = (s: string) => r2KeyOf(s) ?? (/^theatre\/[^\s?#]+\.[a-z0-9]+$/i.test(s) ? s : null)

function walk(value: unknown, path: string, out: (path: string, s: string) => void) {
  if (typeof value === 'string') out(path, value)
  else if (isObj(value)) for (const [k, v] of Object.entries(value)) walk(v, `${path}/${k}`, out)
}

/**
 * A place that uses a file, described for people. `kind`:
 *   timeline — clips on a Studio timeline of this project (a force delete removes them: `regions`)
 *   library  — another record of this project's library pointing at the same file (never blocks)
 *   other    — a Cue, Hit, control panel, another project or the shared Default library (blocks;
 *              a force delete leaves those alone, so the file itself is kept)
 */
export interface AssetReference {
  where: string
  kind: 'timeline' | 'library' | 'other'
  /** timeline: database paths of the clips (projects/{pid}/studio/{sid}/regions/{rid}). */
  regions?: string[]
}

function describe(path: string, data: Json, projectName: string): { where: string; kind: AssetReference['kind'] } {
  const parts = path.split('/').filter(Boolean)
  const at = (...keys: string[]) => keys.reduce<unknown>((v, k) => (isObj(v) ? v[k] : undefined), data)
  const prefix = projectName ? `「${projectName}」` : ''
  const other = (where: string) => ({ where: `${prefix}${where}`, kind: 'other' as const })
  if (parts[0] === 'versions' && parts[2] === 'cueList') {
    const cue = at('versions', parts[1], 'cueList', parts[3]) as Json | undefined
    return other(`Cue ${cue?.cueNumber ?? ''}「${String(cue?.title ?? '')}」`)
  }
  if (parts[0] === 'versions' && parts[2] === 'hits') {
    const hit = at('versions', parts[1], 'hits', parts[3]) as Json | undefined
    return other(`Hit「${String(hit?.name ?? hit?.title ?? '')}」`)
  }
  if (parts[0] === 'studio') {
    const studio = at('studio', parts[1]) as Json | undefined
    const region = parts[2] === 'regions' ? (at('studio', parts[1], 'regions', parts[3]) as Json | undefined) : undefined
    const track = region ? (at('studio', parts[1], 'tracks', String(region.trackId)) as Json | undefined) : undefined
    const where = `Studio「${String(studio?.name ?? '')}」· 音軌「${String(track?.name ?? '未命名')}」`
    // Other projects' timelines are reported, not cleaned up.
    return projectName ? other(where) : { where, kind: region ? 'timeline' : 'other' }
  }
  if (parts[0] === 'media') return { where: `${prefix}素材庫的另一個項目`, kind: projectName ? 'other' : 'library' }
  if (parts[0] === 'surfaces') return other(`控制面板「${String((at('surfaces', parts[1]) as Json | undefined)?.name ?? '')}」`)
  return other(parts.slice(0, 2).join(' / '))
}

/** Everything a reference check reads, loaded once (a batch delete checks many files against it). */
interface ReferenceData {
  mine: Json | null
  shared: Json | null
  sharedStudio: Json | null
  /** Other projects — admins only (others can't read them). */
  others: [string, string, Json][]
}

async function loadReferenceData(projectId: string, user: AppUser | null): Promise<ReferenceData> {
  const [mine, shared, sharedStudio] = await Promise.all([
    get(ref(db, `projects/${projectId}`)).then((s) => s.val() as Json | null),
    get(ref(db, SHARED_MEDIA_PATH)).then((s) => s.val() as Json | null).catch(() => null),
    get(ref(db, SHARED_STUDIO_FILES_PATH)).then((s) => s.val() as Json | null).catch(() => null),
  ])
  const others: ReferenceData['others'] = []
  if (isAdmin(user)) {
    const [all, index] = await Promise.all([get(ref(db, 'projects')).then((s) => (s.val() ?? {}) as Record<string, Json>), get(ref(db, 'projectIndex')).then((s) => (s.val() ?? {}) as Record<string, Json>)])
    for (const [pid, data] of Object.entries(all)) if (pid !== projectId) others.push([pid, String(index[pid]?.name ?? pid), data])
  }
  return { mine, shared, sharedStudio, others }
}

/**
 * Where else a file is used: this project (cues, hits, studio regions, surfaces, other library
 * entries), the shared Default libraries, and — for admins — every other project. Library records
 * in `skip` (full paths, e.g. the ones being deleted together) don't count.
 */
function referencesIn(d: ReferenceData, projectId: string, asset: Pick<ProjectMedia, 'url' | 'publicId'>, skip: Set<string>): AssetReference[] {
  const key = keyOf(asset.url) ?? keyOf(asset.publicId ?? '')
  const matches = (s: string) => s === asset.url || (!!key && keyOf(s) === key)
  const found: AssetReference[] = []
  const add = (ref: { where: string; kind: AssetReference['kind'] }, region?: string) => {
    let f = found.find((x) => x.where === ref.where && x.kind === ref.kind)
    if (!f) found.push((f = { ...ref, ...(ref.kind === 'timeline' ? { regions: [] } : {}) }))
    if (region && f.regions && !f.regions.includes(region)) f.regions.push(region)
  }
  const scan = (data: unknown, projectName: string, skipMedia: (id: string) => boolean) =>
    walk(data, '', (path, s) => {
      if (!matches(s)) return
      const media = /^\/media\/([^/]+)/.exec(path)
      if (media && skipMedia(media[1])) return
      const ref = describe(path, (data ?? {}) as Json, projectName)
      const region = ref.kind === 'timeline' ? /^\/studio\/([^/]+)\/regions\/([^/]+)/.exec(path) : null
      add(ref, region ? `projects/${projectId}/studio/${region[1]}/regions/${region[2]}` : undefined)
    })
  scan(d.mine, '', (id) => skip.has(`${projectMediaPath(projectId)}/${id}`))
  for (const [id, e] of Object.entries(d.shared ?? {})) if (!skip.has(`${SHARED_MEDIA_PATH}/${id}`)) walk(e, '', (_p, s) => matches(s) && add({ where: 'Default 共用資源庫', kind: 'other' }))
  for (const e of Object.values(d.sharedStudio ?? {})) walk(e, '', (_p, s) => matches(s) && add({ where: 'Default Studio 專案檔', kind: 'other' }))
  for (const [, name, data] of d.others) scan(data, name, () => false)
  return found
}

/** Where else a file is used (see referencesIn); `skip` is the library record being deleted. */
export async function findAssetReferences(projectId: string, asset: Pick<ProjectMedia, 'url' | 'publicId'>, skip: string, user: AppUser | null): Promise<AssetReference[]> {
  return referencesIn(await loadReferenceData(projectId, user), projectId, asset, new Set([skip]))
}

/** This project's own R2 folders (theatre/{cues|hits|daw}/{folder}/…): the only files a delete here removes. */
const ownsKey = (key: string, projectName: string, projectId: string) => {
  const folder = cleanProjectName(projectName, projectId)
  return ['cues', 'hits', 'daw'].some((area) => key.startsWith(`theatre/${area}/${folder}/`))
}

/** What deleting one record does. */
export interface AssetDeletePlan {
  asset: ProjectMedia
  key: string | null
  refs: AssetReference[]
  /** Used on a timeline, in a Cue, … — a normal delete is refused; only a force delete goes ahead. */
  inUse: boolean
  /** Timeline clips a force delete removes. */
  clips: string[]
  /** Normal delete (not in use): the R2 file goes too. */
  willDeleteFile: boolean
  /** Force delete: the R2 file goes too (only timelines of this project used it). */
  forceDeletesFile: boolean
  /** Why the file stays, when it does (for the mode that applies). */
  kept: string | null
}

interface DeleteOpts {
  projectId: string
  projectName: string
  /** The index the records live in: projects/{pid}/media, or the shared Default index (admins). */
  base: string
  user: AppUser | null
}

/**
 * Plan deleting several records at once. A file in use (Studio timelines, Cues, Hits, control
 * panels, other projects, the Default library) blocks a normal delete. A force delete also removes
 * this project's timeline clips that use it, and the R2 file when nothing else does. Files go only
 * from this project's own folders (or, for an admin's Default delete, from Default).
 */
export async function planAssetDelete(opts: DeleteOpts & { assets: ProjectMedia[] }): Promise<AssetDeletePlan[]> {
  const { projectId, projectName, base, user, assets } = opts
  const shared = base === SHARED_MEDIA_PATH
  const data = await loadReferenceData(projectId, user)
  const skip = new Set(assets.map((a) => `${base}/${a.id}`))
  return assets.map((asset) => {
    const refs = referencesIn(data, projectId, asset, skip)
    const key = asset.storage === 'r2' ? keyOf(asset.url) ?? keyOf(asset.publicId ?? '') : null
    const own = !!key && (shared || ownsKey(key, projectName, projectId))
    const using = refs.filter((r) => r.kind !== 'library')
    const outside = refs.filter((r) => r.kind !== 'timeline')
    const clips = refs.flatMap((r) => r.regions ?? [])
    const kept = !key
      ? asset.storage === 'r2'
        ? null
        : '檔案在 Cloudinary（無法從這裡刪除）'
      : !own
        ? '檔案屬於其他資料夾（例如 Default 共用資料夾），只移除這個專案的紀錄'
        : outside.length
          ? `仍被使用：${outside.map((r) => r.where).join('、')}`
          : null
    return {
      asset,
      key,
      refs,
      inUse: using.length > 0,
      clips,
      willDeleteFile: !!key && own && refs.length === 0,
      forceDeletesFile: !!key && own && outside.length === 0,
      kept,
    }
  })
}

/**
 * Carry out a plan. Normal: records not in use only. `force`: every record, plus the timeline clips
 * that use them — all in one database write — then the R2 files that go.
 */
export async function executeAssetDelete(opts: DeleteOpts & { plan: AssetDeletePlan[]; force?: boolean }) {
  const { projectId, base, user, plan, force = false } = opts
  const shared = base === SHARED_MEDIA_PATH
  if (shared ? !isAdmin(user) : refuseIfReadOnly(projectId)) throw new Error(shared ? 'Default 共用素材只有管理員可以刪除' : '這個專案目前是唯讀')
  const items = force ? plan : plan.filter((p) => !p.inUse)
  const clips = force ? [...new Set(items.flatMap((p) => p.clips))] : []
  const updates: Json = Object.fromEntries(items.map((p) => [`${base}/${p.asset.id}`, null]))
  for (const c of clips) updates[c] = null
  if (Object.keys(updates).length) await update(ref(db), updates)
  for (const p of items) {
    const record = `${base}/${p.asset.id}`
    const fileGoes = force ? p.forceDeletesFile : p.willDeleteFile
    void logFileActivity({ action: 'delete', name: p.asset.name, fileType: p.asset.kind, storage: p.asset.storage ?? null, url: p.asset.url, key: p.key, record, projectId: projectOfRecord(record), projectName: shared ? 'Default 共用資源庫' : null, from: p.asset.assetFolder ?? p.asset.folder, to: fileGoes ? '已刪除（含 R2 檔案）' : '只移除紀錄（檔案保留）' })
  }
  const keys = [...new Set(items.filter((p) => (force ? p.forceDeletesFile : p.willDeleteFile) && p.key).map((p) => p.key!))]
  for (let i = 0; i < keys.length; i += 400) await deleteR2(keys.slice(i, i + 400))
  // Any other record of this project (or, for admins, the Default index) pointing at a deleted file.
  await forgetDeletedKeys(projectId, keys).catch(() => 0)
  return { records: items.length, files: keys.length, clips: clips.length, skipped: plan.length - items.length }
}
