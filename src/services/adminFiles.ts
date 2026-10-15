import { get, push, ref, serverTimestamp, set, update } from 'firebase/database'
import { DEFAULT_MEDIA_FOLDER, SHARED_MEDIA_PATH, SHARED_STUDIO_FILES_PATH, cleanProjectName, projectMediaPath, type ProjectSummary } from '../types/project'
import { isAdmin, type AppUser } from './auth'
import { fileTypeOf, logFileActivity, projectOfRecord } from './fileActivity'
import { db } from './firebase'
import { toSummary } from './projects'
import { deleteR2, importToR2, listR2, r2KeyOf, type R2Object } from './storage'

/*
 * The admin "全域資源與資料夾管理" center: every folder and file of the app, across projects.
 *
 *   Folders   Default (shared theatre/cues|daw|hits/Default), one per project (its storage folders,
 *             named after the project; its R2 project files), and storage folders that belong to no
 *             project ("未歸屬").
 *   Files     R2 objects (audio / video / images, project and config files) plus library entries
 *             that point at Cloudinary. Each knows which projects use it.
 *   Labels    a display name and tags per file, at mediaTags/{id} (and copied into the library
 *             entries' names, so file pickers show the new name). Renaming never changes a file's
 *             address, so nothing that uses it breaks.
 *   Moving    copies the object to the new folder, rewrites every reference in the database (cues,
 *             hits, studio regions, library entries) to the new address, then deletes the old one.
 */

export type FileKind = 'audio' | 'video' | 'image' | 'project' | 'config'

export interface ManagedFile {
  /** R2 key, or the Cloudinary URL for library entries that aren't on R2. */
  id: string
  key: string | null
  url: string
  /** File name in storage. */
  name: string
  /** Display name (label) if set. */
  label: string
  tags: string[]
  size: number
  lastModified: number
  kind: FileKind
  /** theatre/cues | theatre/hits | theatre/daw | theatre/projects | theatre/setcue-projects | theatre/public | cloudinary */
  area: string
  /** Folder of the file, e.g. theatre/cues/Default. */
  folder: string
  storage: 'r2' | 'cloudinary'
  /** Names of the projects whose data refer to this file. */
  usedBy: string[]
  /** Database paths of library entries for this file (sharedMedia / projects/{pid}/media / sharedStudioFiles). */
  indexPaths: string[]
}

export interface StudioSummaryRow {
  id: string
  name: string
  updatedAt: number
  tracks: number
  regions: number
}

export interface FolderNode {
  id: string
  label: string
  /** standalone: a Studio project with no Set Cue parent; audience: the Cloudinary audience space. */
  group: 'default' | 'template' | 'project' | 'archived' | 'standalone' | 'audience' | 'orphan'
  project?: ProjectSummary
  /** The project's studios (child Studio projects). */
  studios: StudioSummaryRow[]
  /** Storage folder prefixes that belong here (theatre/cues/<name>, …). */
  prefixes: string[]
  files: ManagedFile[]
}

export interface GlobalState {
  folders: FolderNode[]
  /** Default library entries still pointing at Cloudinary (to migrate to R2). */
  defaultOnCloudinary: number
  projects: ProjectSummary[]
  /** Destination folders for moves, by area: theatre/cues/<seg> etc. */
  destinations: { prefix: string; label: string }[]
}

const AREAS = ['theatre/cues', 'theatre/hits', 'theatre/daw'] as const
/** Database-safe id of a file (its key or URL, base64url). */
export const tagId = (fileId: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(fileId)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

function kindOf(name: string, contentType = ''): FileKind {
  const t = contentType || ''
  if (t.startsWith('audio/') || /\.(wav|mp3|m4a|aac|ogg|flac|webm)$/i.test(name)) return 'audio'
  if (t.startsWith('video/') || /\.(mp4|mov|m4v)$/i.test(name)) return 'video'
  if (t.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg)$/i.test(name)) return 'image'
  if (/\.json$/i.test(name)) return 'project'
  return 'config'
}

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object'

/** Every string in a tree with its path (for usage and reference rewriting). */
function walkStrings(value: unknown, path: string, out: (path: string, s: string) => void) {
  if (typeof value === 'string') out(path, value)
  else if (isObj(value)) for (const [k, v] of Object.entries(value)) walkStrings(v, `${path}/${k}`, out)
}

/** Load everything (admins only). */
export async function loadGlobal(user: AppUser | null): Promise<GlobalState> {
  if (!isAdmin(user)) throw new Error('只有管理員可以使用全域資源管理')
  const [indexSnap, dataSnap, sharedSnap, studioFilesSnap, tagsSnap, audienceSnap, ...lists] = await Promise.all([
    get(ref(db, 'projectIndex')),
    get(ref(db, 'projects')),
    get(ref(db, SHARED_MEDIA_PATH)),
    get(ref(db, SHARED_STUDIO_FILES_PATH)),
    get(ref(db, 'mediaTags')),
    get(ref(db, 'audienceMedia')),
    ...AREAS.map((a) => listR2(`${a}/`, 'media')),
    listR2('theatre/daw/', 'raw'),
    listR2('theatre/projects/', 'raw'),
    listR2('theatre/setcue-projects/', 'raw'),
    listR2('theatre/public/', 'media'),
  ])
  if (lists.every((l) => l === null)) throw new Error('伺服器尚未設定 Cloudflare R2')
  const r2: R2Object[] = lists.flatMap((l) => l ?? [])
  const index = (indexSnap.val() ?? {}) as Record<string, Json>
  const projects = Object.entries(index).map(([id, p]) => toSummary(id, p as Parameters<typeof toSummary>[1]))
  const byId = new Map(projects.map((p) => [p.id, p]))
  const data = (dataSnap.val() ?? {}) as Record<string, Json>
  const tags = (tagsSnap.val() ?? {}) as Record<string, { label?: string; tags?: string[] }>

  // Who uses what: every string in every project that is (or contains) a file address.
  const usage = new Map<string, Set<string>>()
  const note = (url: string, pid: string) => {
    const k = r2KeyOf(url) ?? url
    if (!usage.has(k)) usage.set(k, new Set())
    usage.get(k)!.add(pid)
  }
  for (const [pid, project] of Object.entries(data)) walkStrings(project, '', (path, s) => {
    if (path.includes('/media/') || path.includes('/uploads/')) return // library / upload records aren't uses
    if (s.startsWith('/api/r2/o/') || s.startsWith('https://res.cloudinary.com/')) note(s, pid)
  })

  // Library entries (index) per file.
  const indexPaths = new Map<string, string[]>()
  const libraryEntries: { path: string; entry: Json }[] = []
  const addIndex = (path: string, entry: Json) => {
    const url = typeof entry.url === 'string' ? entry.url : ''
    if (!url) return
    const k = r2KeyOf(url) ?? url
    indexPaths.set(k, [...(indexPaths.get(k) ?? []), path])
    libraryEntries.push({ path, entry })
  }
  for (const [id, e] of Object.entries((sharedSnap.val() ?? {}) as Record<string, Json>)) addIndex(`${SHARED_MEDIA_PATH}/${id}`, e)
  for (const [id, e] of Object.entries((studioFilesSnap.val() ?? {}) as Record<string, Json>)) addIndex(`${SHARED_STUDIO_FILES_PATH}/${id}`, e)
  for (const [pid, project] of Object.entries(data)) for (const [id, e] of Object.entries(isObj(project.media) ? (project.media as Record<string, Json>) : {})) addIndex(`${projectMediaPath(pid)}/${id}`, e)

  const names = (ids: Set<string> | undefined) => [...(ids ?? [])].map((pid) => byId.get(pid)?.name ?? '（已刪除的專案）')
  const fileOf = (o: R2Object): ManagedFile => {
    const area = /^theatre\/[^/]+/.exec(o.key)?.[0] ?? 'theatre'
    const t = tags[tagId(o.key)]
    return {
      id: o.key,
      key: o.key,
      url: o.url,
      name: o.name,
      label: t?.label ?? '',
      tags: t?.tags ?? [],
      size: o.size,
      lastModified: o.lastModified,
      kind: kindOf(o.name, o.contentType),
      area,
      folder: o.key.slice(0, o.key.lastIndexOf('/')),
      storage: 'r2',
      usedBy: names(usage.get(o.key)),
      indexPaths: indexPaths.get(o.key) ?? [],
    }
  }
  const files: ManagedFile[] = [...new Map(r2.map((o) => [o.key, fileOf(o)])).values()]
  // Library entries that point at Cloudinary (not on R2).
  let defaultOnCloudinary = 0
  for (const { path, entry } of libraryEntries) {
    const url = String(entry.url)
    if (r2KeyOf(url) || files.some((f) => f.id === url)) continue
    // The Default folder is R2-only: Cloudinary entries left from before wait for the migration.
    if (path.startsWith(SHARED_MEDIA_PATH) || path.startsWith(SHARED_STUDIO_FILES_PATH)) {
      defaultOnCloudinary++
      continue
    }
    const t = tags[tagId(url)]
    files.push({
      id: url,
      key: null,
      url,
      name: String(entry.name ?? url.split('/').pop()),
      label: t?.label ?? '',
      tags: t?.tags ?? [],
      size: Number(entry.bytes) || 0,
      lastModified: Number(entry.createdAt) || 0,
      kind: (entry.kind as FileKind) ?? kindOf(url),
      area: 'cloudinary',
      folder: String(entry.folder ?? ''),
      storage: 'cloudinary',
      usedBy: names(usage.get(url)),
      indexPaths: indexPaths.get(url) ?? [path],
    })
  }

  // Folders.
  const folderOfProject = new Map(projects.map((p) => [cleanProjectName(p.name, p.id), p]))
  const nodes = new Map<string, FolderNode>()
  const node = (id: string, make: () => FolderNode) => nodes.get(id) ?? (nodes.set(id, make()), nodes.get(id)!)
  const groupOf = (p: ProjectSummary): FolderNode['group'] => (p.isMasterTemplate ? 'template' : p.isArchived ? 'archived' : p.kind === 'studio' ? 'standalone' : 'project')
  const studiosOf = (pid: string): StudioSummaryRow[] =>
    Object.entries(isObj(data[pid]?.studio) ? (data[pid].studio as Record<string, Json>) : {})
      .map(([id, st]) => ({
        id,
        name: String(st.name ?? 'Studio'),
        updatedAt: Number(st.updatedAt) || 0,
        tracks: Object.keys(isObj(st.tracks) ? st.tracks : {}).length,
        regions: Object.keys(isObj(st.regions) ? st.regions : {}).length,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'))
  const projectNode = (p: ProjectSummary) => {
    const seg = cleanProjectName(p.name, p.id)
    return node(`project:${p.id}`, () => ({ id: `project:${p.id}`, label: p.name, group: groupOf(p), project: p, studios: studiosOf(p.id), prefixes: AREAS.map((a) => `${a}/${seg}`), files: [] }))
  }
  const defaultNode = node('default', () => ({ id: 'default', label: 'Default 共用資料夾', group: 'default', studios: [], prefixes: AREAS.map((a) => `${a}/Default`), files: [] }))
  for (const p of projects) projectNode(p)
  for (const f of files) {
    let target: FolderNode
    const pidKey = /^theatre\/(?:projects|public)\/([\w-]+)\//.exec(f.id)?.[1] ?? /^theatre\/setcue-projects\/([\w-]+)\.json$/.exec(f.id)?.[1]
    const seg = /^theatre\/(?:cues|hits|daw)\/([^/]+)\//.exec(f.id)?.[1]
    if (pidKey) target = byId.get(pidKey) ? projectNode(byId.get(pidKey)!) : node(`orphan:${pidKey}`, () => ({ id: `orphan:${pidKey}`, label: `已刪除專案 ${pidKey}`, group: 'orphan', studios: [], prefixes: [], files: [] }))
    else if (seg === 'Default') target = defaultNode
    else if (seg && folderOfProject.has(seg)) target = projectNode(folderOfProject.get(seg)!)
    else if (seg) target = node(`orphan:${seg}`, () => ({ id: `orphan:${seg}`, label: seg, group: 'orphan', studios: [], prefixes: AREAS.map((a) => `${a}/${seg}`), files: [] }))
    else if (f.storage === 'cloudinary') {
      // Cloudinary library entry: its folder decides (theatre/cues/Default, theatre/cues/<project>…).
      const cseg = /^theatre\/(?:cues|hits|daw)\/([^/]+)/.exec(f.folder)?.[1]
      target = cseg === 'Default' || f.indexPaths.some((p) => p.startsWith(SHARED_MEDIA_PATH)) ? defaultNode : cseg && folderOfProject.has(cseg) ? projectNode(folderOfProject.get(cseg)!) : defaultNode
    } else target = defaultNode
    target.files.push(f)
  }
  // The Cloudinary audience space: every project's audience uploads (audienceMedia).
  const audience = node('audience', () => ({ id: 'audience', label: '觀眾互動（Cloudinary）', group: 'audience', studios: [], prefixes: [], files: [] }))
  for (const [id, u] of Object.entries((audienceSnap.val() ?? {}) as Record<string, Json>)) {
    const url = String(u.url ?? '')
    if (!url) continue
    const t = tags[tagId(url)]
    const pname = byId.get(String(u.projectId))?.name ?? String(u.projectName ?? '（已刪除的專案）')
    audience.files.push({
      id: url,
      key: null,
      url,
      name: `${u.kind === 'image' ? '觀眾照片' : u.kind === 'audio' ? '觀眾錄音' : '觀眾影片'} ${id.slice(-6)}`,
      label: t?.label ?? '',
      tags: [...(t?.tags ?? []), pname, ...(u.moderation && u.moderation !== 'approved' ? [String(u.moderation)] : []), ...(u.hidden ? ['已隱藏'] : [])],
      size: 0,
      lastModified: Number(u.createdAt) || 0,
      kind: (u.kind as FileKind) ?? 'image',
      area: 'cloudinary',
      folder: `觀眾上傳 · ${pname}`,
      storage: 'cloudinary',
      usedBy: names(usage.get(url)),
      indexPaths: [],
    })
  }
  for (const n of nodes.values()) n.files.sort((a, b) => b.lastModified - a.lastModified)
  const order = { default: 0, template: 1, project: 2, standalone: 3, archived: 4, audience: 5, orphan: 6 }
  const folders = [...nodes.values()].sort((a, b) => order[a.group] - order[b.group] || Number(!!b.project?.isPinned) - Number(!!a.project?.isPinned) || a.label.localeCompare(b.label, 'zh-Hant'))
  const destinations = folders.flatMap((n) => n.prefixes.map((prefix) => ({ prefix, label: `${n.group === 'default' ? 'Default 共用' : n.label} · ${prefix.split('/')[1]}` })))
  return { folders, projects, destinations, defaultOnCloudinary }
}

/**
 * Admins: move the Default library's remaining Cloudinary files to R2 (theatre/cues/Default):
 * copy each file, point its library entry at the copy, and rewrite every project reference to it.
 * The Cloudinary originals are left in place. `only`: entry ids to migrate (default: all).
 */
export async function migrateDefaultToR2(user: AppUser | null, only?: string[]) {
  if (!isAdmin(user)) throw new Error('只有管理員可以遷移 Default 資料夾')
  const shared = ((await get(ref(db, SHARED_MEDIA_PATH))).val() ?? {}) as Record<string, Json>
  let moved = 0
  let refs = 0
  const failed: string[] = []
  for (const [id, e] of Object.entries(shared)) {
    const url = String(e.url ?? '')
    if (only && !only.includes(id)) continue
    if (!url.startsWith('https://res.cloudinary.com/') || e.storage === 'r2') continue
    try {
      const name = String(e.name ?? url.split('/').pop() ?? 'file')
      const copy = await importToR2(url, { folder: DEFAULT_MEDIA_FOLDER, name })
      await update(ref(db, `${SHARED_MEDIA_PATH}/${id}`), { url: copy.secure_url, publicId: copy.public_id, folder: DEFAULT_MEDIA_FOLDER, storage: 'r2', bytes: copy.bytes || Number(e.bytes) || 0, migratedFrom: url })
      refs += await rewriteReferences(url, copy.secure_url, null, null)
      moved++
    } catch (err) {
      failed.push(`${String(e.name ?? id)}：${(err as Error).message}`)
    }
  }
  return { moved, refs, failed }
}

/* ---------- file operations (admins) ---------- */

async function copyR2(from: string, to: string): Promise<{ url: string }> {
  const res = await fetch('/api/r2/copy', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from, to }) })
  const body = (await res.json().catch(() => null)) as { url?: string; error?: string } | null
  if (!res.ok || !body?.url) throw new Error(body?.error ?? `複製失敗（HTTP ${res.status}）`)
  return { url: body.url }
}

const r2UrlOf = (key: string) => `/api/r2/o/${key.split('/').map(encodeURIComponent).join('/')}`

/** Every database string equal to `fromUrl` (projects, libraries), rewritten to `toUrl`. */
async function rewriteReferences(fromUrl: string, toUrl: string, fromKey: string | null, toKey: string | null) {
  const roots = ['projects', SHARED_MEDIA_PATH, SHARED_STUDIO_FILES_PATH]
  const snaps = await Promise.all(roots.map((r) => get(ref(db, r))))
  const updates: Record<string, string> = {}
  snaps.forEach((snap, i) =>
    walkStrings(snap.val(), roots[i], (path, s) => {
      if (path.endsWith('/migratedFrom')) return // a record of where a file came from, not a use
      const key = r2KeyOf(s)
      if (s === fromUrl || (fromKey && key === fromKey)) updates[path] = toUrl
      else if (fromKey && toKey && s === fromKey) updates[path] = toKey // publicId-style references
    }),
  )
  if (Object.keys(updates).length) await update(ref(db), updates)
  return Object.keys(updates).length
}

/** Move a file to another folder (same file name); references follow. Returns how many were rewritten. */
export async function moveFile(f: ManagedFile, destPrefix: string, existing: Set<string>): Promise<number> {
  if (!f.key) throw new Error('Cloudinary 上的檔案無法移動（只能指派或加標籤）')
  if (f.folder === destPrefix) return 0
  let to = `${destPrefix}/${f.name}`
  for (let i = 2; existing.has(to); i++) to = `${destPrefix}/${f.name.replace(/(\.[^.]+)?$/, `-${i}$1`)}`
  const { url } = await copyR2(f.key, to)
  const n = await rewriteReferences(f.url, url, f.key, to)
  // Library entries also store the folder.
  await Promise.all(f.indexPaths.map((p) => update(ref(db, p), { folder: destPrefix }).catch(() => {})))
  // Labels follow the file.
  const t = await get(ref(db, `mediaTags/${tagId(f.key)}`))
  if (t.exists()) await update(ref(db), { [`mediaTags/${tagId(to)}`]: t.val(), [`mediaTags/${tagId(f.key)}`]: null })
  await deleteR2([f.key])
  void logFileActivity({ ...logBase(f), action: 'move', name: f.label || f.name, url, key: to, from: f.folder, to: destPrefix })
  return n
}

/** Delete a file (R2) and its library entries. */
export async function deleteFile(f: ManagedFile) {
  if (f.key) await deleteR2([f.key])
  const updates: Record<string, null> = {}
  for (const p of f.indexPaths) updates[p] = null
  updates[`mediaTags/${tagId(f.id)}`] = null
  await update(ref(db), updates)
  void logFileActivity({ ...logBase(f), action: 'delete', name: f.label || f.name, from: f.folder, to: f.key ? '已刪除（含 R2 檔案）' : '只移除紀錄' })
}

/**
 * Display name and tags; library entries get the new name too (file pickers show it). `current`:
 * the name the file goes by now, when it's known better than its label (for the activity log).
 */
export async function setFileLabel(f: ManagedFile, label: string, tags: string[], current?: string) {
  const clean = label.trim().slice(0, 120)
  const cleanTags = [...new Set(tags.map((t) => t.trim()).filter(Boolean))].slice(0, 20)
  const updates: Record<string, unknown> = {
    [`mediaTags/${tagId(f.id)}`]: clean || cleanTags.length ? { label: clean || null, tags: cleanTags.length ? cleanTags : null, at: serverTimestamp() } : null,
  }
  if (clean) for (const p of f.indexPaths) updates[`${p}/name`] = clean
  await update(ref(db), updates)
  const before = current ?? (f.label || f.name)
  if (clean && clean !== before) void logFileActivity({ ...logBase(f), action: 'rename', name: clean, from: before, to: clean })
}

/**
 * Give a project a file: "link" adds it to the project's media library (same file); "copy" copies
 * it into the project's own folder first, so the project keeps it even if the original goes.
 */
export async function assignFile(f: ManagedFile, project: ProjectSummary, mode: 'link' | 'copy') {
  let url = f.url
  let key = f.key
  let folder = f.folder
  if (mode === 'copy') {
    if (!f.key) throw new Error('Cloudinary 上的檔案只能用「加入素材庫」指派')
    const area = AREAS.find((a) => f.key!.startsWith(`${a}/`)) ?? 'theatre/cues'
    folder = `${area}/${cleanProjectName(project.name, project.id)}`
    key = `${folder}/${f.name}`
    url = (await copyR2(f.key, key)).url
  }
  const kind = f.kind === 'project' || f.kind === 'config' ? 'audio' : f.kind
  await set(push(ref(db, projectMediaPath(project.id))), {
    kind,
    url,
    publicId: key ?? url,
    folder,
    name: f.label || f.name,
    duration: 0,
    bytes: f.size,
    source: 'link',
    storage: f.storage,
    createdAt: serverTimestamp(),
  })
  void logFileActivity({ ...logBase(f), action: 'assign', name: f.label || f.name, url, key, projectId: project.id, projectName: project.name, from: f.folder, to: mode === 'copy' ? folder : `${project.name}（連結）` })
  return { url, key }
}

export const urlForKey = r2UrlOf

/** Log fields for a managed file: its type, address and the project it belongs to. */
function logBase(f: ManagedFile) {
  const record = f.indexPaths.find((p) => projectOfRecord(p)) ?? f.indexPaths[0] ?? null
  const projectId = record ? projectOfRecord(record) : null
  return {
    fileType: fileTypeOf(f.name, f.kind),
    storage: f.storage,
    url: f.url,
    key: f.key,
    record,
    projectId,
    projectName: projectId ? null : /\/Default$/.test(f.folder) ? 'Default 共用資源庫' : null,
  }
}
