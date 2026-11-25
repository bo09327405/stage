import type { IamfConfig, IamfSourceInfo } from '../types/spatialAudio'
import { findTopLevelBox } from './spatialProbe'
import { decodeIamf, fetchIamfBytes, iamfDecoderAvailable, inspectIamf, isIamfBytes, toAudioBuffer } from './iamf/iamfService'
import type { StudioRegion } from '../types/studio'
import { SAMPLE_RATE } from './audio'

/*
 * The IAMF (Eclipsa Audio) decoder seam: libiamf compiled to WebAssembly (tools/iamf-wasm, public/iamf/iamf.wasm), run in a
 * Worker (studio/iamf/). Files decode to binaural stereo with the chosen mix presentation and element gains.
 */

export interface IamfDecoderStatus {
  available: boolean
  reason: string
}

let status: IamfDecoderStatus = { available: true, reason: '' }
const listeners = new Set<() => void>()
const setStatus = (next: IamfDecoderStatus) => {
  status = next
  listeners.forEach((l) => l())
}

/** What is known about the decoder now: optimistic until a load has failed. */
export const iamfDecoderStatus = (): IamfDecoderStatus => status

/** Subscribe to status changes (for React: useSyncExternalStore). */
export const subscribeIamfStatus = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** Try to load the decoder and report. */
export async function checkIamfDecoder(): Promise<IamfDecoderStatus> {
  const ok = await iamfDecoderAvailable()
  setStatus(ok ? { available: true, reason: '' } : { available: false, reason: '無法載入 IAMF 解碼器（public/iamf/iamf.wasm）：這個瀏覽器不支援 WebAssembly / Worker，或檔案遺失' })
  return status
}

/** Element gain trims for libiamf: the designer's overrides, by element id. */
const gainsOf = (cfg: IamfConfig) => Object.fromEntries(Object.entries(cfg.elementGainOverrides).map(([k, v]) => [Number(k.slice(1)), v]))

/** Decoded files kept for a moment (a studio re-reads a region many times while it plays / is edited). */
const decoded = new Map<string, Promise<AudioBuffer>>()

/** Decode the IAMF file at `url` with the config's mix presentation and element gains. */
export function decodeIamfUrl(url: string, cfg: IamfConfig): Promise<AudioBuffer> {
  const gains = gainsOf(cfg)
  const key = `${url}|${cfg.mixPresentationId ?? ''}|${JSON.stringify(gains)}`
  let job = decoded.get(key)
  if (!job) {
    job = fetchIamfBytes(url)
      .then((bytes) => decodeIamf(bytes, { mixId: cfg.mixPresentationId, elementGains: gains }))
      .then(toAudioBuffer)
    job.catch(() => decoded.delete(key))
    decoded.set(key, job)
    while (decoded.size > 4) decoded.delete(decoded.keys().next().value as string)
  }
  return job
}

/** Give back what decoding `url` kept (a finished cue gives its big stereo buffer back at once). */
export function dropIamfUrl(url: string) {
  for (const k of [...decoded.keys()]) if (k.startsWith(`${url}|`)) decoded.delete(k)
}

/** The binaural stereo of an IAMF region for the given settings; silent (with a warning) when the decoder cannot run. */
export async function iamfRegionBuffer(region: Pick<StudioRegion, 'url' | 'sourceDuration' | 'duration'>, config: IamfConfig): Promise<AudioBuffer> {
  try {
    return await decodeIamfUrl(region.url, config)
  } catch (err) {
    console.warn('IAMF decode failed', err)
    setStatus({ available: false, reason: `IAMF 解碼失敗：${(err as Error).message}` })
    const seconds = Math.max(0.1, region.sourceDuration || region.duration)
    return new AudioBuffer({ numberOfChannels: 2, length: Math.ceil(seconds * SAMPLE_RATE), sampleRate: SAMPLE_RATE })
  }
}

/** Decode raw bytes that turned out to be IAMF (a file the browser could not decode) with default settings. */
export async function decodeIamfBytesDefault(bytes: Uint8Array): Promise<AudioBuffer | null> {
  if (!isIamfBytes(bytes)) return null
  return toAudioBuffer(await decodeIamf(bytes))
}

/**
 * Add what only the decoder knows to the header-parsed description: the range each element's gain may be trimmed within
 * (IAMF lets a mix allow trimming only where its author said so). Reads the file's descriptors, not its audio.
 */
export async function enrichIamfSource(url: string, source: IamfSourceInfo): Promise<IamfSourceInfo> {
  try {
    const head = await fetch(url, { headers: { range: 'bytes=0-8388607' } }).then(async (r) => new Uint8Array(await r.arrayBuffer()).subarray(0, 8388608))
    const isMp4 = head.length > 12 && String.fromCharCode(...head.subarray(4, 8)) === 'ftyp'
    const bytes = isMp4 && !findTopLevelBox(head, 'moov') ? await fetchIamfBytes(url) : head
    const info = await inspectIamf(bytes)
    return {
      ...source,
      mixes: source.mixes.map((m) => {
        const real = info.mixes.find((x) => x.id === m.id)
        return {
          ...m,
          elements: m.elements.map((e) => {
            const r = real?.elements.find((x) => x.id === e.id)
            const { gainRange: _old, ...rest } = e // the database rejects undefined values: leave the key out
            void _old
            return r && r.gainMin !== undefined && r.gainMax !== undefined ? { ...rest, gainRange: { min: r.gainMin, max: r.gainMax } } : rest
          }),
        }
      }),
    }
  } catch {
    return source
  }
}
