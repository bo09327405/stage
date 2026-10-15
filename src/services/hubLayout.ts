import { onValue, ref, set } from 'firebase/database'
import { useCallback, useEffect, useRef, useState } from 'react'
import { db } from './firebase'

/*
 * Each user's own arrangement of the lobby's Studio tab: card order per section (drag & drop),
 * section order, and tags (the user's own names and colours; A / B / C / 串場 to start with). Saved to hubLayout/{uid}/studio (follows the user
 * to other devices) and cached in localStorage (instant on reload, works offline).
 * How the tab is grouped and viewed (grid / list) is a per-device preference: localStorage only.
 */

export interface StudioLayout {
  /** Card keys per section, in the user's order. */
  order: Record<string, string[]>
  /** Section ids, in the user's order. */
  sections: string[]
  /** Card key → tag ids. */
  tags: Record<string, string[]>
  /** The user's tags, in their order (null: not customised yet → DEFAULT_TAGS). */
  tagDefs: TagDef[] | null
}

/** A tag: a colour, optionally with a name (no name → shown as just the colour dot). */
export interface TagDef {
  id: string
  name: string
  color: string
}

/** Colours offered when picking (any other colour can be chosen too). */
export const TAG_PALETTE = [
  { color: '#ff453a', name: '紅色' },
  { color: '#ff9f0a', name: '橙色' },
  { color: '#ffd60a', name: '黃色' },
  { color: '#30d158', name: '綠色' },
  { color: '#64d2ff', name: '青色' },
  { color: '#0a84ff', name: '藍色' },
  { color: '#bf5af2', name: '紫色' },
  { color: '#ff375f', name: '粉紅' },
  { color: '#98989d', name: '灰色' },
] as const

export const DEFAULT_TAGS: TagDef[] = [
  { id: 'a', name: 'A', color: '#ff453a' },
  { id: 'b', name: 'B', color: '#ff9f0a' },
  { id: 'c', name: 'C', color: '#ffd60a' },
  { id: 'link', name: '串場', color: '#0a84ff' },
]

// The first version's colour-only tags, so cards tagged with them keep their colour.
const LEGACY: Record<string, string> = { red: '#ff453a', orange: '#ff9f0a', yellow: '#ffd60a', green: '#30d158', blue: '#0a84ff', purple: '#bf5af2', gray: '#98989d' }

export const TAG_NAME_MAX = 20
const HEX = /^#[0-9a-f]{6}$/i

/** The tags in use: the user's (or the defaults), plus any old colour tags still on cards. */
export function tagDefsOf(layout: StudioLayout): TagDef[] {
  const defs = layout.tagDefs ?? DEFAULT_TAGS
  const known = new Set(defs.map((d) => d.id))
  const legacy = [...new Set(Object.values(layout.tags).flat())].filter((id) => !known.has(id) && LEGACY[id]).map((id) => ({ id, name: '', color: LEGACY[id] }))
  return [...defs, ...legacy]
}

/** How a tag is called where a word is needed (menus, group headers). */
export const tagLabel = (t: TagDef) => t.name || `未命名（${TAG_PALETTE.find((p) => p.color.toLowerCase() === t.color.toLowerCase())?.name ?? t.color}）`

const EMPTY: StudioLayout = { order: {}, sections: [], tags: {}, tagDefs: null }
const cacheKey = (uid: string) => `theatre.hub.studioLayout.${uid}`
const path = (uid: string) => `hubLayout/${uid}/studio`

const strings = (v: unknown) => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []).filter((x): x is string => typeof x === 'string')
function clean(raw: unknown): StudioLayout {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const order = Object.fromEntries(Object.entries((r.order ?? {}) as Record<string, unknown>).map(([k, v]) => [k, strings(v)]))
  const tags = Object.fromEntries(
    Object.entries((r.tags ?? {}) as Record<string, unknown>)
      .map(([k, v]) => [k, strings(v)] as const)
      .filter(([, v]) => v.length),
  )
  const rawDefs = r.tagDefs == null ? null : Array.isArray(r.tagDefs) ? r.tagDefs : typeof r.tagDefs === 'object' ? Object.values(r.tagDefs) : []
  const tagDefs =
    rawDefs === null
      ? null
      : rawDefs
          .filter((d): d is TagDef => !!d && typeof d === 'object' && typeof (d as TagDef).id === 'string')
          .map((d) => ({ id: d.id, name: typeof d.name === 'string' ? d.name.slice(0, TAG_NAME_MAX) : '', color: HEX.test(d.color) ? d.color : '#98989d' }))
  return { order, sections: strings(r.sections), tags, tagDefs }
}

function readCache(uid: string): StudioLayout {
  try {
    return clean(JSON.parse(localStorage.getItem(cacheKey(uid)) ?? 'null'))
  } catch {
    return EMPTY
  }
}

export function useStudioLayout(uid: string) {
  const [layout, setLayout] = useState<StudioLayout>(() => readCache(uid))
  // The latest layout, for computing changes outside React's state updaters (which may run more
  // than once — a toggle must apply exactly once).
  const current = useRef(layout)
  useEffect(
    () =>
      onValue(
        ref(db, path(uid)),
        (snap) => {
          // Nothing saved online yet: keep (and upload) what this device has.
          if (!snap.exists()) return
          const next = clean(snap.val())
          current.current = next
          setLayout(next)
          try {
            localStorage.setItem(cacheKey(uid), JSON.stringify(next))
          } catch {
            // ignore
          }
        },
        () => {
          // No access (e.g. rules not deployed yet): the local copy still works.
        },
      ),
    [uid],
  )

  const save = useCallback(
    (change: (l: StudioLayout) => StudioLayout) => {
      const next = change(current.current)
      current.current = next
      setLayout(next)
      try {
        localStorage.setItem(cacheKey(uid), JSON.stringify(next))
      } catch {
        // ignore
      }
      void set(ref(db, path(uid)), next).catch(() => {})
    },
    [uid],
  )

  return {
    layout,
    setOrder: (section: string, keys: string[]) => save((l) => ({ ...l, order: { ...l.order, [section]: keys } })),
    setSections: (ids: string[]) => save((l) => ({ ...l, sections: ids })),
    toggleTag: (key: string, tag: string) =>
      save((l) => {
        const now = l.tags[key] ?? []
        // Kept in the tag list's order, so a card's tags always read the same way.
        const next = now.includes(tag) ? now.filter((t) => t !== tag) : tagDefsOf(l).map((t) => t.id).filter((t) => t === tag || now.includes(t))
        const tags = { ...l.tags }
        if (next.length) tags[key] = next
        else delete tags[key]
        return { ...l, tags }
      }),
    /** Rename / recolour a tag (every card with it follows). */
    updateTag: (id: string, change: Partial<Omit<TagDef, 'id'>>) =>
      save((l) => ({
        ...l,
        tagDefs: tagDefsOf(l).map((t) => (t.id === id ? { ...t, ...change, name: (change.name ?? t.name).trim().slice(0, TAG_NAME_MAX), color: HEX.test(change.color ?? '') ? change.color! : t.color } : t)),
      })),
    /** A new tag (next unused palette colour, no name yet); returns its id. */
    addTag: () => {
      const id = `t${Date.now().toString(36)}`
      save((l) => {
        const defs = tagDefsOf(l)
        const used = new Set(defs.map((t) => t.color.toLowerCase()))
        const color = TAG_PALETTE.find((p) => !used.has(p.color.toLowerCase()))?.color ?? TAG_PALETTE[defs.length % TAG_PALETTE.length].color
        return { ...l, tagDefs: [...defs, { id, name: '', color }] }
      })
      return id
    },
    /** Delete a tag: it comes off every card. */
    removeTag: (id: string) =>
      save((l) => ({
        ...l,
        tagDefs: tagDefsOf(l).filter((t) => t.id !== id),
        tags: Object.fromEntries(
          Object.entries(l.tags)
            .map(([k, v]) => [k, v.filter((t) => t !== id)] as const)
            .filter(([, v]) => v.length),
        ),
      })),
    /** Back to A / B / C / 串場 (tags of other names come off the cards). */
    resetTags: () =>
      save((l) => {
        const keep = new Set(DEFAULT_TAGS.map((t) => t.id))
        return { ...l, tagDefs: null, tags: Object.fromEntries(Object.entries(l.tags).map(([k, v]) => [k, v.filter((t) => keep.has(t))] as const).filter(([, v]) => v.length)) }
      }),
  }
}

/** Items in the user's saved order; ones not placed yet (new) come first, newest first. */
export function arrange<T>(items: T[], saved: string[] | undefined, keyOf: (t: T) => string, newest: (t: T) => number): T[] {
  const rank = new Map((saved ?? []).map((k, i) => [k, i]))
  const fresh = items.filter((t) => !rank.has(keyOf(t))).sort((a, b) => newest(b) - newest(a))
  const placed = items.filter((t) => rank.has(keyOf(t))).sort((a, b) => rank.get(keyOf(a))! - rank.get(keyOf(b))!)
  return [...fresh, ...placed]
}

/* ---------- grouping & view (this device) ---------- */

export type GroupMode = 'none' | 'setcue' | 'name' | 'opened' | 'joined' | 'created' | 'modified' | 'tags'
export type ViewMode = 'grid' | 'list'
export const GROUP_MODES: { id: GroupMode; label: string }[] = [
  { id: 'none', label: '無' },
  { id: 'setcue', label: 'Set Cue 專案名稱' },
  { id: 'name', label: 'Studio 專案名稱' },
  { id: 'opened', label: '上次打開日期' },
  { id: 'joined', label: '加入日期' },
  { id: 'created', label: '製作日期' },
  { id: 'modified', label: '修改日期' },
  { id: 'tags', label: '標籤' },
]
const GROUP_KEY = 'theatre.hub.studio.group'
const VIEW_KEY = 'theatre.hub.studio.view'

function usePref<T extends string>(key: string, allowed: readonly T[], fallback: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const v = localStorage.getItem(key) as T | null
      return v && allowed.includes(v) ? v : fallback
    } catch {
      return fallback
    }
  })
  const change = (v: T) => {
    setValue(v)
    try {
      localStorage.setItem(key, v)
    } catch {
      // ignore
    }
  }
  return [value, change] as const
}

export const useGroupMode = () => usePref<GroupMode>(GROUP_KEY, GROUP_MODES.map((g) => g.id), 'none')
export const useViewMode = () => usePref<ViewMode>(VIEW_KEY, ['grid', 'list'], 'grid')

/** Finder-style date buckets: 今天, 昨天, 過去 7 天, 過去 30 天, then months, then years. */
export function dateBucket(ms: number | null | undefined, now = Date.now()): { id: string; title: string; rank: number } {
  if (!ms) return { id: 'none', title: '沒有日期', rank: -Infinity }
  const day = (t: number) => {
    const d = new Date(t)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }
  const days = Math.round((day(now) - day(ms)) / 86_400_000)
  if (days <= 0) return { id: 'today', title: '今天', rank: 1e15 }
  if (days === 1) return { id: 'yesterday', title: '昨天', rank: 1e15 - 1 }
  if (days < 7) return { id: '7d', title: '過去 7 天', rank: 1e15 - 2 }
  if (days < 30) return { id: '30d', title: '過去 30 天', rank: 1e15 - 3 }
  const d = new Date(ms)
  if (d.getFullYear() === new Date(now).getFullYear()) return { id: `m${d.getMonth()}`, title: `${d.getMonth() + 1} 月`, rank: ms }
  return { id: `y${d.getFullYear()}`, title: `${d.getFullYear()} 年`, rank: ms }
}

/** Names in Traditional Chinese stroke order (Latin A–Z first), numbers naturally. */
export const byName = new Intl.Collator(['zh-Hant-TW-u-co-stroke', 'zh-Hant'], { numeric: true, sensitivity: 'base' }).compare
