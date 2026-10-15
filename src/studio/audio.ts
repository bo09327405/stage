import type { StudioRegion } from '../types/studio'

/*
 * Audio data for the studio: decoding with a cache, non-destructive region processing (reverse,
 * pitch, vocal clean-up), waveform peaks and WAV encoding. Works in any context (no AudioContext
 * needs to be running), so the audience page can use it too.
 */

export const SAMPLE_RATE = 48000

// Decoding doesn't need a running (user-gesture) context; an offline one decodes fine.
let decoder: OfflineAudioContext | null = null
const decodeCtx = () => (decoder ??= new OfflineAudioContext(2, 1, SAMPLE_RATE))

const sources = new Map<string, Promise<AudioBuffer>>()

/** Fetch and decode a source file once; later calls share the result. */
export function loadSource(url: string): Promise<AudioBuffer> {
  let job = sources.get(url)
  if (!job) {
    job = (async () => {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`無法下載音檔（HTTP ${res.status}）`)
      return decodeCtx().decodeAudioData(await res.arrayBuffer())
    })()
    job.catch(() => sources.delete(url))
    sources.set(url, job)
  }
  return job
}

/** Make a just-recorded / generated buffer available under a URL before its upload finishes. */
export function primeSource(url: string, buffer: AudioBuffer) {
  sources.set(url, Promise.resolve(buffer))
}

const cloneBuffer = (b: AudioBuffer, length = b.length) => new AudioBuffer({ numberOfChannels: b.numberOfChannels, length, sampleRate: b.sampleRate })

function reverseBuffer(src: AudioBuffer): AudioBuffer {
  const out = cloneBuffer(src)
  for (let c = 0; c < src.numberOfChannels; c++) {
    const data = out.getChannelData(c)
    data.set(src.getChannelData(c))
    data.reverse()
  }
  return out
}

/**
 * Granular pitch shift that keeps the length: overlapping Hann-windowed grains, each read at the
 * pitch ratio from where the original would be at that moment. Good for voice and effects.
 */
function pitchShift(src: AudioBuffer, semitones: number): AudioBuffer {
  const ratio = 2 ** (semitones / 12)
  const grain = Math.round(src.sampleRate * 0.05)
  const hop = grain >> 1
  const window = new Float32Array(grain).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (grain - 1)))
  const out = cloneBuffer(src)
  for (let c = 0; c < src.numberOfChannels; c++) {
    const input = src.getChannelData(c)
    const output = out.getChannelData(c)
    const norm = new Float32Array(output.length)
    for (let start = -hop; start < input.length; start += hop) {
      for (let j = 0; j < grain; j++) {
        const o = start + j
        if (o < 0 || o >= output.length) continue
        // Center the resampled grain on the same moment of the source.
        const pos = start + grain / 2 + (j - grain / 2) * ratio
        const i0 = Math.floor(pos)
        if (i0 < 0 || i0 + 1 >= input.length) continue
        const frac = pos - i0
        const sample = input[i0] * (1 - frac) + input[i0 + 1] * frac
        output[o] += sample * window[j]
        norm[o] += window[j]
      }
    }
    for (let i = 0; i < output.length; i++) if (norm[i] > 1e-3) output[i] /= norm[i]
  }
  return out
}

/**
 * Vocal clean-up: a noise gate (silence between phrases), then rumble cut, a little mud cut,
 * presence lift and gentle compression, rendered offline.
 */
async function vocalCleanup(src: AudioBuffer): Promise<AudioBuffer> {
  // Gate on a smoothed envelope: below about −48 dBFS the signal fades out.
  const gated = cloneBuffer(src)
  const threshold = 10 ** (-48 / 20)
  const attack = Math.exp(-1 / (src.sampleRate * 0.002))
  const release = Math.exp(-1 / (src.sampleRate * 0.12))
  const env = new Float32Array(src.length)
  let e = 0
  for (let i = 0; i < src.length; i++) {
    let peak = 0
    for (let c = 0; c < src.numberOfChannels; c++) peak = Math.max(peak, Math.abs(src.getChannelData(c)[i]))
    e = peak > e ? attack * e + (1 - attack) * peak : release * e + (1 - release) * peak
    env[i] = e
  }
  let g = 0
  for (let c = 0; c < src.numberOfChannels; c++) {
    const input = src.getChannelData(c)
    const output = gated.getChannelData(c)
    g = 0
    for (let i = 0; i < src.length; i++) {
      const target = env[i] > threshold ? 1 : 0
      g += (target - g) * (target > g ? 0.01 : 0.0005)
      output[i] = input[i] * g
    }
  }

  const ctx = new OfflineAudioContext(src.numberOfChannels, src.length, src.sampleRate)
  const node = new AudioBufferSourceNode(ctx, { buffer: gated })
  const hp = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 90, Q: 0.7 })
  const mud = new BiquadFilterNode(ctx, { type: 'peaking', frequency: 300, Q: 1, gain: -3 })
  const presence = new BiquadFilterNode(ctx, { type: 'peaking', frequency: 4500, Q: 0.8, gain: 3 })
  const comp = new DynamicsCompressorNode(ctx, { threshold: -22, knee: 10, ratio: 3, attack: 0.005, release: 0.15 })
  const makeup = new GainNode(ctx, { gain: 1.25 })
  node.connect(hp).connect(mud).connect(presence).connect(comp).connect(makeup).connect(ctx.destination)
  node.start()
  return ctx.startRendering()
}

const processed = new Map<string, Promise<AudioBuffer>>()

/** The buffer a region actually plays: its source with reverse / pitch / clean-up applied (cached). */
export function regionBuffer(r: Pick<StudioRegion, 'url' | 'reverse' | 'pitch' | 'cleanup'>): Promise<AudioBuffer> {
  if (!r.reverse && !r.pitch && !r.cleanup) return loadSource(r.url)
  const key = `${r.url}|${r.reverse ? 'r' : ''}|${r.pitch}|${r.cleanup ? 'c' : ''}`
  let job = processed.get(key)
  if (!job) {
    job = (async () => {
      let b = await loadSource(r.url)
      if (r.cleanup) b = await vocalCleanup(b)
      if (r.pitch) b = pitchShift(b, r.pitch)
      if (r.reverse) b = reverseBuffer(b)
      return b
    })()
    job.catch(() => processed.delete(key))
    processed.set(key, job)
  }
  return job
}

/** Where a region starts reading in its (possibly reversed) buffer. */
export const bufferOffset = (r: StudioRegion, buffer: AudioBuffer) => (r.reverse ? Math.max(0, buffer.duration - r.offset - r.duration) : r.offset)

/* ---------- peaks (waveform drawing) ---------- */

export const PEAK_RESOLUTION = 256 // samples per peak
const peakCache = new WeakMap<AudioBuffer, Float32Array>()

/** Min/max pairs every PEAK_RESOLUTION samples, all channels combined. */
export function peaksOf(buffer: AudioBuffer): Float32Array {
  const hit = peakCache.get(buffer)
  if (hit) return hit
  const count = Math.ceil(buffer.length / PEAK_RESOLUTION)
  const peaks = new Float32Array(count * 2)
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c))
  for (let p = 0; p < count; p++) {
    let lo = 0
    let hi = 0
    const end = Math.min(buffer.length, (p + 1) * PEAK_RESOLUTION)
    for (const data of channels)
      for (let i = p * PEAK_RESOLUTION; i < end; i++) {
        const v = data[i]
        if (v < lo) lo = v
        else if (v > hi) hi = v
      }
    peaks[p * 2] = lo
    peaks[p * 2 + 1] = hi
  }
  peakCache.set(buffer, peaks)
  return peaks
}

/* ---------- WAV ---------- */

/** Interleaved PCM WAV, 16- or 24-bit. */
export function encodeWav(buffer: AudioBuffer, bitDepth: 16 | 24 = 16): Blob {
  const channels = buffer.numberOfChannels
  const bytes = bitDepth / 8
  const dataSize = buffer.length * channels * bytes
  const out = new ArrayBuffer(44 + dataSize)
  const view = new DataView(out)
  const str = (o: number, s: string) => [...s].forEach((ch, i) => view.setUint8(o + i, ch.charCodeAt(0)))
  str(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, buffer.sampleRate, true)
  view.setUint32(28, buffer.sampleRate * channels * bytes, true)
  view.setUint16(32, channels * bytes, true)
  view.setUint16(34, bitDepth, true)
  str(36, 'data')
  view.setUint32(40, dataSize, true)
  const data = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c))
  let o = 44
  const max = bitDepth === 16 ? 0x7fff : 0x7fffff
  for (let i = 0; i < buffer.length; i++)
    for (let c = 0; c < channels; c++) {
      const v = Math.round(Math.max(-1, Math.min(1, data[c][i])) * max)
      if (bitDepth === 16) view.setInt16(o, v, true)
      else {
        view.setUint8(o, v & 0xff)
        view.setUint8(o + 1, (v >> 8) & 0xff)
        view.setUint8(o + 2, (v >> 16) & 0xff)
      }
      o += bytes
    }
  return new Blob([out], { type: 'audio/wav' })
}

/** Join buffers end to end with silences (TTS sentences and pauses). */
export function concatBuffers(parts: (AudioBuffer | { silence: number })[], sampleRate = SAMPLE_RATE, channels = 1): AudioBuffer {
  const lengths = parts.map((p) => ('silence' in p ? Math.round(p.silence * sampleRate) : Math.round((p.length * sampleRate) / p.sampleRate)))
  const out = new AudioBuffer({ numberOfChannels: channels, length: Math.max(1, lengths.reduce((a, b) => a + b, 0)), sampleRate })
  let at = 0
  parts.forEach((p, i) => {
    if (!('silence' in p)) {
      for (let c = 0; c < channels; c++) {
        const src = p.getChannelData(Math.min(c, p.numberOfChannels - 1))
        const dst = out.getChannelData(c)
        const step = p.sampleRate / sampleRate
        for (let j = 0; j < lengths[i]; j++) dst[at + j] = src[Math.min(src.length - 1, Math.floor(j * step))]
      }
    }
    at += lengths[i]
  })
  return out
}
