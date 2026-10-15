import { get, onValue, push, ref, remove, serverTimestamp, set, update } from 'firebase/database'
import { useEffect, useState } from 'react'
import { INITIAL_SHOW_STATE } from '../types/cue'
import { versionPath, type LivePointer, type ProjectSummary, type ShowRef, type VersionSummary } from '../types/project'
import { isAdmin, useAuth, type AppUser } from './auth'
import { db } from './firebase'
import { newInviteToken } from './membership'

/*
 * Layout:
 *   /projectIndex/{pid}                      name, timestamps, versions/{vid}: { name, createdAt, parentId }
 *   /projects/{pid}/versions/{vid}/cueList   the show's cues
 *   /projects/{pid}/versions/{vid}/hits      hit buttons
 *   /projects/{pid}/versions/{vid}/showState live playback state
 *   /projects/{pid}/versions/{vid}/presence  connected audience codes
 *   /projects/{pid}/uploads                  audience media pool, shared by every version
 *   /live                                    which version the audience follows
 *   /trash/{pid}, /trashIndex/{pid}          soft-deleted projects (data / list entry; admins restore them)
 *
 * The lobby only reads /projectIndex, so it never downloads every show's cue list or
 * re-renders on every GO.
 */

const newKey = () => push(ref(db, 'projectIndex')).key!

const defaultVersionName = (n: number) =>
  `v${n} · ${new Date().toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}`

type RawIndex = Record<
  string,
  {
    name: string
    createdAt: number
    updatedAt: number
    versions?: Record<string, Omit<VersionSummary, 'id'>>
    owner?: ProjectSummary['owner']
    collaborators?: Record<string, unknown>
    kind?: 'studio'
    isLocked?: boolean
    isMasterTemplate?: boolean
    isArchived?: boolean
    isPinned?: boolean
    forkedFrom?: ProjectSummary['forkedFrom']
  }
>

type RawProject = RawIndex[string]

export const toSummary = (id: string, p: RawProject): ProjectSummary => ({
  id,
  name: p.name,
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
  owner: p.owner,
  collaboratorIds: Object.keys(p.collaborators ?? {}),
  kind: p.kind,
  ...(p.isLocked ? { isLocked: true } : {}),
  ...(p.isMasterTemplate ? { isMasterTemplate: true } : {}),
  ...(p.isArchived ? { isArchived: true } : {}),
  ...(p.isPinned ? { isPinned: true } : {}),
  ...(p.forkedFrom ? { forkedFrom: p.forkedFrom } : {}),
  versions: Object.entries(p.versions ?? {})
    .map(([vid, v]) => ({ id: vid, name: v.name, createdAt: v.createdAt, parentId: v.parentId ?? null }))
    .sort((a, b) => b.createdAt - a.createdAt),
})

/**
 * The projects this user can see: admins every project; everyone else only the ones they own or
 * joined (listed in userProjects/{uid}), each read on its own — the full index is admin-only.
 */
export function useProjectIndex() {
  const { user } = useAuth()
  const admin = isAdmin(user)
  const uid = user?.uid ?? null
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null)
  const [error, setError] = useState<Error | null>(null)

  // Admins: the whole index.
  useEffect(() => {
    if (!admin) return
    return onValue(
      ref(db, 'projectIndex'),
      (snapshot) => {
        const raw = (snapshot.val() ?? {}) as RawIndex
        setProjects(Object.entries(raw).map(([id, p]) => toSummary(id, p)).sort((a, b) => b.updatedAt - a.updatedAt))
      },
      setError,
    )
  }, [admin])

  // Everyone else: the projects in their hub.
  const [ids, setIds] = useState<string[] | null>(null)
  useEffect(() => {
    if (admin || !uid) return
    return onValue(
      ref(db, `userProjects/${uid}`),
      (snap) => setIds([...new Set(Object.values((snap.val() ?? {}) as Record<string, { projectId?: string }>).map((e) => e.projectId).filter((x): x is string => !!x))].sort()),
      setError,
    )
  }, [admin, uid])
  const idKey = ids?.join(',') ?? null
  useEffect(() => {
    if (admin || idKey === null) return
    const list = idKey ? idKey.split(',') : []
    const found: Record<string, ProjectSummary | null> = {}
    const publish = () => {
      if (list.some((id) => !(id in found))) return // wait for every project's first answer
      setProjects(
        Object.values(found)
          .filter((p): p is ProjectSummary => !!p)
          .sort((a, b) => b.updatedAt - a.updatedAt),
      )
    }
    if (list.length === 0) publish()
    const offs = list.map((id) =>
      onValue(
        ref(db, `projectIndex/${id}`),
        (snap) => {
          // Deleted (or moved to the trash) projects simply drop out of the hub.
          found[id] = snap.exists() ? toSummary(id, snap.val() as RawProject) : null
          publish()
        },
        () => {
          // No longer a member (left, or removed): hide it.
          found[id] = null
          publish()
        },
      ),
    )
    return () => offs.forEach((o) => o())
  }, [admin, idKey])

  return { projects: user ? projects : null, error }
}

/** One project's index entry, live (undefined while loading, null if missing or not accessible). */
export function useProject(projectId: string | null) {
  const [project, setProject] = useState<ProjectSummary | null | undefined>(undefined)
  useEffect(() => {
    if (!projectId) return
    return onValue(
      ref(db, `projectIndex/${projectId}`),
      (snap) => setProject(snap.exists() ? toSummary(projectId, snap.val() as RawProject) : null),
      () => setProject(null),
    )
  }, [projectId])
  return projectId ? project : null
}

/** Create a project with an empty first version; resolves to its ShowRef. */
export async function createProject(name: string, opts: { owner?: { uid: string; name: string; email: string }; kind?: 'studio' } = {}): Promise<ShowRef> {
  const projectId = newKey()
  const versionId = newKey()
  const now = serverTimestamp()
  await update(ref(db), {
    [`projectIndex/${projectId}`]: {
      name,
      createdAt: now,
      updatedAt: now,
      versions: { [versionId]: { name: defaultVersionName(1), createdAt: now, parentId: null } },
      ...(opts.owner ? { owner: opts.owner } : {}),
      ...(opts.kind ? { kind: opts.kind } : {}),
    },
    // Share links carry this token; only people with it can join.
    ...(opts.owner ? { [`projectInvites/${projectId}`]: newInviteToken() } : {}),
    ...(opts.owner
      ? { [`userProjects/${opts.owner.uid}/setcue_${projectId}`]: opts.kind ? null : { kind: 'setcue', projectId, versionId, name, role: 'owner', lastOpenedAt: now } }
      : {}),
    [`${versionPath({ projectId, versionId })}/showState`]: INITIAL_SHOW_STATE,
  })
  return { projectId, versionId }
}

/**
 * "Save as": copy a version's cue list and hits into a new version of the same project.
 * Playback state starts fresh; cue ids are kept so audience uploads stay linked.
 */
export async function saveAsNewVersion(source: ShowRef, name?: string): Promise<ShowRef> {
  const [cueList, hits, index] = await Promise.all([
    get(ref(db, `${versionPath(source)}/cueList`)),
    get(ref(db, `${versionPath(source)}/hits`)),
    get(ref(db, `projectIndex/${source.projectId}/versions`)),
  ])
  const versionId = newKey()
  const target = { projectId: source.projectId, versionId }
  const now = serverTimestamp()
  await update(ref(db), {
    [`projectIndex/${source.projectId}/versions/${versionId}`]: {
      name: name?.trim() || defaultVersionName(index.size + 1),
      createdAt: now,
      parentId: source.versionId,
    },
    [`projectIndex/${source.projectId}/updatedAt`]: now,
    [`${versionPath(target)}/cueList`]: cueList.val(),
    [`${versionPath(target)}/hits`]: hits.val(),
    [`${versionPath(target)}/showState`]: INITIAL_SHOW_STATE,
  })
  return target
}

/** Turn Firebase errors into messages an operator can act on. */
export function describeFirebaseError(err: unknown): string {
  const code = (err as { code?: string })?.code ?? ''
  const message = (err as Error)?.message ?? String(err)
  if (code === 'PERMISSION_DENIED' || /permission.denied/i.test(message)) {
    return '沒有寫入權限（請檢查 Firebase Realtime Database 規則）'
  }
  if (/network|offline|disconnected/i.test(message)) return '網路連線中斷，請稍後再試'
  return message
}

/**
 * Rename a project. Also updates the name shown on audience devices if this project is on air.
 * Throws a readable Error on failure.
 */
export async function renameProject(projectId: string, name: string) {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('專案名稱不能是空白')
  if (trimmed.length > 80) throw new Error('專案名稱最多 80 個字')
  try {
    const live = (await get(ref(db, 'live'))).val() as LivePointer | null
    await update(ref(db), {
      [`projectIndex/${projectId}/name`]: trimmed,
      [`projectIndex/${projectId}/updatedAt`]: serverTimestamp(),
      ...(live?.projectId === projectId ? { 'live/projectName': trimmed } : {}),
    })
  } catch (err) {
    throw new Error(`重新命名失敗：${describeFirebaseError(err)}`)
  }
}

/** Rename one version of a project (any member of an editable project). */
export async function renameVersion(projectId: string, versionId: string, name: string) {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('版本名稱不能是空白')
  if (trimmed.length > 80) throw new Error('版本名稱最多 80 個字')
  try {
    const live = (await get(ref(db, 'live'))).val() as LivePointer | null
    await update(ref(db), {
      [`projectIndex/${projectId}/versions/${versionId}/name`]: trimmed,
      [`projectIndex/${projectId}/updatedAt`]: serverTimestamp(),
      ...(live?.projectId === projectId && live.versionId === versionId ? { 'live/versionName': trimmed } : {}),
    })
  } catch (err) {
    throw new Error(`重新命名失敗：${describeFirebaseError(err)}`)
  }
}

/**
 * Delete one version of a project — admins only (regular users can't remove history). The last
 * version and the one on air can't be deleted. Versions saved from it now descend from its parent,
 * and hub entries (Set Cue and Studio) that opened it move to the newest remaining version. The
 * project's Studios live beside the versions and are not affected. The Set Cue auto-save history
 * keeps the deleted version's content, so it can still be brought back from there.
 */
export async function deleteVersion(projectId: string, versionId: string, by: AppUser) {
  if (!isAdmin(by)) throw new Error('只有管理員可以刪除版本')
  try {
    const [live, index, hubs] = await Promise.all([
      get(ref(db, 'live')).then((s) => s.val() as LivePointer | null),
      get(ref(db, `projectIndex/${projectId}`)).then((s) => s.val() as RawProject | null),
      get(ref(db, 'userProjects')).then((s) => (s.val() ?? {}) as Record<string, Record<string, { projectId?: string; versionId?: string }>>),
    ])
    const versions = index?.versions ?? {}
    const gone = versions[versionId]
    if (!gone) throw new Error('找不到這個版本')
    if (Object.keys(versions).length <= 1) throw new Error('這是專案唯一的版本，無法刪除')
    if (live?.projectId === projectId && live.versionId === versionId) throw new Error('這個版本正在播出（ON AIR），請先停止播出再刪除')
    const [fallback] = Object.entries(versions)
      .filter(([id]) => id !== versionId)
      .sort((a, b) => (Number(b[1].createdAt) || 0) - (Number(a[1].createdAt) || 0))[0]
    const updates: Record<string, unknown> = {
      [`projectIndex/${projectId}/versions/${versionId}`]: null,
      [`projects/${projectId}/versions/${versionId}`]: null,
      [`projectIndex/${projectId}/updatedAt`]: serverTimestamp(),
    }
    for (const [id, v] of Object.entries(versions)) if (v.parentId === versionId) updates[`projectIndex/${projectId}/versions/${id}/parentId`] = gone.parentId ?? null
    for (const [uid, entries] of Object.entries(hubs))
      for (const [key, e] of Object.entries(entries ?? {})) if (e?.projectId === projectId && e.versionId === versionId) updates[`userProjects/${uid}/${key}/versionId`] = fallback
    await update(ref(db), updates)
    return { name: gone.name, fallback }
  } catch (err) {
    throw new Error(`刪除版本失敗：${describeFirebaseError(err)}`)
  }
}

/** A soft-deleted project in /trash/{pid}: everything needed to put it back exactly as it was. */
export interface TrashedProject {
  id: string
  /** A whole project, or one studio of a Set Cue project. */
  type: 'project' | 'studio'
  name: string
  /** Studio entries: the Set Cue project it belongs to. */
  parentProjectId?: string
  parentName?: string
  kind?: 'studio'
  owner?: ProjectSummary['owner']
  deletedAt: number
  deletedBy: { uid: string; name: string; email: string }
  /** Rough size of the saved data (characters of JSON), shown in the trash. */
  size: number
}

/**
 * Delete a project (admins only): it moves to /trash/{pid} — index entry, all its data (versions,
 * studios, surfaces, triggers, audience uploads, …), studio members and invite — in one atomic
 * write, and can be restored from the admin trash. Clears /live if the audience was following it.
 * Hub entries of its members are kept, so it reappears for them after a restore. Files on R2 /
 * Cloudinary are not touched. Throws a readable Error on failure.
 */
export async function deleteProject(projectId: string, by: AppUser) {
  if (!isAdmin(by)) throw new Error('只有管理員可以刪除整個專案')
  try {
    const [live, index, data, studioMeta, invite] = await Promise.all([
      get(ref(db, 'live')).then((s) => s.val() as LivePointer | null),
      get(ref(db, `projectIndex/${projectId}`)).then((s) => s.val() as RawProject | null),
      get(ref(db, `projects/${projectId}`)).then((s) => s.val() as unknown),
      get(ref(db, `studioMeta/${projectId}`)).then((s) => s.val() as unknown),
      get(ref(db, `projectInvites/${projectId}`)).then((s) => s.val() as string | null),
    ])
    if (!index) throw new Error('找不到這個專案')
    await update(ref(db), {
      [`trash/${projectId}`]: { index, data: data ?? null, studioMeta: studioMeta ?? null, invite: invite ?? null },
      [`trashIndex/${projectId}`]: {
        name: index.name ?? projectId,
        ...(index.kind ? { kind: index.kind } : {}),
        ...(index.owner ? { owner: index.owner } : {}),
        deletedAt: serverTimestamp(),
        deletedBy: { uid: by.uid, name: by.name, email: by.email },
        size: JSON.stringify(data ?? null).length,
      },
      [`projectIndex/${projectId}`]: null,
      [`projects/${projectId}`]: null,
      [`studioMeta/${projectId}`]: null,
      [`projectInvites/${projectId}`]: null,
      ...(live?.projectId === projectId ? { live: null } : {}),
    })
  } catch (err) {
    throw new Error(`刪除失敗：${describeFirebaseError(err)}`)
  }
}

/** Put a project from the trash back exactly where it was (admins only). */
export async function restoreProject(projectId: string) {
  try {
    const [trashed, existing] = await Promise.all([
      get(ref(db, `trash/${projectId}`)).then((s) => s.val() as { index?: RawProject; data?: unknown; studioMeta?: unknown; invite?: string | null } | null),
      get(ref(db, `projectIndex/${projectId}`)).then((s) => s.exists()),
    ])
    if (!trashed?.index) throw new Error('回收桶裡找不到這個專案')
    if (existing) throw new Error('已經有同 ID 的專案存在，無法還原')
    await update(ref(db), {
      [`projectIndex/${projectId}`]: { ...trashed.index, updatedAt: serverTimestamp() },
      [`projects/${projectId}`]: trashed.data ?? null,
      [`studioMeta/${projectId}`]: trashed.studioMeta ?? null,
      [`projectInvites/${projectId}`]: trashed.invite ?? null,
      [`trash/${projectId}`]: null,
      [`trashIndex/${projectId}`]: null,
    })
  } catch (err) {
    throw new Error(`還原失敗：${describeFirebaseError(err)}`)
  }
}

/** The admin trash: soft-deleted projects, most recently deleted first. */
export function useTrash(enabled: boolean) {
  const [items, setItems] = useState<TrashedProject[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!enabled) return
    // The list entries only; the project data stays in /trash until restored.
    return onValue(
      ref(db, 'trashIndex'),
      (snap) => {
        const raw = (snap.val() ?? {}) as Record<string, Partial<Omit<TrashedProject, 'id'>>>
        setItems(
          Object.entries(raw)
            .map(([id, t]) => ({
              id,
              type: (t.type === 'studio' ? 'studio' : 'project') as TrashedProject['type'],
              ...(t.parentProjectId ? { parentProjectId: t.parentProjectId, parentName: t.parentName } : {}),
              name: t.name ?? id,
              kind: t.kind,
              owner: t.owner,
              deletedAt: t.deletedAt ?? 0,
              deletedBy: t.deletedBy ?? { uid: '', name: '?', email: '' },
              size: t.size ?? 0,
            }))
            .sort((a, b) => b.deletedAt - a.deletedAt),
        )
      },
      (err) => setError(err.message),
    )
  }, [enabled])
  return { items, error }
}

/** Bump updatedAt so recently edited projects sort first in the lobby. */
export function touchProject(projectId: string) {
  return set(ref(db, `projectIndex/${projectId}/updatedAt`), serverTimestamp())
}

export function useLivePointer() {
  const [live, setLive] = useState<LivePointer | null | undefined>(undefined)
  useEffect(() => onValue(ref(db, 'live'), (snapshot) => setLive(snapshot.val())), [])
  return live
}

export function setLivePointer(pointer: LivePointer | null) {
  return pointer ? set(ref(db, 'live'), pointer) : remove(ref(db, 'live'))
}

/** Stage 1–3 stored one global show at /cueList and /hits; true until it has been imported once. */
export async function hasLegacyShow(): Promise<boolean> {
  const [cueList, imported] = await Promise.all([get(ref(db, 'cueList')), get(ref(db, 'legacyImportedAt'))])
  return cueList.exists() && !imported.exists()
}

/** Copy the stage 1–3 global show into a new project. The old nodes are left untouched. */
export async function importLegacyShow(name: string): Promise<ShowRef> {
  const [cueList, hits] = await Promise.all([get(ref(db, 'cueList')), get(ref(db, 'hits'))])
  const created = await createProject(name)
  await update(ref(db), {
    [`${versionPath(created)}/cueList`]: cueList.val(),
    [`${versionPath(created)}/hits`]: hits.val(),
    legacyImportedAt: serverTimestamp(),
  })
  return created
}
