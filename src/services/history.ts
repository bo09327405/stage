import { notifyReadOnly, readOnlyReason } from './projectLock'
import { get, limitToLast, onValue, push, query, ref, serverTimestamp, set, update } from 'firebase/database'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { byUser } from './auth'
import { db } from './firebase'

/**
 * Undo / Redo for edits (cue list, hits, control surfaces, triggers, script notes).
 *
 * Every edit goes through `recordedUpdate`, which reads the current value of each path it is about
 * to change, writes the new values in one atomic multi-path update, and keeps both sides. Undo
 * writes the "before" values back, redo the "after" values. Live show state (GO, standby, fader
 * positions, pause) never goes through here, so undo can't stop or restart a running show.
 *
 * The history is per browser tab and per project, keeps the last MAX_STEPS steps, and only holds
 * this tab's own edits; edits from other devices are not undone.
 */

export const MAX_STEPS = 20
/** Consecutive edits with the same key within this window merge into one step (typing, dragging a slider). */
const COALESCE_MS = 2500

export type HistoryGroup = 'cue' | 'hit' | 'surface' | 'trigger' | 'note' | 'studio'

export const GROUP_ICONS: Record<HistoryGroup, string> = {
  cue: '♪',
  hit: '◉',
  surface: '🎛',
  trigger: '⚡',
  note: '📝',
  studio: '🎚',
}

interface Change {
  path: string
  before: unknown
  after: unknown
}

export interface HistoryEntry {
  id: number
  label: string
  group: HistoryGroup
  details: string[]
  changes: Change[]
  at: number
  coalesceKey?: string
  /** Who made the step (signed-in user). */
  by?: ActivityBy | null
  /** Its record in the project's shared activity log (so a merged step updates the same line). */
  activityKey?: string
}

/** Who did something, as shown in history and activity logs. */
export interface ActivityBy {
  uid: string
  name: string
  email: string
  photo: string
}

/** One line of a project's shared activity log: projects/{pid}/activity/{key}. */
export interface ActivityEntry {
  key: string
  at: number
  label: string
  group: HistoryGroup | 'undo'
  details?: string[]
  by: ActivityBy | null
}

/** Everyone's edits to a project, newest last (shared by all collaborators). */
const activityPath = (scope: string) => `projects/${scope}/activity`
async function logActivity(entry: Omit<ActivityEntry, 'key' | 'at'>, key?: string): Promise<string | undefined> {
  const scope = state.scope
  if (!scope) return undefined
  const node = key ? ref(db, `${activityPath(scope)}/${key}`) : push(ref(db, activityPath(scope)))
  await set(node, { ...entry, details: entry.details?.slice(0, 4) ?? null, at: serverTimestamp() }).catch(() => {})
  return node.key ?? undefined
}

interface HistoryState {
  scope: string | null
  entries: HistoryEntry[]
  /** How many entries are applied; entries[index…] are undone (redo-able). */
  index: number
  busy: boolean
  /** Last undo/redo result, for a short notice. */
  notice: { text: string; tone: 'ok' | 'warn'; at: number } | null
}

let state: HistoryState = { scope: null, entries: [], index: 0, busy: false, notice: null }
const listeners = new Set<() => void>()
let nextId = 1
const setState = (next: Partial<HistoryState>) => {
  state = { ...state, ...next }
  for (const l of listeners) l()
}

/* ---------- value helpers ---------- */

/** RTDB drops nulls and empty containers; compare values the way the database stores them. */
function canonical(value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (Array.isArray(value)) {
    const items = value.map(canonical)
    return items.some((v) => v !== null) ? items : null
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as object).sort()) {
      const v = canonical((value as Record<string, unknown>)[key])
      if (v !== null) out[key] = v
    }
    return Object.keys(out).length ? out : null
  }
  return value
}
const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
const clone = <T>(v: T): T => (v === undefined ? (null as T) : structuredClone(v))

const isUnder = (path: string, ancestor: string) => path.startsWith(`${ancestor}/`)
/** Set `value` at the relative `sub` path inside `root` (creating objects on the way). */
function setIn(root: unknown, sub: string, value: unknown): unknown {
  const keys = sub.split('/')
  const top = root && typeof root === 'object' ? { ...(root as Record<string, unknown>) } : {}
  let node = top
  keys.forEach((key, i) => {
    if (i === keys.length - 1) node[key] = value
    else {
      const child = node[key]
      node[key] = child && typeof child === 'object' ? { ...(child as Record<string, unknown>) } : {}
      node = node[key] as Record<string, unknown>
    }
  })
  return top
}

/** Fold `next` into `prev` (prev happened first). Keeps the earliest "before" of every location. */
function mergeChanges(prev: Change[], next: Change[]): Change[] {
  let out = [...prev]
  for (const c of next) {
    const existing = out.find((p) => p.path === c.path)
    if (existing) {
      existing.after = c.after
      continue
    }
    const ancestor = out.find((p) => isUnder(c.path, p.path))
    if (ancestor) {
      ancestor.after = setIn(ancestor.after, c.path.slice(ancestor.path.length + 1), c.after)
      continue
    }
    // `c` covers earlier, smaller changes: its "before" must show them as they were originally.
    const inside = out.filter((p) => isUnder(p.path, c.path))
    let before = c.before
    for (const p of inside) before = setIn(before, p.path.slice(c.path.length + 1), p.before)
    out = out.filter((p) => !inside.includes(p))
    out.push({ path: c.path, before, after: c.after })
  }
  return out
}

/* ---------- describing changes ---------- */

const FIELD_LABELS: Record<string, string> = {
  cueNumber: '編號',
  title: '標題',
  subtitle: '副標題',
  group: '群組',
  type: '類型',
  fadeInTime: '淡入',
  fadeOutTime: '淡出',
  volume: '音量',
  preWaitTime: 'Pre-Wait',
  postWaitTime: 'Post-Wait',
  followMode: '接續模式',
  stopOthers: '對其他 Cue',
  duration: '長度',
  mediaStartTime: '起點',
  mediaEndTime: '終點',
  loop: '循環',
  targetMode: '派發對象',
  targetIds: '派發名單',
  text: '文字',
  label: '名稱',
  color: '顏色',
  x: 'X',
  y: 'Y',
  w: '寬',
  h: '高',
  actions: '動作',
  display: '按鈕類型',
  noteText: '筆記內容',
  noteSource: '筆記來源',
  noteNotionUrl: 'Notion 網址',
  notionUrl: 'Notion 網址',
  source: '筆記模式',
  noteFont: '筆記字級',
  monitorTap: '點選動作',
  momentary: 'Momentary',
  input: '外部輸入',
  enabled: '啟用',
  match: '觸發條件',
  action: '動作',
  order: '順序',
  name: '名稱',
  mode: '樣式',
  free: '自由排列',
  start: '位置',
  offset: '起點',
  pitch: '音高',
  reverse: '反轉',
  cleanup: '人聲清理',
  muted: '靜音',
  gain: '增益',
  pan: '聲相',
  solo: 'Solo',
  mute: '靜音',
  comment: '註解',
  automation: '自動化',
  masterVolume: '主音量',
}

function short(v: unknown): string {
  if (v === null || v === undefined) return '（無）'
  if (typeof v === 'boolean') return v ? '開' : '關'
  if (typeof v === 'number') return String(Math.round(v * 1000) / 1000)
  if (typeof v === 'string') return v.length > 18 ? `「${v.slice(0, 18)}…」` : `「${v}」`
  return '{…}'
}

/** Human readable "field: old → new" lines for the history panel. */
export function describeChanges(changes: Change[], limit = 6): string[] {
  const lines: string[] = []
  for (const c of changes) {
    const leaf = c.path.split('/').at(-1)!
    const b = canonical(c.before)
    const a = canonical(c.after)
    if (b !== null && a !== null && typeof b === 'object' && typeof a === 'object' && !Array.isArray(a)) {
      const keys = new Set([...Object.keys(b as object), ...Object.keys(a as object)])
      for (const k of keys) {
        const bv = (b as Record<string, unknown>)[k]
        const av = (a as Record<string, unknown>)[k]
        // Only fields with a readable name; internal ones (ids, defaults filled in) are noise.
        if (!FIELD_LABELS[k] || same(bv, av)) continue
        lines.push(`${FIELD_LABELS[k] ?? k}：${short(bv)} → ${short(av)}`)
      }
    } else if (b === null) {
      if (!FIELD_LABELS[leaf]) continue // whole record added: the step label says so
      lines.push(`${FIELD_LABELS[leaf]}：→ ${short(a)}`)
    } else if (a === null) {
      if (!FIELD_LABELS[leaf]) continue
      lines.push(`${FIELD_LABELS[leaf]}：${short(b)} → （無）`)
    } else {
      lines.push(`${FIELD_LABELS[leaf] ?? leaf}：${short(b)} → ${short(a)}`)
    }
  }
  const unique = [...new Set(lines)]
  return unique.length > limit ? [...unique.slice(0, limit), `…等 ${unique.length} 項變更`] : unique
}

/* ---------- recording ---------- */

let queue: Promise<unknown> = Promise.resolve()
/** Writes run one after another, so each step's "before" is read after the previous step landed. */
const enqueue = <T>(job: () => Promise<T>): Promise<T> => {
  const run = queue.then(job, job)
  queue = run.catch(() => {})
  return run
}

export interface RecordOptions {
  label: string
  group: HistoryGroup
  /** Absolute database paths → new value (null deletes). These are undoable. */
  updates: Record<string, unknown>
  /** Written in the same update but not undone (timestamps). */
  extra?: Record<string, unknown>
  /** Merge with the previous step if it has the same key and was moments ago. */
  coalesceKey?: string
}

/** Write `updates` atomically and record the step. Resolves when the database accepted it. */
/**
 * Writes of one gesture (a knob or slider drag sends one per pointer move) that are still waiting
 * in the queue: a new write with the same key replaces the waiting one instead of queueing behind
 * it, so the database — and everyone watching — gets the latest value right away.
 */
const waiting = new Map<string, { opts: RecordOptions; promise: Promise<void> }>()

export function recordedUpdate(opts: RecordOptions): Promise<void> {
  // Read-only projects (locked, official template, archived): refuse here too, not only in the rules.
  const blocked = readOnlyReason([...Object.keys(opts.updates), ...Object.keys(opts.extra ?? {})])
  if (blocked) {
    notifyReadOnly(blocked)
    return Promise.reject(new Error(blocked))
  }
  const key = opts.coalesceKey
  const pending = key ? waiting.get(key) : undefined
  if (pending) {
    pending.opts = {
      ...opts,
      updates: { ...pending.opts.updates, ...opts.updates },
      extra: { ...pending.opts.extra, ...opts.extra },
    }
    return pending.promise
  }
  const slot = { opts }
  const promise = enqueue(() => {
    if (key) waiting.delete(key)
    return writeStep(slot.opts)
  })
  if (key) waiting.set(key, Object.assign(slot, { promise }))
  return promise
}

async function writeStep({ label, group, updates, extra = {}, coalesceKey }: RecordOptions): Promise<void> {
  const paths = Object.keys(updates)
  const befores = await Promise.all(paths.map(async (p) => (await get(ref(db, p))).val() as unknown))
  await update(ref(db), { ...updates, ...extra })
  const changes = paths
    .map((path, i) => ({ path, before: clone(befores[i]), after: clone(updates[path]) }))
    .filter((c) => !same(c.before, c.after))
  if (changes.length === 0) return

  const now = Date.now()
  const by = byUser()
  // A new edit discards whatever was undone after the current point.
  let entries = state.entries.slice(0, state.index)
  const top = entries.at(-1)
  let logged: HistoryEntry
  if (coalesceKey && top && top.coalesceKey === coalesceKey && now - top.at < COALESCE_MS) {
    const merged = mergeChanges(top.changes.map((c) => ({ ...c })), changes)
    logged = { ...top, label, changes: merged, details: describeChanges(merged), at: now }
    entries = [...entries.slice(0, -1), logged]
  } else {
    logged = { id: nextId++, label, group, changes, details: describeChanges(changes), at: now, coalesceKey, by }
    entries = [...entries, logged]
  }
  if (entries.length > MAX_STEPS) entries = entries.slice(entries.length - MAX_STEPS)
  setState({ entries, index: entries.length })
  // Shared activity log: a merged step (one slider drag) updates its line instead of adding one.
  logActivity({ label, group, details: logged.details, by }, logged.activityKey).then((key) => {
    if (key && !logged.activityKey) logged.activityKey = key
  })
}

/* ---------- undo / redo ---------- */

async function apply(entry: HistoryEntry, direction: 'undo' | 'redo'): Promise<boolean> {
  const expected = (c: Change) => (direction === 'undo' ? c.after : c.before)
  const target = (c: Change) => (direction === 'undo' ? c.before : c.after)
  // Did someone else change these values since? Still apply, but say so.
  const current = await Promise.all(entry.changes.map(async (c) => (await get(ref(db, c.path))).val() as unknown))
  const conflict = entry.changes.some((c, i) => !same(current[i], expected(c)))
  await update(ref(db), Object.fromEntries(entry.changes.map((c) => [c.path, target(c) ?? null])))
  return conflict
}

/** Move to the point where the first `target` steps are applied (0 = before every recorded step). */
export function jumpTo(target: number): Promise<void> {
  return enqueue(async () => {
    const goal = Math.max(0, Math.min(state.entries.length, target))
    if (goal === state.index || state.busy) return
    setState({ busy: true })
    let conflict = false
    const verb = goal < state.index ? '復原' : '重做'
    let last = ''
    try {
      while (state.index > goal) {
        const entry = state.entries[state.index - 1]
        conflict = (await apply(entry, 'undo')) || conflict
        last = entry.label
        setState({ index: state.index - 1 })
      }
      while (state.index < goal) {
        const entry = state.entries[state.index]
        conflict = (await apply(entry, 'redo')) || conflict
        last = entry.label
        setState({ index: state.index + 1 })
      }
      logActivity({ label: `${verb}：${last}`, group: 'undo', by: byUser() })
      setState({
        notice: {
          text: conflict ? `已${verb}「${last}」（其中資料曾被其他裝置修改）` : `已${verb}：${last}`,
          tone: conflict ? 'warn' : 'ok',
          at: Date.now(),
        },
      })
    } catch (err) {
      setState({ notice: { text: `${verb}失敗：${(err as Error).message}`, tone: 'warn', at: Date.now() } })
    } finally {
      setState({ busy: false })
    }
  })
}

export const undo = () => jumpTo(state.index - 1)
export const redo = () => jumpTo(state.index + 1)
export const clearHistory = () => setState({ entries: [], index: 0, notice: null })

/** History belongs to one project; opening another project starts a fresh one. */
export function setHistoryScope(scope: string) {
  if (state.scope !== scope) setState({ scope, entries: [], index: 0, notice: null })
}

/* ---------- React ---------- */

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function useHistory() {
  return useSyncExternalStore(subscribe, () => state)
}

/**
 * Ctrl/⌘+Z = undo, Ctrl/⌘+Shift+Z or Ctrl+Y = redo, anywhere on the page — except while typing in
 * a text field, where the browser's own text undo applies.
 */
export function useHistoryShortcuts(scope: string) {
  useEffect(() => setHistoryScope(scope), [scope])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Keys pressed while an IME is composing belong to the input method (229 = IME processing).
      if (e.isComposing || e.keyCode === 229) return
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return
      const key = e.key.toLowerCase()
      const isUndo = key === 'z' && !e.shiftKey
      const isRedo = (key === 'z' && e.shiftKey) || (key === 'y' && !e.shiftKey)
      if (!isUndo && !isRedo) return
      const el = e.target as HTMLElement
      const typing =
        el.isContentEditable ||
        el.tagName === 'TEXTAREA' ||
        (el.tagName === 'INPUT' && !['checkbox', 'radio', 'range', 'button', 'color'].includes((el as HTMLInputElement).type))
      if (typing) return
      e.preventDefault()
      if (isUndo) undo()
      else redo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

/** The latest entries of a project's shared activity log (who did what), newest first. */
export function useActivity(scope: string | null, limit = 80) {
  const [items, setItems] = useState<ActivityEntry[] | null>(null)
  useEffect(() => {
    if (!scope) return
    return onValue(
      query(ref(db, activityPath(scope)), limitToLast(limit)),
      (snap) =>
        setItems(
          Object.entries((snap.val() ?? {}) as Record<string, Omit<ActivityEntry, 'key'>>)
            .map(([key, v]) => ({ ...v, key }))
            .sort((a, b) => (b.at ?? 0) - (a.at ?? 0)),
        ),
      () => setItems([]),
    )
  }, [scope, limit])
  return items
}

/** The current history scope (the open project). */
export const useHistoryScope = () => useSyncExternalStore(subscribe, () => state.scope)
