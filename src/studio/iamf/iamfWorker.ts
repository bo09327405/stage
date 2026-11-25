import { decodeIamfFile, inspectIamfFile } from './iamfDecode.ts'
import { IamfModule, compileIamfWasm } from './iamfWasm.ts'
import type { DecodeOptions } from './iamfWasm.ts'

/*
 * Runs the IAMF decoder off the main thread: decoding a few minutes of Opus and rendering it binaurally takes a moment,
 * and the studio and the audience page must not stutter meanwhile. One module per worker.
 */

type Request =
  | { id: number; type: 'init'; wasmUrl: string }
  | { id: number; type: 'decode'; bytes: ArrayBuffer; opts: DecodeOptions }
  | { id: number; type: 'inspect'; bytes: ArrayBuffer }

const scope = self as unknown as { postMessage(message: unknown, transfer?: Transferable[]): void; onmessage: ((e: MessageEvent<Request>) => void) | null }
let module: Promise<IamfModule> | null = null

scope.onmessage = async (e) => {
  const m = e.data
  try {
    if (m.type === 'init') {
      module ??= fetch(m.wasmUrl)
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`)
          return r.arrayBuffer()
        })
        .then((bytes) => compileIamfWasm(bytes))
        .then((compiled) => IamfModule.instantiate(compiled))
      await module
      scope.postMessage({ id: m.id, ok: true })
    } else if (m.type === 'decode') {
      const mod = await module!
      const r = decodeIamfFile(mod, new Uint8Array(m.bytes), m.opts)
      scope.postMessage({ id: m.id, ok: true, channels: r.channels, sampleRate: r.sampleRate, info: r.info }, r.channels.map((c) => c.buffer))
    } else {
      const mod = await module!
      scope.postMessage({ id: m.id, ok: true, info: inspectIamfFile(mod, new Uint8Array(m.bytes)) })
    }
  } catch (err) {
    scope.postMessage({ id: m.id, ok: false, error: (err as Error).message })
  }
}
