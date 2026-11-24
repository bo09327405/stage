import { ambisonicChannels, fieldRotation, foaEncodeGains, FUMA_TO_ACN, type AmbisonicOrder, type AmbisonicsConfig, type Rotation } from '../types/spatialAudio'
import { distanceFromListener, distanceGain, type TrajectoryConfig } from '../types/trajectory'
import { linear, sampleCurves } from './spatial'

/*
 * Ambisonics → binaural, with Omnitone (first order: FOARenderer; second and third order: HOARenderer):
 *
 *   input (4 / 9 / 16 discrete channels) → [Furse-Malham → AmbiX] → Omnitone (rotation + HRTF decoding) → stereo
 *
 * The whole soundfield turns by a rotation matrix (the file's rotationOffset, and the head's on audience devices).
 * Omnitone needs its HRIRs decoded first (initialize), so a renderer is built asynchronously before the mix graph
 * that uses it (prepareAmbisonics); the graph itself is built synchronously as before.
 */

export interface AmbiRenderer {
  order: AmbisonicOrder
  /** Feed the soundfield here: (order+1)² channels, ACN order, or Furse-Malham when the config says so. */
  input: AudioNode
  /** Binaural stereo. */
  output: AudioNode
  /** Rotate the soundfield (degrees). */
  setRotation(rotation: Rotation): void
  /** Rotate with a column-major 3×3 matrix (head tracking). */
  setMatrix(matrix: ArrayLike<number>): void
  /**
   * Second-order statistics of the first-order channels (W, Y, Z, X: 4×4 covariance, row-major) over the last few
   * milliseconds, for the energy radar; null until something plays. Taps the signal on first use.
   */
  covariance(): Float64Array | null
  dispose(): void
}

/**
 * Omnitone's second / third order rotator reads the matrix in a different basis than its first order one: its
 * l = 1 block is multiplied by diag(−1, 1, −1) (a half turn about the vertical axis) on the way in. To turn the field
 * the same way at every order, hand the HOA rotator M·diag(−1, 1, −1): the x and z columns negated.
 */
export function omnitoneMatrix(order: AmbisonicOrder, m: ArrayLike<number>): Float32Array {
  const o = Float32Array.from(m as ArrayLike<number> as number[])
  if (order > 1) for (const i of [0, 1, 2, 6, 7, 8]) o[i] = -o[i]
  return o
}

export async function createAmbiRenderer(ctx: BaseAudioContext, config: Pick<AmbisonicsConfig, 'order' | 'channelLayout' | 'rotationOffset'>): Promise<AmbiRenderer> {
  const { default: Omnitone } = await import('omnitone')
  const order = config.order
  const channels = ambisonicChannels(order)
  const renderer = order === 1 ? Omnitone.createFOARenderer(ctx, {}) : Omnitone.createHOARenderer(ctx, { ambisonicOrder: order })
  await renderer.initialize()

  // The input: discrete channels, extras dropped and missing ones silent.
  const input = new GainNode(ctx, { channelCount: channels, channelCountMode: 'explicit', channelInterpretation: 'discrete' })
  const nodes: AudioNode[] = [input]
  if (config.channelLayout === 'FUMA' && order === 1) {
    // Furse-Malham (W, X, Y, Z; W scaled by 1/√2) → AmbiX (W, Y, Z, X; SN3D).
    const split = new ChannelSplitterNode(ctx, { numberOfOutputs: 4 })
    const merge = new ChannelMergerNode(ctx, { numberOfInputs: 4 })
    input.connect(split)
    FUMA_TO_ACN.from.forEach((src, acn) => {
      const g = new GainNode(ctx, { gain: FUMA_TO_ACN.gain[acn] })
      split.connect(g, src).connect(merge, 0, acn)
      nodes.push(g)
    })
    merge.connect(renderer.input)
    nodes.push(split, merge)
  } else input.connect(renderer.input)

  renderer.setRotationMatrix3(omnitoneMatrix(order, fieldRotation(config.rotationOffset)))

  // The energy tap: only built when somebody looks.
  let tap: { analysers: AnalyserNode[]; split: ChannelSplitterNode; buf: Float32Array<ArrayBuffer>[] } | null = null
  const covariance = () => {
    if (!tap) {
      const split = new ChannelSplitterNode(ctx, { numberOfOutputs: channels })
      input.connect(split)
      const analysers = [0, 1, 2, 3].map((i) => {
        const a = new AnalyserNode(ctx, { fftSize: 1024 })
        split.connect(a, i)
        return a
      })
      tap = { analysers, split, buf: analysers.map(() => new Float32Array(1024)) }
      return null
    }
    tap.analysers.forEach((a, i) => a.getFloatTimeDomainData(tap!.buf[i]))
    const cov = new Float64Array(16)
    const n = tap.buf[0].length
    for (let i = 0; i < 4; i++) for (let j = i; j < 4; j++) {
      let s = 0
      for (let k = 0; k < n; k++) s += tap.buf[i][k] * tap.buf[j][k]
      cov[i * 4 + j] = cov[j * 4 + i] = s / n
    }
    return cov
  }

  return {
    order,
    input,
    output: renderer.output,
    setRotation: (r) => renderer.setRotationMatrix3(omnitoneMatrix(order, fieldRotation(r))),
    setMatrix: (m) => renderer.setRotationMatrix3(omnitoneMatrix(order, m)),
    covariance,
    dispose() {
      for (const n of nodes) n.disconnect()
      renderer.input.disconnect()
      renderer.output.disconnect()
      if (tap) {
        tap.split.disconnect()
        for (const a of tap.analysers) a.disconnect()
        tap = null
      }
    },
  }
}

/* ---------- mono → first-order Ambisonics (a trajectory track encoded into a soundfield) ---------- */

export interface FoaEncoder {
  /** A mono sound (a stereo one is mixed down). */
  input: AudioNode
  /** Four channels (W, Y, Z, X; AmbiX) to add into an Ambisonics track's input. */
  output: AudioNode
  gains: GainNode[]
  airLowpass: BiquadFilterNode
}

/**
 * Encode a mono source into first-order AmbiX at the direction (and distance) it has on its trajectory: the four
 * channel gains are the direction cosines times the distance level, moved along the path as audio-clock curves,
 * and the high end falls with distance like the binaural chain's air absorption.
 */
export function createFoaEncoder(ctx: BaseAudioContext): FoaEncoder {
  const input = new GainNode(ctx, { channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers' })
  const airLowpass = new BiquadFilterNode(ctx, { type: 'lowpass', Q: 0.5, frequency: 20000 })
  const merger = new ChannelMergerNode(ctx, { numberOfInputs: 4 })
  const gains = [0, 1, 2, 3].map((i) => {
    const g = new GainNode(ctx, { gain: 0 })
    airLowpass.connect(g).connect(merger, 0, i)
    return g
  })
  input.connect(airLowpass)
  return { input, output: merger, gains, airLowpass }
}

/** Drive an encoder along its path for the timeline stretch [from, end): timeline second `from` sits at context time `when`. */
export function scheduleFoaEncoder(enc: FoaEncoder, cfg: TrajectoryConfig, origin: number, from: number, when: number, end: number) {
  const length = end - from
  if (length <= 0) return
  const c = sampleCurves(cfg, linear(from - origin), length)
  const n = c.x.length
  const curves = [0, 1, 2, 3].map(() => new Float32Array(n))
  for (let i = 0; i < n; i++) {
    const p = { x: c.x[i], y: c.y[i], z: c.z[i] }
    const level = distanceGain(distanceFromListener(p), cfg.acoustics)
    const g = foaEncodeGains(p)
    for (let k = 0; k < 4; k++) curves[k][i] = g[k] * level
  }
  const dur = Math.max(0.01, length)
  enc.gains.forEach((node, k) => {
    node.gain.setValueAtTime(curves[k][0], when)
    node.gain.setValueCurveAtTime(curves[k], when, dur)
  })
  enc.airLowpass.frequency.setValueAtTime(c.cutoff[0], when)
  enc.airLowpass.frequency.setValueCurveAtTime(c.cutoff, when, dur)
}


/* ---------- live audition ---------- */

/**
 * Plays a soundfield (or, when there is none, a click train encoded at the front) in a loop through a renderer, so the
 * rotation can be heard while it is turned. `renderer.covariance()` feeds the energy radar.
 */
export class AmbiAuditioner {
  private ctx: AudioContext
  private output: AudioNode
  private source: AudioBufferSourceNode | null = null
  private nodes: AudioNode[] = []
  private token = 0
  renderer: AmbiRenderer | null = null

  constructor(ctx: AudioContext, output: AudioNode) {
    this.ctx = ctx
    this.output = output
  }

  get playing() {
    return !!this.source
  }

  /** `buffer`: the soundfield (4+ channels) to loop; anything else is replaced by a click train in front of the listener. */
  async start(buffer: AudioBuffer | null, config: AmbisonicsConfig, clicks: AudioBuffer) {
    this.stop()
    const token = ++this.token
    const field = !!buffer && buffer.numberOfChannels >= ambisonicChannels(1)
    const renderer = await createAmbiRenderer(this.ctx, field ? config : { ...config, channelLayout: 'ACN_SN3D' })
    if (token !== this.token) {
      renderer.dispose()
      return
    }
    const ctx = this.ctx
    const level = new GainNode(ctx, { gain: 0.7 })
    const src = new AudioBufferSourceNode(ctx, { buffer: field ? buffer : clicks, loop: true })
    if (field) src.connect(level)
    else {
      // Mono → first-order AmbiX, straight ahead (−Z).
      const merger = new ChannelMergerNode(ctx, { numberOfInputs: 4 })
      foaEncodeGains({ x: 0, y: 0, z: -2 }).forEach((g, i) => {
        const gain = new GainNode(ctx, { gain: g })
        src.connect(gain).connect(merger, 0, i)
        this.nodes.push(gain)
      })
      merger.connect(level)
      this.nodes.push(merger)
    }
    level.connect(renderer.input)
    renderer.output.connect(this.output)
    this.nodes.push(level)
    this.renderer = renderer
    this.source = src
    src.start()
  }

  update(config: Pick<AmbisonicsConfig, 'rotationOffset'>) {
    this.renderer?.setRotation(config.rotationOffset)
  }

  stop() {
    this.token++
    try {
      this.source?.stop()
    } catch {
      // never started
    }
    this.source?.disconnect()
    for (const n of this.nodes) n.disconnect()
    this.renderer?.dispose()
    this.source = null
    this.renderer = null
    this.nodes = []
  }
}
