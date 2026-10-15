import { onDisconnect, onValue, push, ref, remove, set, update, get } from 'firebase/database'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  DEFAULT_EQ,
  DEFAULT_FX,
  DEFAULT_INPUT,
  PARAM_INFO,
  SECTION_COLORS,
  TRACK_COLORS,
  normalizeStudio,
  type StudioPoint,
  type StudioSection,
  type TrackParam,
  projectLength,
  type StudioPresence,
  type StudioProject,
  type StudioRegion,
  type StudioTrack,
} from '../types/studio'
import { db } from './firebase'
import { currentUser } from './auth'
import { recordedUpdate } from './history'

/*
 * Studio projects live at projects/{pid}/studio/{sid}; who has one open lives at
 * projects/{pid}/studioPresence/{sid}/{clientId}. Every edit is a small multi-path write (one
 * region, one track field), so several people can edit the same studio at once without clobbering
 * each other, and each edit is an undo step.
 */

export const studioPath = (projectId: string, studioId?: string) => `projects/${projectId}/studio${studioId ? `/${studioId}` : ''}`
const presencePath = (projectId: string, studioId: string) => `projects/${projectId}/studioPresence/${studioId}`
const newId = (projectId: string) => push(ref(db, studioPath(projectId))).key!

export interface StudioSummary {
  id: string
  name: string
  length: number
  tracks: number
  regions: number
  updatedAt: number
  /** Position in the Studio tab bar (shared by everyone); unset for studios never reordered. */
  tabOrder: number | null
}

/** All studios of a project (for the tab picker and for binding a cue). */
export function useStudioList(projectId: string) {
  const [list, setList] = useState<StudioSummary[] | null>(null)
  useEffect(
    () =>
      onValue(
        ref(db, studioPath(projectId)),
        (snap) => {
          const raw = (snap.val() ?? {}) as Record<string, Parameters<typeof normalizeStudio>[1]>
          setList(
            Object.entries(raw)
              .map(([id, s]) => {
                const p = normalizeStudio(id, s)
                const order = Number((s as { tabOrder?: unknown } | null)?.tabOrder)
                return { id, name: p.name, length: p.length, tracks: Object.keys(p.tracks).length, regions: Object.keys(p.regions).length, updatedAt: p.updatedAt, tabOrder: Number.isFinite(order) ? order : null }
              })
              // Tab-bar order first; studios never reordered follow, newest first.
              .sort((a, b) => (a.tabOrder ?? Infinity) - (b.tabOrder ?? Infinity) || b.updatedAt - a.updatedAt),
          )
        },
        () => setList([]),
      ),
    [projectId],
  )
  return list
}

/**
 * Save the tab-bar order of a project's studios (every id, left to right) as each studio's
 * tabOrder, so the order is the same after a reload and on every device. Undoable.
 */
export function reorderStudios(projectId: string, ids: string[]) {
  return recordedUpdate({
    label: '調整 Studio 分頁順序',
    group: 'studio',
    updates: Object.fromEntries(ids.map((id, i) => [`${studioPath(projectId, id)}/tabOrder`, i])),
  })
}

/** One studio, live. `null` while loading, `undefined` if it doesn't exist (deleted). */
export function useStudio(projectId: string, studioId: string | null) {
  const [project, setProject] = useState<StudioProject | null | undefined>(null)
  useEffect(() => {
    if (!studioId) return
    return onValue(ref(db, studioPath(projectId, studioId)), (snap) => {
      setProject(snap.exists() ? normalizeStudio(studioId, snap.val()) : undefined)
    })
  }, [projectId, studioId])
  return studioId ? project : undefined
}

/* ---------- edits (all undoable) ---------- */

const touch = (projectId: string, studioId: string) => ({ [`${studioPath(projectId, studioId)}/updatedAt`]: Date.now() })

export function newTrack(order: number, name?: string): Omit<StudioTrack, 'id'> {
  return {
    name: name ?? `音軌 ${order + 1}`,
    color: TRACK_COLORS[order % TRACK_COLORS.length],
    order,
    volume: 1,
    pan: 0,
    mute: false,
    solo: false,
    eq: DEFAULT_EQ,
    fx: DEFAULT_FX,
    automation: {},
    input: DEFAULT_INPUT,
  }
}

/**
 * A new studio in a project. `parentProjectId`: the Set Cue project it belongs to (= projectId for a
 * studio inside a Set Cue project; omitted for a standalone Studio project's container).
 */
export async function createStudio(projectId: string, name: string, opts: { parentProjectId?: string } = {}): Promise<string> {
  const id = newId(projectId)
  const tracks: Record<string, Omit<StudioTrack, 'id'>> = {}
  for (let i = 0; i < 2; i++) tracks[newId(projectId)] = newTrack(i)
  const now = Date.now()
  await recordedUpdate({
    label: `新增 Studio「${name}」`,
    group: 'studio',
    updates: { [studioPath(projectId, id)]: { name, createdAt: now, updatedAt: now, length: 0, masterVolume: 1, tracks, ...(opts.parentProjectId ? { parentProjectId: opts.parentProjectId } : {}) } },
  })
  return id
}

export const renameStudio = (projectId: string, studioId: string, name: string) =>
  recordedUpdate({ label: `Studio 重新命名為「${name}」`, group: 'studio', updates: { [`${studioPath(projectId, studioId)}/name`]: name }, extra: touch(projectId, studioId) })

export const deleteStudio = (projectId: string, studioId: string, name: string) =>
  recordedUpdate({ label: `刪除 Studio「${name}」`, group: 'studio', updates: { [studioPath(projectId, studioId)]: null } })

export function setMasterVolume(projectId: string, studioId: string, volume: number) {
  return recordedUpdate({
    label: '主音量',
    group: 'studio',
    updates: { [`${studioPath(projectId, studioId)}/masterVolume`]: volume },
    extra: touch(projectId, studioId),
    coalesceKey: `studio-master:${studioId}`,
  })
}

export function addTrack(projectId: string, studio: StudioProject, name?: string) {
  const order = Object.keys(studio.tracks).length
  const id = newId(projectId)
  return recordedUpdate({
    label: `新增音軌「${name ?? `音軌 ${order + 1}`}」`,
    group: 'studio',
    updates: { [`${studioPath(projectId, studio.id)}/tracks/${id}`]: newTrack(order, name) },
    extra: touch(projectId, studio.id),
  }).then(() => id)
}

/** Change track fields; slider drags on the same field merge into one undo step. */
export function updateTrack(projectId: string, studioId: string, track: StudioTrack, changes: Partial<Omit<StudioTrack, 'id'>>, label = `調整音軌「${track.name}」`) {
  const base = `${studioPath(projectId, studioId)}/tracks/${track.id}`
  return recordedUpdate({
    label,
    group: 'studio',
    updates: Object.fromEntries(Object.entries(changes).map(([k, v]) => [`${base}/${k}`, v])),
    extra: touch(projectId, studioId),
    coalesceKey: `studio-track:${track.id}:${Object.keys(changes).sort().join(',')}`,
  })
}

export function removeTrack(projectId: string, studio: StudioProject, track: StudioTrack) {
  const base = studioPath(projectId, studio.id)
  const updates: Record<string, unknown> = { [`${base}/tracks/${track.id}`]: null }
  for (const r of Object.values(studio.regions)) if (r.trackId === track.id) updates[`${base}/regions/${r.id}`] = null
  return recordedUpdate({ label: `刪除音軌「${track.name}」`, group: 'studio', updates, extra: touch(projectId, studio.id) })
}

const regionData = (r: Omit<StudioRegion, 'id'> | StudioRegion) => {
  const { id: _id, ...rest } = r as StudioRegion
  return rest
}

export function addRegions(projectId: string, studioId: string, regions: Omit<StudioRegion, 'id'>[], label: string) {
  const base = studioPath(projectId, studioId)
  const updates: Record<string, unknown> = {}
  const ids: string[] = []
  for (const r of regions) {
    const id = newId(projectId)
    ids.push(id)
    updates[`${base}/regions/${id}`] = regionData(r)
  }
  return recordedUpdate({ label, group: 'studio', updates, extra: touch(projectId, studioId) }).then(() => ids)
}

/**
 * Change regions. `coalesceKey` merges a gesture's many writes (dragging, a slider) into one step.
 */
export function updateRegions(
  projectId: string,
  studioId: string,
  changes: { id: string; patch: Partial<Omit<StudioRegion, 'id'>> }[],
  label: string,
  coalesceKey?: string,
) {
  const base = studioPath(projectId, studioId)
  const updates: Record<string, unknown> = {}
  for (const { id, patch } of changes) for (const [k, v] of Object.entries(patch)) updates[`${base}/regions/${id}/${k}`] = v
  return recordedUpdate({ label, group: 'studio', updates, extra: touch(projectId, studioId), coalesceKey })
}

export function removeRegions(projectId: string, studioId: string, ids: string[], label: string) {
  const base = studioPath(projectId, studioId)
  return recordedUpdate({
    label,
    group: 'studio',
    updates: Object.fromEntries(ids.map((id) => [`${base}/regions/${id}`, null])),
    extra: touch(projectId, studioId),
  })
}

/* ---------- sections ---------- */

/** Next free section number ("1", "2", …) for the default name. */
export function nextSectionName(studio: StudioProject) {
  const used = Object.values(studio.sections).map((s) => Number(s.name)).filter(Number.isFinite)
  return String((used.length ? Math.max(...used) : 0) + 1)
}

export function addSection(projectId: string, studio: StudioProject, section: Omit<StudioSection, 'id' | 'color'> & { color?: string }) {
  const id = newId(projectId)
  const color = section.color ?? SECTION_COLORS[Object.keys(studio.sections).length % SECTION_COLORS.length]
  return recordedUpdate({
    label: `新增區段「${section.name}」`,
    group: 'studio',
    updates: { [`${studioPath(projectId, studio.id)}/sections/${id}`]: { ...section, color } },
    extra: touch(projectId, studio.id),
  }).then(() => id)
}

export function updateSections(projectId: string, studioId: string, changes: { id: string; patch: Partial<Omit<StudioSection, 'id'>> }[], label: string, coalesceKey?: string) {
  const base = `${studioPath(projectId, studioId)}/sections`
  const updates: Record<string, unknown> = {}
  for (const { id, patch } of changes) for (const [k, v] of Object.entries(patch)) updates[`${base}/${id}/${k}`] = v
  return recordedUpdate({ label, group: 'studio', updates, extra: touch(projectId, studioId), coalesceKey })
}

export const removeSection = (projectId: string, studioId: string, section: StudioSection) =>
  recordedUpdate({
    label: `刪除區段「${section.name}」`,
    group: 'studio',
    updates: { [`${studioPath(projectId, studioId)}/sections/${section.id}`]: null },
    extra: touch(projectId, studioId),
  })

/* ---------- track automation ---------- */

/** Show / hide a track's automation lane, or set its nodes. */
export function setTrackAutomation(projectId: string, studioId: string, track: StudioTrack, param: TrackParam, lane: { shown?: boolean; points?: StudioPoint[] }, label: string) {
  const base = `${studioPath(projectId, studioId)}/tracks/${track.id}/automation/${param}`
  const updates: Record<string, unknown> = {}
  if (lane.shown !== undefined) updates[`${base}/shown`] = lane.shown
  if (lane.points !== undefined) updates[`${base}/points`] = lane.points
  return recordedUpdate({ label: `${label}（${track.name} · ${PARAM_INFO[param].label}）`, group: 'studio', updates, extra: touch(projectId, studioId) })
}

/** Split regions at a timeline time (⌘E): the left part keeps the id, the right part is new. */
export function splitRegions(projectId: string, studio: StudioProject, ids: string[], at: number) {
  const base = studioPath(projectId, studio.id)
  const updates: Record<string, unknown> = {}
  let count = 0
  for (const id of ids) {
    const r = studio.regions[id]
    if (!r || at <= r.start + 0.01 || at >= r.start + r.duration - 0.01) continue
    const cut = at - r.start
    const left = { duration: cut, fadeOut: Math.min(r.fadeOut, cut), automation: r.automation.filter((p) => p.t <= cut) }
    const rightAuto = r.automation.filter((p) => p.t >= cut).map((p) => ({ t: p.t - cut, v: p.v }))
    const right = {
      ...regionData(r),
      name: `${r.name} (2)`,
      start: at,
      offset: r.reverse ? r.offset : r.offset + cut,
      duration: r.duration - cut,
      fadeIn: 0,
      automation: rightAuto,
    }
    // A reversed region plays its source backwards, so its left part comes from the end of the source.
    if (r.reverse) {
      Object.assign(left, { offset: r.offset + (r.duration - cut) })
      right.offset = r.offset
    }
    for (const [k, v] of Object.entries(left)) updates[`${base}/regions/${id}/${k}`] = v
    updates[`${base}/regions/${newId(projectId)}`] = right
    count++
  }
  if (count === 0) return Promise.resolve(0)
  return recordedUpdate({ label: count === 1 ? '分割片段' : `分割 ${count} 個片段`, group: 'studio', updates, extra: touch(projectId, studio.id) }).then(() => count)
}

/**
 * Keep the stored length (and the duration of every cue bound to this studio) in step with the
 * regions, so a bound cue's timing is right without exporting anything.
 */
export function useLengthSync(projectId: string, studio: StudioProject | null | undefined) {
  const length = studio ? Math.round(projectLength(studio) * 1000) / 1000 : null
  const stored = studio?.length
  const studioId = studio?.id
  useEffect(() => {
    if (length === null || !studioId || Math.abs((stored ?? 0) - length) < 0.001) return
    const timer = setTimeout(async () => {
      await set(ref(db, `${studioPath(projectId, studioId)}/length`), length).catch(() => {})
      // Bound cues may sit in any version of the show.
      const versions = (await get(ref(db, `projects/${projectId}/versions`)).catch(() => null))?.val() as Record<string, { cueList?: Record<string, { studioId?: string }> }> | null
      const updates: Record<string, number> = {}
      for (const [vid, v] of Object.entries(versions ?? {}))
        for (const [cid, c] of Object.entries(v.cueList ?? {})) if (c.studioId === studioId) updates[`projects/${projectId}/versions/${vid}/cueList/${cid}/duration`] = length
      if (Object.keys(updates).length) await update(ref(db), updates).catch(() => {})
    }, 800)
    return () => clearTimeout(timer)
  }, [projectId, studioId, length, stored])
}

/* ---------- presence (who else is here, where their playhead is) ---------- */

const PRESENCE_COLORS = ['#ff8787', '#ffd43b', '#69db7c', '#4dabf7', '#da77f2', '#ffa94d']

export function studioIdentity() {
  try {
    let id = sessionStorage.getItem('theatre.studio.client')
    if (!id) sessionStorage.setItem('theatre.studio.client', (id = Math.random().toString(36).slice(2, 10)))
    // The signed-in Google name when there is one.
    const name = currentUser()?.name || localStorage.getItem('theatre.studio.name') || `成員 ${id.slice(0, 3).toUpperCase()}`
    return { id, name, color: PRESENCE_COLORS[parseInt(id, 36) % PRESENCE_COLORS.length] }
  } catch {
    return { id: 'local', name: '我', color: PRESENCE_COLORS[0] }
  }
}

/** Publish this tab's playhead / selection (throttled) and read everyone else's. */
export function useStudioPresence(projectId: string, studioId: string | null, mine: { playhead: number; playing: boolean; selection: string[] }) {
  const me = useMemo(studioIdentity, [])
  const [others, setOthers] = useState<StudioPresence[]>([])
  const last = useRef(0)
  const pending = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => {
    if (!studioId) return
    const node = ref(db, `${presencePath(projectId, studioId)}/${me.id}`)
    onDisconnect(node).remove().catch(() => {})
    const off = onValue(ref(db, presencePath(projectId, studioId)), (snap) => {
      const raw = (snap.val() ?? {}) as Record<string, Omit<StudioPresence, 'id'>>
      setOthers(
        Object.entries(raw)
          // A heartbeat can land after an entry was removed, leaving just { at }: skip those.
          .filter(([id, p]) => id !== me.id && typeof p.name === 'string' && Date.now() - (p.at ?? 0) < 120_000)
          .map(([id, p]) => ({ ...p, id, selection: Object.values(p.selection ?? {}) })),
      )
    })
    return () => {
      off()
      remove(node).catch(() => {})
    }
  }, [projectId, studioId, me])

  const selectionKey = mine.selection.join(',')
  // Quarter-second steps: smooth enough to follow someone's playhead without flooding the database.
  const headTick = Math.round(mine.playhead * 4)
  useEffect(() => {
    if (!studioId) return
    const write = () => {
      last.current = Date.now()
      set(ref(db, `${presencePath(projectId, studioId)}/${me.id}`), {
        name: me.name,
        color: me.color,
        playhead: Math.round(mine.playhead * 100) / 100,
        playing: mine.playing,
        selection: mine.selection,
        at: Date.now(),
      }).catch(() => {})
    }
    clearTimeout(pending.current)
    const wait = Math.max(0, 400 - (Date.now() - last.current))
    pending.current = setTimeout(write, wait)
    return () => clearTimeout(pending.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- headTick / selectionKey stand in for mine
  }, [projectId, studioId, me, mine.playing, selectionKey, headTick])

  // Heartbeat so idle collaborators don't age out.
  useEffect(() => {
    if (!studioId) return
    // Only refresh an entry that still exists (a bare { at } would otherwise appear as a nameless visitor).
    const t = setInterval(
      () => update(ref(db, `${presencePath(projectId, studioId)}/${me.id}`), { name: me.name, color: me.color, at: Date.now() }).catch(() => {}),
      30_000,
    )
    return () => clearInterval(t)
  }, [projectId, studioId, me])

  return { me, others }
}
