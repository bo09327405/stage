import { fetchIamfBytes } from './iamfService.ts'
import { iamfWasmUrl } from './iamfService.ts'
import { iamfHeadQuaternion } from './iamfStream.ts'
import type { StreamOptions } from './iamfStream.ts'

/*
 * An Eclipsa (IAMF) file played live: libiamf decodes it in a Worker as it plays, so the listener's head rotation reaches the
 * binaural renderer while the sound runs (a file decoded ahead into a buffer cannot follow the head). The Worker's audio
 * reaches an AudioWorklet that plays it at an exact point of the audio clock, so a late joiner or a loop lines up with the
 * server's cue position like any other sound of the stage.
 *
 *   page ── play / head / stop ──▶ Worker (libiamf) ── chunks ──▶ AudioWorklet ──▶ the voice's graph
 *                                      ▲                              │
 *                                      └────── position reports ──────┘
 */

const WORKLET = `
const CAP = 1 << 16
const MASK = CAP - 1
class IamfLive extends AudioWorkletProcessor {
  constructor() {
    super()
    this.l = new Float32Array(CAP)
    this.r = new Float32Array(CAP)
    this.wr = 0
    this.epoch = 0
    this.start = null
    this.end = Infinity
    this.under = 0
    this.tick = 0
    this.link = null
    this.port.onmessage = (e) => {
      const m = e.data
      if (m.t === 'link') {
        this.link = m.port
        this.link.onmessage = (ev) => this.onLink(ev.data)
      } else if (m.t === 'start') {
        this.reset(m.epoch)
        this.start = m.frame
      } else if (m.t === 'stop') {
        this.start = null
      }
    }
  }
  reset(epoch) {
    if (epoch === this.epoch) return
    this.epoch = epoch
    this.wr = 0
    this.end = Infinity
    this.under = 0
    this.l.fill(0)
    this.r.fill(0)
  }
  onLink(m) {
    if (m.t === 'chunk') {
      if (m.epoch < this.epoch) return
      this.reset(m.epoch)
      // a gap (the producer skipped ahead) is silence
      for (let n = Math.max(this.wr, m.n0 - CAP); n < m.n0; n++) { this.l[n & MASK] = 0; this.r[n & MASK] = 0 }
      for (let i = 0; i < m.l.length; i++) { this.l[(m.n0 + i) & MASK] = m.l[i]; this.r[(m.n0 + i) & MASK] = m.r[i] }
      this.wr = Math.max(this.wr, m.n0 + m.l.length)
    } else if (m.t === 'end' && m.epoch >= this.epoch) {
      this.reset(m.epoch)
      this.end = m.at
    }
  }
  process(inputs, outputs) {
    const out = outputs[0]
    if (this.start === null || !out || !out[0]) return true
    const L = out[0]
    const R = out[1] || out[0]
    const f0 = currentFrame - this.start
    for (let i = 0; i < L.length; i++) {
      const n = f0 + i
      if (n >= 0 && n < this.end && n < this.wr && n >= this.wr - CAP) {
        L[i] = this.l[n & MASK]
        R[i] = this.r[n & MASK]
      } else if (n >= this.wr && n < this.end) {
        this.under++
      }
    }
    if (this.link && ++this.tick >= 8) {
      this.tick = 0
      this.link.postMessage({ t: 'pos', lin: f0 + L.length, under: this.under })
      this.under = 0
    }
    return true
  }
}
registerProcessor('iamf-live', IamfLive)
`

const loaded = new WeakMap<BaseAudioContext, Promise<void>>()

function loadWorklet(ctx: AudioContext) {
  let job = loaded.get(ctx)
  if (!job) {
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }))
    job = ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url))
    job.catch(() => loaded.delete(ctx))
    loaded.set(ctx, job)
  }
  return job
}

/** Whether this browser can run it: an AudioWorklet, a module Worker and WebAssembly. */
export const iamfLiveSupported = (ctx: BaseAudioContext) =>
  typeof Worker !== 'undefined' && typeof WebAssembly !== 'undefined' && typeof AudioWorkletNode !== 'undefined' && !!(ctx as AudioContext).audioWorklet

export interface IamfLiveOptions {
  mixId?: number | null
  elementGains?: Record<number, number>
}

export class IamfLive {
  /** Connect this to the voice's graph. */
  readonly output: AudioWorkletNode
  /** Length of the sound, seconds. */
  readonly duration: number
  /** Time between asking it to play and its first sound: the Worker has to seek and render the first chunks. */
  readonly lead = 0.15
  private ctx: AudioContext
  private worker: Worker
  private epoch = 0
  private last = ''

  private constructor(ctx: AudioContext, node: AudioWorkletNode, worker: Worker, duration: number) {
    this.ctx = ctx
    this.output = node
    this.worker = worker
    this.duration = duration
  }

  /** Download the file, start the decoder and have everything ready to play (done at STANDBY). Rejects when any step fails. */
  static async create(ctx: AudioContext, url: string, options: IamfLiveOptions = {}): Promise<IamfLive> {
    if (!iamfLiveSupported(ctx)) throw new Error('這個瀏覽器不支援即時 IAMF 播放')
    const [bytes] = await Promise.all([fetchIamfBytes(url), loadWorklet(ctx)])
    const node = new AudioWorkletNode(ctx, 'iamf-live', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] })
    const worker = new Worker(new URL('./iamfLiveWorker.ts', import.meta.url), { type: 'module' })
    const channel = new MessageChannel()
    node.port.postMessage({ t: 'link', port: channel.port2 }, [channel.port2])
    const copy = bytes.slice().buffer
    const opts: StreamOptions = { sampleRate: ctx.sampleRate, mixId: options.mixId ?? null, elementGains: options.elementGains }
    const opened = new Promise<number>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<{ t: string; duration?: number; error?: string }>) => {
        if (e.data.t === 'opened') resolve(e.data.duration!)
        else if (e.data.t === 'error') reject(new Error(e.data.error))
      }
      worker.onerror = (e) => reject(new Error(e.message || 'IAMF worker failed'))
    })
    worker.postMessage({ type: 'open', wasmUrl: iamfWasmUrl(), bytes: copy, opts, port: channel.port1 }, [copy, channel.port1])
    try {
      return new IamfLive(ctx, node, worker, await opened)
    } catch (err) {
      worker.terminate()
      node.disconnect()
      throw err
    }
  }

  /** Play from `pos` seconds so that this moment is `when` on the audio clock; loops inside `loop` when given. */
  play(when: number, pos: number, loop: { start: number; end: number } | null) {
    const epoch = ++this.epoch
    this.worker.postMessage({ type: 'play', epoch, pos, loop })
    this.output.port.postMessage({ t: 'start', epoch, frame: Math.round(when * this.ctx.sampleRate) })
  }

  stop() {
    this.epoch++
    this.worker.postMessage({ type: 'stop' })
    this.output.port.postMessage({ t: 'stop' })
  }

  /** The listener's head (a column-major 3×3, local → scene), or null to render without head tracking. */
  setHead(m: ArrayLike<number> | null) {
    const q = m ? iamfHeadQuaternion(m) : null
    const key = q ? [q.w, q.x, q.y, q.z].map((v) => v.toFixed(4)).join(',') : ''
    if (key === this.last) return
    this.last = key
    this.worker.postMessage({ type: 'head', q })
  }

  dispose() {
    this.stop()
    this.output.disconnect()
    this.worker.terminate()
  }
}
