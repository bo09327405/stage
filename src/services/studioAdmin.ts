import { get, ref, serverTimestamp, update } from 'firebase/database'
import type { ProjectSummary } from '../types/project'
import { isAdmin, type AppUser } from './auth'
import { isReadOnlyProject } from './projectLock'
import { db } from './firebase'
import { deleteProject } from './projects'
import { deleteR2, dawProjectKey } from './storage'

/*
 * Studio projects in their Set Cue parent, managed by admins:
 *
 *   projects/{pid}/studio/{sid}         the studio; parentProjectId = pid when pid is a Set Cue project
 *   studioMeta/{pid}/{sid}              its owner / collaborators
 *   projects/{pid}/publishedLive/{sid}, published/{id}.studioId, audienceStudios/{sid}
 *   userProjects/{uid}/studio_{pid}_{sid}   hub entries
 *   theatre/projects/{pid}/{sid}.json   auto-saved file on R2
 *
 * A standalone Studio project is a container project of kind "studio" holding one studio; moving
 * its studio into a Set Cue project makes it a child and sends the empty container to the trash.
 * Moving a Set Cue project to the trash takes its studios with it (they live inside it).
 */

type Json = Record<string, unknown>

export interface StudioTrashEntry {
  type: 'studio'
  parentProjectId: string
  studioId: string
  data: Json
  studioMeta: Json | null
  publishedLive: Json | null
  published: Json | null
  audience: boolean
}

/** Trash id of a studio: trash/studio__{pid}__{sid}. */
export const studioTrashId = (pid: string, sid: string) => `studio__${pid}__${sid}`

function requireAdmin(by: AppUser | null) {
  if (!isAdmin(by)) throw new Error('只有管理員可以執行這個動作')
}

/** Everything of one studio inside its project. */
async function readStudioBundle(pid: string, sid: string) {
  const [data, meta, live, published, audience, index] = await Promise.all([
    get(ref(db, `projects/${pid}/studio/${sid}`)).then((s) => s.val() as Json | null),
    get(ref(db, `studioMeta/${pid}/${sid}`)).then((s) => s.val() as Json | null),
    get(ref(db, `projects/${pid}/publishedLive/${sid}`)).then((s) => s.val() as Json | null),
    get(ref(db, `projects/${pid}/published`)).then((s) => (s.val() ?? {}) as Record<string, Json>),
    get(ref(db, `projects/${pid}/audienceStudios/${sid}`)).then((s) => s.val() === true),
    get(ref(db, `projectIndex/${pid}`)).then((s) => s.val() as Json | null),
  ])
  if (!data) throw new Error('找不到這個 Studio')
  const mine = Object.fromEntries(Object.entries(published).filter(([, p]) => p.studioId === sid))
  return { data, meta, live, published: Object.keys(mine).length ? mine : null, audience, index }
}

/** Hub entries (userProjects) that point at a studio, for every user. */
async function hubEntriesOf(pid: string, sid: string) {
  const all = ((await get(ref(db, 'userProjects'))).val() ?? {}) as Record<string, Record<string, Json>>
  const out: { uid: string; key: string; entry: Json }[] = []
  for (const [uid, items] of Object.entries(all)) for (const [key, e] of Object.entries(items ?? {})) if (e.projectId === pid && e.studioId === sid) out.push({ uid, key, entry: e })
  return out
}

/**
 * Admins: move one studio of a Set Cue project to the trash (its data, members, published audio
 * settings). The Set Cue project and its other studios are untouched. A standalone Studio
 * project goes to the trash as a whole project instead.
 */
export async function softDeleteStudio(pid: string, sid: string, by: AppUser) {
  requireAdmin(by)
  const kind = (await get(ref(db, `projectIndex/${pid}/kind`))).val() as string | null
  if (kind === 'studio') return deleteProject(pid, by)
  const b = await readStudioBundle(pid, sid)
  const parentName = String(b.index?.name ?? pid)
  const id = studioTrashId(pid, sid)
  const updates: Record<string, unknown> = {
    [`trash/${id}`]: { type: 'studio', parentProjectId: pid, studioId: sid, data: b.data, studioMeta: b.meta, publishedLive: b.live, published: b.published, audience: b.audience },
    [`trashIndex/${id}`]: {
      type: 'studio',
      name: String(b.data.name ?? 'Studio'),
      parentProjectId: pid,
      parentName,
      studioId: sid,
      deletedAt: serverTimestamp(),
      deletedBy: { uid: by.uid, name: by.name, email: by.email },
      size: JSON.stringify(b.data).length,
    },
    [`projects/${pid}/studio/${sid}`]: null,
    [`projects/${pid}/studioPresence/${sid}`]: null,
    [`projects/${pid}/publishedLive/${sid}`]: null,
    [`projects/${pid}/audienceStudios/${sid}`]: null,
    [`studioMeta/${pid}/${sid}`]: null,
  }
  for (const pubId of Object.keys(b.published ?? {})) updates[`projects/${pid}/published/${pubId}`] = null
  await update(ref(db), updates)
}

/** Put a trashed studio back into its Set Cue project. */
export async function restoreStudio(trashId: string) {
  const t = (await get(ref(db, `trash/${trashId}`))).val() as StudioTrashEntry | null
  if (!t || t.type !== 'studio') throw new Error('回收桶裡找不到這個 Studio')
  const [parent, taken] = await Promise.all([get(ref(db, `projectIndex/${t.parentProjectId}`)), get(ref(db, `projects/${t.parentProjectId}/studio/${t.studioId}`))])
  if (!parent.exists()) throw new Error('它的 Set Cue 母專案已被刪除：請先在回收桶還原母專案，再還原這個 Studio')
  if (taken.exists()) throw new Error('母專案裡已經有同 ID 的 Studio')
  const pid = t.parentProjectId
  const updates: Record<string, unknown> = {
    [`projects/${pid}/studio/${t.studioId}`]: { ...t.data, updatedAt: Date.now() },
    [`studioMeta/${pid}/${t.studioId}`]: t.studioMeta ?? null,
    [`projects/${pid}/publishedLive/${t.studioId}`]: t.publishedLive ?? null,
    [`trash/${trashId}`]: null,
    [`trashIndex/${trashId}`]: null,
  }
  if (t.audience) updates[`projects/${pid}/audienceStudios/${t.studioId}`] = true
  for (const [id, p] of Object.entries(t.published ?? {})) updates[`projects/${pid}/published/${id}`] = p
  await update(ref(db), updates)
}

export interface MoveResult {
  /** Cues of the old parent that played this studio (their binding no longer resolves). */
  unboundCues: number
  /** People added as collaborators of the new parent (they worked on this studio). */
  addedMembers: number
  containerTrashed: boolean
}

/**
 * Admins: move a studio into another Set Cue project (re-assign its parent). Its data, members,
 * published audio settings, hub entries and auto-saved R2 file move along; the studio's owner and
 * collaborators become collaborators of the new parent (so they keep access). A standalone
 * container left empty goes to the trash. Fixed-URL MP3 links contain the project, so the old
 * file stays where it is (embeds keep the last version) and the next render publishes a new one.
 */
export async function moveStudio(fromPid: string, sid: string, toPid: string, by: AppUser): Promise<MoveResult> {
  requireAdmin(by)
  if (fromPid === toPid) throw new Error('已經在這個 Set Cue 專案裡')
  const [b, target, takenSnap] = await Promise.all([
    readStudioBundle(fromPid, sid),
    get(ref(db, `projectIndex/${toPid}`)).then((s) => s.val() as Json | null),
    get(ref(db, `projects/${toPid}/studio/${sid}`)),
  ])
  if (!target) throw new Error('找不到目標 Set Cue 專案')
  if (target.kind === 'studio') throw new Error('目標必須是 Set Cue 專案（不是另一個獨立 Studio）')
  if (takenSnap.exists()) throw new Error('目標專案裡已經有同 ID 的 Studio')
  const toVersions = Object.entries((target.versions ?? {}) as Record<string, { createdAt?: number }>).sort((a, b2) => (b2[1].createdAt ?? 0) - (a[1].createdAt ?? 0))
  const toVersion = toVersions[0]?.[0] ?? ''
  const hub = await hubEntriesOf(fromPid, sid)

  const updates: Record<string, unknown> = {
    [`projects/${toPid}/studio/${sid}`]: { ...b.data, parentProjectId: toPid, updatedAt: Date.now() },
    [`studioMeta/${toPid}/${sid}`]: b.meta ?? null,
    [`projects/${toPid}/publishedLive/${sid}`]: b.live ? { ...b.live, lock: null } : null,
    [`projects/${fromPid}/studio/${sid}`]: null,
    [`projects/${fromPid}/studioPresence/${sid}`]: null,
    [`projects/${fromPid}/publishedLive/${sid}`]: null,
    [`projects/${fromPid}/audienceStudios/${sid}`]: null,
    [`studioMeta/${fromPid}/${sid}`]: null,
  }
  for (const [id, p] of Object.entries(b.published ?? {})) {
    updates[`projects/${toPid}/published/${id}`] = p
    updates[`projects/${fromPid}/published/${id}`] = null
  }
  // Keep the people who work on it: owner + collaborators join the new parent.
  const members = new Map<string, Json>()
  const owner = b.meta?.owner as { uid?: string; name?: string; email?: string } | undefined
  if (owner?.uid) members.set(owner.uid, { name: owner.name ?? '', email: owner.email ?? '', photo: '' })
  for (const [uid, m] of Object.entries((b.meta?.collaborators ?? {}) as Record<string, Json>)) members.set(uid, m)
  if (b.index?.kind === 'studio') {
    const cOwner = b.index.owner as { uid?: string; name?: string; email?: string } | undefined
    if (cOwner?.uid) members.set(cOwner.uid, { name: cOwner.name ?? '', email: cOwner.email ?? '', photo: '' })
    for (const [uid, m] of Object.entries((b.index.collaborators ?? {}) as Record<string, Json>)) members.set(uid, m)
  }
  const targetOwner = (target.owner as { uid?: string } | undefined)?.uid
  const existing = (target.collaborators ?? {}) as Record<string, unknown>
  let added = 0
  for (const [uid, m] of members) {
    if (uid === targetOwner || existing[uid]) continue
    updates[`projectIndex/${toPid}/collaborators/${uid}`] = { name: m.name ?? '', email: m.email ?? '', photo: m.photo ?? '', joinedAt: serverTimestamp(), lastOpenedAt: serverTimestamp(), via: 'studio-move' }
    added++
  }
  // Hub entries follow.
  for (const h of hub) {
    updates[`userProjects/${h.uid}/${h.key}`] = null
    updates[`userProjects/${h.uid}/studio_${toPid}_${sid}`] = { ...h.entry, projectId: toPid, versionId: toVersion }
  }
  await update(ref(db), updates)

  // The auto-saved file follows (theatre/projects/{pid}/{sid}.json).
  const from = dawProjectKey(fromPid, sid)
  const to = dawProjectKey(toPid, sid)
  const copied = await fetch('/api/r2/copy', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from, to }) }).catch(() => null)
  if (copied?.ok) await deleteR2([from]).catch(() => {})

  // Cues of the old parent bound to it can't reach it any more.
  const versions = ((await get(ref(db, `projects/${fromPid}/versions`)).catch(() => null))?.val() ?? {}) as Record<string, { cueList?: Record<string, { studioId?: string }> }>
  const unboundCues = Object.values(versions).reduce((n, v) => n + Object.values(v.cueList ?? {}).filter((c) => c.studioId === sid).length, 0)

  // An emptied standalone container goes to the trash (restorable).
  let containerTrashed = false
  if (b.index?.kind === 'studio') {
    const rest = (await get(ref(db, `projects/${fromPid}/studio`))).val()
    if (!rest) {
      await deleteProject(fromPid, by)
      containerTrashed = true
    }
  }
  return { unboundCues, addedMembers: added, containerTrashed }
}

/** A studio as the hub / file manager show it. */
export interface StudioRef {
  projectId: string
  studioId: string
  name: string
  /** The container project (its Set Cue parent, or a standalone Studio container). */
  project: ProjectSummary
}


/** Set Cue projects a studio can belong to (not standalone containers; editable for this user). */
export const parentChoices = (projects: ProjectSummary[] | null, user: AppUser) =>
  (projects ?? []).filter((p) => p.kind !== 'studio' && !p.isArchived && (isAdmin(user) || !isReadOnlyProject(p))).sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'))

