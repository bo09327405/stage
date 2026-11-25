/*
 * Spatial audio formats of a Studio track or a cue, next to the Sound Trajectory (types/trajectory.ts):
 *
 *   standard             plain stereo / mono
 *   trajectory_binaural  a mono sound moved along a drawn path, rendered with HRTF (trajectoryConfig)
 *   ambisonics           a multichannel soundfield (4 / 9 / 16 channels: first, second, third order), rotated and
 *                        decoded to binaural stereo; other tracks can be encoded into it (busInputs)
 *   eclipsa_iamf         an IAMF (Eclipsa Audio) file: pick a mix presentation, trim its elements, bind the head
 *
 * Pure (no imports), so node's test runner can load it directly.
 *
 * Conventions: Ambisonics are AmbiX (ACN channel order, SN3D normalisation). Angles in degrees: yaw turns the
 * soundfield clockwise seen from above (what was in front moves to the right), pitch tilts it up (front → up), roll
 * lowers its right side. Scene coordinates are the trajectory's: metres, +X right, +Y up, the listener faces −Z.
 */

export type SpatialFormat = 'standard' | 'trajectory_binaural' | 'ambisonics' | 'eclipsa_iamf'

export const SPATIAL_FORMATS: { id: SpatialFormat; label: string; hint: string }[] = [
  { id: 'standard', label: '一般', hint: '單聲道或立體聲' },
  { id: 'trajectory_binaural', label: '軌跡雙耳', hint: '單聲道沿路徑移動，HRTF 雙耳定位' },
  { id: 'ambisonics', label: 'Ambisonics', hint: '4 / 9 / 16 聲道球面聲場，可旋轉校正' },
  { id: 'eclipsa_iamf', label: 'Eclipsa (IAMF)', hint: '含多個混音版本與音訊元素的沉浸式音訊' },
]

export const isSpatialFormat = (v: unknown): v is SpatialFormat => SPATIAL_FORMATS.some((f) => f.id === v)

/* ---------- Ambisonics ---------- */

/** 1 = first order (FOA, 4 channels) … 3 = third order (HOA, 16 channels). */
export type AmbisonicOrder = 1 | 2 | 3
export type AmbisonicLayout = 'ACN_SN3D' | 'FUMA'

export interface Rotation {
  yaw: number
  pitch: number
  roll: number
}

export interface AmbisonicsConfig {
  order: AmbisonicOrder
  /** Channel order / normalisation of the file: AmbiX (ACN + SN3D) or Furse-Malham (converted to AmbiX on playback; first order only). */
  channelLayout: AmbisonicLayout
  /** Fixed correction that turns the soundfield so its front faces the stage (−Z). */
  rotationOffset: Rotation
  /** On audience devices with the gyroscope or an XR session, turn the soundfield with the head. */
  bindHeadTracking: boolean
  /** Tracks (format trajectory_binaural) whose sound is encoded into this soundfield (first order). */
  busInputs: string[]
}

export const DEFAULT_AMBISONICS: AmbisonicsConfig = {
  order: 1,
  channelLayout: 'ACN_SN3D',
  rotationOffset: { yaw: 0, pitch: 0, roll: 0 },
  bindHeadTracking: false,
  busInputs: [],
}

export const ambisonicChannels = (order: AmbisonicOrder) => (order + 1) ** 2

/** The order whose channel count is `channels` (4 → 1, 9 → 2, 16 → 3), or null. */
export function ambisonicOrderOf(channels: number): AmbisonicOrder | null {
  return channels === 4 ? 1 : channels === 9 ? 2 : channels === 16 ? 3 : null
}

/* ---------- Eclipsa Audio / IAMF ---------- */

export interface IamfElementInfo {
  id: number
  type: 'channel_based' | 'scene_based' | 'object_based' | 'unknown'
  /** The element's own label ("Dialogue", "Ambience"…) when a mix presentation names it. */
  name: string
  codecConfigId: number
  substreams: number
  /** Scene-based elements: the number of ambisonic channels. */
  channels?: number
}

export interface IamfMixElement {
  id: number
  name: string
  /** The mix presentation's default gain for this element, dB. */
  defaultGainDb: number
  /** The range (dB, around the default) the mix lets the element be trimmed within; missing = no trimming allowed. */
  gainRange?: { min: number; max: number }
}

export interface IamfMixInfo {
  id: number
  /** Human label (first localised annotation), or "Mix <id>". */
  label: string
  language: string
  elements: IamfMixElement[]
}

export interface IamfSourceInfo {
  primaryProfile: number
  additionalProfile: number
  codecs: string[]
  elements: IamfElementInfo[]
  mixes: IamfMixInfo[]
  /** Seconds, when the container tells. */
  durationSec: number | null
}

export interface IamfConfig {
  /** The mix presentation to render; null = the first one in the file. */
  mixPresentationId: number | null
  /** Extra gain per audio element, dB, keyed "e<elementId>" (−24…+12; missing = 0). */
  elementGainOverrides: Record<string, number>
  bindHeadTracking: boolean
  /** What the file contains (filled in when the file is picked / uploaded). */
  source: IamfSourceInfo | null
}

export const DEFAULT_IAMF: IamfConfig = { mixPresentationId: null, elementGainOverrides: {}, bindHeadTracking: false, source: null }

export const elementKey = (id: number) => `e${id}`
export const ELEMENT_GAIN_RANGE = { min: -24, max: 12 }

/* ---------- normalising what the database hands back ---------- */

const num = (v: unknown, fallback: number, min = -Infinity, max = Infinity) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}
const round = (v: number, digits = 2) => {
  const k = 10 ** digits
  return Math.round(v * k) / k
}
const toList = (v: unknown): unknown[] => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : [])
const withId = (e: unknown): e is Record<string, any> => !!e && typeof e === 'object' && Number.isFinite(Number((e as Record<string, unknown>).id))
const text = (v: unknown, max = 120) => (typeof v === 'string' ? v.slice(0, max) : '')

/** Wrap an angle into (−180, 180]. */
export function wrapDeg(a: number): number {
  const w = ((((a + 180) % 360) + 360) % 360) - 180
  return w === -180 ? 180 : w
}

export function normalizeRotation(raw: unknown): Rotation {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof Rotation, unknown>>
  return { yaw: round(wrapDeg(num(r.yaw, 0))), pitch: round(num(r.pitch, 0, -90, 90)), roll: round(wrapDeg(num(r.roll, 0))) }
}

export function normalizeAmbisonics(raw: unknown): AmbisonicsConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>
  const order = [1, 2, 3].includes(Number(r.order)) ? (Number(r.order) as AmbisonicOrder) : 1
  const layout: AmbisonicLayout = r.channelLayout === 'FUMA' ? 'FUMA' : 'ACN_SN3D'
  return {
    order,
    // Furse-Malham is only defined here for first order.
    channelLayout: layout === 'FUMA' && order === 1 ? 'FUMA' : 'ACN_SN3D',
    rotationOffset: normalizeRotation(r.rotationOffset),
    bindHeadTracking: !!r.bindHeadTracking,
    busInputs: toList(r.busInputs).filter((v): v is string => typeof v === 'string' && v !== '').slice(0, 64),
  }
}

const ELEMENT_TYPES = ['channel_based', 'scene_based', 'object_based', 'unknown'] as const

export function normalizeIamfSource(raw: unknown): IamfSourceInfo | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, any>
  const elements = toList(r.elements)
    .filter(withId)
    .slice(0, 64)
    .map((e) => ({
      id: Number(e.id),
      type: ELEMENT_TYPES.includes(e.type) ? (e.type as IamfElementInfo['type']) : 'unknown',
      name: text(e.name),
      codecConfigId: num(e.codecConfigId, 0, 0),
      substreams: num(e.substreams, 0, 0),
      ...(Number.isFinite(Number(e.channels)) ? { channels: Number(e.channels) } : {}),
    }))
  const mixes = toList(r.mixes)
    .filter(withId)
    .slice(0, 32)
    .map((m) => ({
      id: Number(m.id),
      label: text(m.label) || `Mix ${Number(m.id)}`,
      language: text(m.language, 20),
      elements: toList(m.elements)
        .filter(withId)
        .slice(0, 64)
        .map((e) => ({
          id: Number(e.id),
          name: text(e.name),
          defaultGainDb: round(num(e.defaultGainDb, 0, -128, 127)),
          ...(e.gainRange && Number.isFinite(Number(e.gainRange.min)) && Number.isFinite(Number(e.gainRange.max)) ? { gainRange: { min: round(num(e.gainRange.min, 0, -128, 127)), max: round(num(e.gainRange.max, 0, -128, 127)) } } : {}),
        })),
    }))
  return {
    primaryProfile: num(r.primaryProfile, 0, 0, 255),
    additionalProfile: num(r.additionalProfile, 0, 0, 255),
    codecs: toList(r.codecs).filter((c): c is string => typeof c === 'string').slice(0, 8),
    elements,
    mixes,
    durationSec: Number.isFinite(Number(r.durationSec)) && r.durationSec !== null ? Number(r.durationSec) : null,
  }
}

export function normalizeIamf(raw: unknown): IamfConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>
  const source = normalizeIamfSource(r.source)
  const gains: Record<string, number> = {}
  const rawGains = r.elementGainOverrides && typeof r.elementGainOverrides === 'object' ? r.elementGainOverrides : {}
  for (const [k, v] of Object.entries(rawGains)) {
    if (/^e\d+$/.test(k)) {
      const g = round(num(v, 0, ELEMENT_GAIN_RANGE.min, ELEMENT_GAIN_RANGE.max), 1)
      if (g !== 0) gains[k] = g
    }
  }
  const id = r.mixPresentationId
  return {
    mixPresentationId: id === null || id === undefined || !Number.isFinite(Number(id)) ? null : Number(id),
    elementGainOverrides: gains,
    bindHeadTracking: !!r.bindHeadTracking,
    source,
  }
}

/**
 * The format a track / cue really has. A stored `format` wins; records from before this field existed are
 * `trajectory_binaural` when their trajectory is on, otherwise `standard`.
 */
export function resolveSpatialFormat(stored: unknown, trajectoryEnabled: boolean): SpatialFormat {
  if (isSpatialFormat(stored)) return stored
  return trajectoryEnabled ? 'trajectory_binaural' : 'standard'
}

/** Whether the trajectory is on for a format: it is the format `trajectory_binaural` and only that one. */
export const trajectoryOnFor = (format: SpatialFormat) => format === 'trajectory_binaural'

/** The mix presentation a config renders: the chosen one, else the first of the file. */
export function activeMix(cfg: IamfConfig): IamfMixInfo | null {
  const mixes = cfg.source?.mixes ?? []
  return mixes.find((m) => m.id === cfg.mixPresentationId) ?? mixes[0] ?? null
}

/** Linear gain for an element: the mix presentation's default plus the designer's override. */
export function elementGain(cfg: IamfConfig, el: IamfMixElement): number {
  return 10 ** ((el.defaultGainDb + (cfg.elementGainOverrides[elementKey(el.id)] ?? 0)) / 20)
}

/* ---------- Ambisonics maths ---------- */

const rad = (d: number) => (d * Math.PI) / 180

/**
 * The 3×3 rotation (column-major, 9 numbers, scene coordinates: +X right, +Y up, −Z forward) that turns a
 * soundfield by yaw / pitch / roll: v' = M·v. Yaw about +Y turns what is ahead towards the right; pitch about +X
 * lifts what is ahead; roll about −Z (the forward axis) lowers the right side. Applied in the order yaw, pitch, roll.
 */
export function fieldRotation({ yaw, pitch, roll }: Rotation): Float32Array {
  const ry = rad(-yaw) // a positive yaw sends forward (−Z) to the right (+X): that is a −θ rotation about +Y
  const rp = rad(pitch)
  const rr = rad(-roll) // a positive roll lowers the right side: rotation about the forward axis (−Z)
  const cy = Math.cos(ry), sy = Math.sin(ry)
  const cp = Math.cos(rp), sp = Math.sin(rp)
  const cr = Math.cos(rr), sr = Math.sin(rr)
  // Row-major matrices, then M = Rroll · Rpitch · Ryaw.
  const Y = [cy, 0, sy, 0, 1, 0, -sy, 0, cy]
  const P = [1, 0, 0, 0, cp, -sp, 0, sp, cp]
  const R = [cr, -sr, 0, sr, cr, 0, 0, 0, 1]
  const mul = (a: number[], b: number[]) => {
    const o = new Array<number>(9).fill(0)
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) o[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j]
    return o
  }
  const m = mul(R, mul(P, Y)) // row-major
  const out = new Float32Array(9)
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out[c * 3 + r] = m[r * 3 + c] // → column-major
  return out
}

/** Apply a column-major 3×3 matrix to a vector. */
export function applyMatrix3(m: ArrayLike<number>, v: { x: number; y: number; z: number }) {
  return {
    x: m[0] * v.x + m[3] * v.y + m[6] * v.z,
    y: m[1] * v.x + m[4] * v.y + m[7] * v.z,
    z: m[2] * v.x + m[5] * v.y + m[8] * v.z,
  }
}

/** The transpose (= inverse, for a rotation) of a column-major 3×3 matrix. */
export function transpose3(m: ArrayLike<number>): Float32Array {
  const o = new Float32Array(9)
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = m[c * 3 + r]
  return o
}

/**
 * First-order AmbiX (ACN: W, Y, Z, X; SN3D) gains that place a mono sound in a direction given in scene
 * coordinates. The vector need not be normalised; (0,0,0) is "everywhere" (W only).
 */
export function foaEncodeGains(dir: { x: number; y: number; z: number }): [number, number, number, number] {
  const len = Math.hypot(dir.x, dir.y, dir.z)
  if (len < 1e-6) return [1, 0, 0, 0]
  // scene → AmbiX: forward = −z, left = −x, up = y
  const fx = -dir.z / len
  const fy = -dir.x / len
  const fz = dir.y / len
  return [1, fy, fz, fx]
}

/** Furse-Malham → AmbiX, first order: source channel for each ACN slot, and the gain to apply (W is scaled by √2). */
export const FUMA_TO_ACN: { from: [number, number, number, number]; gain: [number, number, number, number] } = {
  from: [0, 2, 3, 1], // ACN W,Y,Z,X ← FuMa W,X,Y,Z indices 0, 2 (Y), 3 (Z), 1 (X)
  gain: [Math.SQRT2, 1, 1, 1],
}

/**
 * Where a first-order soundfield's energy is, from the powers of its W, Y, Z, X channels and their cross terms:
 * the steered power of a cardioid pointed at `dir` (scene coordinates). `cov` is the 4×4 covariance of
 * (W, Y, Z, X) in row-major order.
 */
export function foaPowerToward(cov: ArrayLike<number>, dir: { x: number; y: number; z: number }): number {
  const [w, y, z, x] = foaEncodeGains(dir)
  const g = [w, y, z, x]
  let p = 0
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) p += g[i] * g[j] * cov[i * 4 + j]
  return Math.max(0, p) / 4
}

/** A·B for column-major 3×3 matrices (apply B first, then A). */
export function mul3(a: ArrayLike<number>, b: ArrayLike<number>): Float32Array {
  const o = new Float32Array(9)
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++) {
      let v = 0
      for (let k = 0; k < 3; k++) v += a[k * 3 + r] * b[c * 3 + k]
      o[c * 3 + r] = v
    }
  return o
}

/**
 * The rotation to give an Ambisonics soundfield when the listener's head has the orientation `head` (a column-major
 * 3×3 rotation, local → scene) and the file carries the correction `offset`: first the offset, then the field turns
 * the opposite way to the head, so a sound stays where it is in the room. Without a head: the offset alone.
 */
export function headFieldMatrix(head: ArrayLike<number> | null, offset: Rotation): Float32Array {
  const off = fieldRotation(offset)
  return head ? mul3(transpose3(head), off) : off
}
