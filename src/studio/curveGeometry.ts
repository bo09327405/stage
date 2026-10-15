import type { StudioPoint } from '../types/studio'
import { segmentControls, shapeOf, type PresetShape, type Range, type SegmentControls } from './curves'

/** Which part of a curve a drag grabbed: the bend grip, or Bézier handle 1 / 2. */
export type CurveGrab = 'grip' | 1 | 2

/** How long a press must be held (without moving) to reset a curve. */
export const LONG_PRESS_MS = 550

export interface CurveGeometry {
  /** Time → x and value → y inside the SVG. */
  X: (t: number) => number
  Y: (v: number) => number
  range: Range
  /** Shape of segments without one (track lanes smooth, region volume linear). */
  def: PresetShape
}

export interface CurveSegment {
  a: StudioPoint
  b: StudioPoint
  c: SegmentControls
  /** SVG path of the segment (M … C / L …). */
  d: string
}

export function curveSegments(points: StudioPoint[], g: CurveGeometry): CurveSegment[] {
  return points.slice(0, -1).map((a, i) => {
    const b = points[i + 1]
    const c = segmentControls(a, b, g.range, g.def)
    const d =
      shapeOf(a, g.def) === 'linear'
        ? `M${g.X(a.t)},${g.Y(a.v)} L${g.X(b.t)},${g.Y(b.v)}`
        : `M${g.X(c.t0)},${g.Y(c.v0)} C${g.X(c.t1)},${g.Y(c.v1)} ${g.X(c.t2)},${g.Y(c.v2)} ${g.X(c.t3)},${g.Y(c.v3)}`
    return { a, b, c, d }
  })
}

/** One path through all nodes, flat to `x0` before the first and to `x1` after the last. */
export function curvePath(points: StudioPoint[], segs: CurveSegment[], g: CurveGeometry, x0: number, x1: number) {
  if (points.length === 0) return ''
  const first = points[0]
  const last = points[points.length - 1]
  return `M${x0},${g.Y(first.v)} L${g.X(first.t)},${g.Y(first.v)}` + segs.map((s) => ' ' + s.d.replace(/^M[^ ]+ /, '')).join('') + ` L${x1},${g.Y(last.v)}`
}

