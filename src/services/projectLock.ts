import { get, onValue, push, ref, serverTimestamp, update } from 'firebase/database'
import { useEffect, useState } from 'react'
import { INITIAL_SHOW_STATE } from '../types/cue'
import type { ProjectSummary, ShowRef } from '../types/project'
import { isAdmin, type AppUser } from './auth'
import { db } from './firebase'
import { toSummary } from './projects'
import { newInviteToken, ownerOf } from './membership'

/*
 * Official templates and read-only projects (admins / teachers set these):
 *
 *   projectIndex/{pid}/isLocked          read-only: members can open, play and view, not edit
 *   projectIndex/{pid}/isMasterTemplate  official template: every signed-in user can open and view it
 *                                        (read-only) and fork it into a project of their own
 *   projectIndex/{pid}/isArchived        archived: read-only, listed apart in the hub
 *   projectIndex/{pid}/forkedFrom        { projectId, name, at } on a fork
 *   templates/{pid}                      list of templates (readable by everyone signed in)
 *
 * Enforced twice: by the database rules (database.rules.json) and in the app — recordedUpdate()
 * refuses edits to a read-only project (see readOnlyReason) and the pages show a read-only bar.
 * Admins are never restricted.
 */

export interface ProjectFlags {
  isLocked?: boolean
  isMasterTemplate?: boolean
  isArchived?: boolean
  isPinned?: boolean
  forkedFrom?: { projectId: string; name: string; at?: number }
}

export const isReadOnlyProject = (f: ProjectFlags | null | undefined) => !!(f?.isLocked || f?.isMasterTemplate || f?.isArchived)

export function readOnlyLabel(f: ProjectFlags | null | undefined) {
  if (f?.isMasterTemplate) return '官方範本（唯讀）'
  if (f?.isArchived) return '已封存（唯讀）'
  if (f?.isLocked) return '已鎖定（唯讀）'
  return ''
}

/* ---------- client-side guard ---------- */

/** Projects that are read-only for the signed-in user (project id → why). */
const readOnly = new Map<string, string>()
export const READ_ONLY_EVENT = 'theatre:read-only-blocked'

/** The reason an edit touching these database paths is refused, or null. */
export function readOnlyReason(paths: string[]): string | null {
  if (readOnly.size === 0) return null
  for (const p of paths) {
    const pid = /^(?:projects|projectIndex|studioMeta)\/([^/]+)/.exec(p)?.[1]
    const reason = pid ? readOnly.get(pid) : undefined
    if (reason) return reason
  }
  return null
}

/** For writes outside recordedUpdate(): true (and a toast) when the project is read-only here. */
export function refuseIfReadOnly(projectId: string): boolean {
  const reason = readOnly.get(projectId)
  if (reason) notifyReadOnly(reason)
  return !!reason
}

/** Whether edits to this project are refused for the signed-in user (silent check). */
export const isReadOnlyHere = (projectId: string) => readOnly.has(projectId)

/** Tell the page an edit was refused (it shows a toast). */
export function notifyReadOnly(reason: string) {
  window.dispatchEvent(new CustomEvent(READ_ONLY_EVENT, { detail: reason }))
}

/**
 * A project's flags, live, and whether it's read-only for this user; registers it with the
 * edit guard while the page is open.
 */
export function useProjectLock(projectId: string | null, user: AppUser | null) {
  const [flags, setFlags] = useState<ProjectFlags | null>(null)
  const admin = isAdmin(user)
  useEffect(() => {
    if (!projectId) return
    const keys = ['isLocked', 'isMasterTemplate', 'isArchived', 'forkedFrom'] as const
    const current: ProjectFlags = {}
    const offs = keys.map((k) =>
      onValue(
        ref(db, `projectIndex/${projectId}/${k}`),
        (snap) => {
          ;(current as Record<string, unknown>)[k] = snap.val() ?? undefined
          setFlags({ ...current })
        },
        () => {},
      ),
    )
    return () => offs.forEach((o) => o())
  }, [projectId])
  const locked = !admin && isReadOnlyProject(flags)
  useEffect(() => {
    if (!projectId) return
    if (locked) readOnly.set(projectId, `🔒 這個專案是${readOnlyLabel(flags)}，不能修改。請按「複製為我的專案」建立自己的副本再編輯。`)
    else readOnly.delete(projectId)
    return () => {
      readOnly.delete(projectId)
    }
  }, [projectId, locked, flags])
  return { flags, readOnly: locked, label: readOnlyLabel(flags) }
}

/* ---------- admin controls ---------- */

/** Set a project's lock / template / archive flags (admins only). */
export async function setProjectFlags(projectId: string, patch: Partial<Pick<ProjectFlags, 'isLocked' | 'isMasterTemplate' | 'isArchived' | 'isPinned'>>, by: AppUser) {
  if (!isAdmin(by)) throw new Error('只有管理員可以設定鎖定、範本或封存')
  const updates: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(patch)) updates[`projectIndex/${projectId}/${k}`] = v ? true : null
  updates[`projectIndex/${projectId}/lockChangedBy`] = { uid: by.uid, name: by.name, email: by.email, at: serverTimestamp() }
  if (patch.isMasterTemplate !== undefined) {
    const name = ((await get(ref(db, `projectIndex/${projectId}/name`))).val() as string | null) ?? ''
    updates[`templates/${projectId}`] = patch.isMasterTemplate ? { name, at: serverTimestamp() } : null
  }
  await update(ref(db), updates)
}

/** Official templates (every signed-in user), newest first. */
export function useTemplates() {
  const [ids, setIds] = useState<string[] | null>(null)
  const [found, setFound] = useState<Record<string, ProjectSummary | null>>({})
  useEffect(
    () =>
      onValue(
        ref(db, 'templates'),
        (snap) => setIds(Object.keys((snap.val() ?? {}) as Record<string, unknown>).sort()),
        () => setIds([]),
      ),
    [],
  )
  const key = ids?.join(',') ?? ''
  useEffect(() => {
    if (!key) return
    const offs = key.split(',').map((id) =>
      onValue(
        ref(db, `projectIndex/${id}`),
        (snap) => setFound((f) => ({ ...f, [id]: snap.exists() ? toSummary(id, snap.val()) : null })),
        () => setFound((f) => ({ ...f, [id]: null })),
      ),
    )
    return () => offs.forEach((o) => o())
  }, [key])
  if (ids === null) return null
  return ids.map((id) => found[id]).filter((p): p is ProjectSummary => !!p?.isMasterTemplate)
}

/* ---------- fork ---------- */

/** Parts of a project that belong to its live use, not its content: not copied into a fork. */
const FORK_SKIP = new Set(['uploads', 'intercom', 'activity', 'studioPresence', 'published', 'publishedLive', 'triggerHost'])
const VERSION_SKIP = new Set(['presence', 'triggerHost'])

export interface ForkResult {
  show: ShowRef
  studioIds: string[]
  kind?: 'studio'
}

/**
 * Copy a project (usually an official template) into a new, independent project owned by `user`:
 * every version (cues, hits, notes), control surfaces, triggers, media library, DAW studios and
 * presets. Playback starts fresh; audience uploads, chat and activity aren't copied. Media files
 * are shared by URL, not duplicated. The source is untouched.
 */
export async function forkProject(sourceId: string, user: AppUser, name: string): Promise<ForkResult> {
  const [indexSnap, dataSnap] = await Promise.all([get(ref(db, `projectIndex/${sourceId}`)), get(ref(db, `projects/${sourceId}`))])
  const index = indexSnap.val() as { name?: string; kind?: 'studio'; versions?: Record<string, { name: string; createdAt: number; parentId?: string | null }> } | null
  if (!index) throw new Error('找不到要複製的專案')
  const data = (dataSnap.val() ?? {}) as Record<string, unknown>
  const projectId = push(ref(db, 'projectIndex')).key!
  const now = serverTimestamp()
  const updates: Record<string, unknown> = {}
  const versions = index.versions ?? {}
  const versionIds = Object.keys(versions).sort((a, b) => (versions[b].createdAt ?? 0) - (versions[a].createdAt ?? 0))
  if (versionIds.length === 0) throw new Error('這個專案沒有任何版本可以複製')

  updates[`projectIndex/${projectId}`] = {
    name: name.trim() || `${index.name ?? '專案'}（我的副本）`,
    createdAt: now,
    updatedAt: now,
    versions,
    owner: ownerOf(user),
    ...(index.kind ? { kind: index.kind } : {}),
    forkedFrom: { projectId: sourceId, name: index.name ?? '', at: Date.now() },
  }
  updates[`projectInvites/${projectId}`] = newInviteToken()

  // Content, written per section / version / studio (where the database rules grant members).
  const rawVersions = (data.versions ?? {}) as Record<string, Record<string, unknown>>
  for (const vid of versionIds) {
    const v = Object.fromEntries(Object.entries(rawVersions[vid] ?? {}).filter(([k]) => !VERSION_SKIP.has(k)))
    updates[`projects/${projectId}/versions/${vid}`] = { ...v, showState: INITIAL_SHOW_STATE }
  }
  const studios = (data.studio ?? {}) as Record<string, Record<string, unknown>>
  for (const [sid, studio] of Object.entries(studios)) updates[`projects/${projectId}/studio/${sid}`] = { ...studio, updatedAt: Date.now() }
  for (const [section, value] of Object.entries(data)) {
    if (section === 'versions' || section === 'studio' || FORK_SKIP.has(section) || value == null) continue
    updates[`projects/${projectId}/${section}`] = value
  }

  // The fork is the student's own: in their hub, they own its studios too.
  const latest = versionIds[0]
  const projectName = (updates[`projectIndex/${projectId}`] as { name: string }).name
  if (index.kind !== 'studio') updates[`userProjects/${user.uid}/setcue_${projectId}`] = { kind: 'setcue', projectId, versionId: latest, name: projectName, role: 'owner', lastOpenedAt: now }
  for (const [sid, studio] of Object.entries(studios)) {
    updates[`studioMeta/${projectId}/${sid}/owner`] = ownerOf(user)
    updates[`userProjects/${user.uid}/studio_${projectId}_${sid}`] = {
      kind: 'studio',
      projectId,
      versionId: latest,
      studioId: sid,
      name: index.kind === 'studio' ? projectName : String(studio.name ?? 'Studio'),
      role: 'owner',
      lastOpenedAt: now,
    }
  }
  await update(ref(db), updates)
  return { show: { projectId, versionId: latest }, studioIds: Object.keys(studios), kind: index.kind }
}

/** Where a fresh fork opens: its console (Set Cue) or its first studio (Studio projects). */
export const forkUrl = (r: ForkResult) =>
  r.kind === 'studio' && r.studioIds[0]
    ? `${location.pathname.replace(/\/surface\/?$/, '/')}?role=studio&project=${r.show.projectId}&version=${r.show.versionId}&studio=${r.studioIds[0]}`
    : `${location.pathname.replace(/\/surface\/?$/, '/')}?role=console&project=${r.show.projectId}&version=${r.show.versionId}`

