import { isReadOnlyHere } from './projectLock'
import { onValue, push, ref, serverTimestamp, set } from 'firebase/database'
import { useEffect, useState } from 'react'
import { SURFACE_COLUMNS, normalizeMonitorLayout, normalizeWidget, type MonitorLayout, type Surface, type SurfaceWidget } from '../types/surface'
import { defaultSurfaceWidgets } from '../utils/builtinModules'
import { normalizeSequence, type ExecutorSlot } from '../types/sequence'
import { db } from './firebase'
import { recordedUpdate } from './history'

/** Surfaces belong to a project (shared by all its versions): projects/{pid}/surfaces/{sid}. */
const surfacesPath = (projectId: string) => `projects/${projectId}/surfaces`

type RawSurface = Omit<Surface, 'id' | 'widgets' | 'sequences' | 'executors'> & {
  widgets?: Record<string, Partial<SurfaceWidget> & Pick<SurfaceWidget, 'id' | 'type'>>
  sequences?: Record<string, Parameters<typeof normalizeSequence>[1]>
  executors?: Record<string, Partial<ExecutorSlot>>
}

function normalizeSurface(id: string, raw: RawSurface): Surface {
  const widgets: Record<string, SurfaceWidget> = {}
  for (const [wid, w] of Object.entries(raw.widgets ?? {})) widgets[wid] = normalizeWidget({ ...w, id: wid })
  return {
    id,
    name: raw.name ?? '未命名控台',
    columns: raw.columns ?? SURFACE_COLUMNS,
    oscHost: raw.oscHost ?? '',
    oscPort: raw.oscPort ?? 53000,
    updatedAt: raw.updatedAt ?? 0,
    monitor: normalizeMonitorLayout(raw.monitor),
    widgets,
    sequences: Object.fromEntries(Object.entries(raw.sequences ?? {}).map(([sid, seq]) => [sid, normalizeSequence(sid, seq)])),
    executors: Object.fromEntries(
      Object.entries(raw.executors ?? {})
        .filter(([, e]) => typeof e?.sequenceId === 'string')
        .map(([no, e]) => [no, { sequenceId: e.sequenceId! }]),
    ),
  }
}

export function useSurfaces(projectId: string) {
  const [surfaces, setSurfaces] = useState<Surface[] | null>(null)
  const [error, setError] = useState<Error | null>(null)

  useEffect(
    () =>
      onValue(
        ref(db, surfacesPath(projectId)),
        (snapshot) => {
          const raw = (snapshot.val() ?? {}) as Record<string, RawSurface>
          setSurfaces(
            Object.entries(raw)
              .map(([id, s]) => normalizeSurface(id, s))
              .sort((a, b) => b.updatedAt - a.updatedAt),
          )
        },
        setError,
      ),
    [projectId],
  )

  return { surfaces, error }
}

/** Create a surface, pre-filled with the built-in Theatre module unless `blank`. */
export async function createSurface(projectId: string, name: string, { blank = false } = {}): Promise<string> {
  const id = push(ref(db, surfacesPath(projectId))).key!
  const widgets = blank ? [] : defaultSurfaceWidgets(() => newWidgetId(projectId, id))
  await recordedUpdate({
    label: `新增控台「${name}」`,
    group: 'surface',
    updates: {
      [`${surfacesPath(projectId)}/${id}`]: {
        name,
        columns: SURFACE_COLUMNS,
        oscHost: '',
        oscPort: 53000,
        updatedAt: Date.now(),
        widgets: Object.fromEntries(widgets.map((w) => [w.id, w])),
      },
    },
  })
  return id
}

/** Replace a surface's whole layout (import, or "reset to template"). */
export function replaceSurfaceLayout(
  projectId: string,
  surfaceId: string,
  widgets: SurfaceWidget[],
  meta: Partial<Pick<Surface, 'columns' | 'oscHost' | 'oscPort'>> = {},
  label = '套用控台佈局',
) {
  const base = `${surfacesPath(projectId)}/${surfaceId}`
  return recordedUpdate({
    label,
    group: 'surface',
    updates: {
      ...Object.fromEntries(Object.entries(meta).map(([k, v]) => [`${base}/${k}`, v])),
      [`${base}/widgets`]: Object.fromEntries(widgets.map((w) => [w.id, w])),
    },
    extra: { [`${base}/updatedAt`]: serverTimestamp() },
  })
}

export function updateSurfaceMeta(projectId: string, surfaceId: string, changes: Partial<Pick<Surface, 'name' | 'oscHost' | 'oscPort'>>) {
  const base = `${surfacesPath(projectId)}/${surfaceId}`
  return recordedUpdate({
    label: changes.name ? `控台重新命名為「${changes.name}」` : '修改控台 OSC 目標',
    group: 'surface',
    updates: Object.fromEntries(Object.entries(changes).map(([k, v]) => [`${base}/${k}`, v])),
    extra: { [`${base}/updatedAt`]: serverTimestamp() },
    coalesceKey: `surface-meta:${surfaceId}`,
  })
}

/** Write one widget (layout and properties). Per-widget writes keep concurrent edits from clobbering each other. */
export function saveWidget(projectId: string, surfaceId: string, widget: SurfaceWidget, kind: 'props' | 'layout' | 'add' = 'props') {
  const label = { add: `新增元件「${widget.label}」`, layout: `移動 / 調整「${widget.label}」`, props: `編輯元件「${widget.label}」` }[kind]
  const base = `${surfacesPath(projectId)}/${surfaceId}`
  return recordedUpdate({
    label,
    group: 'surface',
    updates: { [`${base}/widgets/${widget.id}`]: widget },
    extra: { [`${base}/updatedAt`]: serverTimestamp() },
    // Typing a label or dragging a size stepper is one step.
    coalesceKey: `widget:${widget.id}:${kind}`,
  })
}

export const newWidgetId = (projectId: string, surfaceId: string) =>
  push(ref(db, `${surfacesPath(projectId)}/${surfaceId}/widgets`)).key!

export function removeWidget(projectId: string, surfaceId: string, widgetId: string, name = '') {
  const base = `${surfacesPath(projectId)}/${surfaceId}`
  return recordedUpdate({
    label: `刪除元件${name ? `「${name}」` : ''}`,
    group: 'surface',
    updates: { [`${base}/widgets/${widgetId}`]: null },
    extra: { [`${base}/updatedAt`]: serverTimestamp() },
  })
}

export function deleteSurface(projectId: string, surfaceId: string, name = '') {
  return recordedUpdate({ label: `刪除控台${name ? `「${name}」` : ''}`, group: 'surface', updates: { [`${surfacesPath(projectId)}/${surfaceId}`]: null } })
}

/** Save the Cue Monitor arrangement (mode, grid size, tile order and spans) for a surface. */
export function saveMonitorLayout(projectId: string, surfaceId: string, layout: MonitorLayout) {
  return recordedUpdate({
    label: 'Cue Monitor 版面調整',
    group: 'surface',
    updates: { [`${surfacesPath(projectId)}/${surfaceId}/monitor`]: layout },
    // Slider drags (tile height, font) collapse into one step.
    coalesceKey: `monitor:${surfaceId}`,
  })
}

/** Fader positions are live performance state; write just the value, not the whole widget. */
export function saveFaderValue(projectId: string, surfaceId: string, widgetId: string, value: number) {
  // A read-only project keeps its saved positions (the move itself still drives playback).
  if (isReadOnlyHere(projectId)) return Promise.resolve()
  return set(ref(db, `${surfacesPath(projectId)}/${surfaceId}/widgets/${widgetId}/value`), value)
}
