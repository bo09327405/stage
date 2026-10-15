import { get, ref, update } from 'firebase/database'
import { SHARED_MEDIA_PATH } from '../types/project'
import { studioPath } from './studio'
import { db } from './firebase'
import { currentUser } from './auth'
import { deleteProject } from './projects'
import { importProject, parseProjectFile, type ProjectFile } from './projectTransfer'
import {
  DAW_AUDIO_PREFIX,
  DAW_PROJECTS_PREFIX,
  SETCUE_PROJECTS_PREFIX,
  deleteR2,
  listR2,
  objectName,
  r2KeyOf,
  readR2Json,
  type R2Object,
} from './storage'

/*
 * Managing what the two systems keep on R2: auto-saved DAW projects and studio audio
 * (theatre/projects/, theatre/daw/), and auto-saved Set Cue projects (theatre/setcue-projects/).
 *
 * Deleting is permanent, so audio is only deleted when nothing else uses it: every studio and cue
 * in Firebase, every other DAW project file on R2 and every published project file is checked.
 */

type Json = Record<string, unknown>
const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)

/** Every R2 object key referenced (as an /api/r2/o/… URL) anywhere inside a value. */
export function r2KeysIn(value: unknown, out = new Set<string>(), depth = 0): Set<string> {
  if (depth > 40) return out
  if (typeof value === 'string') {
    const key = r2KeyOf(value)
    if (key) out.add(key)
  } else if (value && typeof value === 'object') {
    for (const child of Object.values(value)) r2KeysIn(child, out, depth + 1)
  }
  return out
}

/* ---------- DAW Studio ---------- */

export interface DawCloudProject {
  key: string
  showId: string
  studioId: string
  name: string
  showName: string
  size: number
  lastModified: number
  tracks: number
  regions: number
  /** Studio audio its regions use. */
  audio: string[]
  /** The studio still exists in Firebase (open in the DAW). */
  live: boolean
  /** Versions kept in the file's embedded history. */
  versions: number
  /** When its content was last saved (falls back to the object's last-modified time). */
  savedAt: number
}

export interface DawAudio extends R2Object {
  /** Who uses it (labels), e.g. Studio「Scene 1」（318）. */
  usedBy: string[]
}

export interface DawCloud {
  projects: DawCloudProject[]
  audio: DawAudio[]
  /** Audio key → ids of what uses it ("studio:{show}/{studio}", "cue:{show}", "file:{key}"). */
  users: Map<string, Set<string>>
  labels: Map<string, string>
  /** Firebase projects/{pid}/media and the shared index, for removing dead library entries. */
  mediaIndex: { path: string; key: string }[]
}

interface DawFileJson {
  history?: unknown[]
  savedAt?: number
  name?: string
  show?: { id?: string; name?: string }
  studio?: { tracks?: Json; regions?: Json }
}

/**
 * Everything on R2 that the DAW uses. `projectIds`: the projects to look at (a member's own); null
 * = every project (admins). The server only lists files of projects the caller belongs to.
 */
export async function loadDawCloud(projectIds: string[] | null = null): Promise<DawCloud> {
  const readAll = async (): Promise<[Record<string, { name?: string }>, Record<string, Json>]> => {
    if (projectIds === null) {
      const [i, p] = await Promise.all([get(ref(db, 'projectIndex')), get(ref(db, 'projects'))])
      return [(i.val() ?? {}) as Record<string, { name?: string }>, (p.val() ?? {}) as Record<string, Json>]
    }
    const pairs = await Promise.all(
      projectIds.map(async (id) => {
        const [i, p] = await Promise.all([get(ref(db, `projectIndex/${id}`)).catch(() => null), get(ref(db, `projects/${id}`)).catch(() => null)])
        return [id, i?.val() as { name?: string } | null, p?.val() as Json | null] as const
      }),
    )
    return [Object.fromEntries(pairs.filter(([, i]) => i).map(([id, i]) => [id, i!])), Object.fromEntries(pairs.filter(([, , p]) => p).map(([id, , p]) => [id, p!]))]
  }
  const [projectFiles, audioFiles, publishedFiles, [index, fb], sharedSnap] = await Promise.all([
    listR2(DAW_PROJECTS_PREFIX, 'raw'),
    listR2(DAW_AUDIO_PREFIX, 'media'),
    listR2(DAW_AUDIO_PREFIX, 'raw'),
    readAll(),
    get(ref(db, SHARED_MEDIA_PATH)),
  ])
  if (projectFiles === null || audioFiles === null) throw new Error('伺服器尚未設定 Cloudflare R2')
  const showName = (id: string) => index[id]?.name ?? '（已刪除的演出）'

  const users = new Map<string, Set<string>>()
  const labels = new Map<string, string>()
  const track = (keys: Set<string>, id: string, label: string) => {
    labels.set(id, label)
    for (const k of keys) {
      if (!k.startsWith(DAW_AUDIO_PREFIX)) continue
      if (!users.has(k)) users.set(k, new Set())
      users.get(k)!.add(id)
    }
  }

  // Live data in Firebase: studios, cues and hits of every show.
  const mediaIndex: { path: string; key: string }[] = []
  for (const [pid, project] of Object.entries(fb)) {
    for (const [sid, studio] of Object.entries(isObject(project.studio) ? project.studio : {})) {
      track(r2KeysIn(isObject(studio) ? studio.regions : null), `studio:${pid}/${sid}`, `Studio「${(studio as Json)?.name ?? sid}」（${showName(pid)}）`)
    }
    for (const version of Object.values(isObject(project.versions) ? project.versions : {})) {
      if (!isObject(version)) continue
      track(r2KeysIn([version.cueList, version.hits]), `cue:${pid}`, `Set Cue（${showName(pid)}）`)
    }
    for (const [id, m] of Object.entries(isObject(project.media) ? project.media : {})) {
      const key = isObject(m) && typeof m.url === 'string' ? r2KeyOf(m.url) : null
      if (key) mediaIndex.push({ path: `projects/${pid}/media/${id}`, key })
    }
  }
  for (const [id, m] of Object.entries((sharedSnap.val() ?? {}) as Json)) {
    const key = isObject(m) && typeof m.url === 'string' ? r2KeyOf(m.url) : null
    if (key) mediaIndex.push({ path: `${SHARED_MEDIA_PATH}/${id}`, key })
  }

  // Auto-saved DAW projects.
  const projects = await Promise.all(
    projectFiles.map(async (o): Promise<DawCloudProject> => {
      const [showId = '', file = ''] = o.key.slice(DAW_PROJECTS_PREFIX.length).split('/')
      const studioId = file.replace(/\.json$/, '')
      const json = await readR2Json<DawFileJson>(o.key).catch(() => ({}) as DawFileJson)
      // Audio of the current version and of every version in its embedded history (restorable).
      const audio = [...r2KeysIn([json.studio?.regions, json.history])].filter((k) => k.startsWith(DAW_AUDIO_PREFIX))
      // The Firebase studio (if any) already counts; the file counts on its own once the studio is gone.
      const live = isObject(fb[showId]?.studio) && isObject((fb[showId].studio as Json)[studioId])
      track(new Set(audio), `studio:${showId}/${studioId}`, `Studio「${json.name ?? studioId}」（${index[showId]?.name ?? json.show?.name ?? showId}）`)
      return {
        key: o.key,
        showId,
        studioId,
        name: json.name ?? studioId,
        showName: index[showId]?.name ?? json.show?.name ?? '（已刪除的演出）',
        size: o.size,
        lastModified: o.lastModified,
        tracks: Object.keys(json.studio?.tracks ?? {}).length,
        regions: Object.keys(json.studio?.regions ?? {}).length,
        audio,
        live,
        versions: Array.isArray(json.history) ? json.history.length : 0,
        savedAt: json.savedAt ?? o.lastModified,
      }
    }),
  )

  // Published project files (theatre/daw/…/projects, theatre/daw/Default).
  await Promise.all(
    (publishedFiles ?? []).map(async (o) => {
      const json = await readR2Json<DawFileJson>(o.key).catch(() => null)
      if (json) track(r2KeysIn(json.studio?.regions), `file:${o.key}`, `專案檔「${objectName(o.key)}」`)
    }),
  )

  const audio = audioFiles.map((o) => ({ ...o, usedBy: [...(users.get(o.key) ?? [])].map((id) => labels.get(id) ?? id) }))
  return { projects: projects.sort((a, b) => b.lastModified - a.lastModified), audio: audio.sort((a, b) => b.lastModified - a.lastModified), users, labels, mediaIndex }
}

/** What deleting a DAW project removes: its file, plus audio nothing else uses. */
export function planDawDelete(cloud: DawCloud, project: DawCloudProject) {
  const self = `studio:${project.showId}/${project.studioId}`
  const exclusive = project.audio.filter((k) => [...(cloud.users.get(k) ?? [])].every((id) => id === self))
  const shared = project.audio.filter((k) => !exclusive.includes(k))
  return { exclusive, shared }
}

/** Remove library entries that point at deleted audio. */
async function dropMediaEntries(cloud: DawCloud, keys: string[]) {
  const gone = new Set(keys)
  const updates: Record<string, null> = {}
  for (const m of cloud.mediaIndex) if (gone.has(m.key)) updates[m.path] = null
  if (Object.keys(updates).length) await update(ref(db), updates)
}

/**
 * Permanently delete a DAW project: its R2 file, the audio only it uses, the studio in Firebase
 * (so auto-save doesn't write it back) and library entries for the deleted audio.
 */
export async function deleteDawProject(cloud: DawCloud, project: DawCloudProject) {
  const { exclusive, shared } = planDawDelete(cloud, project)
  const deleted = await deleteR2([project.key, ...exclusive])
  await update(ref(db), {
    [studioPath(project.showId, project.studioId)]: null,
    [`projects/${project.showId}/studioPresence/${project.studioId}`]: null,
  })
  await dropMediaEntries(cloud, exclusive)
  return { deleted: deleted.length, kept: shared.length }
}

/** Permanently delete one studio audio file (and its library entries). */
export async function deleteDawAudio(cloud: DawCloud, key: string) {
  await deleteR2([key])
  await dropMediaEntries(cloud, [key])
}

/* ---------- Set Cue ---------- */

export interface SetCueCloudProject {
  key: string
  projectId: string
  name: string
  size: number
  lastModified: number
  /** The project still exists in the lobby. */
  inSystem: boolean
}

export async function loadSetCueCloud(): Promise<SetCueCloudProject[]> {
  const [files, indexSnap] = await Promise.all([listR2(SETCUE_PROJECTS_PREFIX, 'raw'), get(ref(db, 'projectIndex'))])
  if (files === null) throw new Error('伺服器尚未設定 Cloudflare R2')
  const index = (indexSnap.val() ?? {}) as Record<string, { name?: string }>
  const items = await Promise.all(
    files.map(async (o) => {
      const projectId = o.key.slice(SETCUE_PROJECTS_PREFIX.length).replace(/\.json$/, '')
      const name = index[projectId]?.name ?? (await readR2Json<Partial<ProjectFile>>(o.key).then((f) => f.project?.name).catch(() => undefined)) ?? projectId
      return { key: o.key, projectId, name, size: o.size, lastModified: o.lastModified, inSystem: !!index[projectId] }
    }),
  )
  return items.sort((a, b) => b.lastModified - a.lastModified)
}

/** Bring back a Set Cue project that's only on R2, under its original id (so auto-save continues the same file). */
export async function restoreSetCueProject(item: SetCueCloudProject) {
  const exists = (await get(ref(db, `projectIndex/${item.projectId}`))).exists()
  if (exists) throw new Error('這個專案已在系統中')
  const file = parseProjectFile(JSON.stringify(await readR2Json(item.key)))
  return importProject(file, file.project.name, item.projectId)
}

/** Permanently delete a Set Cue project file from R2, and optionally the project itself. */
export async function deleteSetCueCloud(item: SetCueCloudProject, alsoProject: boolean) {
  // Delete the project first: otherwise an open console could auto-save the file right back.
  if (alsoProject && item.inSystem) {
    const me = currentUser()
    if (!me) throw new Error('請先登入')
    await deleteProject(item.projectId, me)
  }
  await deleteR2([item.key])
}

/** Put an auto-saved DAW project back into its show under its original id. */
export async function restoreDawProject(project: DawCloudProject) {
  const json = await readR2Json<{ name?: string; length?: number; studio?: { masterVolume?: number; tracks?: Json; regions?: Json; sections?: Json } }>(project.key)
  if (!json.studio) throw new Error('專案檔內容不完整')
  const now = Date.now()
  await update(ref(db), {
    [studioPath(project.showId, project.studioId)]: {
      name: json.name ?? project.name,
      createdAt: now,
      updatedAt: now,
      length: json.length ?? 0,
      masterVolume: json.studio.masterVolume ?? 1,
      tracks: json.studio.tracks ?? {},
      regions: json.studio.regions ?? {},
      sections: json.studio.sections ?? {},
    },
  })
}
