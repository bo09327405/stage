/*
 * 3D sound trajectory (Studio track → binaural HRTF): where a track's sound sits around the listener over time.
 * Stored on the track as `trajectoryConfig` (plain JSON, see normalizeTrajectory); evaluated by studio/trajectoryPath.ts,
 * rendered by studio/spatial.ts and edited in components/studio/TrajectoryPanel.tsx.
 *
 * Pure (no imports), so node's test runner can load it directly.
 *
 * Conventions: metres; right-handed, Y up; the listener is the origin and faces −Z (+X is right, +Y is up).
 */

export interface TrajVec3 {
  x: number
  y: number
  z: number
}

/** static: one fixed point · freehand: a drawn / hand-edited path · preset: generated from `preset` (sliders). */
export type TrajPathType = 'static' | 'freehand' | 'preset'
export const TRAJ_PATH_TYPES: TrajPathType[] = ['static', 'freehand', 'preset']

export type TrajPresetShape = 'orbit' | 'lissajous' | 'spiral' | 'pendulum'
export const TRAJ_PRESET_SHAPES: { id: TrajPresetShape; label: string; hint: string }[] = [
  { id: 'orbit', label: '圓周環繞 Orbit', hint: '繞著觀眾一圈' },
  { id: 'lissajous', label: '8 字形 Lissajous', hint: '在前方畫 8 字' },
  { id: 'spiral', label: '螺旋 Spiral', hint: '邊繞邊升高、由近而遠' },
  { id: 'pendulum', label: '鐘擺 Pendulum', hint: '在前方左右擺盪' },
]

export type TrajLoopMode = 'once' | 'loop' | 'pingpong'
export const TRAJ_LOOP_MODES: { id: TrajLoopMode; label: string }[] = [
  { id: 'once', label: '單趟' },
  { id: 'loop', label: '循環' },
  { id: 'pingpong', label: '來回' },
]

/** Parameters of the preset generators (the sliders of the "geometry" box). */
export interface TrajPreset {
  shape: TrajPresetShape
  /** Metres. */
  radius: number
  /** Metres: orbit / lissajous / pendulum height; spiral rise. */
  height: number
  /** Spiral turns. */
  turns: number
}

export interface TrajPlayback {
  /** Seconds for one pass along the path. */
  durationSec: number
  loopMode: TrajLoopMode
  /** 0–1 shift along the path: several tracks sharing one path with 0 / 0.25 / 0.5 / 0.75 chase each other. */
  phaseOffset: number
}

export interface TrajAcoustics {
  /** Distance (m) up to which the level does not fall. */
  refDistance: number
  /** Distance (m) beyond which the level stops falling (and the air / reverb effects saturate). */
  maxDistance: number
  rolloffFactor: number
  /** 0–1: how much of the high end distance takes away. */
  airAbsorption: number
  /** 0–1: reverb amount for a far source (a near one is drier). */
  reverbSend: number
}

export interface TrajectoryConfig {
  enabled: boolean
  pathType: TrajPathType
  preset: TrajPreset
  /** Control points of the spline. */
  waypoints: TrajVec3[]
  /** The path closes on itself (orbit, 8-figure): the last point flows into the first. */
  closed: boolean
  playback: TrajPlayback
  acoustics: TrajAcoustics
  /**
   * Follow another track's path and playback (waypoints, duration, loop mode) with this track's own
   * `phaseOffset` and acoustics; '' = use own path.
   */
  pathSourceTrackId: string
  /**
   * On audience devices with the gyroscope or an XR session running, turn the sound field with the head: the
   * listener's facing follows the view, so a sound stays where it is in the room while the audience looks around.
   */
  headTrack: boolean
}

export const TRAJ_LIMIT = 50
export const MAX_WAYPOINTS = 64

export const DEFAULT_TRAJ_PRESET: TrajPreset = { shape: 'orbit', radius: 3, height: 0, turns: 3 }

export const DEFAULT_TRAJECTORY: TrajectoryConfig = {
  enabled: false,
  pathType: 'static',
  preset: DEFAULT_TRAJ_PRESET,
  waypoints: [{ x: 0, y: 0, z: -2 }],
  closed: false,
  playback: { durationSec: 12, loopMode: 'loop', phaseOffset: 0 },
  acoustics: { refDistance: 1, maxDistance: 20, rolloffFactor: 1, airAbsorption: 0.5, reverbSend: 0.25 },
  pathSourceTrackId: '',
  headTrack: false,
}

const num = (v: unknown, fallback: number, min = -Infinity, max = Infinity) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}
const round = (v: number, digits = 3) => {
  const k = 10 ** digits
  return Math.round(v * k) / k
}

/** Realtime Database hands arrays back as objects keyed by index. */
const toList = (v: unknown): unknown[] => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : [])

export function normalizeVec3(raw: unknown, fallback: TrajVec3 = { x: 0, y: 0, z: -2 }): TrajVec3 {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof TrajVec3, unknown>>
  return {
    x: round(num(r.x, fallback.x, -TRAJ_LIMIT, TRAJ_LIMIT)),
    y: round(num(r.y, fallback.y, -TRAJ_LIMIT, TRAJ_LIMIT)),
    z: round(num(r.z, fallback.z, -TRAJ_LIMIT, TRAJ_LIMIT)),
  }
}

/** Repair a stored (or hand-edited) config: every field present, clamped, and no undefined (the database rejects it). */
export function normalizeTrajectory(raw: unknown): TrajectoryConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>
  const d = DEFAULT_TRAJECTORY
  const pathType: TrajPathType = TRAJ_PATH_TYPES.includes(r.pathType) ? r.pathType : d.pathType
  const shape: TrajPresetShape = TRAJ_PRESET_SHAPES.some((s) => s.id === r.preset?.shape) ? r.preset.shape : d.preset.shape
  let waypoints = toList(r.waypoints)
    .filter((p) => p && typeof p === 'object')
    .slice(0, MAX_WAYPOINTS)
    .map((p) => normalizeVec3(p))
  if (waypoints.length === 0) waypoints = d.waypoints.map((p) => ({ ...p }))
  if (pathType === 'static') waypoints = [waypoints[0]]
  const refDistance = num(r.acoustics?.refDistance, d.acoustics.refDistance, 0.1, 20)
  return {
    enabled: !!r.enabled,
    pathType,
    preset: {
      shape,
      radius: num(r.preset?.radius, d.preset.radius, 0.5, TRAJ_LIMIT),
      height: num(r.preset?.height, d.preset.height, -TRAJ_LIMIT, TRAJ_LIMIT),
      turns: num(r.preset?.turns, d.preset.turns, 0.5, 12),
    },
    waypoints,
    closed: pathType !== 'static' && !!r.closed && waypoints.length >= 3,
    playback: {
      durationSec: num(r.playback?.durationSec, d.playback.durationSec, 0.5, 3600),
      loopMode: TRAJ_LOOP_MODES.some((m) => m.id === r.playback?.loopMode) ? r.playback.loopMode : d.playback.loopMode,
      phaseOffset: num(r.playback?.phaseOffset, 0, 0, 1),
    },
    acoustics: {
      refDistance,
      maxDistance: num(r.acoustics?.maxDistance, d.acoustics.maxDistance, refDistance + 0.5, 200),
      rolloffFactor: num(r.acoustics?.rolloffFactor, d.acoustics.rolloffFactor, 0, 5),
      airAbsorption: num(r.acoustics?.airAbsorption, d.acoustics.airAbsorption, 0, 1),
      reverbSend: num(r.acoustics?.reverbSend, d.acoustics.reverbSend, 0, 1),
    },
    pathSourceTrackId: typeof r.pathSourceTrackId === 'string' ? r.pathSourceTrackId : '',
    headTrack: !!r.headTrack,
  }
}

/* ---------- geometric generators ---------- */

const TAU = Math.PI * 2

/**
 * Waypoints for a preset shape. Orbit and 8-figure are closed (the last point flows into the first); spiral and
 * pendulum are open. Every shape starts straight ahead of the listener (−Z) and keeps clear of the head.
 */
export function generatePreset(p: TrajPreset): { waypoints: TrajVec3[]; closed: boolean; loopMode: TrajLoopMode } {
  const { radius: r, height: h } = p
  const pts: TrajVec3[] = []
  const at = (x: number, y: number, z: number) => pts.push(normalizeVec3({ x, y, z }))
  switch (p.shape) {
    case 'orbit': {
      const n = 16
      for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU
        at(r * Math.sin(a), h, -r * Math.cos(a))
      }
      return { waypoints: pts, closed: true, loopMode: 'loop' }
    }
    case 'lissajous': {
      const n = 20
      for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU
        at(r * Math.sin(a), h, -r - r * 0.5 * Math.sin(2 * a))
      }
      return { waypoints: pts, closed: true, loopMode: 'loop' }
    }
    case 'spiral': {
      const n = Math.min(MAX_WAYPOINTS, Math.max(12, Math.round(p.turns * 12)))
      for (let i = 0; i < n; i++) {
        const u = i / (n - 1)
        const a = u * p.turns * TAU
        const rr = r * (0.35 + 0.65 * u)
        at(rr * Math.sin(a), h * u, -rr * Math.cos(a))
      }
      return { waypoints: pts, closed: false, loopMode: 'once' }
    }
    case 'pendulum': {
      const n = 11
      for (let i = 0; i < n; i++) {
        const th = ((i / (n - 1)) * 2 - 1) * (Math.PI / 3)
        at(r * Math.sin(th), h, -r * Math.cos(th))
      }
      return { waypoints: pts, closed: false, loopMode: 'pingpong' }
    }
  }
}

/**
 * Thin a dragged stroke to a clean control polygon: drop points closer than `minGap` to the last kept one, then,
 * if still above `max`, keep an even subset (always including both ends).
 */
export function decimateStroke(points: TrajVec3[], minGap = 0.35, max = 32): TrajVec3[] {
  if (points.length <= 2) return points.slice()
  const kept: TrajVec3[] = [points[0]]
  for (let i = 1; i < points.length - 1; i++) {
    const a = kept[kept.length - 1]
    if (Math.hypot(points[i].x - a.x, points[i].y - a.y, points[i].z - a.z) >= minGap) kept.push(points[i])
  }
  kept.push(points[points.length - 1])
  if (kept.length <= max) return kept
  return Array.from({ length: max }, (_, i) => kept[Math.round((i * (kept.length - 1)) / (max - 1))])
}

/* ---------- time → position progress ---------- */

/**
 * Where on the path (0–1 of its length) the sound is `t` seconds after its path clock started: the pass length,
 * the loop mode and the track's phase offset decide. `once` stops at the end; `pingpong` runs there and back.
 */
export function pathProgress(pb: TrajPlayback, t: number): number {
  const u = Math.max(0, t) / pb.durationSec + pb.phaseOffset
  switch (pb.loopMode) {
    case 'once':
      return Math.min(1, u)
    case 'loop':
      return u - Math.floor(u)
    case 'pingpong': {
      const m = u % 2
      return m <= 1 ? m : 2 - m
    }
  }
}

/* ---------- distance acoustics ---------- */

export const distanceFromListener = (p: TrajVec3) => Math.hypot(p.x, p.y, p.z)

/** Low-pass cutoff (Hz) that air absorption leaves at distance `d`: nothing up to refDistance, ~4 octaves down at maxDistance (full amount). */
export function airCutoffHz(d: number, a: TrajAcoustics): number {
  const far = Math.min(1, Math.max(0, (d - a.refDistance) / (a.maxDistance - a.refDistance)))
  return Math.max(800, 20000 * 2 ** (-4 * a.airAbsorption * far))
}

/** Wet (reverb) level at distance `d`: a near source is mostly dry, a far one mostly reverberant. */
export function reverbWetAt(d: number, a: TrajAcoustics): number {
  const far = Math.min(1, Math.max(0, d / a.maxDistance))
  return a.reverbSend * (0.15 + 0.85 * Math.sqrt(far))
}

/** Level at distance `d` from the listener: the 'inverse' model of Web Audio's panner (1 up to refDistance, then falling). */
export function distanceGain(d: number, a: TrajAcoustics): number {
  const clamped = Math.min(Math.max(d, a.refDistance), a.maxDistance)
  return a.refDistance / (a.refDistance + a.rolloffFactor * (clamped - a.refDistance))
}
