import { putR2 } from './storage'
import { byUser } from './auth'

/*
 * Embedded version history for auto-saved project files on R2.
 *
 * The project file (theatre/projects/{show}/{studio}.json, theatre/setcue-projects/{pid}.json)
 * keeps its normal shape — so importing, restoring and the R2 managers read it as before — plus:
 *
 *   savedAt      when the current content was saved
 *   summary      what changed in it, in words
 *   currentKind  how it was saved: auto / manual / restore
 *   history      up to 15 earlier versions, newest first: { at, kind, summary, state }
 *   restore      set while an older version is applied: which one, and the "latest" to go back to
 *
 * Every save reads the file first and pushes its content onto `history`, then overwrites the same
 * object — one file per project, nothing else is written. Auto-saves arrive every few seconds of
 * editing, so consecutive auto versions less than a minute apart are merged into one entry;
 * manual saves and "before restore" points are always kept.
 */

export const HISTORY_LIMIT = 15
const MERGE_WINDOW_MS = 60_000

export type VersionKind = 'auto' | 'manual' | 'beforeRestore' | 'restore'
type Json = Record<string, unknown>

export interface HistoryEntry<S = Json> {
  /** When this version was saved (ms). */
  at: number
  /** Who saved it (signed-in user), when known. */
  by?: SavedBy | null
  kind: VersionKind
  summary: string
  /** The project content of this version (the file minus its history fields). */
  state: S
}

export interface RestoreMarker {
  /** The version now applied. */
  toAt: number
  /** The history entry holding the state from just before restoring ("Jump to Latest"). */
  latestAt: number
  restoredAt: number
}

/** Who saved a version. */
export interface SavedBy {
  uid: string
  name: string
  email: string
  photo: string
}

export interface VersionedFile<S = Json> {
  savedAt?: number
  savedBy?: SavedBy | null
  summary?: string
  currentKind?: VersionKind
  history?: HistoryEntry<S>[]
  restore?: RestoreMarker | null
}

const ENVELOPE = ['savedAt', 'savedBy', 'summary', 'currentKind', 'history', 'restore', 'exportedAt'] as const

/** The project content of a file: everything except the history fields and timestamps. */
export function contentOf(file: Json): Json {
  const out: Json = {}
  for (const [k, v] of Object.entries(file)) if (!(ENVELOPE as readonly string[]).includes(k)) out[k] = v
  return out
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export type Summarize = (before: Json | null, after: Json) => string

async function readFile(key: string): Promise<(Json & VersionedFile) | null> {
  const res = await fetch(`/api/r2/o/${key.split('/').map(encodeURIComponent).join('/')}`, { cache: 'no-store' })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`讀取雲端版本失敗（HTTP ${res.status}）`)
  return (await res.json()) as Json & VersionedFile
}

/**
 * Save `file` over `key`, moving the content already there into its history.
 * Returns false when nothing changed (no write).
 */
export async function saveWithHistory(key: string, file: Json, { kind, summarize, restore }: { kind: VersionKind; summarize: Summarize; restore?: RestoreMarker | null }): Promise<boolean> {
  const prev = await readFile(key)
  const next = contentOf(file)
  const now = Date.now()
  let history = [...(prev?.history ?? [])]
  if (prev) {
    const prevState = contentOf(prev)
    // Same content: only a manual save needs recording (it marks the current version as kept).
    if (same(prevState, next) && restore === undefined) {
      if (kind !== 'manual' || prev.currentKind === 'manual') return false
      await putR2(key, JSON.stringify({ ...prev, currentKind: 'manual' }))
      return true
    }
    const prevKind = prev.currentKind ?? 'auto'
    // While editing, auto-saves come every few seconds: keep about one per minute. The newest
    // auto entry is dropped when the one before it is less than a minute older than what's being
    // pushed, so entries stay roughly a minute apart over a long session.
    const [top, beforeTop] = history
    if (prevKind === 'auto' && top?.kind === 'auto' && beforeTop && (prev.savedAt ?? now) - beforeTop.at < MERGE_WINDOW_MS) history.shift()
    const older = history[0]?.state ?? null
    history.unshift({ at: prev.savedAt ?? now, by: prev.savedBy ?? null, kind: prevKind, summary: summarize(older, prevState), state: prevState })
  }
  history = history.slice(0, HISTORY_LIMIT)
  const out: Json & VersionedFile = {
    ...file,
    savedAt: now,
    savedBy: byUser(),
    summary: summarize(prev ? contentOf(prev) : null, next),
    currentKind: kind,
    history,
    restore: restore === undefined ? (prev?.restore ?? null) : restore,
  }
  await putR2(key, JSON.stringify(out))
  return true
}

/** The file with its history, or null when it doesn't exist yet. */
export const loadVersions = (key: string) => readFile(key)

/**
 * Apply an older version: the live state right now is kept as a "before restore" entry (so
 * "Jump to Latest" can bring it back), the file's current content becomes the old version, and
 * `apply` writes it to the live project.
 */
export async function restoreVersion(
  key: string,
  entry: HistoryEntry,
  { live, apply, summarize }: { live: Json; apply: (state: Json) => Promise<void>; summarize: Summarize },
) {
  const file = await readFile(key)
  if (!file) throw new Error('雲端還沒有這個專案的版本')
  const now = Date.now()
  const history = [...(file.history ?? [])]
  const current = contentOf(file)
  let latestAt: number
  if (file.restore && same(current, live)) {
    // Already on a restored version with no new edits: the way back stays the same.
    latestAt = file.restore.latestAt
  } else {
    const unsaved = !same(current, live)
    // The saved current version keeps its own kind and summary; flagged as the way back unless
    // there are newer unsaved edits, which then become the "before restore" version on top.
    history.unshift({
      at: file.savedAt ?? now,
      by: file.savedBy ?? null,
      kind: unsaved ? (file.currentKind ?? 'auto') : 'beforeRestore',
      summary: unsaved ? (file.summary ?? '') : `還原前的最新版本 · ${file.summary ?? ''}`,
      state: current,
    })
    if (unsaved) history.unshift({ at: now, by: byUser(), kind: 'beforeRestore', summary: '還原前的最新版本 · ' + summarize(current, live), state: live })
    latestAt = history[0].at
  }
  await putR2(
    key,
    JSON.stringify({
      ...file,
      ...entry.state,
      savedAt: now + 1,
      savedBy: byUser(),
      summary: `還原為 ${formatVersionTime(entry.at)} 的版本`,
      currentKind: 'restore',
      history: history.slice(0, HISTORY_LIMIT),
      restore: { toAt: entry.at, latestAt, restoredAt: now },
    }),
  )
  await apply(entry.state)
}

/** Undo a restore: apply the "before restore" version again and clear the marker. */
export async function jumpToLatest(key: string, { apply }: { apply: (state: Json) => Promise<void> }) {
  const file = await readFile(key)
  const marker = file?.restore
  if (!file || !marker) throw new Error('目前不是還原後的狀態')
  const latest = file.history?.find((h) => h.at === marker.latestAt)
  if (!latest) throw new Error('找不到還原前的版本（可能已超過 15 個版本被移除）')
  await putR2(
    key,
    JSON.stringify({ ...file, ...latest.state, savedAt: Date.now(), savedBy: byUser(), summary: '返回最新版本', currentKind: 'manual', restore: null }),
  )
  await apply(latest.state)
}

/** Leave the restored version in place and forget the way back. */
export async function dismissRestore(key: string) {
  const file = await readFile(key)
  if (file?.restore) await putR2(key, JSON.stringify({ ...file, restore: null }))
}

export const formatVersionTime = (ms: number) =>
  new Date(ms).toLocaleString('zh-TW', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })

/* ---------- change summaries ---------- */

const rec = (v: unknown): Record<string, Json> => (v && typeof v === 'object' ? (v as Record<string, Json>) : {})
function diff(a: unknown, b: unknown) {
  const A = rec(a)
  const B = rec(b)
  const added = Object.keys(B).filter((k) => !(k in A))
  const removed = Object.keys(A).filter((k) => !(k in B))
  const changed = Object.keys(B).filter((k) => k in A && !same(A[k], B[k]))
  return { added, removed, changed, A, B }
}
const names = (ids: string[], from: Record<string, Json>, field: string) => {
  const list = ids.map((id) => String(from[id]?.[field] ?? '').trim()).filter(Boolean)
  return list.length ? `「${list.slice(0, 2).join('」「')}」${list.length > 2 ? ` 等 ${list.length} 個` : ''}` : ''
}
const join = (parts: (string | false | 0 | null | undefined)[], fallback: string) => parts.filter(Boolean).join('；') || fallback

/** DAW Studio: tracks, regions, sections, automation, mix. */
export const summarizeStudio: Summarize = (before, after) => {
  const b = rec(before?.studio)
  const a = rec(after.studio)
  if (!before) return `建立（${Object.keys(rec(a.tracks)).length} 軌、${Object.keys(rec(a.regions)).length} 片段）`
  const t = diff(b.tracks, a.tracks)
  const r = diff(b.regions, a.regions)
  const s = diff(b.sections, a.sections)
  const auto = t.changed.filter((id) => !same(t.A[id]?.automation, t.B[id]?.automation)).length
  const mix = t.changed.length - auto
  return join(
    [
      before.name !== after.name && `重新命名為「${String(after.name)}」`,
      t.added.length && `新增音軌 ${names(t.added, t.B, 'name') || t.added.length}`,
      t.removed.length && `刪除音軌 ${names(t.removed, t.A, 'name') || t.removed.length}`,
      r.added.length && `新增 ${r.added.length} 個片段`,
      r.removed.length && `刪除 ${r.removed.length} 個片段`,
      r.changed.length && `調整 ${r.changed.length} 個片段`,
      s.added.length + s.removed.length + s.changed.length > 0 && `區段變更 ${s.added.length + s.removed.length + s.changed.length} 處`,
      auto && `自動化曲線 ${auto} 軌`,
      mix > 0 && `音軌設定 ${mix} 軌`,
      !same(b.masterVolume, a.masterVolume) && '主音量',
    ],
    '細部調整',
  )
}

/** Set Cue: cue lists, hits, scripts of every version; surfaces, triggers, media. */
export const summarizeSetCue: Summarize = (before, after) => {
  const bd = rec(before?.data)
  const ad = rec(after.data)
  const bv = rec(bd.versions)
  const av = rec(ad.versions)
  const total = (vs: Record<string, Json>) => Object.values(vs).reduce((n, v) => n + Object.keys(rec(v.cueList)).length, 0)
  if (!before) return `建立（${Object.keys(av).length} 個版本、${total(av)} 個 Cue）`
  const parts: (string | false)[] = []
  const bp = rec(before.project)
  const ap = rec(after.project)
  if (bp.name !== ap.name) parts.push(`專案改名為「${String(ap.name)}」`)
  const vers = diff(bp.versions, ap.versions)
  if (vers.added.length) parts.push(`新增版本 ${names(vers.added, vers.B, 'name')}`)
  if (vers.removed.length) parts.push(`刪除版本 ${names(vers.removed, vers.A, 'name')}`)
  for (const vid of Object.keys(av)) {
    const c = diff(bv[vid]?.cueList, av[vid]?.cueList)
    if (c.added.length) parts.push(`新增 Cue ${names(c.added, c.B, 'title') || c.added.length}`)
    if (c.removed.length) parts.push(`刪除 Cue ${names(c.removed, c.A, 'title') || c.removed.length}`)
    if (c.changed.length) parts.push(`修改 Cue ${names(c.changed, c.B, 'title') || c.changed.length}`)
    const h = diff(bv[vid]?.hits, av[vid]?.hits)
    if (h.added.length + h.removed.length + h.changed.length) parts.push(`Hits 變更 ${h.added.length + h.removed.length + h.changed.length} 個`)
    if (!same(bv[vid]?.script, av[vid]?.script)) parts.push('筆記內容')
  }
  if (!same(bd.surfaces, ad.surfaces)) parts.push('控制面板')
  if (!same(bd.triggers, ad.triggers)) parts.push('觸發規則')
  if (!same(bd.media, ad.media)) parts.push('素材庫')
  return join(parts, '細部調整')
}
