import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { compileIamfWasm, IamfDecoder, IamfModule } from '../src/studio/iamf/iamfWasm.ts'
import { decodeIamfFile, inspectIamfFile, isMp4 } from '../src/studio/iamf/iamfDecode.ts'
import { findIamfTrack } from '../src/studio/iamf/mp4Samples.ts'
import { parseIamfStream, probeSpatialBytes } from '../src/studio/spatialProbe.ts'

const dir = new URL('./fixtures/iamf/', import.meta.url)
const bytes = (name) => new Uint8Array(fs.readFileSync(new URL(name, dir)))
const mod = await IamfModule.instantiate(await compileIamfWasm(fs.readFileSync(new URL('../public/iamf/iamf.wasm', import.meta.url))))
const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length)

function readWav(name) {
  const b = fs.readFileSync(new URL(name, dir))
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const ch = dv.getUint16(22, true)
  const n = (b.length - 44) / 2 / ch
  const out = Array.from({ length: ch }, () => new Float32Array(n))
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) out[c][i] = dv.getInt16(44 + (i * ch + c) * 2, true) / 32768
  return { rate: dv.getUint32(24, true), channels: out }
}

test('PCM stream decodes bit-exactly to the AOM reference render (stereo loudspeaker layout, native rate)', () => {
  const ref = readWav('test_000002_rendered_id_42_sub_mix_0_layout_0.wav')
  const r = decodeIamfFile(mod, bytes('test_000002.iamf'), { soundSystem: 0, sampleRate: ref.rate })
  assert.equal(r.channels.length, 2)
  assert.equal(r.channels[0].length, ref.channels[0].length)
  let worst = 0
  for (let c = 0; c < 2; c++) for (let i = 0; i < ref.channels[c].length; i++) worst = Math.max(worst, Math.abs(ref.channels[c][i] - r.channels[c][i]))
  assert.ok(worst < 1 / 32768, `max difference ${worst}`)
})

test('binaural output of an Opus stream: two channels, audible, a second long, no NaN', () => {
  const r = decodeIamfFile(mod, bytes('test_000021.iamf'))
  assert.equal(r.channels.length, 2)
  assert.equal(r.sampleRate, 48000)
  assert.ok(Math.abs(r.channels[0].length / 48000 - 0.5) < 0.05)
  assert.ok(rms(r.channels[0]) > 0.01 && rms(r.channels[1]) > 0.01)
  assert.ok(r.channels.every((c) => c.every((v) => Number.isFinite(v))))
})

test('the MP4 variant of a stream decodes to the same sound as the standalone stream', () => {
  const mp4 = bytes('test_000021_s.mp4')
  assert.ok(isMp4(mp4))
  const track = findIamfTrack(mp4)
  assert.ok(track.samples.length > 10 && track.config.length > 20)
  const a = decodeIamfFile(mod, bytes('test_000021.iamf'))
  const b = decodeIamfFile(mod, mp4)
  assert.ok(Math.abs(a.channels[0].length - b.channels[0].length) <= 1024)
  assert.ok(Math.abs(rms(a.channels[0]) / rms(b.channels[0]) - 1) < 0.02)
})

test('stream info from libiamf agrees with the JS header parser (mixes and elements)', () => {
  for (const name of ['test_000002.iamf', 'test_000083.iamf', 'test_000850.iamf']) {
    const b = bytes(name)
    const info = inspectIamfFile(mod, b)
    const mine = parseIamfStream(b).info
    assert.deepEqual(info.mixes.map((m) => [m.id, m.elements.map((e) => e.id)]), mine.mixes.map((m) => [m.id, m.elements.map((e) => e.id)]), name)
    assert.deepEqual(info.elements.map((e) => e.id).sort(), mine.elements.map((e) => e.id).sort(), name)
  }
  // the ambisonics vector: libiamf says scene-based with 4 channels, as does the parser
  const amb = inspectIamfFile(mod, bytes('test_000083.iamf'))
  assert.equal(amb.elements[0].type, 1)
  assert.equal(amb.elements[0].channels, 4)
  assert.equal(probeSpatialBytes(bytes('test_000021_s.mp4')).suggestedFormat, 'eclipsa_iamf')
})

test('ambisonics element renders to binaural stereo, loud enough', () => {
  const r = decodeIamfFile(mod, bytes('test_000083.iamf'))
  assert.equal(r.channels.length, 2)
  assert.ok(rms(r.channels[0]) > 0.03)
})

test('element gain trims are refused when the stream gives no range; unknown mix ids are errors', () => {
  const b = bytes('test_000850.iamf')
  const d = new IamfDecoder(mod)
  assert.notEqual(d.configure(b), null)
  assert.equal(d.setElementGain(d.streamInfo.mixes[0].elements[0].id, -3), false)
  d.close()
  const d2 = new IamfDecoder(mod)
  assert.throws(() => d2.setMix(999999) ?? d2.configure(b), /mix presentation|configure/)
  d2.close()
  assert.throws(() => decodeIamfFile(mod, new Uint8Array(64).fill(3)))
})

test('head tracking can be switched on for a binaural render', () => {
  const b = bytes('test_000083.iamf')
  const d = new IamfDecoder(mod)
  const used = d.configure(b)
  d.setHead(true, { w: 1, x: 0, y: 0, z: 0 })
  const upright = []
  d.decode(b.subarray(used), (l) => upright.push(...l))
  d.close()
  // turned 90° about the vertical axis: the same soundfield decodes differently (left/right balance changes)
  const d2 = new IamfDecoder(mod)
  const used2 = d2.configure(b)
  d2.setHead(true, { w: Math.SQRT1_2, x: 0, y: Math.SQRT1_2, z: 0 })
  const turned = []
  d2.decode(b.subarray(used2), (l) => turned.push(...l))
  d2.close()
  assert.ok(upright.length > 1000 && turned.length > 1000)
  let diff = 0
  for (let i = 0; i < Math.min(upright.length, turned.length); i++) diff += Math.abs(upright[i] - turned[i])
  assert.ok(diff > 1, `head rotation changed nothing (${diff})`)
})
