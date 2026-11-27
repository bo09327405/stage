import { IamfModule, compileIamfWasm } from './iamfWasm.ts'
import { IamfStreamSource, type HeadQuaternion, type StreamOptions } from './iamfStream.ts'
import { LiveSession } from './iamfLiveSession.ts'

/*
 * One live Eclipsa sound: loads the decoder, opens the file and keeps the audience's AudioWorklet fed. The worklet talks to
 * this worker through a MessageChannel port (its position reports ask for more audio; the audio goes back the same way),
 * so the page's main thread is not in the loop. Head rotation arrives from the page.
 */

type Request =
  | { type: 'open'; wasmUrl: string; bytes: ArrayBuffer; opts: StreamOptions; port: MessagePort }
  | { type: 'play'; epoch: number; pos: number; loop: { start: number; end: number } | null }
  | { type: 'stop' }
  | { type: 'head'; q: HeadQuaternion | null }

const scope = self as unknown as { postMessage(message: unknown): void; onmessage: ((e: MessageEvent<Request>) => void) | null }
let source: IamfStreamSource | null = null
let session: LiveSession | null = null
let port: MessagePort | null = null

scope.onmessage = async (e) => {
  const m = e.data
  try {
    if (m.type === 'open') {
      const wasm = await fetch(m.wasmUrl).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.arrayBuffer()
      })
      const mod = await IamfModule.instantiate(await compileIamfWasm(wasm))
      source = IamfStreamSource.open(mod, new Uint8Array(m.bytes), m.opts)
      port = m.port
      session = new LiveSession(
        source,
        (c) => port!.postMessage({ t: 'chunk', epoch: c.epoch, n0: c.n0, l: c.l, r: c.r }, [c.l.buffer, c.r.buffer]),
        (end) => port!.postMessage({ t: 'end', epoch: end.epoch, at: end.at }),
      )
      port.onmessage = (ev: MessageEvent<{ t: 'pos'; lin: number; under: number }>) => session?.fill(ev.data.lin, ev.data.under)
      scope.postMessage({ t: 'opened', duration: source.duration })
    } else if (m.type === 'play') session?.play(m.epoch, m.pos, m.loop)
    else if (m.type === 'stop') session?.stop()
    else if (m.type === 'head') session?.setHead(m.q)
  } catch (err) {
    scope.postMessage({ t: 'error', error: (err as Error).message })
  }
}
