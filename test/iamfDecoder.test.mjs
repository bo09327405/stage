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

/* ---------- streaming: seek and head tracking ---------- */

import { iamfHeadQuaternion, IamfStreamSource, opusPreSkip } from '../src/studio/iamf/iamfStream.ts'

const readAll = (s, chunk = 1000) => {
  const out = [[], []]
  for (let r; (r = s.read(chunk)); ) {
    out[0].push(...r[0])
    out[1].push(...r[1])
  }
  return out
}

/** A copy of the FOA fixture whose audio is replaced by noise coming from one direction (azimuth left +, elevation up +). */
function noiseFrom(azDeg, elDeg) {
  const az = (azDeg * Math.PI) / 180
  const el = (elDeg * Math.PI) / 180
  const gain = [1, Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)] // ACN W, Y, Z, X
  const b = bytes('test_000083.iamf').slice()
  const leb = (p) => {
    let v = 0
    let n = 0
    for (;;) {
      const x = b[p + n]
      v += (x & 0x7f) * 2 ** (7 * n)
      n++
      if (!(x & 0x80)) return [v, n]
    }
  }
  const count = [0, 0, 0, 0]
  for (let p = 0; p < b.length; ) {
    const type = b[p] >> 3
    const [size, n] = leb(p + 1)
    const at = p + 1 + n
    if (type >= 6 && type <= 9) {
      const dv = new DataView(b.buffer, at, size)
      const ch = type - 6
      for (let i = 0; i < size / 2; i++) dv.setInt16(i * 2, Math.round(8000 * ((Math.sin((count[ch] * 64 + i) * 12.9898 + 78.233) * 43758.5453) % 1) * gain[ch]), true)
      count[ch]++
    }
    p = at + size
  }
  return b
}
const level = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length)
const ild = (ch) => 20 * Math.log10(level(ch[1]) / level(ch[0]))
const aboutZ = (deg) => {
  const h = (deg * Math.PI) / 360
  return { w: Math.cos(h), x: 0, y: 0, z: Math.sin(h) }
}

test('the stream source splits an IA stream and an MP4 into the same temporal units', () => {
  const a = IamfStreamSource.open(mod, bytes('test_000021.iamf'))
  const b = IamfStreamSource.open(mod, bytes('test_000021_s.mp4'))
  assert.equal(a.sampleRate, 48000)
  assert.ok(Math.abs(a.duration - 0.52) < 0.02, `duration ${a.duration}`)
  assert.equal(a.duration, b.duration)
  a.close()
  b.close()
})

test('reading a stream in pieces equals the one-shot decode', () => {
  const whole = decodeIamfFile(mod, bytes('test_000021.iamf'))
  const s = IamfStreamSource.open(mod, bytes('test_000021.iamf'))
  const got = readAll(s, 777)
  s.close()
  assert.equal(got[0].length, whole.channels[0].length)
  let worst = 0
  for (let i = 0; i < got[0].length; i++) worst = Math.max(worst, Math.abs(got[0][i] - whole.channels[0][i]), Math.abs(got[1][i] - whole.channels[1][i]))
  assert.ok(worst < 1e-6, `max difference ${worst}`)
})

test('seeking lands on the right sample (PCM exactly, Opus within its codec noise), looping included', () => {
  for (const [name, tolerance] of [['test_000083.iamf', 2e-3], ['test_000021.iamf', 2e-3]]) {
    const whole = readAll(IamfStreamSource.open(mod, bytes(name)))
    for (const t of [0, 0.1, 0.2, 0.31, 0.45]) {
      const s = IamfStreamSource.open(mod, bytes(name))
      s.seek(t)
      const r = s.read(1200)
      s.close()
      const at = Math.round(t * 48000)
      let err = 0
      for (let i = 0; i < r[0].length; i++) err = Math.max(err, Math.abs(r[0][i] - whole[0][at + i]))
      assert.ok(err < tolerance, `${name} seek ${t}: max difference ${err}`)
    }
  }
  const s = IamfStreamSource.open(mod, bytes('test_000021.iamf'))
  s.seek(0.2)
  s.read(500)
  s.seek(0.05) // back, as a loop does
  assert.equal(s.positionSamples(), Math.round(0.05 * 48000))
  assert.ok(s.read(1000)[0].length === 1000)
  s.close()
})

test('the Opus pre-skip is read from the codec config', () => {
  const b = bytes('test_000021.iamf')
  const d = new IamfDecoder(mod)
  const used = d.configure(b)
  d.close()
  assert.equal(opusPreSkip(b.subarray(0, used)), 312)
  assert.equal(opusPreSkip(bytes('test_000083.iamf')), 0)
})

test('head tracking: turning the head left moves a front source to the right ear, and the reverse', () => {
  const front = noiseFrom(0, 0)
  const render = (m) => {
    const s = IamfStreamSource.open(mod, front)
    s.setHead(iamfHeadQuaternion(m))
    const out = readAll(s)
    s.close()
    return ild(out)
  }
  // stage frame: x right, y up, z back (front is −z). Rotation about +y by θ turns the head left by θ.
  const yaw = (deg) => {
    const c = Math.cos((deg * Math.PI) / 180)
    const s = Math.sin((deg * Math.PI) / 180)
    return [c, 0, -s, 0, 1, 0, s, 0, c] // column-major
  }
  const straight = render(yaw(0))
  const left = render(yaw(90))
  const right = render(yaw(-90))
  assert.ok(Math.abs(straight) < 3, `a source straight ahead is centred (${straight.toFixed(1)} dB)`)
  assert.ok(left > straight + 4, `head turned left: source on the right (${left.toFixed(1)} dB)`)
  assert.ok(right < straight - 4, `head turned right: source on the left (${right.toFixed(1)} dB)`)
})

test('head tracking: tilting the head up puts a front source below, and an up source moves with a roll', () => {
  const up = noiseFrom(0, 90)
  const render = (m) => {
    const s = IamfStreamSource.open(mod, up)
    s.setHead(iamfHeadQuaternion(m))
    const out = readAll(s)
    s.close()
    return ild(out)
  }
  // roll the head 90° to the right shoulder (rotation about −z in the stage frame): a source overhead lands on the left
  const roll = (deg) => {
    const c = Math.cos((deg * Math.PI) / 180)
    const s = Math.sin((deg * Math.PI) / 180)
    return [c, s, 0, -s, c, 0, 0, 0, 1]
  }
  const level0 = render(roll(0))
  const rolledRight = render(roll(-90))
  const rolledLeft = render(roll(90))
  assert.ok(Math.abs(level0) < 3, `overhead is centred (${level0.toFixed(1)})`)
  assert.ok(rolledRight < level0 - 4 && rolledLeft > level0 + 4, `roll: right ${rolledRight.toFixed(1)} · left ${rolledLeft.toFixed(1)}`)
  void aboutZ
})

test('the quaternion of the identity matrix is the identity; a 90° yaw about +y becomes a 90° turn about IAMF\'s up axis', () => {
  const id = iamfHeadQuaternion([1, 0, 0, 0, 1, 0, 0, 0, 1])
  assert.deepEqual([id.w, id.x, id.y, id.z].map((v) => Math.round(v * 1e6) / 1e6 + 0), [1, 0, 0, 0])
  const q = iamfHeadQuaternion([0, 0, -1, 0, 1, 0, 1, 0, 0])
  assert.deepEqual([q.w, q.x, q.y, q.z].map((v) => Math.round(v * 1e4) / 1e4 + 0), [0.7071, 0, 0, 0.7071])
})

/* ---------- the live session (what the Worker runs) ---------- */

import { LiveSession } from '../src/studio/iamf/iamfLiveSession.ts'

/** Run a session the way the worklet drives it: report the played position every 20 ms of audio, collect the chunks. */
function runSession(name, play, seconds, opts = { soundSystem: 0 }) {
  const source = IamfStreamSource.open(mod, bytes(name), opts)
  const chunks = []
  let end = null
  // like the Worker's postMessage with a transfer list, sending empties the chunk's arrays: keep a copy
  const session = new LiveSession(source, (c) => chunks.push({ ...c, l: structuredClone(c.l, { transfer: [c.l.buffer] }), r: structuredClone(c.r, { transfer: [c.r.buffer] }) }), (e) => (end = e))
  const [epoch, pos, loop] = play
  session.play(epoch, pos, loop)
  const frames = Math.round(seconds * 48000)
  for (let played = 0; played < frames; played += 960) session.fill(played)
  source.close()
  const out = new Float32Array(frames)
  const have = new Uint8Array(frames)
  for (const c of chunks) for (let i = 0; i < c.l.length && c.n0 + i < frames; i++) {
      out[c.n0 + i] = c.l[i]
      have[c.n0 + i] = 1
    }
  return { out, have, chunks, end }
}

test('a live session streams the sound from the start position, in order and without gaps', () => {
  const whole = readAll(IamfStreamSource.open(mod, bytes('test_000021.iamf'), { soundSystem: 0 }))
  const { out, have, chunks } = runSession('test_000021.iamf', [3, 0.1, null], 0.3)
  assert.ok(chunks.every((c) => c.epoch === 3))
  assert.ok(have.every((h) => h === 1), 'every frame is delivered')
  const at = Math.round(0.1 * 48000)
  let err = 0
  for (let i = 0; i < out.length; i++) err = Math.max(err, Math.abs(out[i] - whole[0][at + i]))
  assert.ok(err < 2e-3, `max difference ${err}`)
})

test('a live session loops inside the given region, on the sample, and stays ahead of the player', () => {
  const whole = readAll(IamfStreamSource.open(mod, bytes('test_000021.iamf'), { soundSystem: 0 }))
  const ls = Math.round(0.1 * 48000)
  const le = Math.round(0.25 * 48000)
  const { out, have } = runSession('test_000021.iamf', [1, 0.2, { start: 0.1, end: 0.25 }], 0.9)
  assert.ok(have.every((h) => h === 1))
  let err = 0
  for (let n = 0; n < out.length; n++) {
    const m = ls + ((Math.round(0.2 * 48000) - ls + n) % (le - ls))
    err = Math.max(err, Math.abs(out[n] - whole[0][m]))
  }
  assert.ok(err < 2e-3, `max difference ${err}`)
})

test('a live session without a loop ends where the stream ends', () => {
  const { end, have } = runSession('test_000021.iamf', [2, 0.3, null], 0.6)
  assert.ok(end && end.epoch === 2 && end.at > 0.15 * 48000 && end.at < 0.3 * 48000, `ended at ${end?.at}`)
  assert.equal(have[Math.round(0.4 * 48000)], 0)
})

test('a player that is behind the clock skips ahead instead of replaying late audio', () => {
  const source = IamfStreamSource.open(mod, bytes('test_000021.iamf'), { soundSystem: 0 })
  const chunks = []
  const s = new LiveSession(source, (c) => chunks.push(c), () => {})
  s.play(1, 0, null)
  const first = chunks.length
  s.fill(20000) // the worklet reports it is already 20000 frames in
  source.close()
  assert.ok(chunks.length > first)
  assert.ok(chunks[first].n0 >= 20000, `the next chunk starts at ${chunks[first].n0}`)
})

test('head rotation set on a live session changes what is rendered from then on', () => {
  const render = (rotate) => {
    const source = IamfStreamSource.open(mod, noiseFrom(0, 0))
    const out = []
    const s = new LiveSession(source, (c) => out.push(c), () => {})
    s.setHead(rotate ? iamfHeadQuaternion([0, 0, -1, 0, 1, 0, 1, 0, 0]) : null)
    s.play(1, 0, null)
    for (let played = 0; played < 12000; played += 960) s.fill(played)
    source.close()
    const l = out.flatMap((c) => [...c.l])
    const r = out.flatMap((c) => [...c.r])
    return 20 * Math.log10(level(r) / level(l))
  }
  assert.ok(render(true) > render(false) + 4)
})
