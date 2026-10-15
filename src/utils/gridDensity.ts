import { useState } from 'react'

/*
 * Control-panel grid size, per device (localStorage): how big the cells are (scale of the
 * fit-to-width grid), the gap between blocks, and row height relative to column width. Block
 * positions stay in grid cells (shared with the team), so the layout is the same on every screen —
 * only its size changes.
 */

export interface GridDensity {
  /** Grid width as a share of the panel width (1 = fit; above 1 scrolls sideways). */
  scale: number
  /** Gap between blocks, px. */
  gap: number
  /** Row height as a share of the column width. */
  row: number
  [key: string]: number
}

export type GridPreset = 'compact' | 'normal' | 'spacious'
export const GRID_PRESETS: Record<GridPreset, { label: string; hint: string; value: GridDensity }> = {
  compact: { label: '精巧', hint: 'Compact', value: { scale: 0.8, gap: 6, row: 0.7 } },
  normal: { label: '標準', hint: 'Normal', value: { scale: 1, gap: 10, row: 0.8 } },
  spacious: { label: '寬鬆', hint: 'Spacious', value: { scale: 1.2, gap: 16, row: 0.95 } },
}
export const DEFAULT_DENSITY = GRID_PRESETS.normal.value
export const LIMITS = { scale: [0.5, 1.6], gap: [2, 28], row: [0.5, 1.3] } as const

const KEY = 'theatre.surface.grid'
const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, v))
function clean(raw: unknown): GridDensity | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<GridDensity>
  const n = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
  return { scale: clamp(n(r.scale, 1), LIMITS.scale), gap: Math.round(clamp(n(r.gap, 10), LIMITS.gap)), row: clamp(n(r.row, 0.8), LIMITS.row) }
}
const read = (key: string) => {
  try {
    return clean(JSON.parse(localStorage.getItem(key) ?? 'null'))
  } catch {
    return null
  }
}

export const presetOf = (d: GridDensity): GridPreset | null =>
  (Object.keys(GRID_PRESETS) as GridPreset[]).find((p) => {
    const v = GRID_PRESETS[p].value
    return Math.abs(v.scale - d.scale) < 0.001 && v.gap === d.gap && Math.abs(v.row - d.row) < 0.001
  }) ?? null

/** This device's grid size for a panel (falls back to the last one chosen on this device). */
export function useGridDensity(surfaceId: string | null) {
  const load = () => (surfaceId ? read(`${KEY}.${surfaceId}`) : null) ?? read(KEY) ?? DEFAULT_DENSITY
  const [state, setState] = useState(() => ({ id: surfaceId, value: load() }))
  // Switching panels: load that panel's setting (during render, not in an effect).
  let density = state.value
  if (state.id !== surfaceId) {
    density = load()
    setState({ id: surfaceId, value: density })
  }
  const set = (next: GridDensity) => {
    const v = clean(next) ?? DEFAULT_DENSITY
    setState({ id: surfaceId, value: v })
    try {
      localStorage.setItem(KEY, JSON.stringify(v))
      if (surfaceId) localStorage.setItem(`${KEY}.${surfaceId}`, JSON.stringify(v))
    } catch {
      // Not remembered; still applies now.
    }
  }
  return [density, set] as const
}

/* ---------- shared by the grid-size menus (panel grid, Executor sidebar) ---------- */

export type SizeValues = Record<string, number>
export interface SizePreset<T extends SizeValues> {
  label: string
  hint: string
  value: T
}
export interface SizeSlider<T extends SizeValues> {
  field: keyof T & string
  label: string
  min: number
  max: number
  step: number
  format: (v: number) => string
}

/** Which preset these values are (null: custom). */
export function matchPreset<T extends SizeValues>(value: T, presets: Record<string, SizePreset<T>>): string | null {
  return Object.keys(presets).find((p) => Object.entries(presets[p].value).every(([k, v]) => Math.abs(v - value[k]) < 0.001)) ?? null
}

export const PANEL_GRID_SLIDERS: SizeSlider<GridDensity>[] = [
  { field: 'scale', label: '縮放（欄寬）', min: LIMITS.scale[0], max: LIMITS.scale[1], step: 0.05, format: (v) => `${Math.round(v * 100)}%` },
  { field: 'gap', label: '間距', min: LIMITS.gap[0], max: LIMITS.gap[1], step: 1, format: (v) => `${v} px` },
  { field: 'row', label: '列高（相對欄寬）', min: LIMITS.row[0], max: LIMITS.row[1], step: 0.05, format: (v) => `${Math.round(v * 100)}%` },
]
