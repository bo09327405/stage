import type { ParamTarget, ShowParam, StudioParam, SurfaceWidget } from '../types/surface'

/*
 * What knobs and faders can control live, and the range of each. A control's position (0–1 of
 * its travel) maps onto the parameter's range; labels format values for the knob readout.
 */

export interface ParamDef {
  label: string
  min: number
  max: number
  /** Where double-click on a knob returns to. */
  def: number
  format: (v: number) => string
}

const db = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)} dB`
const pct = (v: number) => `${Math.round(v * 100)}%`
const pan = (v: number) => (Math.abs(v) < 0.01 ? 'C' : v < 0 ? `L${Math.round(-v * 100)}` : `R${Math.round(v * 100)}`)
const hz = (v: number) => {
  const f = 20 * 1000 ** v
  return f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 0 : 1)} kHz` : `${Math.round(f)} Hz`
}
const gainDb = (g: number) => (g <= 0 ? '−∞' : db(20 * Math.log10(g)))

export const SHOW_PARAMS: Record<ShowParam, ParamDef> = {
  master: { label: 'Master 音量', min: 0, max: 100, def: 100, format: (v) => `${Math.round(v)}%` },
  eqLow: { label: 'EQ 低音', min: -15, max: 15, def: 0, format: db },
  eqMid: { label: 'EQ 中音', min: -15, max: 15, def: 0, format: db },
  eqHigh: { label: 'EQ 高音', min: -15, max: 15, def: 0, format: db },
  filter: { label: 'Filter Cutoff（低通）', min: 0, max: 1, def: 1, format: hz },
  reverb: { label: 'Reverb Wet', min: 0, max: 1, def: 0, format: pct },
  delay: { label: 'Delay Wet', min: 0, max: 1, def: 0, format: pct },
  pan: { label: 'Pan 聲像', min: -1, max: 1, def: 0, format: pan },
}

export const STUDIO_PARAMS: Record<StudioParam, ParamDef> = {
  volume: { label: '音量', min: 0, max: 1.5, def: 1, format: gainDb },
  pan: { label: 'Pan 聲像', min: -1, max: 1, def: 0, format: pan },
  reverb: { label: 'Reverb', min: 0, max: 1, def: 0, format: pct },
  delay: { label: 'Delay', min: 0, max: 1, def: 0, format: pct },
  eqLow: { label: 'EQ 低音', min: -18, max: 18, def: 0, format: db },
  eqMid: { label: 'EQ 中音', min: -18, max: 18, def: 0, format: db },
  eqHigh: { label: 'EQ 高音', min: -18, max: 18, def: 0, format: db },
}

export const paramDef = (t: ParamTarget): ParamDef => (t.scope === 'show' ? SHOW_PARAMS[t.param] : STUDIO_PARAMS[t.param])

/** Parameter value for a control position 0–1. */
export const fromNorm = (t: ParamTarget, n: number) => {
  const d = paramDef(t)
  return d.min + Math.max(0, Math.min(1, n)) * (d.max - d.min)
}
/** Control position 0–1 for a parameter value. */
export const toNorm = (t: ParamTarget, v: number) => {
  const d = paramDef(t)
  return d.max === d.min ? 0 : (v - d.min) / (d.max - d.min)
}

/** Database field of a Studio parameter, under projects/{pid}/studio/{sid}/. */
export function studioParamPath(t: Extract<ParamTarget, { scope: 'studio' }>): string {
  if (t.trackId === 'master') return 'masterVolume'
  const base = `tracks/${t.trackId}`
  switch (t.param) {
    case 'volume':
      return `${base}/volume`
    case 'pan':
      return `${base}/pan`
    case 'reverb':
      return `${base}/fx/reverb`
    case 'delay':
      return `${base}/fx/delay`
    case 'eqLow':
      return `${base}/eq/low`
    case 'eqMid':
      return `${base}/eq/mid`
    case 'eqHigh':
      return `${base}/eq/high`
  }
}

/** A knob / fader position (0–1 of its travel). */
export const widgetNorm = (w: SurfaceWidget, v: number) => (w.max === w.min ? 0 : Math.max(0, Math.min(1, (v - w.min) / (w.max - w.min))))

/** Readout for a knob / fader: the bound parameter in its own units, else the raw value. */
export function widgetReadout(w: SurfaceWidget, value: number) {
  const n = widgetNorm(w, value)
  for (const a of w.actions) {
    if (a.kind === 'param') return paramDef(a.target).format(fromNorm(a.target, n))
    if (a.kind === 'xfade') return `${Math.round(n * 100)}%`
    if (a.kind === 'hit') return a.mode === 'trigger' ? (n >= 0.5 ? 'ON' : 'OFF') : `${Math.round(n * 100)}%`
  }
  return value.toFixed(2)
}
