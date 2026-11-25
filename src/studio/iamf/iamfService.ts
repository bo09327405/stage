import type { DecodedIamf } from './iamfDecode.ts'
import type { DecodeOptions, IamfStreamInfo } from './iamfWasm.ts'

/*
 * The IAMF decoder as the app uses it: a module Worker that loads public/iamf/iamf.wasm on first use and decodes files
 * to binaural stereo. Bytes are copied into the worker (the cache keeps its own), results come back as transferred arrays.
 */

export const iamfWasmUrl = () => `${import.meta.env.BASE_URL}iamf/iamf.wasm`

interface Reply {
  id: number
  ok: boolean
  error?: string
  channels?: Float32Array[]
  sampleRate?: number
  info?: IamfStreamInfo
}

let worker: Worker | null = null
let ready: Promise<void> | null = null
let nextId = 1
const waiting = new Map<number, { resolve: (r: Reply) => void; reject: (e: Error) => void }>()

function call(message: Record<string, unknown>, transfer: Transferable[] = []): Promise<Reply> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject })
    worker!.postMessage({ id, ...message }, transfer)
  })
}

/** Start the worker and load the module (once). Rejects when the module cannot be loaded. */
export function initIamf(): Promise<void> {
  if (!ready) {
    worker = new Worker(new URL('./iamfWorker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<Reply>) => {
      const w = waiting.get(e.data.id)
      if (!w) return
      waiting.delete(e.data.id)
      if (e.data.ok) w.resolve(e.data)
      else w.reject(new Error(e.data.error ?? 'IAMF decoder error'))
    }
    worker.onerror = (e) => {
      for (const w of waiting.values()) w.reject(new Error(e.message || 'IAMF worker failed'))
      waiting.clear()
    }
    ready = call({ type: 'init', wasmUrl: iamfWasmUrl() }).then(() => undefined)
    ready.catch(() => {
      worker?.terminate()
      worker = null
      ready = null
    })
  }
  return ready
}

/** Whether the decoder can be loaded here (a Worker, WebAssembly and the module file). */
export async function iamfDecoderAvailable(): Promise<boolean> {
  if (typeof Worker === 'undefined' || typeof WebAssembly === 'undefined') return false
  try {
    await initIamf()
    return true
  } catch {
    return false
  }
}

/** Decode a .iamf stream or an MP4 / M4A with IAMF to binaural stereo. */
export async function decodeIamf(bytes: Uint8Array, opts: DecodeOptions = {}): Promise<DecodedIamf> {
  await initIamf()
  const copy = bytes.slice().buffer
  const r = await call({ type: 'decode', bytes: copy, opts }, [copy])
  return { channels: r.channels!, sampleRate: r.sampleRate!, info: r.info! }
}

/** The stream's description (profiles, elements, mix presentations with gain ranges), without decoding audio. */
export async function inspectIamf(bytes: Uint8Array): Promise<IamfStreamInfo> {
  await initIamf()
  const copy = bytes.slice().buffer
  return (await call({ type: 'inspect', bytes: copy }, [copy])).info!
}

/** Decoded stereo as a Web Audio buffer. */
export function toAudioBuffer(d: DecodedIamf): AudioBuffer {
  const buf = new AudioBuffer({ numberOfChannels: d.channels.length, length: d.channels[0].length, sampleRate: d.sampleRate })
  d.channels.forEach((c, i) => buf.copyToChannel(c as Float32Array<ArrayBuffer>, i))
  return buf
}

/** Whether the bytes are an IA stream (sequence header 'iamf') or an MP4 with an IAMF brand. */
export function isIamfBytes(b: Uint8Array): boolean {
  if (b.length < 12) return false
  const text = (at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n))
  if ((b[0] === 0xf8 || b[0] === 0xfc) && b.length > 8) return text(2, 4) === 'iamf'
  if (text(4, 4) === 'ftyp') return text(0, Math.min(b.length, 256)).includes('iamf')
  return false
}

const files = new Map<string, Promise<Uint8Array>>()

/** The bytes of a file (cached while in use; call `forgetIamfFile` when done with a big one). */
export function fetchIamfBytes(url: string): Promise<Uint8Array> {
  let job = files.get(url)
  if (!job) {
    job = fetch(url).then(async (res) => {
      if (!res.ok) throw new Error(`無法下載 IAMF 檔案（HTTP ${res.status}）`)
      return new Uint8Array(await res.arrayBuffer())
    })
    job.catch(() => files.delete(url))
    files.set(url, job)
    while (files.size > 3) files.delete(files.keys().next().value as string)
  }
  return job
}

export const forgetIamfFile = (url: string) => files.delete(url)
