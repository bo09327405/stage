import type { CurveHandles, StudioPoint } from '../types/studio'

/*
 * Automation curves. Each node carries the shape of the segment that leaves it (to the next node):
 *
 *   smooth  — ease-in-out (the default; exactly the old smoothstep curve)
 *   linear  — a straight line
 *   bezier  — a cubic Bézier with two free handles
 *
 * Every shape is evaluated as a cubic Bézier P0 → P1 → P2 → P3 in (time, value) space, P0 / P3
 * being the two nodes. Handles are stored relative to the segment so they follow when the nodes
 * move: x as a fraction (0–1) of the segment's length (which keeps the curve a function of time),
 * y as an offset from the straight line between the nodes, in fractions of the parameter's range
 * (so a flat segment can still bend). Handle values are clamped into the parameter's range, which
 * keeps the whole curve inside it (a Bézier stays within its control points' hull).
 */

/** Preset shapes. A point without `curve` takes its context's default (track lanes: smooth, region volume: linear). */
export type PresetShape = 'smooth' | 'linear'
export type Shape = PresetShape | 'bezier'

/** A segment's shape, given its context's default. */
export const shapeOf = (p: StudioPoint, def: PresetShape): Shape => (p.curve === 'bezier' && p.h ? 'bezier' : (p.curve ?? def))

export interface Range {
  min: number
  max: number
}

/** Control points of a segment in (time, value) space. */
export interface SegmentControls {
  t0: number
  v0: number
  t1: number
  v1: number
  t2: number
  v2: number
  t3: number
  v3: number
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))
const lerp = (a: number, b: number, x: number) => a + (b - a) * x

/** The handles that reproduce each preset shape (in the stored, relative form). */
export function presetHandles(shape: 'smooth' | 'linear', a: StudioPoint, b: StudioPoint, range: Range): CurveHandles {
  if (shape === 'linear') return { x1: 1 / 3, y1: 0, x2: 2 / 3, y2: 0 }
  // smoothstep 3x² − 2x³ is the Bézier with P1 = (1/3, a.v) and P2 = (2/3, b.v).
  const span = range.max - range.min || 1
  return { x1: 1 / 3, y1: (a.v - lerp(a.v, b.v, 1 / 3)) / span, x2: 2 / 3, y2: (b.v - lerp(a.v, b.v, 2 / 3)) / span }
}

/** A segment's handles, whatever its shape. */
export function handlesOf(a: StudioPoint, b: StudioPoint, range: Range, def: PresetShape = 'smooth'): CurveHandles {
  const shape = shapeOf(a, def)
  return shape === 'bezier' ? a.h! : presetHandles(shape, a, b, range)
}

/** Absolute control points of the segment a → b. */
export function segmentControls(a: StudioPoint, b: StudioPoint, range: Range, def: PresetShape = 'smooth'): SegmentControls {
  const h = handlesOf(a, b, range, def)
  const span = range.max - range.min || 1
  const x1 = clamp(h.x1, 0, 1)
  const x2 = clamp(h.x2, 0, 1)
  return {
    t0: a.t,
    v0: a.v,
    t1: lerp(a.t, b.t, x1),
    v1: clamp(lerp(a.v, b.v, x1) + h.y1 * span, range.min, range.max),
    t2: lerp(a.t, b.t, x2),
    v2: clamp(lerp(a.v, b.v, x2) + h.y2 * span, range.min, range.max),
    t3: b.t,
    v3: b.v,
  }
}

/** Stored handles for absolute control-point positions (a handle being dragged). */
export function handlesFromControls(a: StudioPoint, b: StudioPoint, c: { t1: number; v1: number; t2: number; v2: number }, range: Range): CurveHandles {
  const span = range.max - range.min || 1
  const dt = b.t - a.t || 1e-6
  const x1 = clamp((c.t1 - a.t) / dt, 0, 1)
  const x2 = clamp((c.t2 - a.t) / dt, 0, 1)
  const r = (n: number) => Math.round(n * 10000) / 10000
  return {
    x1: r(x1),
    y1: r((clamp(c.v1, range.min, range.max) - lerp(a.v, b.v, x1)) / span),
    x2: r(x2),
    y2: r((clamp(c.v2, range.min, range.max) - lerp(a.v, b.v, x2)) / span),
  }
}

const bez = (p0: number, p1: number, p2: number, p3: number, s: number) => {
  const u = 1 - s
  return u * u * u * p0 + 3 * u * u * s * p1 + 3 * u * s * s * p2 + s * s * s * p3
}
const bezD = (p0: number, p1: number, p2: number, p3: number, s: number) => {
  const u = 1 - s
  return 3 * u * u * (p1 - p0) + 6 * u * s * (p2 - p1) + 3 * s * s * (p3 - p2)
}

/** The curve parameter s (0–1) where the segment reaches time t: Newton steps, bisection fallback. */
export function solveS(c: SegmentControls, t: number): number {
  if (t <= c.t0) return 0
  if (t >= c.t3) return 1
  let s = (t - c.t0) / (c.t3 - c.t0)
  for (let i = 0; i < 8; i++) {
    const err = bez(c.t0, c.t1, c.t2, c.t3, s) - t
    if (Math.abs(err) < 1e-7) return s
    const d = bezD(c.t0, c.t1, c.t2, c.t3, s)
    if (Math.abs(d) < 1e-9) break
    s = clamp(s - err / d, 0, 1)
  }
  // Handles at the ends make the derivative vanish; bisection always converges (x(s) is monotonic).
  let lo = 0
  let hi = 1
  for (let i = 0; i < 40; i++) {
    s = (lo + hi) / 2
    if (bez(c.t0, c.t1, c.t2, c.t3, s) < t) lo = s
    else hi = s
  }
  return s
}

/** Value of segment a → b at time t (a.t ≤ t ≤ b.t). */
export function segmentValueAt(a: StudioPoint, b: StudioPoint, t: number, range: Range, def: PresetShape = 'smooth'): number {
  if (shapeOf(a, def) === 'linear') return lerp(a.v, b.v, (t - a.t) / Math.max(1e-6, b.t - a.t))
  const c = segmentControls(a, b, range, def)
  return bez(c.v0, c.v1, c.v2, c.v3, solveS(c, t))
}

/** Lane value at time t: the curves between nodes, flat before the first and after the last. */
export function curveValueAt(points: StudioPoint[], t: number, fallback: number, range: Range, def: PresetShape = 'smooth'): number {
  if (points.length === 0) return fallback
  if (t <= points[0].t) return points[0].v
  const last = points[points.length - 1]
  if (t >= last.t) return last.v
  // Binary search: lanes can have many nodes and playback samples 50 times a second.
  let lo = 0
  let hi = points.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (points[mid].t <= t) lo = mid
    else hi = mid
  }
  return segmentValueAt(points[lo], points[hi], t, range, def)
}

/**
 * Split segment a → b at time t exactly (de Casteljau), for inserting a node on the curve. Returns
 * the updated first node and the new middle node, both carrying the halves' shapes.
 */
export function splitSegment(a: StudioPoint, b: StudioPoint, t: number, range: Range, def: PresetShape = 'smooth'): [StudioPoint, StudioPoint] {
  const c = segmentControls(a, b, range, def)
  const s = solveS(c, t)
  const mix = (p: [number, number], q: [number, number]): [number, number] => [lerp(p[0], q[0], s), lerp(p[1], q[1], s)]
  const P0: [number, number] = [c.t0, c.v0]
  const P1: [number, number] = [c.t1, c.v1]
  const P2: [number, number] = [c.t2, c.v2]
  const P3: [number, number] = [c.t3, c.v3]
  const A = mix(P0, P1)
  const B = mix(P1, P2)
  const C = mix(P2, P3)
  const D = mix(A, B)
  const E = mix(B, C)
  const M = mix(D, E)
  const r3 = (n: number) => Math.round(n * 1000) / 1000
  const mid: StudioPoint = { t: r3(M[0]), v: r3(M[1]) }
  if (shapeOf(a, def) === 'linear') return [a, { ...mid, ...(a.curve ? { curve: a.curve } : {}) }]
  const first: StudioPoint = { ...a, curve: 'bezier', h: handlesFromControls(a, mid, { t1: A[0], v1: A[1], t2: D[0], v2: D[1] }, range) }
  const second: StudioPoint = { ...mid, curve: 'bezier', h: handlesFromControls(mid, b, { t1: E[0], v1: E[1], t2: C[0], v2: C[1] }, range) }
  return [first, second]
}

/** Reset a segment to a preset shape (drops custom handles). The context default isn't stored. */
export function withShape(p: StudioPoint, shape: PresetShape, def: PresetShape = 'smooth'): StudioPoint {
  const { h: _h, curve: _c, ...rest } = p
  return shape === def ? rest : { ...rest, curve: shape }
}

/** Double-click / long-press reset: a custom curve goes back to the default; smooth ⇄ linear. */
export function resetShape(p: StudioPoint, def: PresetShape): StudioPoint {
  const shape = shapeOf(p, def)
  return withShape(p, shape === 'bezier' ? def : shape === 'smooth' ? 'linear' : 'smooth', def)
}

/** Point on the segment halfway along its curve (where its bend grip sits). */
export function segmentMid(c: SegmentControls) {
  return { t: (c.t0 + 3 * c.t1 + 3 * c.t2 + c.t3) / 8, v: (c.v0 + 3 * c.v1 + 3 * c.v2 + c.v3) / 8 }
}

/**
 * Bend a segment so its middle passes through value `v` (dragging the bend grip): symmetric
 * handles at one and two thirds of the segment, both offset by the same amount.
 */
export function bendHandles(a: StudioPoint, b: StudioPoint, v: number, range: Range): CurveHandles {
  const span = range.max - range.min || 1
  // With x1 = 1/3 and x2 = 2/3 the middle of the curve is 3/4 of the common offset above the line.
  const k = Math.max(-1, Math.min(1, (v - (a.v + b.v) / 2) / (0.75 * span)))
  const r = (n: number) => Math.round(n * 10000) / 10000
  return { x1: 1 / 3, y1: r(k), x2: 2 / 3, y2: r(k) }
}
