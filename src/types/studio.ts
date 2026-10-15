/**
 * Theatre DAW Studio: multitrack audio projects that live inside a show project, at
 * projects/{pid}/studio/{studioId}. Everything is non-destructive: regions point at source files
 * (Cloudinary URLs) and carry their own trim, gain, fades, automation and processing flags.
 */

import { curveValueAt } from '../studio/curves'

/**
 * An automation node. Region volume: `t` seconds from the region's start, `v` gain (0–1.5), linear
 * between nodes. Track lanes: `t` timeline seconds, `v` in the parameter's range, and the shape of
 * the segment leaving this node (see studio/curves.ts).
 */
export interface StudioPoint {
  t: number
  v: number
  /** Shape of the segment to the next node; missing = the default (track lanes smooth, region volume linear). */
  curve?: 'linear' | 'smooth' | 'bezier'
  /** Bézier handles (with curve "bezier"). */
  h?: CurveHandles
}

/**
 * Bézier handles of a segment, relative to it: x1 / x2 as fractions (0–1) of the segment's length,
 * y1 / y2 as offsets from the straight line between the nodes in fractions of the parameter range.
 */
export interface CurveHandles {
  x1: number
  y1: number
  x2: number
  y2: number
}

export type RegionKind = 'file' | 'recording' | 'tts'

/** Fade curves. Names describe the curve as heard in time: a fade-out's "smooth start" begins gently. */
export type FadeShape = 'linear' | 'log' | 'smooth' | 'smoothStart' | 'smoothEnd'
export const FADE_SHAPES: { id: FadeShape; label: string }[] = [
  { id: 'linear', label: '線性 Linear' },
  { id: 'log', label: '對數 Logarithmic' },
  { id: 'smooth', label: 'Smooth start/Smooth end' },
  { id: 'smoothStart', label: 'Smooth start' },
  { id: 'smoothEnd', label: 'Smooth end' },
]
const isFadeShape = (v: unknown): v is FadeShape => FADE_SHAPES.some((s) => s.id === v)

/**
 * Gain of a fade at progress `p` (0 = silent end of the ramp, 1 = full level end of the ramp).
 * For a fade-out pass the remaining fraction and `out = true`: it is the mirror image in time.
 */
export function fadeRamp(shape: FadeShape | undefined, p: number, out = false): number {
  const x = Math.min(1, Math.max(0, p))
  switch (out && (shape === 'smoothStart' || shape === 'smoothEnd') ? (shape === 'smoothStart' ? 'smoothEnd' : 'smoothStart') : shape) {
    case 'log':
      return Math.log10(1 + 9 * x)
    case 'smooth':
      return x * x * (3 - 2 * x)
    case 'smoothStart':
      return x * x
    case 'smoothEnd':
      return 1 - (1 - x) * (1 - x)
    default:
      return x
  }
}

export interface StudioRegion {
  id: string
  trackId: string
  name: string
  kind: RegionKind
  /** Source audio (CORS-enabled URL, usually Cloudinary). */
  url: string
  publicId: string
  /** Where the region sits on the timeline, seconds. */
  start: number
  /** Where in the source the region begins, seconds. */
  offset: number
  /** Region length on the timeline, seconds. */
  duration: number
  /** Full length of the source file, seconds (limits trimming). */
  sourceDuration: number
  /** Linear gain, 0–2. */
  gain: number
  fadeIn: number
  fadeOut: number
  /** Curve of the fade ramps (default linear). */
  fadeInShape?: FadeShape
  fadeOutShape?: FadeShape
  muted: boolean
  reverse: boolean
  /** Pitch shift in semitones (−12…12); length is kept. */
  pitch: number
  /** Vocal clean-up: rumble filter, noise gate, presence and gentle compression. */
  cleanup: boolean
  comment: string
  automation: StudioPoint[]
}

/** 3-band EQ, gains in dB (−18…18). */
export interface StudioEq {
  low: number
  mid: number
  midFreq: number
  high: number
}

export interface StudioFx {
  /** High-pass cutoff in Hz; 0 = off. */
  highpass: number
  compressor: boolean
  /** Send levels 0–1. */
  reverb: number
  delay: number
  delayTime: number
  feedback: number
}

/** Track-level automation parameters (BandLab-style "+ Automation"). */
export type TrackParam = 'volume' | 'pan' | 'filter'

export const TRACK_PARAMS: TrackParam[] = ['volume', 'pan', 'filter']

/**
 * Value ranges per parameter: volume is a gain multiplier on top of the fader (0–1.5), pan −1…1
 * (overrides the pan knob while it has nodes), filter a low-pass cutoff as 0–1 (20 Hz…20 kHz, log).
 */
export const PARAM_INFO: Record<TrackParam, { label: string; min: number; max: number; default: number; color: string }> = {
  volume: { label: '音量 Volume', min: 0, max: 1.5, default: 1, color: '#30d158' },
  pan: { label: '聲相 Pan', min: -1, max: 1, default: 0, color: '#4dabf7' },
  filter: { label: '濾波 Filter（低通）', min: 0, max: 1, default: 1, color: '#da77f2' },
}

/** Low-pass cutoff for a normalized filter value. */
export const filterHz = (v: number) => 20 * 1000 ** Math.min(1, Math.max(0, v))

/** One automation lane under a track: nodes at absolute timeline seconds. */
export interface AutomationLane {
  shown: boolean
  points: StudioPoint[]
}

/** A named stretch of the timeline (verse, scene, cue window), shown above the tracks. */
export interface StudioSection {
  id: string
  name: string
  start: number
  end: number
  color: string
}

export const SECTION_COLORS = ['#9775fa', '#f783ac', '#4dabf7', '#38d9a9', '#ffa94d']

/* ---------- recording input (mic channel strip) ---------- */

export type TunerMode = 'natural' | 'classic' | 'robotic'

export const TUNER_MODES: Record<TunerMode, { label: string; speed: number }> = {
  natural: { label: '自然 Natural', speed: 0.12 },
  classic: { label: '標準 Classic', speed: 0.04 },
  robotic: { label: '機器人 Robotic', speed: 0 },
}

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

/** "" = key not set (snap to any semitone); otherwise "<root 0–11>:major|minor". */
export type TunerKey = string

export function keyLabel(key: TunerKey) {
  if (!key) return 'Key Not Set（半音）'
  const [root, scale] = key.split(':')
  return `${NOTE_NAMES[Number(root)]} ${scale === 'minor' ? 'Minor 小調' : 'Major 大調'}`
}

/** Which pitch classes a key allows. */
export function keyMask(key: TunerKey): boolean[] {
  if (!key) return Array(12).fill(true)
  const [rootText, scale] = key.split(':')
  const root = Number(rootText)
  const steps = scale === 'minor' ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11]
  const mask = Array(12).fill(false)
  for (const s of steps) mask[(root + s) % 12] = true
  return mask
}

export interface TunerSettings {
  enabled: boolean
  /** On: corrected while you sing (and monitored). Off: applied to the take when recording stops. */
  realtime: boolean
  mode: TunerMode
  key: TunerKey
  /** 0–1 */
  amount: number
}

/** How a track records: gain before everything, noise removal and pitch correction (printed into the take). */
export interface TrackInput {
  /** dB, −12…+24 */
  preGain: number
  noiseRemoval: boolean
  /** Noise gate threshold, dBFS (set by Calibrate). */
  gateDb: number
  tuner: TunerSettings
}

export const DEFAULT_INPUT: TrackInput = {
  preGain: 0,
  noiseRemoval: false,
  gateDb: -50,
  tuner: { enabled: false, realtime: true, mode: 'natural', key: '', amount: 0.8 },
}

export interface StudioTrack {
  id: string
  name: string
  color: string
  order: number
  /** Linear 0–1.5. */
  volume: number
  /** −1 (left) … 1 (right). */
  pan: number
  mute: boolean
  solo: boolean
  eq: StudioEq
  fx: StudioFx
  automation: Partial<Record<TrackParam, AutomationLane>>
  input: TrackInput
}

export interface StudioProject {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  /** End of the last region, seconds (kept up to date for cue binding). */
  length: number
  masterVolume: number
  tracks: Record<string, StudioTrack>
  regions: Record<string, StudioRegion>
  sections: Record<string, StudioSection>
  /**
   * The Set Cue project this studio belongs to (it lives at projects/{parentProjectId}/studio/{id}).
   * Missing on standalone Studio projects (a container project of kind "studio", no Set Cue parent)
   * and on studios from before this field existed (their container is their parent).
   */
  parentProjectId?: string
}

/** Someone with this studio open (live collaboration). */
export interface StudioPresence {
  id: string
  name: string
  color: string
  playhead: number
  playing: boolean
  selection: string[]
  at: number
}

export const TRACK_COLORS = ['#ff6b6b', '#ffa94d', '#ffd43b', '#69db7c', '#38d9a9', '#4dabf7', '#9775fa', '#f783ac']

export const DEFAULT_EQ: StudioEq = { low: 0, mid: 0, midFreq: 1000, high: 0 }
export const DEFAULT_FX: StudioFx = { highpass: 0, compressor: false, reverb: 0, delay: 0, delayTime: 0.3, feedback: 0.35 }

const num = (v: unknown, fallback: number, lo = -Infinity, hi = Infinity) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback
}

export function normalizeTrack(id: string, raw: Partial<StudioTrack> = {}): StudioTrack {
  return {
    id,
    name: typeof raw.name === 'string' ? raw.name : '音軌',
    color: typeof raw.color === 'string' ? raw.color : TRACK_COLORS[0],
    order: num(raw.order, 0),
    volume: num(raw.volume, 1, 0, 1.5),
    pan: num(raw.pan, 0, -1, 1),
    mute: !!raw.mute,
    solo: !!raw.solo,
    eq: {
      low: num(raw.eq?.low, 0, -18, 18),
      mid: num(raw.eq?.mid, 0, -18, 18),
      midFreq: num(raw.eq?.midFreq, 1000, 120, 8000),
      high: num(raw.eq?.high, 0, -18, 18),
    },
    fx: {
      highpass: num(raw.fx?.highpass, 0, 0, 1000),
      compressor: !!raw.fx?.compressor,
      reverb: num(raw.fx?.reverb, 0, 0, 1),
      delay: num(raw.fx?.delay, 0, 0, 1),
      delayTime: num(raw.fx?.delayTime, 0.3, 0.02, 2),
      feedback: num(raw.fx?.feedback, 0.35, 0, 0.9),
    },
    automation: Object.fromEntries(
      TRACK_PARAMS.filter((p) => raw.automation?.[p]).map((p) => {
        const lane = raw.automation![p]!
        const info = PARAM_INFO[p]
        return [p, { shown: lane.shown !== false, points: normalizePoints(lane.points, 0, Infinity, info.min, info.max, true) }]
      }),
    ),
    input: normalizeInput(raw.input),
  }
}

export function normalizeInput(raw: Partial<TrackInput> | undefined): TrackInput {
  const t: Partial<TunerSettings> = raw?.tuner ?? {}
  return {
    preGain: num(raw?.preGain, 0, -12, 24),
    noiseRemoval: !!raw?.noiseRemoval,
    gateDb: num(raw?.gateDb, -50, -80, -20),
    tuner: {
      enabled: !!t.enabled,
      realtime: t.realtime !== false,
      mode: t.mode === 'classic' || t.mode === 'robotic' ? t.mode : 'natural',
      key: typeof t.key === 'string' && /^(\d{1,2}:(major|minor))?$/.test(t.key) ? t.key : '',
      amount: num(t.amount, 0.8, 0, 1),
    },
  }
}

/** RTDB returns arrays as objects when keys have gaps; keep valid nodes, sorted by time. */
function normalizePoints(raw: unknown, tMin: number, tMax: number, vMin: number, vMax: number, curves = false): StudioPoint[] {
  return Object.values((raw ?? {}) as Record<string, StudioPoint>)
    .filter((p): p is StudioPoint => !!p && Number.isFinite(Number(p.t)) && Number.isFinite(Number(p.v)))
    .map((p) => {
      const point: StudioPoint = { t: num(p.t, 0, tMin, tMax), v: num(p.v, 0, vMin, vMax) }
      if (!curves) return point
      // Only set keys that have values: the database rejects undefined.
      if (p.curve === 'linear' || p.curve === 'smooth') point.curve = p.curve
      else if (p.curve === 'bezier' && p.h) {
        point.curve = 'bezier'
        point.h = { x1: num(p.h.x1, 1 / 3, 0, 1), y1: num(p.h.y1, 0, -1, 1), x2: num(p.h.x2, 2 / 3, 0, 1), y2: num(p.h.y2, 0, -1, 1) }
      }
      return point
    })
    .sort((a, b) => a.t - b.t)
}

export function normalizeSection(id: string, raw: Partial<StudioSection> = {}): StudioSection {
  const start = num(raw.start, 0, 0)
  return {
    id,
    name: typeof raw.name === 'string' ? raw.name : '區段',
    start,
    end: Math.max(start + 0.1, num(raw.end, start + 8, 0)),
    color: typeof raw.color === 'string' ? raw.color : SECTION_COLORS[0],
  }
}

export function normalizeRegion(id: string, raw: Partial<StudioRegion> = {}): StudioRegion {
  const sourceDuration = num(raw.sourceDuration, 0, 0)
  return {
    id,
    trackId: typeof raw.trackId === 'string' ? raw.trackId : '',
    name: typeof raw.name === 'string' ? raw.name : '片段',
    kind: raw.kind === 'recording' || raw.kind === 'tts' ? raw.kind : 'file',
    url: typeof raw.url === 'string' ? raw.url : '',
    publicId: typeof raw.publicId === 'string' ? raw.publicId : '',
    start: num(raw.start, 0, 0),
    offset: num(raw.offset, 0, 0),
    duration: num(raw.duration, sourceDuration || 1, 0.01),
    sourceDuration,
    gain: num(raw.gain, 1, 0, 2),
    fadeIn: num(raw.fadeIn, 0, 0),
    fadeOut: num(raw.fadeOut, 0, 0),
    ...(isFadeShape(raw.fadeInShape) ? { fadeInShape: raw.fadeInShape } : {}),
    ...(isFadeShape(raw.fadeOutShape) ? { fadeOutShape: raw.fadeOutShape } : {}),
    muted: !!raw.muted,
    reverse: !!raw.reverse,
    pitch: num(raw.pitch, 0, -12, 12),
    cleanup: !!raw.cleanup,
    comment: typeof raw.comment === 'string' ? raw.comment : '',
    automation: normalizePoints(raw.automation, 0, Infinity, 0, 1.5, true),
  }
}

export function normalizeStudio(
  id: string,
  raw: Partial<StudioProject> & {
    tracks?: Record<string, Partial<StudioTrack>>
    regions?: Record<string, Partial<StudioRegion>>
    sections?: Record<string, Partial<StudioSection>>
  } = {},
): StudioProject {
  const tracks = Object.fromEntries(Object.entries(raw.tracks ?? {}).map(([tid, t]) => [tid, normalizeTrack(tid, t)]))
  const regions = Object.fromEntries(
    Object.entries(raw.regions ?? {})
      .map(([rid, r]) => [rid, normalizeRegion(rid, r)] as const)
      .filter(([, r]) => tracks[r.trackId] && r.url),
  )
  return {
    id,
    name: typeof raw.name === 'string' ? raw.name : '未命名 Studio',
    createdAt: num(raw.createdAt, 0),
    updatedAt: num(raw.updatedAt, 0),
    length: num(raw.length, 0, 0),
    masterVolume: num(raw.masterVolume, 1, 0, 1.5),
    ...(typeof raw.parentProjectId === 'string' && raw.parentProjectId ? { parentProjectId: raw.parentProjectId } : {}),
    tracks,
    regions,
    sections: Object.fromEntries(Object.entries(raw.sections ?? {}).map(([sid, sec]) => [sid, normalizeSection(sid, sec)])),
  }
}

/** Region volume automation: gain 0–1.5, straight lines between nodes unless a segment is curved. */
export const REGION_GAIN_RANGE = { min: 0, max: 1.5 }

/** Sections in timeline order. */
export const sortedSections = (p: StudioProject) => Object.values(p.sections).sort((a, b) => a.start - b.start)

/**
 * Track automation value of `param` at timeline time `t`: the lane's curves (smooth, linear or
 * Bézier) between nodes, flat before the first and after the last; the parameter's default when
 * the lane has no nodes.
 */
export function laneValueAt(points: StudioPoint[], t: number, param: TrackParam): number {
  const info = PARAM_INFO[param]
  return curveValueAt(points, t, info.default, info)
}

/** Tracks in display order. */
export const sortedTracks = (p: StudioProject) => Object.values(p.tracks).sort((a, b) => a.order - b.order)

/** End of the last region (the project's playable length). */
export const projectLength = (p: StudioProject) => Object.values(p.regions).reduce((end, r) => Math.max(end, r.start + r.duration), 0)

/**
 * Region gain at `t` seconds from its start: automation (linear between nodes unless curved; flat before the
 * first and after the last), times the fade-in / fade-out ramps, times the region gain.
 */
export function regionGainAt(r: StudioRegion, t: number): number {
  const auto = curveValueAt(r.automation, t, 1, REGION_GAIN_RANGE, 'linear')
  const fadeIn = r.fadeIn > 0 ? fadeRamp(r.fadeInShape, t / r.fadeIn) : 1
  const fadeOut = r.fadeOut > 0 ? fadeRamp(r.fadeOutShape, (r.duration - t) / r.fadeOut, true) : 1
  return Math.max(0, r.gain * auto * Math.max(0, fadeIn) * Math.max(0, fadeOut))
}
