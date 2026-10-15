import { get, onValue, ref, serverTimestamp, set, update } from 'firebase/database'
import { useEffect, useMemo, useState } from 'react'
import { isAdmin, type AppUser } from './auth'
import { db } from './firebase'

/*
 * Who owns and who works on what.
 *
 *   projectIndex/{pid}/owner                 { uid, name, email }   (Set Cue project)
 *   projectIndex/{pid}/collaborators/{uid}   { name, email, photo, joinedAt, lastOpenedAt }
 *   studioMeta/{pid}/{sid}/owner, …/collaborators/{uid}            (DAW Studio project)
 *   userProjects/{uid}/{key}                 what appears in that user's hub
 *
 *   projectInvites/{pid}                     invite token, part of every share link
 *
 * Only members (owner + collaborators) and admins can open a project (enforced by the database
 * rules too). A share link carries the invite token: opening it while signed in adds you as a
 * collaborator and puts the project in your hub. Members can leave; that only takes them off the
 * list — the project and everyone else are untouched.
 */

/** A fresh invite token (part of share links). */
export const newInviteToken = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return [...bytes].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 20)
}

export type Access = { status: 'member' | 'admin' | 'joined' | 'template' } | { status: 'denied'; reason: 'no-invite' | 'bad-invite' } | { status: 'missing' }

const isPermissionError = (err: unknown) => /permission/i.test(String((err as Error)?.message ?? err))

/** Read a path; null when the rules refuse (not a member). */
async function tryGet<T>(path: string): Promise<{ ok: true; value: T | null } | { ok: false }> {
  try {
    return { ok: true, value: (await get(ref(db, path))).val() as T | null }
  } catch (err) {
    if (isPermissionError(err)) return { ok: false }
    throw err
  }
}

/**
 * Make sure this user may open the project: members and admins go straight in; anyone else needs
 * the project's invite token (from the share link), which adds them as a collaborator.
 */
export async function ensureProjectAccess(u: AppUser, projectId: string, invite: string | null): Promise<Access> {
  const index = await tryGet<{ name?: string; owner?: { uid?: string }; collaborators?: Record<string, unknown>; isMasterTemplate?: boolean }>(`projectIndex/${projectId}`)
  if (index.ok) {
    if (!index.value) return { status: 'missing' }
    if (index.value.owner?.uid === u.uid || index.value.collaborators?.[u.uid]) return { status: 'member' }
    if (isAdmin(u)) return { status: 'admin' }
    // Official templates: everyone signed in may view them (read-only) and fork them.
    if (index.value.isMasterTemplate && !invite) return { status: 'template' }
  }
  if (!invite) return { status: 'denied', reason: 'no-invite' }
  try {
    await set(ref(db, `projectIndex/${projectId}/collaborators/${u.uid}`), { ...memberOf(u), invite, joinedAt: serverTimestamp(), lastOpenedAt: serverTimestamp() })
  } catch (err) {
    if (isPermissionError(err)) return { status: 'denied', reason: 'bad-invite' }
    throw err
  }
  // With the database rules in place the write above only succeeds with the right token; check
  // it here as well so a wrong link never joins anyone.
  const token = await tryGet<string>(`projectInvites/${projectId}`)
  if (!token.ok || !token.value || token.value !== invite) {
    await set(ref(db, `projectIndex/${projectId}/collaborators/${u.uid}`), null).catch(() => {})
    return { status: 'denied', reason: 'bad-invite' }
  }
  return { status: 'joined' }
}

/** The project's invite token (creating one for older projects). Members only. */
export async function ensureInvite(projectId: string): Promise<string> {
  const current = (await get(ref(db, `projectInvites/${projectId}`))).val() as string | null
  if (current) return current
  const token = newInviteToken()
  await set(ref(db, `projectInvites/${projectId}`), token)
  return token
}

/** New invite token: links shared so far stop working for people who haven't joined yet. */
export async function rotateInvite(projectId: string): Promise<string> {
  const token = newInviteToken()
  await set(ref(db, `projectInvites/${projectId}`), token)
  return token
}

export function useInvite(projectId: string | null) {
  const [token, setToken] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    if (!projectId) return
    ensureInvite(projectId).catch(() => {})
    return onValue(ref(db, `projectInvites/${projectId}`), (snap) => setToken(snap.val() as string | null), () => setToken(null))
  }, [projectId])
  return token
}

/**
 * Leave a project: off its collaborator list (project and studios) and out of your hub. The
 * project itself and everyone else's access stay as they are. Owners can't leave their own project.
 */
export async function leaveProject(u: AppUser, projectId: string) {
  const owner = (await get(ref(db, `projectIndex/${projectId}/owner/uid`)).catch(() => null))?.val() as string | null
  if (owner === u.uid) throw new Error('你是這個專案的建立者，不能退出')
  const [studios, hub] = await Promise.all([
    get(ref(db, `studioMeta/${projectId}`)).then((s) => (s.val() ?? {}) as Record<string, StudioMeta>).catch(() => ({}) as Record<string, StudioMeta>),
    get(ref(db, `userProjects/${u.uid}`)).then((s) => (s.val() ?? {}) as Record<string, Omit<UserProject, 'key'>>),
  ])
  const updates: Record<string, null> = {}
  for (const [key, item] of Object.entries(hub)) if (item.projectId === projectId) updates[`userProjects/${u.uid}/${key}`] = null
  for (const [sid, meta] of Object.entries(studios)) if (meta.collaborators?.[u.uid]) updates[`studioMeta/${projectId}/${sid}/collaborators/${u.uid}`] = null
  // Last: after this the project is no longer readable.
  await update(ref(db), updates)
  await set(ref(db, `projectIndex/${projectId}/collaborators/${u.uid}`), null)
}

export type HubKind = 'setcue' | 'studio'

export interface Member {
  name: string
  email: string
  photo: string
  joinedAt?: number
  lastOpenedAt?: number
}

export interface UserProject {
  key: string
  kind: HubKind
  projectId: string
  versionId?: string
  studioId?: string
  name: string
  role: 'owner' | 'collaborator'
  lastOpenedAt: number
}

const memberOf = (u: AppUser) => ({ name: u.name, email: u.email, photo: u.photo })
export const ownerOf = (u: AppUser) => ({ uid: u.uid, name: u.name, email: u.email })
const keyFor = (kind: HubKind, projectId: string, studioId?: string) => (kind === 'setcue' ? `setcue_${projectId}` : `studio_${projectId}_${studioId}`)

async function join(u: AppUser, kind: HubKind, base: string, entry: { projectId: string; versionId?: string; studioId?: string; name: string }) {
  const owner = (await get(ref(db, `${base}/owner`)).catch(() => null))?.val() as { uid?: string } | null
  const role = owner?.uid === u.uid ? 'owner' : 'collaborator'
  const updates: Record<string, unknown> = {
    [`userProjects/${u.uid}/${keyFor(kind, entry.projectId, entry.studioId)}`]: { kind, ...entry, role, lastOpenedAt: serverTimestamp() },
  }
  if (role === 'collaborator') {
    const existing = (await get(ref(db, `${base}/collaborators/${u.uid}`))).val() as (Member & { invite?: string }) | null
    updates[`${base}/collaborators/${u.uid}`] = { ...memberOf(u), ...(existing?.invite ? { invite: existing.invite } : {}), joinedAt: existing?.joinedAt ?? serverTimestamp(), lastOpenedAt: serverTimestamp() }
  }
  await update(ref(db), updates)
}

/** Opened a Set Cue project (console / control panel) as a member: list it in this user's hub. Admins visiting aren't added. */
export const joinSetCue = async (u: AppUser, projectId: string, versionId: string, name: string) => {
  // Admins visiting, and anyone viewing an official template, aren't added to the project.
  if (!(await isMember(u, projectId))) return
  return join(u, 'setcue', `projectIndex/${projectId}`, { projectId, versionId, name })
}

async function isMember(u: AppUser, projectId: string) {
  const index = (await get(ref(db, `projectIndex/${projectId}`))).val() as { owner?: { uid?: string }; collaborators?: Record<string, unknown> } | null
  return index?.owner?.uid === u.uid || !!index?.collaborators?.[u.uid]
}

/** Opened a DAW Studio project (already a project member). Admins visiting aren't added. */
export const joinStudio = async (u: AppUser, projectId: string, versionId: string, studioId: string, name: string) => {
  if (!(await isMember(u, projectId))) return
  return join(u, 'studio', `studioMeta/${projectId}/${studioId}`, { projectId, versionId, studioId, name })
}

/** Mark a new studio as created by this user. */
export async function claimStudio(u: AppUser, projectId: string, versionId: string, studioId: string, name: string) {
  await update(ref(db), {
    [`studioMeta/${projectId}/${studioId}/owner`]: ownerOf(u),
    [`userProjects/${u.uid}/${keyFor('studio', projectId, studioId)}`]: { kind: 'studio', projectId, versionId, studioId, name, role: 'owner', lastOpenedAt: serverTimestamp() },
  })
}

/** The projects in a user's hub (their own and the ones they joined), most recent first. */
export function useUserProjects(uid: string | null) {
  const [items, setItems] = useState<UserProject[] | null>(null)
  useEffect(() => {
    if (!uid) return
    return onValue(
      ref(db, `userProjects/${uid}`),
      (snap) =>
        setItems(
          Object.entries((snap.val() ?? {}) as Record<string, Omit<UserProject, 'key'>>)
            .map(([key, v]) => ({ ...v, key }))
            .sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0)),
        ),
      () => setItems([]),
    )
  }, [uid])
  return items
}

export interface StudioMeta {
  owner?: { uid: string; name: string; email: string }
  collaborators?: Record<string, Member>
}

/** Owner and collaborators of the studios of these projects (for the hub's Studio tab). */
export function useStudioMeta(projectIds: string[]) {
  const [meta, setMeta] = useState<Record<string, Record<string, StudioMeta>>>({})
  const key = [...projectIds].sort().join(',')
  useEffect(() => {
    if (!key) return
    const offs = key.split(',').map((pid) =>
      onValue(
        ref(db, `studioMeta/${pid}`),
        (snap) => setMeta((m) => ({ ...m, [pid]: (snap.val() ?? {}) as Record<string, StudioMeta> })),
        () => setMeta((m) => ({ ...m, [pid]: {} })),
      ),
    )
    return () => offs.forEach((o) => o())
  }, [key])
  return useMemo(() => meta, [meta])
}

/** Members of a project (owner + collaborators), for share dialogs. */
export function useMembers(path: string | null) {
  const [members, setMembers] = useState<{ owner: StudioMeta['owner'] | null; collaborators: (Member & { uid: string })[] } | null>(null)
  useEffect(() => {
    if (!path) return
    return onValue(ref(db, path), (snap) => {
      const v = (snap.val() ?? {}) as StudioMeta
      setMembers({
        owner: v.owner ?? null,
        collaborators: Object.entries(v.collaborators ?? {})
          .map(([uid, m]) => ({ ...m, uid }))
          .sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0)),
      })
    })
  }, [path])
  return members
}
