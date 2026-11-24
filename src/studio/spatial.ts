import { airCutoffHz, distanceFromListener, reverbWetAt, type TrajectoryConfig } from '../types/trajectory'
import type { StudioProject, StudioTrack } from '../types/studio'
import { buildPath } from './trajectoryPath'

/*
 * Binaural rendering of a track's 3D trajectory. The listener sits at the origin facing −Z (Web Audio's default
 * AudioListener); the sound goes through an HRTF PannerNode whose position follows the path.
 *
 *   track autoGain → air-absorption low-pass → PannerNode (HRTF) → master          (dry, positional)
 *                  ↘ distance reverb send ────→ the track's convolver → wetBus → master
 *
 * Positions, the low-pass cutoff and the reverb send are scheduled as value curves on the audio clock
 * (AudioParam.setValueCurveAtTime), so they stay sample-accurate and aligned with the regions whatever the frame
 * rate of the page does. Used by the studio mix (buildMix: preview, export, cues) and by the live auditioner.
 */

export interface SpatialNodes {
  airLowpass: BiquadFilterNode
  panner: PannerNode
  /** Where the non-positional returns (reverb, delay) join the master. */
  wetBus: GainNode
  /** Reverb send that grows with distance; feeds the track's convolver. */
  send: GainNode
}

/** Control rate of the scheduled curves, per second. */
const RATE = 50
const MAX_STEPS = 20000

/** The config a track actually plays: a track that follows another's path takes its waypoints and timing. */
export function effectiveTrajectory(project: StudioProject, track: StudioTrack): TrajectoryConfig {
  const own = track.trajectoryConfig
  const src = own.pathSourceTrackId && own.pathSourceTrackId !== track.id ? project.tracks[own.pathSourceTrackId]?.trajectoryConfig : undefined
  if (!src) return own
  return {
    ...own,
    pathType: src.pathType,
    waypoints: src.waypoints,
    closed: src.closed,
    playback: { ...own.playback, durationSec: src.playback.durationSec, loopMode: src.playback.loopMode },
  }
}

/** Timeline second where a track's path clock starts: its first region (the sound begins at the path's start). */
export function trackPathOrigin(project: StudioProject, trackId: string): number {
  const starts = Object.values(project.regions)
    .filter((r) => r.trackId === trackId)
    .map((r) => r.start)
  return starts.length ? Math.min(...starts) : 0
}

export function createSpatial(ctx: BaseAudioContext, cfg: TrajectoryConfig): SpatialNodes {
  const a = cfg.acoustics
  const start = buildPath(cfg).at(0)
  const panner = new PannerNode(ctx, {
    panningModel: 'HRTF',
    distanceModel: 'inverse',
    refDistance: a.refDistance,
    maxDistance: a.maxDistance,
    rolloffFactor: a.rolloffFactor,
    positionX: start.x,
    positionY: start.y,
    positionZ: start.z,
  })
  const airLowpass = new BiquadFilterNode(ctx, { type: 'lowpass', Q: 0.5, frequency: airCutoffHz(distanceFromListener(start), a) })
  const send = new GainNode(ctx, { gain: reverbWetAt(distanceFromListener(start), a) })
  const wetBus = new GainNode(ctx)
  airLowpass.connect(panner)
  return { airLowpass, panner, wetBus, send }
}

interface SpatialCurves {
  x: Float32Array
  y: Float32Array
  z: Float32Array
  cutoff: Float32Array
  send: Float32Array
}

/** Maps `dt` seconds into a stretch to a path time: here simply `t0 + dt` (a negative path time waits at the path's start). */
const linear = (t0: number) => (dt: number) => t0 + dt

/** The path sampled over `length` seconds; `timeAt(dt)` gives the path time `dt` seconds into the stretch. */
function sampleCurves(cfg: TrajectoryConfig, timeAt: (dt: number) => number, length: number, rate = RATE): SpatialCurves {
  const path = buildPath(cfg)
  const steps = Math.max(2, Math.min(MAX_STEPS, Math.ceil(length * rate)))
  const c: SpatialCurves = { x: new Float32Array(steps), y: new Float32Array(steps), z: new Float32Array(steps), cutoff: new Float32Array(steps), send: new Float32Array(steps) }
  for (let i = 0; i < steps; i++) {
    const p = path.at(timeAt((length * i) / (steps - 1)))
    const d = distanceFromListener(p)
    c.x[i] = p.x
    c.y[i] = p.y
    c.z[i] = p.z
    c.cutoff[i] = airCutoffHz(d, cfg.acoustics)
    c.send[i] = reverbWetAt(d, cfg.acoustics)
  }
  return c
}

export function scheduleCurves(nodes: SpatialNodes, c: SpatialCurves, when: number, length: number) {
  const dur = Math.max(0.01, length)
  const pairs: [AudioParam, Float32Array][] = [
    [nodes.panner.positionX, c.x],
    [nodes.panner.positionY, c.y],
    [nodes.panner.positionZ, c.z],
    [nodes.airLowpass.frequency, c.cutoff],
    [nodes.send.gain, c.send],
  ]
  for (const [param, curve] of pairs) {
    param.setValueAtTime(curve[0], when)
    param.setValueCurveAtTime(curve, when, dur)
  }
}

/**
 * Drive a track's spatial nodes along its path for the timeline stretch [from, end): timeline second `from`
 * sits at context time `when`. The path clock starts at `origin` (timeline seconds).
 */
export function scheduleSpatialPath(nodes: SpatialNodes, cfg: TrajectoryConfig, origin: number, from: number, when: number, end: number) {
  const length = end - from
  if (length <= 0) return
  scheduleCurves(nodes, sampleCurves(cfg, linear(from - origin), length), when, length)
}

/* ---------- live audition ---------- */

/** A looping click train: short noise bursts with silence between, so movement and direction are easy to hear. */
export function auditionBuffer(ctx: BaseAudioContext): AudioBuffer {
  const rate = ctx.sampleRate
  const buf = ctx.createBuffer(1, rate, rate)
  const data = buf.getChannelData(0)
  for (const at of [0, 0.5]) {
    const n = Math.round(rate * 0.14)
    for (let i = 0; i < n; i++) data[Math.round(at * rate) + i] = (Math.random() * 2 - 1) * (1 - i / n) ** 2
  }
  return buf
}

const CHUNK = 2
const AHEAD = 3.5

/**
 * Plays one sound (a region's audio, or a click train) in a loop through a track's spatial chain so the path can
 * be heard while it is being drawn: moving a waypoint re-schedules the movement from now. `pathTime()` is what the
 * viewport reads to show where the sound is.
 */
export class SpatialAuditioner {
  private nodes: SpatialNodes | null = null
  private source: AudioBufferSourceNode | null = null
  private timer: ReturnType<typeof setInterval> | undefined
  private clock0 = 0
  private scheduledUntil = 0
  private cfg: TrajectoryConfig | null = null

  private ctx: AudioContext
  private output: AudioNode

  constructor(ctx: AudioContext, output: AudioNode) {
    this.ctx = ctx
    this.output = output
  }

  get playing() {
    return !!this.source
  }

  /** Seconds since the path clock started (null when not playing). */
  pathTime(): number | null {
    return this.source ? Math.max(0, this.ctx.currentTime - this.clock0) : null
  }

  start(cfg: TrajectoryConfig, buffer: AudioBuffer | null) {
    this.stop()
    this.cfg = cfg
    const ctx = this.ctx
    const nodes = createSpatial(ctx, cfg)
    const level = new GainNode(ctx, { gain: 0.6 })
    const reverb = new ConvolverNode(ctx, { buffer: auditionReverb(ctx) })
    level.connect(nodes.airLowpass)
    nodes.panner.connect(this.output)
    level.connect(nodes.send)
    nodes.send.connect(reverb).connect(nodes.wetBus)
    nodes.wetBus.connect(this.output)
    const src = new AudioBufferSourceNode(ctx, { buffer: buffer ?? auditionBuffer(ctx), loop: true })
    src.connect(level)
    this.clock0 = ctx.currentTime + 0.05
    this.scheduledUntil = this.clock0
    this.nodes = nodes
    this.source = src
    this.top()
    src.start(this.clock0)
    this.timer = setInterval(() => this.top(), 400)
  }

  /** The path or acoustics changed: re-aim the running sound from now. */
  update(cfg: TrajectoryConfig) {
    this.cfg = cfg
    const n = this.nodes
    if (!n || !this.source) return
    const now = this.ctx.currentTime
    const a = cfg.acoustics
    n.panner.refDistance = a.refDistance
    n.panner.maxDistance = a.maxDistance
    n.panner.rolloffFactor = a.rolloffFactor
    for (const p of [n.panner.positionX, n.panner.positionY, n.panner.positionZ, n.airLowpass.frequency, n.send.gain]) p.cancelScheduledValues(now)
    this.scheduledUntil = now
    this.top()
  }

  /** Keep the next few seconds of movement scheduled. */
  private top() {
    const n = this.nodes
    const cfg = this.cfg
    if (!n || !cfg) return
    const now = this.ctx.currentTime
    if (this.scheduledUntil < now) this.scheduledUntil = now
    while (this.scheduledUntil < now + AHEAD) {
      scheduleCurves(n, sampleCurves(cfg, linear(this.scheduledUntil - this.clock0), CHUNK), this.scheduledUntil, CHUNK)
      this.scheduledUntil += CHUNK
    }
  }

  stop() {
    clearInterval(this.timer)
    this.timer = undefined
    try {
      this.source?.stop()
    } catch {
      // never started
    }
    this.source?.disconnect()
    this.nodes?.panner.disconnect()
    this.nodes?.wetBus.disconnect()
    this.source = null
    this.nodes = null
  }
}

/** A short decaying-noise impulse for the audition's distance reverb. */
function auditionReverb(ctx: BaseAudioContext): AudioBuffer {
  const len = Math.round(ctx.sampleRate * 1.6)
  const ir = ctx.createBuffer(2, len, ctx.sampleRate)
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c)
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3
  }
  return ir
}

/* ---------- audience runtime ---------- */

/**
 * One sound's spatial chain on an audience device. No editor, no drawing: it only evaluates the spline for the
 * next few seconds and writes the positions into the PannerNode as audio-clock curves, topped up from the engine's
 * ticker. `pathTime(ctxTime)` says where on the path (seconds on the path clock) the sound is at an audio-clock
 * moment — the engine derives it from the cue's server-time position, so every phone puts the sound in the same place.
 *
 *   input → air-absorption low-pass → PannerNode (HRTF) → output
 *         ↘ distance reverb send ──→ reverbBus
 */
export class SpatialRunner {
  private nodes: SpatialNodes
  private cfg: TrajectoryConfig
  private ctx: BaseAudioContext
  private rate: number
  private pathTime: (ctxTime: number) => number = () => 0
  private scheduledUntil = 0
  private running = false

  /** `rate`: control points per second; phones can use a lower one than the studio. */
  constructor(ctx: BaseAudioContext, cfg: TrajectoryConfig, rate = 25) {
    this.ctx = ctx
    this.cfg = cfg
    this.rate = rate
    this.nodes = createSpatial(ctx, cfg)
  }

  connect(input: AudioNode, output: AudioNode, reverbBus: AudioNode | null) {
    input.connect(this.nodes.airLowpass)
    this.nodes.panner.connect(output)
    if (reverbBus) {
      input.connect(this.nodes.send)
      this.nodes.send.connect(reverbBus)
    }
  }

  /** (Re)start the movement: from now, the sound is at `pathTime(ctx time)` on the path. */
  start(pathTime: (ctxTime: number) => number) {
    this.pathTime = pathTime
    const now = this.ctx.currentTime
    const n = this.nodes
    for (const p of [n.panner.positionX, n.panner.positionY, n.panner.positionZ, n.airLowpass.frequency, n.send.gain]) p.cancelScheduledValues(now)
    this.scheduledUntil = now
    this.running = true
    this.top()
  }

  /** Keep the next few seconds of movement scheduled (cheap when there is nothing to add). */
  top() {
    if (!this.running) return
    const now = this.ctx.currentTime
    if (this.scheduledUntil < now) this.scheduledUntil = now
    while (this.scheduledUntil < now + AHEAD) {
      const at = this.scheduledUntil
      scheduleCurves(this.nodes, sampleCurves(this.cfg, (dt) => this.pathTime(at + dt), CHUNK, this.rate), at, CHUNK)
      this.scheduledUntil += CHUNK
    }
  }

  /** Freeze the movement where it is (a paused cue). */
  hold() {
    this.running = false
    const now = this.ctx.currentTime
    const n = this.nodes
    for (const p of [n.panner.positionX, n.panner.positionY, n.panner.positionZ, n.airLowpass.frequency, n.send.gain]) {
      const v = p.value
      p.cancelScheduledValues(now)
      p.setValueAtTime(v, now)
    }
  }

  /** Release every node. */
  dispose() {
    this.running = false
    const n = this.nodes
    for (const node of [n.airLowpass, n.panner, n.send, n.wetBus]) node.disconnect()
  }
}
