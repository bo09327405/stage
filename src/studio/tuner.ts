import { TUNER_MODES, keyMask, type TunerSettings } from '../types/studio'

/*
 * Vocal Tuner (pitch correction).
 *
 * The algorithm is plain JavaScript in a string so the very same code runs inside the realtime
 * AudioWorklet (monitoring / recording) and on the main thread for "not realtime" takes:
 *
 *  1. Pitch detection every 256 samples: normalized autocorrelation (NSDF) on a 2048-sample
 *     window decimated ×2, 70–1000 Hz, first strong peak with parabolic interpolation.
 *  2. Target: the nearest note allowed by the key; the correction ratio is scaled by Amount and
 *     glides there at the mode's speed (Robotic = instant, the classic hard-tune sound).
 *  3. Shift: a two-tap delay-line pitch shifter with Hann crossfades (constant latency ≈ 20 ms),
 *     blended back to the dry (equally delayed) signal when there's nothing to correct, so
 *     unvoiced sounds and in-tune notes pass untouched.
 */
export const TUNER_SOURCE = `
class Tuner {
  constructor(sr) {
    this.sr = sr
    this.size = 8192
    this.buf = new Float32Array(this.size)
    this.w = 0
    this.win = Math.round(sr * 0.04)
    this.phase = this.win / 2
    this.ratio = 1
    this.target = 1
    this.wet = 0
    this.det = new Float32Array(2048)
    this.detW = 0
    this.since = 0
    this.frame = new Float32Array(1024)
    this.mask = [true, true, true, true, true, true, true, true, true, true, true, true]
    this.amount = 1
    this.speed = 0.05
    this.enabled = true
    this.lastF0 = 0
  }
  setParams(p) {
    if (p.mask) this.mask = p.mask
    if (p.amount !== undefined) this.amount = p.amount
    if (p.speed !== undefined) this.speed = p.speed
    if (p.enabled !== undefined) this.enabled = p.enabled
  }
  detect() {
    const N = 1024, sr = this.sr / 2, f = this.frame
    let energy = 0
    for (let i = 0; i < N; i++) {
      const a = this.det[(this.detW + i * 2) % 2048]
      f[i] = a
      energy += a * a
    }
    if (energy / N < 1e-5) return 0
    const minLag = Math.max(2, Math.floor(sr / 1000)), maxLag = Math.min(N - 2, Math.floor(sr / 70))
    const nsdf = new Float32Array(maxLag + 2)
    let best = -1, bestVal = 0, globalMax = 0
    for (let lag = minLag; lag <= maxLag + 1; lag++) {
      let ac = 0, m = 0
      for (let i = 0; i < N - lag; i++) { ac += f[i] * f[i + lag]; m += f[i] * f[i] + f[i + lag] * f[i + lag] }
      nsdf[lag] = m > 0 ? (2 * ac) / m : 0
      if (nsdf[lag] > globalMax) globalMax = nsdf[lag]
    }
    if (globalMax < 0.6) return 0
    for (let lag = minLag + 1; lag <= maxLag; lag++) {
      if (nsdf[lag] > nsdf[lag - 1] && nsdf[lag] >= nsdf[lag + 1] && nsdf[lag] > 0.85 * globalMax) { best = lag; bestVal = nsdf[lag]; break }
    }
    if (best < 0) return 0
    const a = nsdf[best - 1], b = bestVal, c = nsdf[best + 1]
    const shift = (a - c) / (2 * (a - 2 * b + c) || 1)
    return sr / (best + (Number.isFinite(shift) ? shift : 0))
  }
  nearest(f0) {
    const midi = 69 + 12 * Math.log2(f0 / 440)
    let bestNote = Math.round(midi), bestDist = Infinity
    for (let n = Math.floor(midi) - 2; n <= Math.ceil(midi) + 2; n++) {
      if (!this.mask[((n % 12) + 12) % 12]) continue
      const d = Math.abs(n - midi)
      if (d < bestDist) { bestDist = d; bestNote = n }
    }
    return 440 * Math.pow(2, (bestNote - 69) / 12)
  }
  read(delay) {
    let pos = this.w - delay
    while (pos < 0) pos += this.size
    const i = Math.floor(pos), frac = pos - i
    return this.buf[i % this.size] * (1 - frac) + this.buf[(i + 1) % this.size] * frac
  }
  process(input, output) {
    const win = this.win, half = win / 2
    const glide = this.speed > 0 ? 1 - Math.exp(-1 / (this.speed * this.sr)) : 1
    for (let i = 0; i < input.length; i++) {
      const x = input[i]
      this.det[this.detW] = x
      this.detW = (this.detW + 1) % 2048
      if (++this.since >= 256) {
        this.since = 0
        const f0 = this.enabled ? this.detect() : 0
        this.lastF0 = f0
        this.target = f0 > 0 ? 1 + (this.nearest(f0) / f0 - 1) * this.amount : 1
      }
      this.ratio += (this.target - this.ratio) * glide
      this.buf[this.w] = x
      this.phase -= this.ratio - 1
      while (this.phase < 0) this.phase += win
      while (this.phase >= win) this.phase -= win
      const d1 = this.phase, d2 = (this.phase + half) % win
      const g1 = 0.5 - 0.5 * Math.cos((2 * Math.PI * d1) / win)
      const g2 = 0.5 - 0.5 * Math.cos((2 * Math.PI * d2) / win)
      const shifted = this.read(d1 + 1) * g1 + this.read(d2 + 1) * g2
      const dry = this.read(half + 1)
      const wantWet = Math.abs(this.ratio - 1) > 0.0008 ? 1 : 0
      this.wet += (wantWet - this.wet) * 0.003
      output[i] = this.wet * shifted + (1 - this.wet) * dry
      this.w = (this.w + 1) % this.size
    }
  }
}
`

type TunerInstance = {
  win: number
  lastF0: number
  setParams: (p: { mask?: boolean[]; amount?: number; speed?: number; enabled?: boolean }) => void
  process: (input: Float32Array, output: Float32Array) => void
}
type TunerClass = new (sampleRate: number) => TunerInstance

let TunerImpl: TunerClass | null = null
const tunerClass = () => (TunerImpl ??= new Function(`${TUNER_SOURCE}; return Tuner`)() as TunerClass)

/** Parameters for the Tuner from track settings. */
export const tunerParams = (t: TunerSettings) => ({
  enabled: t.enabled,
  mask: keyMask(t.key),
  amount: t.mode === 'robotic' ? 1 : t.amount,
  speed: TUNER_MODES[t.mode].speed,
})

/** Apply pitch correction to a recorded buffer (latency removed, so the take stays in time). */
export function tuneBuffer(buffer: AudioBuffer, settings: TunerSettings): AudioBuffer {
  const out = new AudioBuffer({ numberOfChannels: buffer.numberOfChannels, length: buffer.length, sampleRate: buffer.sampleRate })
  const Tuner = tunerClass()
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const tuner = new Tuner(buffer.sampleRate)
    tuner.setParams(tunerParams(settings))
    const latency = Math.round(tuner.win / 2) + 1
    const input = new Float32Array(buffer.length + latency)
    input.set(buffer.getChannelData(c))
    const tuned = new Float32Array(input.length)
    tuner.process(input, tuned)
    out.getChannelData(c).set(tuned.subarray(latency, latency + buffer.length))
  }
  return out
}

/** Estimate the pitch (Hz) of a buffer's middle, for tests and the tuner readout. */
export function detectPitch(data: Float32Array, sampleRate: number): number {
  const tuner = new (tunerClass())(sampleRate)
  tuner.setParams({ amount: 0 })
  const scratch = new Float32Array(data.length)
  tuner.process(data, scratch)
  return tuner.lastF0
}
