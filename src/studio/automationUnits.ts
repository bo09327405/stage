import { filterHz, type TrackParam } from '../types/studio'

/*
 * Automation node values in the units people type: volume / region gain in dB, pan in L/R %,
 * filter cutoff in Hz. Stored values: gain multiplier 0–1.5, pan −1…1, filter 0–1 (log 20 Hz–20 kHz).
 */

export type NodeParam = TrackParam | 'gain'

export interface NodeUnit {
  label: string
  unit: string
  min: number
  max: number
  step: number
  hint: string
}

const MAX_GAIN = 1.5
const MAX_DB = Math.round(20 * Math.log10(MAX_GAIN) * 10) / 10 // +3.5
const MIN_DB = -60

export const NODE_UNITS: Record<NodeParam, NodeUnit> = {
  gain: { label: '音量', unit: 'dB', min: MIN_DB, max: MAX_DB, step: 0.1, hint: `${MIN_DB} 以下 = 靜音（−∞），最大 +${MAX_DB}` },
  volume: { label: '音量', unit: 'dB', min: MIN_DB, max: MAX_DB, step: 0.1, hint: `${MIN_DB} 以下 = 靜音（−∞），最大 +${MAX_DB}` },
  pan: { label: '聲相', unit: 'L−／R+', min: -100, max: 100, step: 1, hint: '−100 = 全左，0 = 置中，100 = 全右' },
  filter: { label: '低通截止頻率', unit: 'Hz', min: 20, max: 20000, step: 1, hint: '20 – 20000 Hz（20000 = 不濾波）' },
}

/** Stored value → number shown in the editor. */
export function toDisplay(param: NodeParam, v: number): number {
  if (param === 'gain' || param === 'volume') return v <= 0 ? MIN_DB : Math.round(20 * Math.log10(v) * 10) / 10
  if (param === 'pan') return Math.round(v * 100)
  return Math.round(filterHz(v))
}

/** Number typed in the editor → stored value (clamped to the parameter's range). */
export function fromDisplay(param: NodeParam, x: number): number {
  const round = (n: number) => Math.round(n * 1000) / 1000
  if (param === 'gain' || param === 'volume') return x <= MIN_DB ? 0 : round(Math.min(MAX_GAIN, 10 ** (x / 20)))
  if (param === 'pan') return round(Math.max(-1, Math.min(1, x / 100)))
  // Log scale: 4 decimals keep typed frequencies within ~0.1 %.
  return Math.round(Math.max(0, Math.min(1, Math.log(Math.max(20, Math.min(20000, x)) / 20) / Math.log(1000))) * 10000) / 10000
}

/** Short text for a stored value: "-3.0 dB", "L 40", "1.2 kHz". */
export function nodeLabel(param: NodeParam, v: number): string {
  if (param === 'gain' || param === 'volume') return v <= 0 ? '−∞ dB' : `${toDisplay(param, v) >= 0 ? '+' : ''}${toDisplay(param, v).toFixed(1)} dB`
  if (param === 'pan') return Math.abs(v) < 0.01 ? 'C' : v < 0 ? `L ${Math.round(-v * 100)}` : `R ${Math.round(v * 100)}`
  const hz = filterHz(v)
  return hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10000 ? 0 : 1)} kHz` : `${Math.round(hz)} Hz`
}
