import test from 'node:test'
import assert from 'node:assert/strict'
import {
  activeMix, ambisonicOrderOf, applyMatrix3, elementGain, fieldRotation, foaEncodeGains, foaPowerToward, normalizeAmbisonics, normalizeIamf,
  resolveSpatialFormat, transpose3, wrapDeg, DEFAULT_IAMF,
} from '../src/types/spatialAudio.ts'

const close = (a, b, eps = 1e-5) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`)
const vec = (v, x, y, z) => { close(v.x, x); close(v.y, y); close(v.z, z) }

test('resolveSpatialFormat: stored wins; old records derive from the trajectory flag', () => {
  assert.equal(resolveSpatialFormat('ambisonics', true), 'ambisonics')
  assert.equal(resolveSpatialFormat(undefined, true), 'trajectory_binaural')
  assert.equal(resolveSpatialFormat(undefined, false), 'standard')
  assert.equal(resolveSpatialFormat('bogus', false), 'standard')
})

test('ambisonicOrderOf: 4 / 9 / 16 channels', () => {
  assert.equal(ambisonicOrderOf(4), 1)
  assert.equal(ambisonicOrderOf(9), 2)
  assert.equal(ambisonicOrderOf(16), 3)
  assert.equal(ambisonicOrderOf(2), null)
  assert.equal(ambisonicOrderOf(8), null)
})

test('normalizeAmbisonics: defaults to FOA, clamps, FuMa only at first order', () => {
  const d = normalizeAmbisonics(null)
  assert.equal(d.order, 1)
  assert.equal(d.channelLayout, 'ACN_SN3D')
  assert.deepEqual(d.rotationOffset, { yaw: 0, pitch: 0, roll: 0 })
  const c = normalizeAmbisonics({ order: '3', channelLayout: 'FUMA', rotationOffset: { yaw: 270, pitch: 200, roll: -190 }, bindHeadTracking: 1, busInputs: { 0: 'a', 1: '', 2: 7 } })
  assert.equal(c.order, 3)
  assert.equal(c.channelLayout, 'ACN_SN3D')
  assert.deepEqual(c.rotationOffset, { yaw: -90, pitch: 90, roll: 170 })
  assert.equal(c.bindHeadTracking, true)
  assert.deepEqual(c.busInputs, ['a'])
  assert.equal(normalizeAmbisonics({ order: 1, channelLayout: 'FUMA' }).channelLayout, 'FUMA')
  assert.equal(normalizeAmbisonics({ order: 9 }).order, 1)
})

test('normalizeIamf: gains keyed e<id>, clamped, zero dropped; source repaired; array-ish objects accepted', () => {
  const c = normalizeIamf({
    mixPresentationId: '7',
    elementGainOverrides: { e1: 99, e2: -3.04, e3: 0, bad: 5 },
    bindHeadTracking: true,
    source: { primaryProfile: 1, elements: { 0: { id: 1, type: 'scene_based', name: 'Ambience', channels: 4 }, 1: { name: 'no id' } }, mixes: { 0: { id: 7, label: '', elements: { 0: { id: 1, name: 'Ambience', defaultGainDb: 3.456 } } } } },
  })
  assert.equal(c.mixPresentationId, 7)
  assert.deepEqual(c.elementGainOverrides, { e1: 12, e2: -3 })
  assert.equal(c.source.elements.length, 1)
  assert.equal(c.source.mixes[0].label, 'Mix 7')
  assert.equal(c.source.mixes[0].elements[0].defaultGainDb, 3.46)
  assert.equal(normalizeIamf(null).mixPresentationId, null)
  assert.equal(normalizeIamf({ mixPresentationId: null }).mixPresentationId, null)
})

test('activeMix / elementGain: chosen mix else the first; default + override in dB', () => {
  const cfg = normalizeIamf({
    elementGainOverrides: { e1: 6 },
    source: { mixes: [{ id: 3, elements: [{ id: 1, defaultGainDb: -6 }] }, { id: 9, elements: [] }] },
  })
  assert.equal(activeMix(cfg).id, 3)
  assert.equal(activeMix({ ...cfg, mixPresentationId: 9 }).id, 9)
  assert.equal(activeMix(DEFAULT_IAMF), null)
  close(elementGain(cfg, cfg.source.mixes[0].elements[0]), 1) // −6 dB + 6 dB
})

test('wrapDeg', () => {
  assert.equal(wrapDeg(190), -170)
  assert.equal(wrapDeg(-180), 180)
  assert.equal(wrapDeg(360), 0)
})

test('fieldRotation: yaw turns the front to the right, pitch to up, roll lowers the right', () => {
  const front = { x: 0, y: 0, z: -1 }
  vec(applyMatrix3(fieldRotation({ yaw: 90, pitch: 0, roll: 0 }), front), 1, 0, 0)
  vec(applyMatrix3(fieldRotation({ yaw: -90, pitch: 0, roll: 0 }), front), -1, 0, 0)
  vec(applyMatrix3(fieldRotation({ yaw: 0, pitch: 90, roll: 0 }), front), 0, 1, 0)
  vec(applyMatrix3(fieldRotation({ yaw: 0, pitch: 0, roll: 90 }), { x: 1, y: 0, z: 0 }), 0, -1, 0)
  vec(applyMatrix3(fieldRotation({ yaw: 0, pitch: 0, roll: 0 }), { x: 0.3, y: -0.2, z: 0.9 }), 0.3, -0.2, 0.9)
  // the inverse undoes it
  const m = fieldRotation({ yaw: 33, pitch: 20, roll: -15 })
  const v = applyMatrix3(transpose3(m), applyMatrix3(m, { x: 0.4, y: 0.5, z: -0.7 }))
  vec(v, 0.4, 0.5, -0.7)
})

test('foaEncodeGains (AmbiX ACN: W, Y, Z, X): front, left, up', () => {
  assert.deepEqual(foaEncodeGains({ x: 0, y: 0, z: -3 }).map((g) => +g.toFixed(6)), [1, 0, 0, 1]) // front → X
  assert.deepEqual(foaEncodeGains({ x: -2, y: 0, z: 0 }).map((g) => +g.toFixed(6)), [1, 1, 0, 0]) // left → Y
  assert.deepEqual(foaEncodeGains({ x: 0, y: 5, z: 0 }).map((g) => +g.toFixed(6)), [1, 0, 1, 0]) // up → Z
  assert.deepEqual(foaEncodeGains({ x: 0, y: 0, z: 0 }), [1, 0, 0, 0])
})

test('foaPowerToward: a source in front is loudest towards the front, silent behind', () => {
  // covariance of W,Y,Z,X for a unit source straight ahead: all channels = [1,0,0,1]
  const g = foaEncodeGains({ x: 0, y: 0, z: -1 })
  const cov = new Float64Array(16)
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) cov[i * 4 + j] = g[i] * g[j]
  close(foaPowerToward(cov, { x: 0, y: 0, z: -1 }), 1)
  close(foaPowerToward(cov, { x: 0, y: 0, z: 1 }), 0)
  assert.ok(foaPowerToward(cov, { x: 1, y: 0, z: 0 }) > 0.2 && foaPowerToward(cov, { x: 1, y: 0, z: 0 }) < 0.3)
})

import { headFieldMatrix, mul3 } from '../src/types/spatialAudio.ts'
import { deviceMatrix, headingOf, lookDirection, recentre } from '../src/utils/deviceOrientation.ts'

test('mul3: identity and order (apply right matrix first)', () => {
  const I = Float32Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1)
  const yaw90 = fieldRotation({ yaw: 90, pitch: 0, roll: 0 })
  vec(applyMatrix3(mul3(I, yaw90), { x: 0, y: 0, z: -1 }), 1, 0, 0)
  // yaw 90 then pitch 90: front → right, then pitch lifts "ahead" — a right-pointing vector stays right
  const both = mul3(fieldRotation({ yaw: 0, pitch: 90, roll: 0 }), yaw90)
  vec(applyMatrix3(both, { x: 0, y: 0, z: -1 }), 1, 0, 0)
})

test('headFieldMatrix: a head turned right moves a front sound to the left; no head = the offset', () => {
  const off = { yaw: 0, pitch: 0, roll: 0 }
  const headRight = fieldRotation({ yaw: 90, pitch: 0, roll: 0 }) // looking 90° to the right
  vec(applyMatrix3(headFieldMatrix(headRight, off), { x: 0, y: 0, z: -1 }), -1, 0, 0)
  vec(applyMatrix3(headFieldMatrix(null, { yaw: 90, pitch: 0, roll: 0 }), { x: 0, y: 0, z: -1 }), 1, 0, 0)
  // offset first, head second: offset 90° (front → right), head turned right 90° → that sound is now straight ahead
  vec(applyMatrix3(headFieldMatrix(headRight, { yaw: 90, pitch: 0, roll: 0 }), { x: 0, y: 0, z: -1 }), 0, 0, -1)
})

test('deviceMatrix: an upright phone looks along −Z; alpha turns the heading', () => {
  vec(lookDirection(deviceMatrix(0, 90, 0)), 0, 0, -1)
  close(headingOf(deviceMatrix(0, 90, 0)), 0)
  // Device alpha grows counter-clockwise (compass heading goes the other way): +90° alpha looks to the left (−X).
  vec(lookDirection(deviceMatrix(90, 90, 0)), -1, 0, 0)
  close(Math.abs(headingOf(deviceMatrix(90, 90, 0))), 90)
  // tilted back (beta 45): looks above the horizon
  assert.ok(lookDirection(deviceMatrix(0, 135, 0)).y > 0.5 || lookDirection(deviceMatrix(0, 45, 0)).y > 0.5)
})

test('recentre: whatever the phone looks at becomes straight ahead', () => {
  const m = deviceMatrix(130, 90, 0)
  const h = headingOf(m)
  close(headingOf(recentre(m, h)), 0, 1e-3)
  vec(lookDirection(recentre(m, h)), 0, 0, -1)
})
