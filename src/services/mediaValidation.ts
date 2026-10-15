import { get, ref, update } from 'firebase/database'
import { useEffect, useMemo, useRef, useState } from 'react'
import { SHARED_MEDIA_PATH, projectMediaPath } from '../types/project'
import { isAdmin, currentUser } from './auth'
import { db } from './firebase'
import { fileTypeOf, logFileActivity } from './fileActivity'
import type { ProjectMedia } from './mediaLibrary'
import { r2KeyOf } from './storage'

/*
 * Keeping media lists honest: library records whose file is gone (deleted on R2 / Cloudinary,
 * outside the app or by an older version) are hidden from pickers and their records cleaned up.
 *
 * Each file is checked with a HEAD request — R2 through this server (/api/r2/o/…), Cloudinary
 * directly. Only a definite "not found" (404 / 410) counts as gone; anything inconclusive (no
 * network, a server error, no permission) keeps the file. Results are cached for a while;
 * 同步雲端 checks again.
 */

const TTL = 10 * 60_000
const CONCURRENCY = 6
type Status = boolean | null // true: exists · false: gone · null: unknown
const cache = new Map<string, { status: Status; at: number }>()

async function head(url: string): Promise<Status> {
  try {
    const res = await fetch(url, { method: 'HEAD', cache: 'no-store' })
    if (res.ok) return true
    return res.status === 404 || res.status === 410 ? false : null
  } catch {
    return null
  }
}

/** Does the file behind `url` still exist? (cached; `force` checks again) */
export async function fileExists(url: string, force = false): Promise<Status> {
  const hit = cache.get(url)
  if (!force && hit && Date.now() - hit.at < TTL && hit.status !== null) return hit.status
  const status = await head(url)
  cache.set(url, { status, at: Date.now() })
  return status
}

/** The entries of `list` whose file is definitely gone. */
export async function findMissing(list: ProjectMedia[], force = false): Promise<ProjectMedia[]> {
  const checkable = list.filter((m) => /^(\/api\/r2\/o\/|https:\/\/res\.cloudinary\.com\/)/.test(m.url))
  const urls = [...new Set(checkable.map((m) => m.url))]
  const gone = new Set<string>()
  let i = 0
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, urls.length) }, async () => {
      while (i < urls.length) {
        const url = urls[i++]
        if ((await fileExists(url, force)) === false) gone.add(url)
      }
    }),
  )
  return checkable.filter((m) => gone.has(m.url))
}

/**
 * Remove the records of files that no longer exist: this project's library, and (admins) the shared
 * Default index. Entries listed live from storage have no record and are skipped.
 */
export async function forgetMissing(projectId: string | null, missing: ProjectMedia[]) {
  const updates: Record<string, null> = {}
  const admin = isAdmin(currentUser())
  // Which index each record lives in: look it up rather than guess from its folder.
  const [mine, shared] = await Promise.all([
    projectId ? get(ref(db, projectMediaPath(projectId))).then((s) => (s.val() ?? {}) as Record<string, unknown>) : Promise.resolve({} as Record<string, unknown>),
    admin ? get(ref(db, SHARED_MEDIA_PATH)).then((s) => (s.val() ?? {}) as Record<string, unknown>) : Promise.resolve({} as Record<string, unknown>),
  ])
  for (const m of missing) {
    if (projectId && m.id in mine) updates[`${projectMediaPath(projectId)}/${m.id}`] = null
    else if (admin && m.id in shared) updates[`${SHARED_MEDIA_PATH}/${m.id}`] = null
  }
  const paths = Object.keys(updates)
  if (!paths.length) return 0
  await update(ref(db), updates)
  for (const p of paths) {
    const m = missing.find((x) => p.endsWith(`/${x.id}`))!
    void logFileActivity({ action: 'delete', name: m.name, fileType: fileTypeOf(m.name, m.kind), storage: m.storage ?? 'cloudinary', url: m.url, key: r2KeyOf(m.url), record: p, projectId: p.startsWith('projects/') ? projectId : null, projectName: p.startsWith(SHARED_MEDIA_PATH) ? 'Default 共用資源庫' : null, from: m.folder, to: '清理失效紀錄（雲端檔案已不存在）' })
  }
  return paths.length
}

/**
 * After the app deletes files from R2: drop the records that pointed at them (this project's
 * library, and the shared Default index for admins), so no picker shows them.
 */
export async function forgetDeletedKeys(projectId: string | null, keys: string[]) {
  if (!keys.length) return 0
  const admin = isAdmin(currentUser())
  const want = new Set(keys)
  const updates: Record<string, null> = {}
  const scan = (base: string, all: Record<string, { url?: string; publicId?: string }>) => {
    for (const [id, m] of Object.entries(all)) if ((m.publicId && want.has(m.publicId)) || (m.url && want.has(r2KeyOf(m.url) ?? ''))) updates[`${base}/${id}`] = null
  }
  if (projectId) scan(projectMediaPath(projectId), ((await get(ref(db, projectMediaPath(projectId)))).val() ?? {}) as Record<string, { url?: string }>)
  if (admin) scan(SHARED_MEDIA_PATH, ((await get(ref(db, SHARED_MEDIA_PATH))).val() ?? {}) as Record<string, { url?: string }>)
  for (const k of keys) cache.set(`/api/r2/o/${k.split('/').map(encodeURIComponent).join('/')}`, { status: false, at: Date.now() })
  if (Object.keys(updates).length) await update(ref(db), updates)
  return Object.keys(updates).length
}

/**
 * A media list with gone files filtered out (and, when `cleanup`, their records removed). Bump
 * `nonce` to check again regardless of the cache.
 */
export function useLiveMedia(list: ProjectMedia[] | null, opts: { projectId: string | null; cleanup: boolean; nonce: number }) {
  const [gone, setGone] = useState<Set<string>>(new Set())
  // Everything found gone while this list is open (cleaned records drop out of `list`, so `gone`
  // alone would undercount).
  const [everGone, setEverGone] = useState<Set<string>>(new Set())
  const [checking, setChecking] = useState(false)
  const [removed, setRemoved] = useState(0)
  const cleaned = useRef(new Set<string>())
  const lastNonce = useRef(opts.nonce)
  const signature = (list ?? []).map((m) => `${m.id}|${m.url}`).join(',')

  useEffect(() => {
    if (!list) return
    let alive = true
    const force = lastNonce.current !== opts.nonce
    lastNonce.current = opts.nonce
    const run = async () => {
      setChecking(true)
      const missing = await findMissing(list, force)
      if (!alive) return
      setGone(new Set(missing.map((m) => m.id)))
      if (missing.length) setEverGone((prev) => new Set([...prev, ...missing.map((m) => m.id)]))
      setChecking(false)
      const fresh = missing.filter((m) => !cleaned.current.has(m.id))
      if (opts.cleanup && fresh.length) {
        fresh.forEach((m) => cleaned.current.add(m.id))
        const n = await forgetMissing(opts.projectId, fresh).catch(() => 0)
        if (alive && n) setRemoved((r) => r + n)
      }
    }
    void run()
    return () => {
      alive = false
    }
  }, [signature, opts.nonce]) // eslint-disable-line react-hooks/exhaustive-deps

  const files = useMemo(() => (list ? list.filter((m) => !gone.has(m.id)) : null), [list, gone])
  return { files, checking, hidden: everGone.size, removed }
}
