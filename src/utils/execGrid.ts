import { useState } from 'react'
import type { SizePreset, SizeSlider } from './gridDensity'

/*
 * Grid size of the control panel's Executor sidebar (per device, localStorage): how wide a strip
 * column is at least, the gap between strips, and the size of a strip's fader and keys.
 */

export interface ExecGrid {
  /** Minimum strip width, px (the sidebar fits as many columns as this allows). */
  col: number
  /** Gap between strips, px. */
  gap: number
  /** Fader / GO / PAUSE size (1 = standard). */
  scale: number
  /** Strips per row: 0 = as many as fit, 1–8 = fixed. */
  cols: number
  [key: string]: number
}

export const EXEC_GRID_PRESETS: Record<'compact' | 'normal' | 'spacious', SizePreset<ExecGrid>> = {
  compact: { label: '精巧', hint: 'Compact', value: { col: 108, gap: 6, scale: 0.8, cols: 0 } },
  normal: { label: '標準', hint: 'Normal', value: { col: 124, gap: 8, scale: 1, cols: 0 } },
  spacious: { label: '寬鬆', hint: 'Spacious', value: { col: 170, gap: 14, scale: 1.25, cols: 0 } },
}
export const DEFAULT_EXEC_GRID = EXEC_GRID_PRESETS.normal.value

const LIMITS = { col: [96, 280], gap: [2, 24], scale: [0.7, 1.6], cols: [0, 8] } as const
export const EXEC_GRID_SLIDERS: SizeSlider<ExecGrid>[] = [
  { field: 'col', label: '欄寬（每條推桿最小寬度）', min: LIMITS.col[0], max: LIMITS.col[1], step: 2, format: (v) => `${v} px` },
  { field: 'gap', label: '間距', min: LIMITS.gap[0], max: LIMITS.gap[1], step: 1, format: (v) => `${v} px` },
  { field: 'scale', label: '推桿與按鍵大小', min: LIMITS.scale[0], max: LIMITS.scale[1], step: 0.05, format: (v) => `${Math.round(v * 100)}%` },
  { field: 'cols', label: '每排數量', min: LIMITS.cols[0], max: LIMITS.cols[1], step: 1, format: (v) => (v ? `${v} 個` : '自動') },
]

/**
 * Grid columns for a strip container: as many as fit (each at least `col` wide), or a fixed
 * count (each never narrower than the smallest usable strip — narrower rooms scroll sideways).
 */
export const execGridColumns = (g: ExecGrid) => (g.cols ? `repeat(${g.cols}, minmax(${LIMITS.col[0]}px, 1fr))` : `repeat(auto-fill, minmax(min(${g.col}px, 100%), 1fr))`)

const KEY = 'theatre.surface.execGrid'
const clamp = (v: unknown, [lo, hi]: readonly [number, number], fallback: number) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback
}
const clean = (r: Partial<ExecGrid> | null | undefined): ExecGrid => ({
  col: Math.round(clamp(r?.col, LIMITS.col, DEFAULT_EXEC_GRID.col)),
  gap: Math.round(clamp(r?.gap, LIMITS.gap, DEFAULT_EXEC_GRID.gap)),
  scale: clamp(r?.scale, LIMITS.scale, DEFAULT_EXEC_GRID.scale),
  cols: Math.round(clamp(r?.cols, LIMITS.cols, 0)),
})

export function useExecGrid() {
  const [value, setValue] = useState<ExecGrid>(() => {
    try {
      return clean(JSON.parse(localStorage.getItem(KEY) ?? 'null'))
    } catch {
      return DEFAULT_EXEC_GRID
    }
  })
  const set = (next: ExecGrid) => {
    const v = clean(next)
    setValue(v)
    try {
      localStorage.setItem(KEY, JSON.stringify(v))
    } catch {
      // Not remembered; still applies now.
    }
  }
  return [value, set] as const
}
