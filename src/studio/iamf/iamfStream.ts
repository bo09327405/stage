import { IamfDecoder, type IamfModule, type IamfStreamInfo } from './iamfWasm.ts'
import { findIamfTrack } from './mp4Samples.ts'
import { isMp4 } from './iamfDecode.ts'

/*
 * An IAMF file played as a stream: the decoder is fed one temporal unit at a time, can be moved to any time (a late joiner,
 * a loop) and takes the listener's head rotation while it decodes. Pure (no DOM / Worker API), so the Worker that feeds the
 * audience's AudioWorklet and node's test runner share it.
 */

/** Pre-roll before a seek target: codecs (Opus) and the binaural renderer need some audio before the target to settle. */
const PREROLL_SECONDS = 0.25

interface Unit {
  start: number
  end: number
}

/** Head orientation as a unit quaternion in IAMF's frame: x right, y front, z up (what libiamf's renderer expects). */
export interface HeadQuaternion {
  w: number
  x: number
  y: number
  z: number
}

/**
 * IAMF's frame is x right, y front, z up; the stage (three.js, WebXR, the gyroscope code) is x right, y up, z back. The same
 * rotation expressed in the two frames differs by that change of axes: (x, y, z) → (x, −z, y).
 */
export function iamfHeadQuaternion(m: ArrayLike<number>): HeadQuaternion {
  // m: column-major 3×3 rotation (local → scene). Standard matrix → quaternion, in the stage frame.
  const [m00, m10, m20, m01, m11, m21, m02, m12, m22] = [m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8]]
  const trace = m00 + m11 + m22
  let w: number, x: number, y: number, z: number
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2
    w = s / 4
    x = (m21 - m12) / s
    y = (m02 - m20) / s
    z = (m10 - m01) / s
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2
    w = (m21 - m12) / s
    x = s / 4
    y = (m01 + m10) / s
    z = (m02 + m20) / s
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2
    w = (m02 - m20) / s
    x = (m01 + m10) / s
    y = s / 4
    z = (m12 + m21) / s
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2
    w = (m10 - m01) / s
    x = (m02 + m20) / s
    y = (m12 + m21) / s
    z = s / 4
  }
  return { w, x, y: -z || 0, z: y }
}

/** Where a standalone IA stream's temporal units begin and end (no decoding): a unit holds one audio frame per substream. */
function splitStream(b: Uint8Array, from: number): Unit[] {
  const units: Unit[] = []
  const leb = (p: number): [number, number] => {
    let v = 0
    let n = 0
    for (;;) {
      const x = b[p + n]
      if (x === undefined) return [0, 0]
      v += (x & 0x7f) * 2 ** (7 * n)
      n++
      if (!(x & 0x80)) return [v, n]
    }
  }
  let p = from
  let unitStart = from
  let lastAudioEnd = from
  let seen = new Set<number>()
  while (p < b.length) {
    const type = b[p] >> 3
    const flags = b[p] & 7
    const [size, n] = leb(p + 1)
    if (!n) break
    let at = p + 1 + n
    const end = at + size
    if (end > b.length) break
    if (flags & 4) {
      // a redundant copy of an OBU already seen
    } else if (type === 4) {
      // temporal delimiter: a unit begins here
      if (lastAudioEnd > unitStart) units.push({ start: unitStart, end: lastAudioEnd })
      unitStart = p
      seen = new Set()
    } else if (type >= 5 && type <= 23) {
      let id = type - 6
      if (flags & 2) at += leb(at)[1] + leb(at + leb(at)[1])[1] // trimming: samples to trim at the end and at the start
      if (flags & 1) at += leb(at)[1] + leb(at)[0] // header extension
      if (type === 5) id = leb(at)[0]
      if (seen.has(id)) {
        // this substream already has its frame in the unit: the unit ended with the previous audio frame
        if (lastAudioEnd > unitStart) units.push({ start: unitStart, end: lastAudioEnd })
        unitStart = lastAudioEnd
        seen = new Set()
      }
      seen.add(id)
      lastAudioEnd = end
    }
    p = end
  }
  if (lastAudioEnd > unitStart) units.push({ start: unitStart, end: lastAudioEnd })
  return units
}

/** The Opus pre-skip (samples at 48 kHz) in a stream's codec config OBU; 0 for other codecs. libiamf drops it at the start of a stream only. */
export function opusPreSkip(config: Uint8Array): number {
  let p = 0
  const leb = () => {
    let v = 0
    for (let n = 0; ; n++) {
      const x = config[p++]
      if (x === undefined) return 0
      v += (x & 0x7f) * 2 ** (7 * n)
      if (!(x & 0x80)) return v
    }
  }
  while (p < config.length) {
    const type = config[p++] >> 3
    const size = leb()
    const end = p + size
    if (type === 0) {
      leb() // codec_config_id
      const id = String.fromCharCode(...config.subarray(p, p + 4))
      p += 4
      if (id !== 'Opus') return 0
      leb() // num_samples_per_frame
      p += 2 // audio_roll_distance
      return (config[p + 2] << 8) | config[p + 3] // version, channel count, then pre_skip (big endian)
    }
    p = end
  }
  return 0
}

export interface StreamOptions {
  /** Output sample rate (the audio context's). */
  sampleRate?: number
  mixId?: number | null
  elementGains?: Record<number, number>
  /** Conformance tests only: a loudspeaker layout instead of binaural. */
  soundSystem?: number
}

export class IamfStreamSource {
  readonly info: IamfStreamInfo
  readonly sampleRate: number
  /** Length in seconds. */
  readonly duration: number
  private mod: IamfModule
  private bytes: Uint8Array
  private opts: StreamOptions
  private config: Uint8Array
  private complete: boolean
  private units: Unit[]
  private dec: IamfDecoder
  private unitOut: number
  private preSkip: number
  private nextUnit = 0
  private skip = 0
  private flushed = false
  private queue: Float32Array[][] = []
  private queued = 0
  private head: HeadQuaternion | null = null

  private constructor(mod: IamfModule, bytes: Uint8Array, opts: StreamOptions, config: Uint8Array, complete: boolean, units: Unit[]) {
    this.mod = mod
    this.bytes = bytes
    this.opts = opts
    this.config = config
    this.complete = complete
    this.units = units
    this.sampleRate = opts.sampleRate ?? 48000
    this.preSkip = (opusPreSkip(config) * this.sampleRate) / 48000
    this.dec = this.openDecoder()
    this.info = this.dec.streamInfo!
    this.unitOut = (this.info.samplesPerFrame * this.sampleRate) / this.info.rate
    this.duration = (units.length * this.info.samplesPerFrame) / this.info.rate
  }

  static open(mod: IamfModule, bytes: Uint8Array, opts: StreamOptions = {}): IamfStreamSource {
    if (isMp4(bytes)) {
      const track = findIamfTrack(bytes)
      return new IamfStreamSource(
        mod,
        bytes,
        opts,
        track.config,
        true,
        track.samples.map((s) => ({ start: s.offset, end: s.offset + s.size })),
      )
    }
    const probe = new IamfDecoder(mod, opts.sampleRate ?? 48000, opts.soundSystem ?? -1)
    try {
      const used = probe.configure(bytes)
      if (used == null) throw new Error('IAMF descriptors are incomplete')
      return new IamfStreamSource(mod, bytes, opts, bytes.subarray(0, used), true, splitStream(bytes, used))
    } finally {
      probe.close()
    }
  }

  private openDecoder() {
    const d = new IamfDecoder(this.mod, this.sampleRate, this.opts.soundSystem ?? -1)
    try {
      if (this.opts.mixId != null) d.setMix(this.opts.mixId)
      if (d.configure(this.config, this.complete) == null) throw new Error('IAMF descriptors are incomplete')
      for (const [id, db] of Object.entries(this.opts.elementGains ?? {})) d.setElementGain(Number(id), db)
      if (this.head) d.setHead(true, this.head)
      return d
    } catch (err) {
      d.close()
      throw err
    }
  }

  /** Render with (a unit quaternion) or without (null) the listener's head rotation; takes effect from the next unit decoded. */
  setHead(q: HeadQuaternion | null) {
    this.head = q
    this.dec.setHead(!!q, q ?? undefined)
  }

  private emitted = 0
  private start = 0

  /** Output position of the next sample `read` returns, in samples. */
  positionSamples() {
    return this.start + this.emitted
  }

  /** Move to `seconds` (clamped to the stream). Decodes a short pre-roll first so the sound is settled at the target. */
  seek(seconds: number) {
    this.seekTo(Math.max(0, Math.round(seconds * this.sampleRate)))
  }

  /** Same, in output samples. */
  seekTo(target: number) {
    const k = Math.min(this.units.length - 1, Math.floor(target / this.unitOut))
    const roll = Math.ceil((PREROLL_SECONDS * this.sampleRate) / this.unitOut) + 1
    const k0 = Math.max(0, k - roll)
    this.dec.close()
    this.dec = this.openDecoder()
    this.queue = []
    this.queued = 0
    this.flushed = false
    this.nextUnit = k0
    // libiamf drops the codec's pre-skip only at the very start of a stream: when decoding begins later, drop it here
    this.skip = Math.max(0, Math.round(target - k0 * this.unitOut + (k0 > 0 ? this.preSkip : 0)))
    this.start = target
    this.emitted = 0
  }

  private pull() {
    if (this.nextUnit < this.units.length) {
      const u = this.units[this.nextUnit++]
      this.dec.decode(this.bytes.subarray(u.start, u.end), (...f) => this.push(f))
    } else if (!this.flushed) {
      this.flushed = true
      this.dec.decode(null, (...f) => this.push(f))
    } else {
      return false
    }
    return true
  }

  private push(frame: Float32Array[]) {
    let f = frame
    if (this.skip > 0) {
      const cut = Math.min(this.skip, f[0].length)
      this.skip -= cut
      f = f.map((c) => c.subarray(cut))
    }
    if (f[0].length) {
      this.queue.push(f)
      this.queued += f[0].length
    }
  }

  /** The next `frames` output samples (fewer at the end of the stream, null when there is nothing left): [left, right]. */
  read(frames: number): Float32Array[] | null {
    while (this.queued < frames && this.pull());
    if (!this.queued) return null
    const n = Math.min(frames, this.queued)
    const out = [new Float32Array(n), new Float32Array(n)]
    let at = 0
    while (at < n) {
      const f = this.queue[0]
      const take = Math.min(f[0].length, n - at)
      out[0].set(f[0].subarray(0, take), at)
      out[1].set((f[1] ?? f[0]).subarray(0, take), at)
      at += take
      if (take === f[0].length) this.queue.shift()
      else this.queue[0] = f.map((c) => c.subarray(take))
    }
    this.queued -= n
    this.emitted += n
    return out
  }

  close() {
    this.dec.close()
  }
}
