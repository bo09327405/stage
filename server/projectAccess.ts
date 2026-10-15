import type { IncomingMessage } from 'node:http'

/*
 * Who may touch which R2 objects, decided by the Realtime Database itself: the server asks the
 * database REST API with the caller's own Firebase ID token, so the answer follows exactly the
 * same security rules as the app (database.rules.json). No admin credentials live on the server.
 *
 * The browser sends its ID token as the `theatre_id` cookie (kept fresh by services/auth.ts),
 * so plain <audio src> / fetch requests to /api/r2 carry it too.
 *
 *   signed in   GET /users?shallow          (rules: auth != null)
 *   admin       GET /projectIndex?shallow   (rules: admins only)
 *   member      GET /projectIndex/{pid}/name
 */

const TTL_MS = 30_000

export interface Caller {
  token: string | null
  uid: string | null
}

/** The caller behind an Authorization / Cookie header pair (Node dev server and the Worker share this). */
export function callerFromHeaders(authorization: string | null | undefined, cookie: string | null | undefined): Caller {
  let token: string | null = null
  if (authorization?.startsWith('Bearer ')) token = authorization.slice(7).trim()
  if (!token) {
    const m = /(?:^|;\s*)theatre_id=([^;]+)/.exec(cookie ?? '')
    if (m) token = decodeURIComponent(m[1])
  }
  if (token && !/^[\w-]+\.[\w-]+\.[\w-]*$/.test(token)) token = null
  // The uid is only used after the database has accepted this same token.
  let uid: string | null = null
  if (token) {
    try {
      const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
      const payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))) as { user_id?: string; sub?: string }
      uid = payload.user_id ?? payload.sub ?? null
    } catch {
      token = null
    }
  }
  return { token, uid }
}

export function callerOf(req: IncomingMessage): Caller {
  return callerFromHeaders(req.headers.authorization, req.headers.cookie)
}

/** Same cleanup as cleanProjectName() in src/types/project.ts (R2 folders are named after projects). */
export function cleanProjectName(name: string, fallback: string) {
  const cleaned = name
    .normalize('NFC')
    .replace(/[\s/\\.:]+/g, '_')
    .replace(/[^\p{L}\p{N}_-]/gu, '')
    .replace(/_+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '')
    .slice(0, 60)
  if (cleaned.toLowerCase() === 'default') return `${cleaned}_${fallback.replace(/[^\w-]/g, '').slice(-6)}`
  return cleaned || fallback
}

export function projectAccess(dbUrl: string | undefined) {
  // Also accepts an emulator URL with its namespace, e.g. http://127.0.0.1:9400/?ns=demo-project.
  let base = ''
  const extra = new URLSearchParams()
  try {
    const u = new URL(dbUrl ?? '')
    base = `${u.origin}${u.pathname}`.replace(/\/+$/, '')
    u.searchParams.forEach((v, k) => extra.set(k, v))
  } catch {
    base = ''
  }
  const cache = new Map<string, { at: number; value: unknown }>()

  async function cached<T>(key: string, job: () => Promise<T>): Promise<T> {
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value as T
    const value = await job()
    cache.set(key, { at: Date.now(), value })
    if (cache.size > 2000) for (const [k, v] of cache) if (Date.now() - v.at > TTL_MS) cache.delete(k)
    return value
  }

  /** GET a database path as the caller: { ok, value } (ok = the rules allowed the read). */
  async function read(path: string, c: Caller, shallow = false): Promise<{ ok: boolean; value: unknown }> {
    if (!base) return { ok: false, value: null }
    return cached(`${c.token ?? '-'}|${path}|${shallow}`, async () => {
      const params = new URLSearchParams(extra)
      if (shallow) params.set('shallow', 'true')
      if (c.token) params.set('auth', c.token)
      const res = await fetch(`${base}/${path}.json?${params}`, { signal: AbortSignal.timeout(10_000) }).catch(() => null)
      if (!res?.ok) return { ok: false, value: null }
      return { ok: true, value: await res.json().catch(() => null) }
    })
  }

  /** The project's index entry as the caller sees it (null if they can't read it). */
  async function project(pid: string, c: Caller) {
    if (!/^[\w-]{1,64}$/.test(pid)) return null
    const r = await read(`projectIndex/${pid}`, c)
    return r.ok ? ((r.value as ProjectEntry | null) ?? null) : null
  }
  /** May the caller change this project's files: an admin, or a member of a project that isn't read-only. */
  async function canWrite(pid: string, c: Caller) {
    if (await isAdmin(c)) return true
    const p = await project(pid, c)
    if (!p || !c.uid) return false
    const member = p.owner?.uid === c.uid || !!p.collaborators?.[c.uid]
    return member && !(p.isLocked || p.isMasterTemplate || p.isArchived)
  }
  /**
   * Media folders the caller may upload to / delete from: their editable projects'. The shared
   * Default folders are admin-only (everyone can read them).
   */
  async function writableFolders(c: Caller): Promise<Set<string>> {
    const out = new Set<string>()
    if (!c.uid) return out
    const mine = (await read(`userProjects/${c.uid}`, c)).value as Record<string, { projectId?: string }> | null
    const ids = [...new Set(Object.values(mine ?? {}).map((e) => e.projectId).filter((x): x is string => !!x))]
    await Promise.all(
      ids.map(async (pid) => {
        const p = await project(pid, c)
        if (p?.name && (await canWrite(pid, c))) out.add(cleanProjectName(p.name, pid))
      }),
    )
    return out
  }

  const signedIn = async (c: Caller) => (await read('users', c, true)).ok
  const isAdmin = async (c: Caller) => (await read('projectIndex', c, true)).ok
  const isMember = async (pid: string, c: Caller) => /^[\w-]{1,64}$/.test(pid) && (await read(`projectIndex/${pid}/name`, c)).ok
  const projectKind = async (pid: string, c: Caller) => ((await read(`projectIndex/${pid}/kind`, c)).value as string | null) ?? null
  /** R2 folder names (theatre/daw|cues|hits/<name>) of the caller's projects, plus the shared Default. */
  async function folders(c: Caller): Promise<Set<string>> {
    const out = new Set(['Default'])
    if (!c.uid) return out
    const mine = (await read(`userProjects/${c.uid}`, c)).value as Record<string, { projectId?: string }> | null
    const ids = [...new Set(Object.values(mine ?? {}).map((e) => e.projectId).filter((x): x is string => !!x))]
    await Promise.all(
      ids.map(async (pid) => {
        const name = (await read(`projectIndex/${pid}/name`, c)).value
        if (typeof name === 'string') out.add(cleanProjectName(name, pid))
      }),
    )
    return out
  }
  /** Is this module the caller's own (or are they an admin)? */
  async function ownsModule(id: string, c: Caller) {
    const by = (await read(`surfaceModules/${id}/by/uid`, c)).value
    return by === c.uid || (await isAdmin(c))
  }

  return { signedIn, isAdmin, isMember, projectKind, folders, ownsModule, canWrite, writableFolders }
}

export type ProjectAccess = ReturnType<typeof projectAccess>

interface ProjectEntry {
  name?: string
  owner?: { uid?: string }
  collaborators?: Record<string, unknown>
  isLocked?: boolean
  isMasterTemplate?: boolean
  isArchived?: boolean
}

/** The project a key belongs to, when its path says so. */
export function projectOfKey(key: string): { pid: string; kind: 'daw-file' | 'setcue-file' | 'public' } | null {
  let m = /^theatre\/projects\/([\w-]+)\/[^/]+$/.exec(key)
  if (m) return { pid: m[1], kind: 'daw-file' }
  m = /^theatre\/setcue-projects\/([\w-]+)\.json$/.exec(key)
  if (m) return { pid: m[1], kind: 'setcue-file' }
  m = /^theatre\/public\/([\w-]+)\//.exec(key)
  if (m) return { pid: m[1], kind: 'public' }
  return null
}
