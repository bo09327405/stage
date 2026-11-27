import type { HeadQuaternion, IamfStreamSource } from './iamfStream.ts'

/*
 * The decoding side of live Eclipsa playback: given where the sound starts and whether it loops, keeps a few tenths of a
 * second of binaural audio rendered ahead of what the AudioWorklet has played, and sends it as chunks tagged with their
 * position on the playback timeline ("linear" frame 0 = the moment the sound starts; the worklet maps that to the audio clock).
 * Head rotation set meanwhile is applied to the audio decoded from then on. Pure: the Worker and the tests drive it.
 */

/** Frames per message: 20 ms at 48 kHz. */
const CHUNK = 960
/** How far ahead of the played position audio is kept, seconds: the head-tracking latency is about this much. It grows when the worklet runs dry. */
const START_AHEAD = 0.12
const MAX_AHEAD = 0.4

export interface LiveChunk {
  epoch: number
  /** Linear frame of the first sample. */
  n0: number
  l: Float32Array
  r: Float32Array
}

export interface LiveEnd {
  epoch: number
  /** Linear frame where the sound ends. */
  at: number
}

export class LiveSession {
  private source: IamfStreamSource
  private rate: number
  private emit: (c: LiveChunk) => void
  private emitEnd: (e: LiveEnd) => void
  private epoch = 0
  private active = false
  /** Next linear frame to produce. */
  private lin = 0
  /** Next media sample to read. */
  private cur = 0
  private loopStart = 0
  private loopEnd = 0
  private looping = false
  private ahead = START_AHEAD

  constructor(source: IamfStreamSource, emit: (c: LiveChunk) => void, emitEnd: (e: LiveEnd) => void) {
    this.source = source
    this.rate = source.sampleRate
    this.emit = emit
    this.emitEnd = emitEnd
  }

  /** Start (or restart) the sound at `pos` seconds, looping inside `loop` (seconds) when given. */
  play(epoch: number, pos: number, loop: { start: number; end: number } | null) {
    const total = Math.floor(this.source.duration * this.rate)
    this.epoch = epoch
    this.lin = 0
    this.cur = Math.min(total, Math.max(0, Math.round(pos * this.rate)))
    this.looping = false
    if (loop) {
      const s = Math.max(0, Math.round(loop.start * this.rate))
      const e = Math.min(total, Math.round(loop.end * this.rate))
      if (e - s > CHUNK) {
        this.looping = true
        this.loopStart = s
        this.loopEnd = e
      }
    }
    this.active = true
    this.fill(0)
  }

  stop() {
    this.active = false
  }

  setHead(q: HeadQuaternion | null) {
    this.source.setHead(q)
  }

  /** The worklet has played up to linear frame `played`, and ran dry `underruns` times since its last report: produce what it needs next. */
  fill(played: number, underruns = 0) {
    if (!this.active) return
    if (underruns > 0) this.ahead = Math.min(MAX_AHEAD, this.ahead + 0.05)
    // Behind the clock (a slow start): drop what can no longer be played on time.
    if (played > this.lin) {
      this.cur += played - this.lin
      this.lin = played
      if (this.looping && this.cur >= this.loopEnd) this.cur = this.loopStart + ((this.cur - this.loopStart) % (this.loopEnd - this.loopStart))
    }
    const limit = Math.max(0, played) + Math.round(this.ahead * this.rate)
    while (this.active && this.lin < limit) {
      if (this.looping && this.cur >= this.loopEnd) this.cur = this.loopStart
      const want = Math.min(CHUNK, this.looping ? this.loopEnd - this.cur : CHUNK)
      if (this.source.positionSamples() !== this.cur) this.source.seekTo(this.cur)
      const got = this.source.read(want)
      if (!got) {
        if (this.looping && this.cur > this.loopStart) {
          // The stream is a little shorter than its nominal length: that is where it loops.
          this.loopEnd = this.cur
          if (this.loopEnd - this.loopStart <= CHUNK) this.looping = false
          continue
        }
        this.active = false
        this.emitEnd({ epoch: this.epoch, at: this.lin })
        return
      }
      // Read the length first: sending the chunk may transfer (and so empty) its arrays.
      const n = got[0].length
      this.emit({ epoch: this.epoch, n0: this.lin, l: got[0], r: got[1] })
      this.lin += n
      this.cur += n
    }
  }
}
