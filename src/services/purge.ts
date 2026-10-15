import { get, ref, serverTimestamp, update } from 'firebase/database'
import { SHARED_MEDIA_PATH, SHARED_STUDIO_FILES_PATH, cleanProjectName } from '../types/project'
import { tagId } from './adminFiles'
import { isAdmin, type AppUser } from './auth'
import { db } from './firebase'
import { deleteR2, listR2, r2KeyOf, type R2Object } from './storage'

/*
 * Permanent delete from the admin trash ("徹底刪除" / "清空回收桶").
 *
 *   1. Plan (dry run): what the item owns on R2 — files under its project id (auto-saves, Set Cue
 *      file, published MP3s) and its media folders (theatre/cues|hits|daw/<project name>/) — and
 *      who else still uses any of them: live projects, other trashed projects, the Default library.
 *   2. Back up: every owned file someone else still uses is copied into that user's folder (or
 *      Default), and their references are rewritten to the copy, so nothing else stops playing.
 *   3. Purge: delete the remaining files from R2 and every trace in the database — the trash
 *      entry, project data (cues, automation, activity log, intercom chat…), members, invite,
 *      template listing, hub entries, file labels.
 *
 * Kept on purpose (retention policy): audience uploads on Cloudinary — their records move to
 * audienceArchive/{pid} and stay in the audience space. Operator files on Cloudinary from before
 * R2 can't be deleted from here and are reported.
 */

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object'
const AREAS = ['cues', 'hits', 'daw'] as const

interface TrashIndexEntry {
  type?: 'project' | 'studio'
  name?: string
  parentProjectId?: string
  studioId?: string
}

/** Something that refers to files: a live project, a trashed one, or the Default library. */
interface Holder {
  id: string
  name: string
  /** Database root of its data (projects/{id}, trash/{id}/data, sharedMedia/default…). */
  root: string
  /** Folder name for backups (theatre/<area>/<folder>/). */
  folder: string
}

export interface PurgeBackup {
  key: string
  toKey: string
  holder: string
  /** Database paths that will point at the copy. */
  paths: number
}

export interface PurgePlan {
  items: { id: string; name: string; type: 'project' | 'studio' }[]
  /** R2 objects to delete. */
  deleteKeys: { key: string; size: number }[]
  bytes: number
  backups: PurgeBackup[]
  /** Owned files kept because others use them and they live in a shared place (studio purge). */
  kept: { key: string; reason: string }[]
  /** Database paths removed. */
  dbPaths: string[]
  audienceKept: number
  cloudinaryKept: number
  /** Internal: reference rewrites per backup. */
  rewrites: { path: string; value: string }[]
  archives: Record<string, unknown>
}

/** Every string under `value` with its database path. */
function walk(value: unknown, path: string, out: (path: string, s: string) => void) {
  if (typeof value === 'string') out(path, value)
  else if (isObj(value)) for (const [k, v] of Object.entries(value)) walk(v, `${path}/${k}`, out)
}

/** The R2 key a string refers to (an /api/r2/o/… URL or a bare theatre/… key). */
const keyOf = (s: string) => r2KeyOf(s) ?? (/^theatre\/[^\s?#]+\.[a-z0-9]+$/i.test(s) ? s : null)
const r2UrlOf = (key: string) => `/api/r2/o/${key.split('/').map(encodeURIComponent).join('/')}`

async function listAll(): Promise<R2Object[]> {
  const lists = await Promise.all([
    ...AREAS.flatMap((a) => [listR2(`theatre/${a}/`, 'media'), listR2(`theatre/${a}/`, 'raw')]),
    listR2('theatre/projects/', 'raw'),
    listR2('theatre/setcue-projects/', 'raw'),
    listR2('theatre/public/', 'media'),
  ])
  return [...new Map(lists.flatMap((l) => l ?? []).map((o) => [o.key, o])).values()]
}

/** Plan the permanent delete of these trash entries (nothing is changed). */
export async function planPurge(ids: string[], user: AppUser | null): Promise<PurgePlan> {
  let trashIds = [...ids]
  if (!isAdmin(user)) throw new Error('只有管理員可以徹底刪除')
  const [trashSnap, trashIndexSnap, projectsSnap, indexSnap, sharedSnap, studioFilesSnap, objects] = await Promise.all([
    get(ref(db, 'trash')),
    get(ref(db, 'trashIndex')),
    get(ref(db, 'projects')),
    get(ref(db, 'projectIndex')),
    get(ref(db, SHARED_MEDIA_PATH)),
    get(ref(db, SHARED_STUDIO_FILES_PATH)),
    listAll(),
  ])
  const trash = (trashSnap.val() ?? {}) as Record<string, Json>
  const tIndex = (trashIndexSnap.val() ?? {}) as Record<string, TrashIndexEntry>
  const live = (projectsSnap.val() ?? {}) as Record<string, Json>
  const index = (indexSnap.val() ?? {}) as Record<string, { name?: string }>
  const sizeOf = new Map(objects.map((o) => [o.key, o.size]))
  // A purged project takes its separately trashed studios along (they could never be restored).
  const purging = new Set(trashIds)
  for (const [tid, e] of Object.entries(tIndex)) if (e.type === 'studio' && e.parentProjectId && purging.has(e.parentProjectId)) purging.add(tid)
  trashIds = [...purging].sort((a, b) => Number(tIndex[a]?.type === 'studio') - Number(tIndex[b]?.type === 'studio'))

  // Holders that stay: live projects, trash entries not being purged, the Default libraries.
  const holders: { holder: Holder; data: unknown }[] = []
  for (const [pid, data] of Object.entries(live)) holders.push({ holder: { id: pid, name: index[pid]?.name ?? pid, root: `projects/${pid}`, folder: cleanProjectName(index[pid]?.name ?? pid, pid) }, data })
  for (const [tid, t] of Object.entries(trash)) {
    if (purging.has(tid)) continue
    const e = tIndex[tid] ?? {}
    const name = String(e.name ?? (isObj(t.index) ? t.index.name : tid))
    holders.push({ holder: { id: tid, name: `${name}（回收桶）`, root: `trash/${tid}/data`, folder: e.type === 'studio' ? cleanProjectName(index[e.parentProjectId ?? '']?.name ?? name, e.parentProjectId ?? tid) : cleanProjectName(name, tid) }, data: t.data })
  }
  holders.push({ holder: { id: 'default-media', name: 'Default 共用資源庫', root: SHARED_MEDIA_PATH, folder: 'Default' }, data: sharedSnap.val() })
  holders.push({ holder: { id: 'default-studio', name: 'Default 共用資源庫', root: SHARED_STUDIO_FILES_PATH, folder: 'Default' }, data: studioFilesSnap.val() })

  // Who refers to which key, and where.
  const refs = new Map<string, { holder: Holder; path: string; raw: string }[]>()
  for (const { holder, data } of holders)
    walk(data, holder.root, (path, s) => {
      const key = keyOf(s)
      if (!key) return
      if (!refs.has(key)) refs.set(key, [])
      refs.get(key)!.push({ holder, path, raw: s })
    })

  // Folder names still in use by someone else (never purge a shared folder wholesale).
  const foldersInUse = new Set<string>(['Default', ...holders.map((h) => h.holder.folder)])

  const plan: PurgePlan = { items: [], deleteKeys: [], bytes: 0, backups: [], kept: [], dbPaths: [], audienceKept: 0, cloudinaryKept: 0, rewrites: [], archives: {} }
  const toDelete = new Set<string>()
  const usersSnap = await get(ref(db, 'userProjects'))
  const hubs = (usersSnap.val() ?? {}) as Record<string, Record<string, { projectId?: string; studioId?: string }>>
  const tagsSnap = await get(ref(db, 'mediaTags'))
  const tags = (tagsSnap.val() ?? {}) as Record<string, unknown>

  for (const tid of trashIds) {
    const t = trash[tid]
    const e = tIndex[tid] ?? {}
    if (!t && !e) continue
    const studio = e.type === 'studio' || t?.type === 'studio'
    const name = String(e.name ?? (isObj(t?.index) ? (t.index as Json).name : tid))
    plan.items.push({ id: tid, name, type: studio ? 'studio' : 'project' })
    plan.dbPaths.push(`trash/${tid}`, `trashIndex/${tid}`)

    // Strings in the item's own data (what it used).
    const usedKeys = new Set<string>()
    walk(t?.data, '', (_p, s) => {
      const k = keyOf(s)
      if (k) usedKeys.add(k)
      else if (s.startsWith('https://res.cloudinary.com/')) plan.cloudinaryKept++
    })

    let owned: string[]
    if (studio) {
      const pid = String(e.parentProjectId ?? t?.parentProjectId ?? '')
      const sid = String(e.studioId ?? t?.studioId ?? '')
      const seg = cleanProjectName(index[pid]?.name ?? '', pid)
      // Its auto-save, and audio in the parent's studio folder that nothing else uses.
      owned = [`theatre/projects/${pid}/${sid}.json`, ...[...usedKeys].filter((k) => k.startsWith(`theatre/daw/${seg}/`))]
      for (const k of owned) {
        if (!sizeOf.has(k)) continue
        if (refs.get(k)?.length) plan.kept.push({ key: k, reason: `仍被「${[...new Set(refs.get(k)!.map((r) => r.holder.name))].join('、')}」使用` })
        else toDelete.add(k)
      }
      for (const [uid, items] of Object.entries(hubs)) for (const [key, it] of Object.entries(items ?? {})) if (it.projectId === pid && it.studioId === sid) plan.dbPaths.push(`userProjects/${uid}/${key}`)
      continue
    }

    // A whole project: files under its id, and its media folders (if no one else has that folder name).
    const pid = tid
    const seg = cleanProjectName(name, pid)
    const folderShared = foldersInUse.has(seg)
    owned = objects
      .map((o) => o.key)
      .filter(
        (k) =>
          k.startsWith(`theatre/projects/${pid}/`) ||
          k === `theatre/setcue-projects/${pid}.json` ||
          k.startsWith(`theatre/public/${pid}/`) ||
          (!folderShared && AREAS.some((a) => k.startsWith(`theatre/${a}/${seg}/`))),
      )
    // With a folder name another project also uses, only the files this project itself used go.
    if (folderShared) for (const k of usedKeys) if (AREAS.some((a) => k.startsWith(`theatre/${a}/${seg}/`)) && sizeOf.has(k)) owned.push(k)

    for (const k of new Set(owned)) {
      const users = refs.get(k) ?? []
      // Shared: one copy per holder that still uses it, then point their references at the copy.
      const byHolder = new Map<string, { holder: Holder; refs: typeof users }>()
      for (const r of users) {
        if (!byHolder.has(r.holder.id)) byHolder.set(r.holder.id, { holder: r.holder, refs: [] })
        byHolder.get(r.holder.id)!.refs.push(r)
      }
      let keep = false
      for (const { holder, refs: list } of byHolder.values()) {
        const area = AREAS.find((a) => k.startsWith(`theatre/${a}/`)) ?? 'daw'
        const toKey = `theatre/${area}/${holder.folder}/${k.split('/').pop()}`
        if (toKey === k) {
          // Already in the user's own folder (same folder name): just keep it.
          keep = true
          plan.kept.push({ key: k, reason: `在「${holder.name}」的資料夾裡，保留` })
          continue
        }
        plan.backups.push({ key: k, toKey, holder: holder.name, paths: list.length })
        for (const r of list) plan.rewrites.push({ path: r.path, value: r.raw === k ? toKey : r.raw.startsWith('/api/r2/o/') ? r2UrlOf(toKey) : toKey })
      }
      if (!keep) toDelete.add(k)
    }

    // Database traces beyond the trash entry.
    const data = isObj(t?.data) ? t.data : {}
    const uploads = isObj(data.uploads) ? data.uploads : null
    if (uploads) {
      plan.audienceKept += Object.keys(uploads).length
      plan.archives[`audienceArchive/${pid}`] = { name, archivedAt: serverTimestamp(), uploads }
    }
    plan.dbPaths.push(`projects/${pid}`, `projectIndex/${pid}`, `studioMeta/${pid}`, `projectInvites/${pid}`, `templates/${pid}`)
    for (const [uid, items] of Object.entries(hubs)) for (const [key, it] of Object.entries(items ?? {})) if (it.projectId === pid) plan.dbPaths.push(`userProjects/${uid}/${key}`)
  }

  plan.deleteKeys = [...toDelete].map((key) => ({ key, size: sizeOf.get(key) ?? 0 }))
  plan.bytes = plan.deleteKeys.reduce((n, k) => n + k.size, 0)
  for (const { key } of plan.deleteKeys) if (tags[tagId(key)]) plan.dbPaths.push(`mediaTags/${tagId(key)}`)
  plan.dbPaths = [...new Set(plan.dbPaths)]
  return plan
}

/**
 * Carry out a plan: back up shared files (copy + rewrite references), archive audience records,
 * remove the database traces, then delete the files from R2. Returns what was done.
 */
export async function executePurge(plan: PurgePlan, user: AppUser | null, onStep?: (text: string) => void) {
  if (!isAdmin(user)) throw new Error('只有管理員可以徹底刪除')
  // 1. Backups first: if a copy fails nothing has been deleted yet.
  const done = new Set<string>()
  for (const b of plan.backups) {
    if (done.has(b.toKey)) continue
    onStep?.(`備份「${b.key.split('/').pop()}」到 ${b.holder}…`)
    const res = await fetch('/api/r2/copy', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: b.key, to: b.toKey }) })
    if (!res.ok) throw new Error(`備份失敗（${b.key}）：${((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? res.status}；尚未刪除任何東西`)
    done.add(b.toKey)
  }
  onStep?.('更新引用與清除資料庫…')
  const updates: Record<string, unknown> = { ...plan.archives }
  for (const r of plan.rewrites) updates[r.path] = r.value
  for (const p of plan.dbPaths) updates[p] = null
  await update(ref(db), updates)
  // 2. Files last.
  const keys = plan.deleteKeys.map((k) => k.key)
  let deleted = 0
  for (let i = 0; i < keys.length; i += 400) {
    onStep?.(`刪除 R2 檔案 ${Math.min(i + 400, keys.length)} / ${keys.length}…`)
    deleted += (await deleteR2(keys.slice(i, i + 400))).length
  }
  return { deleted, backups: done.size, items: plan.items.length }
}
