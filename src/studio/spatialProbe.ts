import {
  ambisonicOrderOf,
  type AmbisonicLayout,
  type AmbisonicOrder,
  type IamfElementInfo,
  type IamfMixInfo,
  type IamfSourceInfo,
  type SpatialFormat,
} from '../types/spatialAudio.ts'

/*
 * Reading what a spatial audio file is, from its header alone (no decoding): channel count, whether it is an
 * Ambisonics WAV (AmbiX or Furse-Malham), and — for Eclipsa Audio — the IAMF descriptors: profile, codec,
 * audio elements and the mix presentations with their element names. Works on a Uint8Array, so it runs in the
 * browser (on an upload, or on a few megabytes fetched from R2) and in node's test runner.
 *
 * IAMF syntax: AOMedia IAMF specification (OBU header, Sequence Header, Codec Config, Audio Element, Mix Presentation;
 * ISOBMFF binding 'iamf' / 'iacb'). Anything unexpected makes a parser stop and keep what it already has.
 */

export type Container = 'wav' | 'ogg' | 'flac' | 'mp4' | 'iamf' | 'unknown'

export interface SpatialProbe {
  container: Container
  codec: string
  channels: number | null
  sampleRate: number | null
  durationSec: number | null
  ambisonics: { order: AmbisonicOrder; channelLayout: AmbisonicLayout; /** false = guessed from the channel count alone */ certain: boolean } | null
  iamf: IamfSourceInfo | null
  suggestedFormat: SpatialFormat
  /** What the designer should know before using the file (cannot be decoded here, layout is a guess…). */
  notes: string[]
}

const emptyProbe = (): SpatialProbe => ({ container: 'unknown', codec: '', channels: null, sampleRate: null, durationSec: null, ambisonics: null, iamf: null, suggestedFormat: 'standard', notes: [] })

const ascii = (b: Uint8Array, at: number, len: number) => String.fromCharCode(...b.subarray(at, at + len))
const u16le = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8)
const u32le = (b: Uint8Array, at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0
const u16be = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1]
const u32be = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0
const i16be = (b: Uint8Array, at: number) => (u16be(b, at) << 16) >> 16

/* ---------- IAMF ---------- */

class Reader {
  b: Uint8Array
  p: number
  end: number
  constructor(b: Uint8Array, p = 0, end = b.length) {
    this.b = b
    this.p = p
    this.end = end
  }
  get left() {
    return this.end - this.p
  }
  u8() {
    if (this.p >= this.end) throw new RangeError('end of data')
    return this.b[this.p++]
  }
  u32() {
    if (this.p + 4 > this.end) throw new RangeError('end of data')
    const v = u32be(this.b, this.p)
    this.p += 4
    return v
  }
  i16() {
    if (this.p + 2 > this.end) throw new RangeError('end of data')
    const v = i16be(this.b, this.p)
    this.p += 2
    return v
  }
  /** Unsigned LEB128 (at most 8 bytes). */
  leb() {
    let v = 0
    for (let i = 0; i < 8; i++) {
      const byte = this.u8()
      v += (byte & 0x7f) * 2 ** (7 * i)
      if (!(byte & 0x80)) return v
    }
    throw new RangeError('bad leb128')
  }
  /** Null-terminated UTF-8 string. */
  str() {
    const start = this.p
    while (this.p < this.end && this.b[this.p] !== 0) this.p++
    if (this.p >= this.end) throw new RangeError('unterminated string')
    const s = new TextDecoder().decode(this.b.subarray(start, this.p))
    this.p++
    return s
  }
  skip(n: number) {
    if (n < 0 || this.p + n > this.end) throw new RangeError('skip past end')
    this.p += n
  }
}

const OBU = { CODEC_CONFIG: 0, AUDIO_ELEMENT: 1, MIX_PRESENTATION: 2, TEMPORAL_DELIMITER: 4, FRAME_FIRST: 5, FRAME_LAST: 23, FRAME_ID0: 6, SEQUENCE_HEADER: 31 }

/** ParamDefinition (parameter id, rate, and the timing it carries when it is defined in the OBU itself). */
function skipParamDefinition(r: Reader) {
  r.leb() // parameter_id
  r.leb() // parameter_rate
  const mode = r.u8() >> 7 // param_definition_mode (1 bit) + 7 reserved
  if (mode === 0) {
    r.leb() // duration
    const constant = r.leb() // constant_subblock_duration
    if (constant === 0) {
      const n = r.leb() // num_subblocks
      if (n > 4096) throw new RangeError('implausible subblock count')
      for (let i = 0; i < n; i++) r.leb()
    }
  }
}

interface CodecInfo {
  id: number
  codec: string
  samplesPerFrame: number
  sampleRate: number | null
}

function parseCodecConfig(r: Reader): CodecInfo {
  const id = r.leb()
  const codec = String.fromCharCode(r.u8(), r.u8(), r.u8(), r.u8())
  const samplesPerFrame = r.leb()
  r.i16() // audio_roll_distance
  let sampleRate: number | null = null
  if (codec === 'ipcm') {
    r.u8() // sample_format_flags
    r.u8() // sample_size
    sampleRate = r.u32()
  } else if (codec === 'Opus') sampleRate = 48000
  return { id, codec, samplesPerFrame, sampleRate }
}

function parseAudioElement(r: Reader): IamfElementInfo {
  const id = r.leb()
  const typeBits = r.u8() >> 5
  const codecConfigId = r.leb()
  const substreams = r.leb()
  if (substreams > 255) throw new RangeError('implausible substream count')
  for (let i = 0; i < substreams; i++) r.leb()
  const type: IamfElementInfo['type'] = typeBits === 0 ? 'channel_based' : typeBits === 1 ? 'scene_based' : typeBits === 2 ? 'object_based' : 'unknown'
  const el: IamfElementInfo = { id, type, name: '', codecConfigId, substreams }
  try {
    const numParams = r.leb()
    for (let i = 0; i < numParams; i++) {
      const t = r.leb()
      if (t === 1) {
        skipParamDefinition(r) // demixing
        r.u8() // default_w (4) + reserved (4)
      } else if (t === 2) skipParamDefinition(r) // recon gain
      else r.skip(r.leb()) // anything else is size-prefixed
    }
    if (type === 'scene_based') {
      const mode = r.leb() // 0 = mono (each substream one channel), 1 = projection
      el.channels = r.u8() // output_channel_count (both modes start with it)
      void mode
    }
  } catch {
    // The rest of the element (layers, channel counts) is nice to have only.
  }
  return el
}

interface RawMix {
  id: number
  labels: string[]
  languages: string[]
  elements: { id: number; names: string[]; defaultGainDb: number }[]
}

function parseMixPresentation(r: Reader): RawMix {
  const id = r.leb()
  const count = r.leb()
  if (count > 64) throw new RangeError('implausible label count')
  const languages = Array.from({ length: count }, () => r.str())
  const labels = Array.from({ length: count }, () => r.str())
  const mix: RawMix = { id, labels, languages, elements: [] }
  const subMixes = r.leb()
  try {
    if (subMixes > 0) {
      // Only the first sub-mix is read: it is the one a stereo / binaural render uses.
      const n = r.leb()
      if (n > 128) throw new RangeError('implausible element count')
      for (let j = 0; j < n; j++) {
        const elementId = r.leb()
        const names = Array.from({ length: count }, () => r.str())
        r.u8() // headphones_rendering_mode etc.
        r.skip(r.leb()) // rendering_config_extension_size bytes
        skipParamDefinition(r) // element_mix_gain
        const gain = r.i16() / 256 // default_mix_gain, Q7.8 dB
        mix.elements.push({ id: elementId, names, defaultGainDb: gain })
      }
    }
  } catch {
    // Keep the elements read so far.
  }
  return mix
}

interface IamfScan {
  info: IamfSourceInfo | null
  temporalUnits: number
  frames: number
  codec: CodecInfo | null
}

/** Walk a run of IAMF OBUs: the descriptors fill in the info, temporal units / audio frames are counted. */
function scanObus(b: Uint8Array, countTemporalUnits: boolean): IamfScan {
  const r = new Reader(b)
  let header: { primary: number; additional: number } | null = null
  const codecs: CodecInfo[] = []
  const elements: IamfElementInfo[] = []
  const mixesRaw: RawMix[] = []
  let temporalUnits = 0
  let frames = 0
  let sawAudio = false
  while (r.left >= 2) {
    const start = r.p
    let type: number
    let size: number
    let flag: number
    let ext: number
    try {
      const b0 = r.u8()
      type = b0 >> 3
      flag = (b0 >> 1) & 1
      ext = b0 & 1
      size = r.leb()
    } catch {
      break
    }
    if (size > r.left) break
    const body = new Reader(b, r.p, r.p + size)
    r.p += size
    const isFrame = type >= OBU.FRAME_FIRST && type <= OBU.FRAME_LAST
    // Audio frames may start with trim counts; any OBU may carry an extension header before its payload.
    try {
      if (isFrame && flag) {
        body.leb() // num_samples_to_trim_at_end
        body.leb() // num_samples_to_trim_at_start
      }
      if (ext) body.skip(body.leb())
    } catch {
      continue
    }
    if (type === OBU.TEMPORAL_DELIMITER) {
      temporalUnits++
      sawAudio = true
      continue
    }
    if (isFrame) {
      sawAudio = true
      if (type === OBU.FRAME_ID0) frames++
      else if (type === OBU.FRAME_FIRST) {
        try {
          if (body.leb() === 0) frames++
        } catch {
          // ignore
        }
      }
      if (!countTemporalUnits) break
      continue
    }
    if (sawAudio && !countTemporalUnits) break
    try {
      if (type === OBU.SEQUENCE_HEADER) {
        if (body.u32() !== 0x69616d66) {
          if (start === 0) return { info: null, temporalUnits: 0, frames: 0, codec: null }
          continue
        }
        header = { primary: body.u8(), additional: body.u8() }
      } else if (type === OBU.CODEC_CONFIG) codecs.push(parseCodecConfig(body))
      else if (type === OBU.AUDIO_ELEMENT) elements.push(parseAudioElement(body))
      else if (type === OBU.MIX_PRESENTATION) mixesRaw.push(parseMixPresentation(body))
    } catch {
      // A descriptor we cannot read is skipped; the rest still counts.
    }
  }
  if (!header) return { info: null, temporalUnits, frames, codec: codecs[0] ?? null }
  // Names: a mix presentation labels its elements; the first non-empty annotation names the element.
  const nameOf = new Map<number, string>()
  for (const m of mixesRaw) for (const e of m.elements) if (e.names[0] && !nameOf.has(e.id)) nameOf.set(e.id, e.names[0])
  for (const e of elements) e.name = nameOf.get(e.id) ?? ''
  const mixes: IamfMixInfo[] = mixesRaw.map((m) => ({
    id: m.id,
    label: m.labels[0] || `Mix ${m.id}`,
    language: m.languages[0] ?? '',
    elements: m.elements.map((e) => ({ id: e.id, name: e.names[0] || nameOf.get(e.id) || `Element ${e.id}`, defaultGainDb: Math.round(e.defaultGainDb * 100) / 100 })),
  }))
  const info: IamfSourceInfo = {
    primaryProfile: header.primary,
    additionalProfile: header.additional,
    codecs: [...new Set(codecs.map((c) => c.codec))],
    elements,
    mixes,
    durationSec: null,
  }
  return { info, temporalUnits, frames, codec: codecs[0] ?? null }
}

/** A standalone .iamf stream (IA Sequence): descriptors first, then temporal units. */
export function parseIamfStream(b: Uint8Array): { info: IamfSourceInfo; samplesPerFrame: number; sampleRate: number | null } | null {
  const scan = scanObus(b, true)
  if (!scan.info) return null
  const codec = scan.codec
  const units = scan.temporalUnits || scan.frames
  if (codec && codec.sampleRate && units) scan.info.durationSec = (units * codec.samplesPerFrame) / codec.sampleRate
  return { info: scan.info, samplesPerFrame: codec?.samplesPerFrame ?? 0, sampleRate: codec?.sampleRate ?? null }
}

/** The configOBUs of an ISOBMFF 'iacb' box: the same descriptor OBUs, no audio. */
export function parseIamfConfig(b: Uint8Array): IamfSourceInfo | null {
  return scanObus(b, false).info
}

/* ---------- ISOBMFF ---------- */

interface Mp4Track {
  handler: string
  timescale: number
  duration: number
  entry: string
  channels: number | null
  sampleRate: number | null
  iacb: Uint8Array | null
}

const MP4_CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl'])

function walkMp4(b: Uint8Array, start: number, end: number, cb: (type: string, at: number, size: number) => void) {
  let p = start
  while (p + 8 <= end) {
    let size = u32be(b, p)
    const type = ascii(b, p + 4, 4)
    let header = 8
    if (size === 1 && p + 16 <= end) {
      size = u32be(b, p + 8) * 2 ** 32 + u32be(b, p + 12)
      header = 16
    } else if (size === 0) size = end - p
    if (size < header || p + size > end) {
      // A box that runs past the data we have: report it truncated so callers can still look inside.
      cb(type, p + header, Math.min(end, p + Math.max(size, header)) - (p + header))
      return
    }
    cb(type, p + header, size - header)
    p += size
  }
}

/** The audio track of an MP4 / M4A (given at least its moov box). */
function parseMp4(b: Uint8Array): { tracks: Mp4Track[]; major: string; brands: string[] } {
  const tracks: Mp4Track[] = []
  let major = ''
  const brands: string[] = []
  walkMp4(b, 0, b.length, (type, at, len) => {
    if (type === 'ftyp') {
      major = ascii(b, at, 4)
      for (let i = at + 8; i + 4 <= at + len; i += 4) brands.push(ascii(b, i, 4))
    }
    if (type !== 'moov') return
    walkMp4(b, at, at + len, (t1, a1, l1) => {
      if (t1 !== 'trak') return
      const tr: Mp4Track = { handler: '', timescale: 0, duration: 0, entry: '', channels: null, sampleRate: null, iacb: null }
      const visit = (from: number, to: number) =>
        walkMp4(b, from, to, (t, a, l) => {
          if (MP4_CONTAINERS.has(t)) return visit(a, a + l)
          if (t === 'hdlr' && l >= 12) tr.handler = ascii(b, a + 8, 4)
          else if (t === 'mdhd' && l >= 20) {
            const v = b[a]
            if (v === 1 && l >= 32) {
              tr.timescale = u32be(b, a + 20)
              tr.duration = u32be(b, a + 24) * 2 ** 32 + u32be(b, a + 28)
            } else {
              tr.timescale = u32be(b, a + 12)
              tr.duration = u32be(b, a + 16)
            }
          } else if (t === 'stsd' && l >= 16) {
            const entryAt = a + 8
            const entrySize = u32be(b, entryAt)
            tr.entry = ascii(b, entryAt + 4, 4)
            // AudioSampleEntry: 8-byte box header, 6 reserved + data_reference_index, 8 reserved, channelcount, samplesize, …, samplerate (16.16)
            if (entryAt + 36 <= to) {
              tr.channels = u16be(b, entryAt + 24)
              tr.sampleRate = u32be(b, entryAt + 32) >>> 16
              if (tr.entry === 'iamf') {
                walkMp4(b, entryAt + 36, Math.min(to, entryAt + Math.max(entrySize, 36)), (ct, ca, cl) => {
                  // IAConfigurationBox: configurationVersion (8), configOBUs_size (leb128), configOBUs
                  if (ct === 'iacb' && cl >= 2) {
                    try {
                      const rr = new Reader(b, ca + 1, ca + cl)
                      const n = rr.leb()
                      tr.iacb = b.subarray(rr.p, Math.min(rr.p + n, ca + cl))
                    } catch {
                      // ignore
                    }
                  }
                })
              }
            }
          }
        })
      visit(a1, a1 + l1)
      tracks.push(tr)
    })
  })
  return { tracks, major, brands }
}

/** Byte offsets of the moov box in an MP4 (top-level scan; null when it is not within `b`). */
export function findTopLevelBox(b: Uint8Array, wanted: string): { at: number; size: number } | null {
  let p = 0
  while (p + 8 <= b.length) {
    let size = u32be(b, p)
    const type = ascii(b, p + 4, 4)
    if (size === 1 && p + 16 <= b.length) size = u32be(b, p + 8) * 2 ** 32 + u32be(b, p + 12)
    if (type === wanted) return { at: p, size: size === 0 ? b.length - p : size }
    if (size < 8) return null
    p += size
  }
  return null
}

/* ---------- containers ---------- */

const AMBISONIC_GUID_TAIL = [0x21, 0x07, 0xd3, 0x11, 0x86, 0x44, 0xc8, 0xc1, 0xca, 0x00, 0x00, 0x00]

function probeWav(b: Uint8Array, p: SpatialProbe) {
  p.container = 'wav'
  p.codec = 'pcm'
  let at = 12
  let blockAlign = 0
  let furse = false
  while (at + 8 <= b.length) {
    const id = ascii(b, at, 4)
    const size = u32le(b, at + 4)
    if (id === 'fmt ' && at + 8 + 16 <= b.length) {
      const tag = u16le(b, at + 8)
      p.channels = u16le(b, at + 10)
      p.sampleRate = u32le(b, at + 12)
      blockAlign = u16le(b, at + 20)
      if (tag === 0xfffe && size >= 40 && at + 8 + 40 <= b.length) {
        // WAVE_FORMAT_EXTENSIBLE: the sub-format GUID says "Ambisonic B-format" (Furse-Malham) for AMBISONIC_B_FORMAT_*
        const g = b.subarray(at + 8 + 24, at + 8 + 40)
        const kind = g[0] | (g[1] << 8) | (g[2] << 16) | (g[3] << 24)
        furse = (kind === 1 || kind === 3) && AMBISONIC_GUID_TAIL.every((v, i) => g[4 + i] === v)
      }
    } else if (id === 'data') {
      if (blockAlign && p.sampleRate && size < 0xfffffff0) p.durationSec = size / blockAlign / p.sampleRate
      break
    }
    at += 8 + size + (size & 1)
  }
  if (p.channels === null) p.notes.push('WAV 檔頭找不到 fmt 區塊')
  const order = p.channels ? ambisonicOrderOf(p.channels) : null
  if (order) {
    p.ambisonics = { order, channelLayout: furse && order === 1 ? 'FUMA' : 'ACN_SN3D', certain: furse }
    p.suggestedFormat = 'ambisonics'
    if (!furse) p.notes.push(`${p.channels} 聲道：假設是 AmbiX（ACN / SN3D）Ambisonics；若其實是環繞聲道，請維持「一般」`)
    if (furse) p.notes.push('檔頭標示為 Ambisonic B-format（Furse-Malham），播放時會自動轉為 AmbiX')
  }
}

function probeOgg(b: Uint8Array, p: SpatialProbe) {
  p.container = 'ogg'
  if (b.length < 27) return
  const segs = b[26]
  const at = 27 + segs
  if (ascii(b, at, 8) === 'OpusHead') {
    p.codec = 'opus'
    p.channels = b[at + 9]
    p.sampleRate = 48000
    const family = b[at + 18]
    if (family === 2 || family === 3) {
      const order = ambisonicOrderOf(p.channels ?? 0)
      p.notes.push(`Opus 聲道對應 family ${family}（Ambisonics）；多數瀏覽器無法解碼，建議轉成多聲道 WAV 後再上傳`)
      if (order) {
        p.ambisonics = { order, channelLayout: 'ACN_SN3D', certain: true }
        p.suggestedFormat = 'ambisonics'
      }
    } else if (p.channels && ambisonicOrderOf(p.channels)) {
      p.ambisonics = { order: ambisonicOrderOf(p.channels)!, channelLayout: 'ACN_SN3D', certain: false }
      p.suggestedFormat = 'ambisonics'
      p.notes.push(`${p.channels} 聲道 Opus：假設是 AmbiX Ambisonics`)
    }
  } else if (b[at] === 1 && ascii(b, at + 1, 6) === 'vorbis') {
    p.codec = 'vorbis'
    p.channels = b[at + 11]
    p.sampleRate = u32le(b, at + 12)
    const order = p.channels ? ambisonicOrderOf(p.channels) : null
    if (order) {
      p.ambisonics = { order, channelLayout: 'ACN_SN3D', certain: false }
      p.suggestedFormat = 'ambisonics'
      p.notes.push(`${p.channels} 聲道 Ogg Vorbis：假設是 AmbiX（ACN / SN3D）Ambisonics`)
    }
  }
}

function probeFlac(b: Uint8Array, p: SpatialProbe) {
  p.container = 'flac'
  p.codec = 'flac'
  if (b.length >= 26) {
    p.sampleRate = (b[18] << 12) | (b[19] << 4) | (b[20] >> 4)
    p.channels = ((b[20] >> 1) & 7) + 1
    const total = (b[21] & 0xf) * 2 ** 32 + u32be(b, 22)
    if (total && p.sampleRate) p.durationSec = total / p.sampleRate
  }
}

function probeMp4(b: Uint8Array, p: SpatialProbe) {
  p.container = 'mp4'
  const { tracks, brands, major } = parseMp4(b)
  const audio = tracks.find((t) => t.handler === 'soun') ?? tracks[0]
  if (!audio) {
    p.notes.push('找不到音訊軌（moov 不在讀取範圍內？）')
    return
  }
  p.codec = audio.entry
  if (audio.timescale && audio.duration) p.durationSec = audio.duration / audio.timescale
  if (audio.entry === 'iamf' || brands.includes('iamf') || major === 'iamf') {
    p.codec = 'iamf'
    p.iamf = audio.iacb ? parseIamfConfig(audio.iacb) : null
    p.suggestedFormat = 'eclipsa_iamf'
    if (p.iamf && p.durationSec) p.iamf.durationSec = p.durationSec
    if (!p.iamf) p.notes.push('偵測到 IAMF 軌，但讀不到描述資料（iacb）')
    return
  }
  p.channels = audio.channels
  p.sampleRate = audio.sampleRate
  const order = audio.channels ? ambisonicOrderOf(audio.channels) : null
  if (order) {
    p.ambisonics = { order, channelLayout: 'ACN_SN3D', certain: false }
    p.suggestedFormat = 'ambisonics'
    p.notes.push(`${audio.channels} 聲道 ${audio.entry}：假設是 AmbiX Ambisonics`)
  }
}

/** What a file is, from the first bytes (and, for an MP4, its moov box: pass `moov` when it was not at the front). */
export function probeSpatialBytes(head: Uint8Array, opts: { moov?: Uint8Array } = {}): SpatialProbe {
  const p = emptyProbe()
  if (head.length < 12) {
    p.notes.push('檔案太小，無法判斷')
    return p
  }
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'WAVE') probeWav(head, p)
  else if (ascii(head, 0, 4) === 'OggS') probeOgg(head, p)
  else if (ascii(head, 0, 4) === 'fLaC') probeFlac(head, p)
  else if (ascii(head, 4, 4) === 'ftyp') probeMp4(opts.moov ? concat(head.subarray(0, findTopLevelBox(head, 'ftyp')?.size ?? 0), opts.moov) : head, p)
  else if ((head[0] === 0xf8 || head[0] === 0xfc) && head.length > 8) {
    const parsed = parseIamfStream(head)
    if (parsed) {
      p.container = 'iamf'
      p.codec = 'iamf'
      p.iamf = parsed.info
      p.durationSec = parsed.info.durationSec
      p.suggestedFormat = 'eclipsa_iamf'
    }
  }
  if (p.container === 'unknown') p.notes.push('無法辨識的檔案格式（支援 WAV / Ogg / FLAC / MP4 / M4A / IAMF）')
  return p
}

function concat(a: Uint8Array, b: Uint8Array) {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

const HEAD_BYTES = 4 * 1024 * 1024

/**
 * Probe a file or any Blob: reads the first few megabytes, and — for an MP4 whose moov box sits after the media —
 * the moov box itself.
 */
export async function probeSpatialBlob(blob: Blob): Promise<SpatialProbe> {
  const head = new Uint8Array(await blob.slice(0, HEAD_BYTES).arrayBuffer())
  if (head.length >= 12 && ascii(head, 4, 4) === 'ftyp' && !findTopLevelBox(head, 'moov')) {
    // Walk the top-level boxes with small reads until the moov is found.
    let at = 0
    while (at + 16 <= blob.size) {
      const h = new Uint8Array(await blob.slice(at, at + 16).arrayBuffer())
      let size = u32be(h, 0)
      if (size === 1) size = u32be(h, 8) * 2 ** 32 + u32be(h, 12)
      if (size === 0) size = blob.size - at
      if (ascii(h, 4, 4) === 'moov') {
        const moov = new Uint8Array(await blob.slice(at, Math.min(blob.size, at + size)).arrayBuffer())
        return probeSpatialBytes(head, { moov })
      }
      if (size < 8) break
      at += size
    }
  }
  return probeSpatialBytes(head)
}

/**
 * Probe a file that lives at a URL (R2 / Cloudinary): fetches the first few megabytes (a Range request when the
 * server supports it) and the moov box of an MP4 where needed.
 */
export async function probeSpatialUrl(url: string, signal?: AbortSignal): Promise<SpatialProbe> {
  const res = await fetch(url, { headers: { range: `bytes=0-${HEAD_BYTES - 1}` }, signal })
  if (!res.ok && res.status !== 206) throw new Error(`無法讀取檔案（HTTP ${res.status}）`)
  const head = new Uint8Array(await res.arrayBuffer()).subarray(0, HEAD_BYTES)
  const total = Number(/\/(\d+)$/.exec(res.headers.get('content-range') ?? '')?.[1] ?? head.length)
  if (head.length >= 12 && ascii(head, 4, 4) === 'ftyp' && !findTopLevelBox(head, 'moov') && total > head.length) {
    let at = 0
    while (at + 16 <= total) {
      const r = await fetch(url, { headers: { range: `bytes=${at}-${at + 15}` }, signal })
      const h = new Uint8Array(await r.arrayBuffer())
      if (h.length < 16) break
      let size = u32be(h, 0)
      if (size === 1) size = u32be(h, 8) * 2 ** 32 + u32be(h, 12)
      if (size === 0) size = total - at
      if (ascii(h, 4, 4) === 'moov') {
        const m = await fetch(url, { headers: { range: `bytes=${at}-${Math.min(total, at + size) - 1}` }, signal })
        return probeSpatialBytes(head, { moov: new Uint8Array(await m.arrayBuffer()) })
      }
      if (size < 8) break
      at += size
    }
  }
  return probeSpatialBytes(head)
}
