import { IamfDecoder, IamfModule, decodeIamfStream, type DecodeOptions, type IamfStreamInfo } from './iamfWasm.ts'
import { findIamfTrack } from './mp4Samples.ts'

/** Whether the bytes look like an MP4 / M4A (ISOBMFF) rather than a standalone IA stream. */
export const isMp4 = (b: Uint8Array) => b.length > 12 && String.fromCharCode(b[4], b[5], b[6], b[7]) === 'ftyp'

export interface DecodedIamf {
  /** Binaural stereo: [left, right]. */
  channels: Float32Array[]
  sampleRate: number
  info: IamfStreamInfo
}

/** Decode a .iamf stream or an MP4 / M4A with an IAMF track to binaural stereo. */
export function decodeIamfFile(mod: IamfModule, bytes: Uint8Array, opts: DecodeOptions = {}): DecodedIamf {
  if (!isMp4(bytes)) {
    const r = decodeIamfStream(mod, bytes, opts)
    return { channels: r.channels, sampleRate: r.sampleRate, info: r.info }
  }
  const track = findIamfTrack(bytes)
  const dec = new IamfDecoder(mod, opts.sampleRate ?? 48000, opts.soundSystem ?? -1)
  try {
    if (opts.mixId != null) dec.setMix(opts.mixId)
    if (dec.configure(track.config, true) == null) throw new Error('IAMF descriptors are incomplete')
    for (const [id, db] of Object.entries(opts.elementGains ?? {})) dec.setElementGain(Number(id), db)
    const parts: Float32Array[][] = Array.from({ length: dec.channels }, () => [])
    const take = (...frame: Float32Array[]) => frame.forEach((f, c) => parts[c].push(f))
    for (const s of track.samples) dec.decode(bytes.subarray(s.offset, s.offset + s.size), take)
    dec.decode(null, take)
    const channels = parts.map((list) => {
      const out = new Float32Array(list.reduce((n, p) => n + p.length, 0))
      let at = 0
      for (const p of list) {
        out.set(p, at)
        at += p.length
      }
      return out
    })
    return { channels, sampleRate: dec.sampleRate || dec.streamInfo?.rate || 48000, info: dec.streamInfo! }
  } finally {
    dec.close()
  }
}

/** Only read the stream's description (profiles, elements, mixes with their element gain ranges): no audio is decoded. */
export function inspectIamfFile(mod: IamfModule, bytes: Uint8Array): IamfStreamInfo {
  const dec = new IamfDecoder(mod)
  try {
    const config = isMp4(bytes) ? findIamfTrack(bytes).config : bytes
    if (dec.configure(config, isMp4(bytes)) == null) throw new Error('IAMF descriptors are incomplete')
    return dec.streamInfo!
  } finally {
    dec.close()
  }
}
