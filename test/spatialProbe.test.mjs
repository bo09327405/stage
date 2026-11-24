import test from 'node:test'
import assert from 'node:assert/strict'
import { parseIamfConfig, parseIamfStream, probeSpatialBytes } from '../src/studio/spatialProbe.ts'

/* ---- tiny builders ---- */
const bytes = (...parts) => Uint8Array.from(parts.flatMap((p) => (typeof p === 'number' ? [p] : [...p])))
const ascii = (s) => [...s].map((c) => c.charCodeAt(0))
const leb = (n) => { const out = []; do { let b = n & 0x7f; n = Math.floor(n / 128); if (n) b |= 0x80; out.push(b) } while (n); return out }
const cstr = (s) => [...new TextEncoder().encode(s), 0]
const u16be = (n) => [(n >> 8) & 255, n & 255]
const u32be = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
const u16le = (n) => [n & 255, (n >> 8) & 255]
const u32le = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]
const obu = (type, payload, flags = 0) => [(type << 3) | flags, ...leb(payload.length), ...payload]

const seqHeader = obu(31, [...ascii('iamf'), 1, 1])
const opusConfig = obu(0, [...leb(200), ...ascii('Opus'), ...leb(960), ...u16be(-4 & 0xffff), 0, 2, 0x38, 0x01, 0, 0, 0, 0, 0, 0, 0])
const pcmConfig = obu(0, [...leb(201), ...ascii('ipcm'), ...leb(1024), ...u16be(0), 1, 16, ...u32be(48000)])
const paramDef = [...leb(0), ...leb(48000), 0, ...leb(1024), ...leb(1024)] // parameter_id, rate, mode 0, duration, constant_subblock_duration
const sceneElement = obu(1, [...leb(10), 1 << 5, ...leb(200), ...leb(4), 0, 1, 2, 3, ...leb(0), ...leb(0), 4, 4, 0, 1, 2, 3])
const dialogueElement = obu(1, [...leb(11), 0 << 5, ...leb(201), ...leb(1), 4, ...leb(0), 1 << 5, 0x10, 1, 0])
const mixElement = (id, name, gainQ8) => [...leb(id), ...cstr(name), 0, ...leb(0), ...paramDef, ...u16be(gainQ8 & 0xffff)]
const mix = (id, label, lang, elements) =>
  obu(2, [...leb(id), ...leb(1), ...cstr(lang), ...cstr(label), ...leb(1), ...leb(elements.length), ...elements.flat(), ...paramDef, ...u16be(0), ...leb(0)])
const mixAmbience = mix(30, 'Ambience mix', 'en-us', [mixElement(10, 'Ambience', 0), mixElement(11, 'Dialogue', -3 * 256)])
const mixDialogue = mix(31, '旁白強調', 'zh-tw', [mixElement(10, 'Ambience', -6 * 256), mixElement(11, 'Dialogue', 3 * 256)])
const descriptors = [...seqHeader, ...opusConfig, ...pcmConfig, ...sceneElement, ...dialogueElement, ...mixAmbience, ...mixDialogue]
const unit = (n) => [...obu(4, []), ...obu(6, [n, n, n]), ...obu(7, [n]), ...obu(8, [n]), ...obu(9, [n])]

test('IAMF stream: profile, codecs, elements, mix presentations with named elements and gains', () => {
  const stream = bytes(descriptors, Array.from({ length: 100 }, (_, i) => unit(i)).flat())
  const r = parseIamfStream(stream)
  assert.ok(r)
  const { info } = r
  assert.equal(info.primaryProfile, 1)
  assert.deepEqual(info.codecs, ['Opus', 'ipcm'])
  assert.equal(info.elements.length, 2)
  assert.deepEqual(info.elements.map((e) => [e.id, e.type, e.name, e.channels ?? null]), [[10, 'scene_based', 'Ambience', 4], [11, 'channel_based', 'Dialogue', null]])
  assert.equal(info.mixes.length, 2)
  assert.equal(info.mixes[0].id, 30)
  assert.equal(info.mixes[0].label, 'Ambience mix')
  assert.equal(info.mixes[0].language, 'en-us')
  assert.deepEqual(info.mixes[0].elements.map((e) => [e.id, e.name, e.defaultGainDb]), [[10, 'Ambience', 0], [11, 'Dialogue', -3]])
  assert.equal(info.mixes[1].label, '旁白強調')
  assert.deepEqual(info.mixes[1].elements.map((e) => e.defaultGainDb), [-6, 3])
  // 100 temporal units × 960 samples at 48 kHz (the first codec config is Opus)
  assert.ok(Math.abs(info.durationSec - 2) < 1e-9)
})

test('IAMF stream: frames without temporal delimiters are counted by the first substream', () => {
  const stream = bytes(seqHeader, opusConfig, sceneElement, mixAmbience, Array.from({ length: 50 }, (_, i) => [...obu(6, [i]), ...obu(7, [i])]).flat())
  assert.ok(Math.abs(parseIamfStream(stream).info.durationSec - 1) < 1e-9)
})

test('IAMF: not an IAMF stream → null; truncated descriptors keep what was read', () => {
  assert.equal(parseIamfStream(bytes(obu(31, [...ascii('xxxx'), 1, 1]))), null)
  assert.equal(parseIamfStream(bytes([0x00, 0x01, 0x02])), null)
  const cut = bytes(seqHeader, opusConfig, sceneElement, mixAmbience.slice(0, mixAmbience.length - 14))
  const r = parseIamfStream(cut)
  assert.ok(r === null || r.info.elements.length === 1)
})

test('IAMF: an OBU with an extension header and one with trim fields are skipped properly', () => {
  const withExt = [(0 << 3) | 1, ...leb(opusConfig.length - 2 + 2), 1, 0xaa, ...opusConfig.slice(2)] // extension_header_size 1, one byte
  const stream = bytes(seqHeader, withExt, sceneElement, mixAmbience)
  const r = parseIamfStream(stream)
  assert.deepEqual(r.info.codecs, ['Opus'])
  assert.equal(r.info.elements.length, 1)
  assert.equal(r.info.mixes[0].elements.length, 2)
})

/* ---- ISOBMFF ---- */
const box = (type, ...payload) => { const body = payload.flat(); return [...u32be(8 + body.length), ...ascii(type), ...body] }
const full = (type, ...payload) => box(type, 0, 0, 0, 0, ...payload)
function mp4(entry, { timescale = 48000, duration = 96000, brand = 'iso6' } = {}) {
  const mdhd = full('mdhd', ...u32be(0), ...u32be(0), ...u32be(timescale), ...u32be(duration), ...u16be(0), ...u16be(0))
  const hdlr = full('hdlr', ...u32be(0), ...ascii('soun'), ...new Array(12).fill(0), 0)
  const stsd = full('stsd', ...u32be(1), ...entry)
  const trak = box('trak', box('mdia', mdhd, hdlr, box('minf', box('stbl', stsd))))
  return bytes(box('ftyp', ascii('iso6'), u32be(0), ascii(brand)), box('moov', trak), box('mdat', [1, 2, 3, 4]))
}
const audioEntry = (type, channels, rate, ...children) =>
  box(type, new Array(6).fill(0), u16be(1), new Array(8).fill(0), u16be(channels), u16be(16), u16be(0), u16be(0), u32be(rate << 16), ...children)

test('MP4 with an iamf sample entry: descriptors from the iacb box, duration from mdhd', () => {
  const config = bytes(seqHeader, opusConfig, sceneElement, dialogueElement, mixAmbience)
  const iacb = box('iacb', 1, leb(config.length), [...config])
  const p = probeSpatialBytes(mp4(audioEntry('iamf', 0, 0, iacb), { brand: 'iamf' }))
  assert.equal(p.container, 'mp4')
  assert.equal(p.codec, 'iamf')
  assert.equal(p.suggestedFormat, 'eclipsa_iamf')
  assert.equal(p.iamf.mixes[0].id, 30)
  assert.equal(p.iamf.elements.length, 2)
  assert.equal(p.durationSec, 2)
  assert.equal(p.iamf.durationSec, 2)
})

test('MP4 / M4A with 4 channels: Ambisonics is assumed (not certain)', () => {
  const p = probeSpatialBytes(mp4(audioEntry('mp4a', 4, 48000)))
  assert.equal(p.channels, 4)
  assert.equal(p.sampleRate, 48000)
  assert.equal(p.suggestedFormat, 'ambisonics')
  assert.equal(p.ambisonics.certain, false)
  assert.equal(probeSpatialBytes(mp4(audioEntry('mp4a', 2, 44100))).suggestedFormat, 'standard')
})

/* ---- WAV / Ogg / FLAC ---- */
function wav({ channels, rate = 48000, bits = 16, seconds = 2, extensible = null }) {
  const blockAlign = (channels * bits) / 8
  const fmt = extensible
    ? [...u16le(0xfffe), ...u16le(channels), ...u32le(rate), ...u32le(rate * blockAlign), ...u16le(blockAlign), ...u16le(bits), ...u16le(22), ...u16le(bits), ...u32le(0), ...extensible]
    : [...u16le(1), ...u16le(channels), ...u32le(rate), ...u32le(rate * blockAlign), ...u16le(blockAlign), ...u16le(bits)]
  const dataLen = rate * seconds * blockAlign
  return bytes(ascii('RIFF'), u32le(36 + dataLen), ascii('WAVE'), ascii('fmt '), u32le(fmt.length), fmt, ascii('data'), u32le(dataLen), new Array(16).fill(0))
}
const bFormatGuid = (kind) => [kind, 0, 0, 0, 0x21, 0x07, 0xd3, 0x11, 0x86, 0x44, 0xc8, 0xc1, 0xca, 0, 0, 0]

test('WAV: 4 / 9 / 16 channels are Ambisonics orders 1–3 (AmbiX assumed); stereo is standard', () => {
  for (const [ch, order] of [[4, 1], [9, 2], [16, 3]]) {
    const p = probeSpatialBytes(wav({ channels: ch }))
    assert.equal(p.container, 'wav')
    assert.equal(p.channels, ch)
    assert.equal(p.ambisonics.order, order)
    assert.equal(p.ambisonics.channelLayout, 'ACN_SN3D')
    assert.equal(p.suggestedFormat, 'ambisonics')
    assert.equal(p.durationSec, 2)
  }
  const st = probeSpatialBytes(wav({ channels: 2 }))
  assert.equal(st.suggestedFormat, 'standard')
  assert.equal(st.ambisonics, null)
})

test('WAV with the Ambisonic B-format GUID is Furse-Malham', () => {
  const p = probeSpatialBytes(wav({ channels: 4, extensible: bFormatGuid(1) }))
  assert.equal(p.ambisonics.channelLayout, 'FUMA')
  assert.equal(p.ambisonics.certain, true)
  const fl = probeSpatialBytes(wav({ channels: 4, bits: 32, extensible: bFormatGuid(3) }))
  assert.equal(fl.ambisonics.channelLayout, 'FUMA')
  // an extensible WAV with another GUID (plain PCM) stays AmbiX
  const pcm = probeSpatialBytes(wav({ channels: 4, extensible: [1, 0, 0, 0, 0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71] }))
  assert.equal(pcm.ambisonics.channelLayout, 'ACN_SN3D')
})

const oggPage = (packet) => bytes(ascii('OggS'), 0, 2, new Array(20).fill(0), 1, packet.length, packet)
test('Ogg Opus: ambisonic mapping families are flagged; Vorbis channel count is read', () => {
  const head = (ch, family) => [...ascii('OpusHead'), 1, ch, ...u16le(312), ...u32le(48000), ...u16le(0), family, ...(family === 3 ? [1, 3, 0, 1, 2, 3] : [])]
  const amb = probeSpatialBytes(oggPage(head(4, 3)))
  assert.equal(amb.codec, 'opus')
  assert.equal(amb.channels, 4)
  assert.equal(amb.suggestedFormat, 'ambisonics')
  assert.ok(amb.notes.some((n) => /family 3/.test(n)))
  assert.equal(probeSpatialBytes(oggPage(head(2, 0))).suggestedFormat, 'standard')
  const vorbis = probeSpatialBytes(oggPage([1, ...ascii('vorbis'), ...u32le(0), 4, ...u32le(48000)]))
  assert.equal(vorbis.codec, 'vorbis')
  assert.equal(vorbis.channels, 4)
  assert.equal(vorbis.sampleRate, 48000)
})

test('FLAC STREAMINFO: channels, rate, duration', () => {
  const info = new Array(34).fill(0)
  const rate = 48000, ch = 4, bps = 24, total = 96000
  const packed = (BigInt(rate) << 44n) | (BigInt(ch - 1) << 41n) | (BigInt(bps - 1) << 36n) | BigInt(total)
  for (let i = 0; i < 8; i++) info[10 + i] = Number((packed >> BigInt(56 - 8 * i)) & 0xffn)
  const p = probeSpatialBytes(bytes(ascii('fLaC'), 0x80, 0, 0, 34, info))
  assert.equal(p.container, 'flac')
  assert.equal(p.channels, 4)
  assert.equal(p.sampleRate, 48000)
  assert.equal(p.durationSec, 2)
})

test('unknown data gets a note, not an exception', () => {
  const p = probeSpatialBytes(new Uint8Array(64).fill(7))
  assert.equal(p.container, 'unknown')
  assert.equal(p.suggestedFormat, 'standard')
  assert.ok(p.notes.length > 0)
  assert.equal(parseIamfConfig(new Uint8Array(0)), null)
})
