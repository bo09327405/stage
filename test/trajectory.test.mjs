import test from 'node:test'
import assert from 'node:assert/strict'
import { airCutoffHz, decimateStroke, DEFAULT_TRAJECTORY, generatePreset, normalizeTrajectory, pathProgress, reverbWetAt } from '../src/types/trajectory.ts'
import { buildPath } from '../src/studio/trajectoryPath.ts'

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`)

test('normalizeTrajectory: junk becomes the default, RTDB object-arrays are repaired', () => {
  const d = normalizeTrajectory(null)
  assert.equal(d.enabled, false)
  assert.equal(d.waypoints.length, 1)
  const c = normalizeTrajectory({
    enabled: 1,
    pathType: 'freehand',
    waypoints: { 0: { x: '2', y: 999, z: -1 }, 1: { x: 0, y: 0, z: -3 }, 2: null, 3: { x: 1, y: 1, z: 1 } },
    closed: true,
    playback: { durationSec: -5, loopMode: 'bogus', phaseOffset: 4 },
    acoustics: { refDistance: 5, maxDistance: 1, airAbsorption: 3 },
  })
  assert.equal(c.enabled, true)
  assert.equal(c.waypoints.length, 3)
  assert.deepEqual(c.waypoints[0], { x: 2, y: 50, z: -1 })
  assert.equal(c.closed, true)
  assert.equal(c.playback.durationSec, 0.5)
  assert.equal(c.playback.loopMode, 'loop')
  assert.equal(c.playback.phaseOffset, 1)
  assert.ok(c.acoustics.maxDistance > c.acoustics.refDistance)
  assert.equal(c.acoustics.airAbsorption, 1)
})

test('normalizeTrajectory: static keeps one point, a 2-point path cannot be closed', () => {
  assert.equal(normalizeTrajectory({ pathType: 'static', waypoints: [{ x: 1, y: 0, z: -1 }, { x: 2, y: 0, z: -1 }] }).waypoints.length, 1)
  assert.equal(normalizeTrajectory({ pathType: 'freehand', closed: true, waypoints: [{ x: 1, y: 0, z: -1 }, { x: 2, y: 0, z: -1 }] }).closed, false)
})

test('pathProgress: once clamps, loop wraps, pingpong runs there and back, phase shifts', () => {
  const pb = (loopMode, phaseOffset = 0) => ({ durationSec: 10, loopMode, phaseOffset })
  close(pathProgress(pb('once'), 5), 0.5)
  close(pathProgress(pb('once'), 25), 1)
  close(pathProgress(pb('loop'), 12.5), 0.25)
  close(pathProgress(pb('pingpong'), 5), 0.5)
  close(pathProgress(pb('pingpong'), 15), 0.5)
  close(pathProgress(pb('pingpong'), 12), 0.8)
  close(pathProgress(pb('loop', 0.25), 0), 0.25)
  close(pathProgress(pb('loop', 0.25), 8), 0.05)
  close(pathProgress(pb('loop'), -3), 0)
})

test('generatePreset: closed shapes start straight ahead, nothing passes through the head', () => {
  for (const shape of ['orbit', 'lissajous', 'spiral', 'pendulum']) {
    const g = generatePreset({ shape, radius: 3, height: 1, turns: 3 })
    assert.ok(g.waypoints.length >= 3 && g.waypoints.length <= 64, shape)
    assert.ok(g.waypoints.every((p) => Math.hypot(p.x, p.y, p.z) > 0.5), `${shape} stays clear of the head`)
  }
  const orbit = generatePreset({ shape: 'orbit', radius: 3, height: 0, turns: 1 })
  assert.equal(orbit.closed, true)
  assert.deepEqual(orbit.waypoints[0], { x: 0, y: 0, z: -3 })
  assert.equal(generatePreset({ shape: 'pendulum', radius: 3, height: 0, turns: 1 }).loopMode, 'pingpong')
})

test('buildPath: passes the first / last waypoint at constant speed, closed paths loop seamlessly', () => {
  const open = normalizeTrajectory({ pathType: 'freehand', waypoints: [{ x: -3, y: 0, z: -2 }, { x: 0, y: 1, z: -4 }, { x: 3, y: 0, z: -2 }] })
  const p = buildPath(open)
  const a = p.atProgress(0)
  const b = p.atProgress(1)
  close(a.x, -3, 1e-4)
  close(b.x, 3, 1e-4)
  const orbit = generatePreset({ shape: 'orbit', radius: 3, height: 0, turns: 1 })
  const c = buildPath(normalizeTrajectory({ pathType: 'preset', waypoints: orbit.waypoints, closed: true, playback: { durationSec: 8, loopMode: 'loop', phaseOffset: 0 } }))
  const s = c.at(0)
  const e = c.at(8)
  close(s.x, e.x, 1e-3)
  close(s.z, e.z, 1e-3)
  // phase offset 0.5 on the same path = the opposite side
  const half = buildPath({ ...normalizeTrajectory({ pathType: 'preset', waypoints: orbit.waypoints, closed: true }), playback: { durationSec: 8, loopMode: 'loop', phaseOffset: 0.5 } }).at(0)
  assert.ok(half.z > 2.5, 'half way round an orbit that starts in front is behind')
})

test('buildPath: static and one-point paths stay put', () => {
  const p = buildPath(DEFAULT_TRAJECTORY)
  assert.deepEqual(p.at(7), { x: 0, y: 0, z: -2 })
  assert.equal(p.sample(5).length, 5)
})

test('distance acoustics: nothing within refDistance, darker and wetter with distance', () => {
  const a = { refDistance: 1, maxDistance: 20, rolloffFactor: 1, airAbsorption: 1, reverbSend: 0.5 }
  close(airCutoffHz(0.5, a), 20000)
  assert.ok(airCutoffHz(10, a) < airCutoffHz(5, a))
  assert.ok(airCutoffHz(100, a) >= 800)
  assert.equal(airCutoffHz(10, { ...a, airAbsorption: 0 }), 20000)
  assert.ok(reverbWetAt(15, a) > reverbWetAt(1, a))
  assert.ok(reverbWetAt(1000, a) <= 0.5 + 1e-9)
})

test('decimateStroke: drops crowded points, caps the count, keeps both ends', () => {
  const stroke = Array.from({ length: 400 }, (_, i) => ({ x: Math.sin(i / 20) * 3, y: 0, z: -2 - i * 0.01 }))
  const d = decimateStroke(stroke, 0.35, 32)
  assert.ok(d.length <= 32)
  assert.deepEqual(d[0], stroke[0])
  assert.deepEqual(d[d.length - 1], stroke[stroke.length - 1])
  assert.equal(decimateStroke([stroke[0], stroke[1]]).length, 2)
})

test('headTrack defaults off and survives normalisation', () => {
  assert.equal(normalizeTrajectory(null).headTrack, false)
  assert.equal(normalizeTrajectory({ headTrack: true }).headTrack, true)
  assert.equal(normalizeTrajectory({ headTrack: 'yes' }).headTrack, true)
})
