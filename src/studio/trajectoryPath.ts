import { CatmullRomCurve3, Vector3 } from 'three'
import { pathProgress, type TrajectoryConfig, type TrajVec3 } from '../types/trajectory.ts'

/**
 * A track's sound path as a spline. The same curve (arc-length parameterised, so the sound moves at a steady
 * speed) is drawn in the studio viewport and evaluated by the audio engine, so what you see is what you hear.
 */
export interface TrajectoryPath {
  /** Position `t` seconds after the path clock started (pass length, loop mode and phase offset applied). */
  at: (t: number) => TrajVec3
  /** Position at a fraction (0–1) of the path's length. */
  atProgress: (u: number) => TrajVec3
  /** `count` points along the whole path, for drawing it. */
  sample: (count: number) => TrajVec3[]
}

const toVec = (v: Vector3): TrajVec3 => ({ x: v.x, y: v.y, z: v.z })

export function buildPath(cfg: TrajectoryConfig): TrajectoryPath {
  const pts = cfg.waypoints
  if (cfg.pathType === 'static' || pts.length < 2) {
    const p = pts[0] ?? { x: 0, y: 0, z: -2 }
    const fixed = () => ({ ...p })
    return { at: fixed, atProgress: fixed, sample: (n) => Array.from({ length: Math.max(1, n) }, fixed) }
  }
  const curve = new CatmullRomCurve3(
    pts.map((p) => new Vector3(p.x, p.y, p.z)),
    cfg.closed,
    'centripetal',
  )
  const atProgress = (u: number) => toVec(curve.getPointAt(Math.min(1, Math.max(0, u))))
  return {
    atProgress,
    at: (t) => atProgress(pathProgress(cfg.playback, t)),
    sample: (n) => curve.getSpacedPoints(Math.max(2, n)).map(toVec),
  }
}
