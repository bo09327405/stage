/*
 * libiamf (the AOMedia IAMF reference decoder) compiled to WebAssembly — see tools/iamf-wasm. This file loads the module
 * and wraps one decoder instance. It uses no DOM / Node API, so it runs on the main thread, in a Worker, in an
 * AudioWorklet and in node's test runner. Output is always binaural stereo.
 *
 * The module is a STANDALONE_WASM build: it needs only a handful of host functions (a clock, stubs for stdio), supplied here.
 */

export interface IamfStreamInfo {
  maxFrame: number
  primary: number
  additional: number
  rate: number
  samplesPerFrame: number
  mixId: number
  elements: { id: number; codec: number; type: number; layout: number; channels: number }[]
  mixes: { id: number; elements: { id: number; mode: number; profile: number; gainMin?: number; gainMax?: number }[] }[]
}

interface Exports {
  memory: WebAssembly.Memory
  _initialize?: () => void
  iw_open(rate: number, bitDepth: number, soundSystem: number): number
  iw_close(w: number): void
  iw_set_mix(w: number, id: number): number
  iw_configure(w: number, data: number, size: number, rsize: number): number
  iw_set_gain(w: number, id: number, db: number): number
  iw_head_tracking(w: number, on: number): number
  iw_head_rotation(w: number, qw: number, qx: number, qy: number, qz: number): number
  iw_decode(w: number, data: number, size: number, rsize: number): number
  iw_pcm(w: number): number
  iw_max_frame(w: number): number
  iw_channels(w: number): number
  iw_alloc(n: number): number
  iw_free(p: number): void
  iw_info(w: number): number
}

const ERRORS: Record<number, string> = {
  [-1]: 'bad argument',
  [-2]: 'buffer too small',
  [-3]: 'internal error',
  [-4]: 'invalid packet',
  [-5]: 'invalid state',
  [-6]: 'unimplemented',
  [-7]: 'allocation failed',
  [-8]: 'pending',
}
export const IAMF_ERR_BUFFER_TOO_SMALL = -2
export const iamfErrorText = (code: number) => ERRORS[code] ?? `error ${code}`

/** Compile the module once; share the result between decoders (and send it to a Worker / Worklet). */
export const compileIamfWasm = (bytes: BufferSource) => WebAssembly.compile(bytes)

/** A loaded module instance: the decoders made from it share its memory (so use one module per thread). */
export class IamfModule {
  readonly x: Exports

  private constructor(x: Exports) {
    this.x = x
  }

  static async instantiate(module: WebAssembly.Module): Promise<IamfModule> {
    let memory: WebAssembly.Memory | null = null
    const stub = () => 0
    const imports: WebAssembly.Imports = {
      env: {
        emscripten_asm_const_int: stub,
        HaveOffsetConverter: stub,
        emscripten_notify_memory_growth: stub,
      },
      wasi_snapshot_preview1: {
        fd_write: (_fd: number, _iov: number, _n: number, written: number) => {
          // Nothing is printed: report the bytes as written so the C library carries on.
          if (memory) {
            const v = new DataView(memory.buffer)
            let total = 0
            for (let i = 0; i < _n; i++) total += v.getUint32(_iov + i * 8 + 4, true)
            v.setUint32(written, total, true)
          }
          return 0
        },
        fd_close: stub,
        fd_seek: () => 70, // ESPIPE
        proc_exit: () => {
          throw new Error('libiamf called exit()')
        },
        clock_time_get: (_id: number, _precision: bigint, out: number) => {
          if (memory) new DataView(memory.buffer).setBigUint64(out, BigInt(Math.round(Date.now() * 1e6)), true)
          return 0
        },
        environ_sizes_get: (count: number, size: number) => {
          if (memory) {
            const v = new DataView(memory.buffer)
            v.setUint32(count, 0, true)
            v.setUint32(size, 0, true)
          }
          return 0
        },
        environ_get: stub,
      },
    }
    const instance = await WebAssembly.instantiate(module, imports)
    const x = instance.exports as unknown as Exports
    memory = x.memory
    x._initialize?.()
    return new IamfModule(x)
  }

  /** Copy bytes into the module's memory; returns the pointer (free with `x.iw_free`). */
  put(data: Uint8Array): number {
    const p = this.x.iw_alloc(Math.max(1, data.length))
    if (!p) throw new Error('IAMF decoder is out of memory')
    new Uint8Array(this.x.memory.buffer, p, data.length).set(data)
    return p
  }
}

export interface DecodeOptions {
  /** Conformance tests only: a loudspeaker layout (0 = stereo) instead of binaural. */
  soundSystem?: number
  /** Output sample rate (default 48000). */
  sampleRate?: number
  /** The mix presentation to render (default: the first one in the stream). */
  mixId?: number | null
  /** Extra gain per audio element, dB, keyed by element id. */
  elementGains?: Record<number, number>
}

/** One decoder instance: configure it with the descriptor OBUs, then feed it audio. */
export class IamfDecoder {
  private mod: IamfModule
  private w: number
  /** Output rate: 48000 unless asked otherwise (0 = the stream's own). */
  readonly sampleRate: number
  /** Output channels: 2 (binaural) unless a loudspeaker layout was asked for. */
  readonly channels: number
  private bits = 32
  private info: IamfStreamInfo | null = null

  /** `soundSystem` is only for conformance tests (0 = stereo loudspeakers); the app always renders binaural. */
  constructor(mod: IamfModule, sampleRate = 48000, soundSystem = -1) {
    this.mod = mod
    this.sampleRate = sampleRate
    this.w = mod.x.iw_open(sampleRate, this.bits, soundSystem)
    if (!this.w) throw new Error('IAMF decoder could not be created')
    this.channels = mod.x.iw_channels(this.w)
  }

  /** The stream's profiles, audio elements and mix presentations (after configure). */
  get streamInfo() {
    return this.info
  }

  /** Choose the mix presentation (before configure). */
  setMix(id: number) {
    const r = this.mod.x.iw_set_mix(this.w, id)
    if (r < 0) throw new Error(`mix presentation ${id}: ${iamfErrorText(r)}`)
  }

  /**
   * Feed the descriptor OBUs. Returns how many bytes it used, or null when it needs more data. Throws on a real error.
   * `complete`: `data` is exactly the descriptors (an MP4's iacb box); otherwise it is a stream and the decoder reads on until
   * it meets the first audio OBU.
   */
  configure(data: Uint8Array, complete = false): number | null {
    const x = this.mod.x
    const p = this.mod.put(data)
    const r = x.iw_alloc(4)
    try {
      new DataView(x.memory.buffer).setUint32(r, 0, true)
      const ret = x.iw_configure(this.w, p, data.length, complete ? 0 : r)
      const used = new DataView(x.memory.buffer).getUint32(r, true)
      if (ret === 0) {
        const ptr = x.iw_info(this.w)
        if (ptr) {
          const mem = new Uint8Array(x.memory.buffer)
          let end = ptr
          while (mem[end]) end++
          this.info = JSON.parse(new TextDecoder().decode(mem.subarray(ptr, end))) as IamfStreamInfo
          x.iw_free(ptr)
        }
        return used
      }
      if (ret === IAMF_ERR_BUFFER_TOO_SMALL) return null
      throw new Error(`IAMF configure failed: ${iamfErrorText(ret)}`)
    } finally {
      x.iw_free(p)
      x.iw_free(r)
    }
  }

  /** Extra gain for one audio element of the chosen mix, dB. Returns false when the stream does not allow it (no gain range). */
  setElementGain(elementId: number, db: number): boolean {
    return this.mod.x.iw_set_gain(this.w, elementId, db) === 0
  }

  /** Turn the head-tracked binaural render on / off, and set the head's rotation (a unit quaternion). */
  setHead(enabled: boolean, q?: { w: number; x: number; y: number; z: number }) {
    this.mod.x.iw_head_tracking(this.w, enabled ? 1 : 0)
    if (enabled && q) this.mod.x.iw_head_rotation(this.w, q.w, q.x, q.y, q.z)
  }

  /**
   * Decode audio OBUs (null flushes). `onFrame` receives each decoded frame as two Float32Arrays (copies).
   * Returns the bytes consumed (decoding stops when the module wants more data or hits an error).
   */
  decode(data: Uint8Array | null, onFrame: (...channels: Float32Array[]) => void): number {
    const x = this.mod.x
    if (!this.info) throw new Error('IAMF decoder is not configured')
    const p = data && data.length ? this.mod.put(data) : 0
    const r = x.iw_alloc(4)
    let used = 0
    try {
      while (true) {
        new DataView(x.memory.buffer).setUint32(r, 0, true)
        const left = data ? data.length - used : 0
        const samples = x.iw_decode(this.w, p ? p + used : 0, left, r)
        const consumed = new DataView(x.memory.buffer).getUint32(r, true)
        if (samples > 0) {
          const n = this.channels
          const pcm = new Int32Array(x.memory.buffer, x.iw_pcm(this.w), samples * n)
          const out = Array.from({ length: n }, () => new Float32Array(samples))
          for (let i = 0; i < samples; i++) for (let c = 0; c < n; c++) out[c][i] = pcm[i * n + c] / 2147483648
          onFrame(...out)
        } else if (samples < 0) {
          if (samples === -5) throw new Error('IAMF stream changed: the decoder must be configured again')
          break
        }
        if (!data) break
        used += consumed
        if (used >= data.length || !consumed) break
      }
      return used
    } finally {
      if (p) x.iw_free(p)
      x.iw_free(r)
    }
  }

  close() {
    if (this.w) this.mod.x.iw_close(this.w)
    this.w = 0
  }
}

/**
 * Decode a whole standalone IA stream (a .iamf file) to binaural stereo. Descriptors first, then audio.
 */
export function decodeIamfStream(mod: IamfModule, stream: Uint8Array, opts: DecodeOptions = {}) {
  const dec = new IamfDecoder(mod, opts.sampleRate ?? 48000, opts.soundSystem ?? -1)
  try {
    if (opts.mixId != null) dec.setMix(opts.mixId)
    const used = dec.configure(stream)
    if (used == null) throw new Error('IAMF descriptors are incomplete')
    for (const [id, db] of Object.entries(opts.elementGains ?? {})) dec.setElementGain(Number(id), db)
    const parts: Float32Array[][] = Array.from({ length: dec.channels }, () => [])
    const take = (...frame: Float32Array[]) => frame.forEach((f, c) => parts[c].push(f))
    dec.decode(stream.subarray(used), take)
    dec.decode(null, take)
    const join = (list: Float32Array[]) => {
      const out = new Float32Array(list.reduce((n, p) => n + p.length, 0))
      let at = 0
      for (const p of list) {
        out.set(p, at)
        at += p.length
      }
      return out
    }
    const channels = parts.map(join)
    return { channels, left: channels[0], right: channels[1] ?? channels[0], sampleRate: dec.sampleRate || dec.streamInfo?.rate || 48000, info: dec.streamInfo! }
  } finally {
    dec.close()
  }
}
