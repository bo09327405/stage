import test from 'node:test'
import assert from 'node:assert/strict'
import { animationTime, isModelUrl, kelvinToRgb, lightDirection, newXrObject, newXrScene, normalizeXr, panoVideoTime, wrapDegrees, xrAssets, xrProblem } from '../src/types/xr.ts'

test('normalizeXr: null stays null, a bare record gets every default', () => {
  assert.equal(normalizeXr(null), null)
  assert.equal(normalizeXr('nope'), null)
  const s = normalizeXr({ mode: 'vr_stage' })
  assert.equal(s.mode, 'vr_stage')
  assert.deepEqual(s.objects, [])
  assert.equal(s.camera.fov, 70)
  assert.equal(s.gyro, true)
  assert.equal(s.pano.kind, 'image')
})

test('normalizeXr repairs what the database hands back', () => {
  const s = normalizeXr({
    mode: 'bogus',
    pano: { url: '/api/r2/o/theatre/cues/x/pano.MP4', yaw: 9999 },
    // RTDB returns arrays as objects, drops empty strings' siblings, and may hold junk.
    objects: { 0: { id: 'a', url: 'a.glb', position: { x: '2', y: null }, scale: { x: 0, y: -4, z: 5000 }, animationLoop: 'nope', animationSpeed: 99 }, 1: { id: 'a', url: 'b.glb' }, 2: { name: 'no url' }, 3: null },
    camera: { yaw: 45, pitch: 200, fov: 5 },
    ambient: { intensity: -1, kelvin: 99 },
    background: 'red',
    gyro: false,
  })
  assert.equal(s.mode, '360_pano')
  assert.equal(s.pano.kind, 'video')
  assert.equal(s.pano.yaw, 360)
  assert.equal(s.objects.length, 2)
  assert.notEqual(s.objects[0].id, s.objects[1].id)
  assert.deepEqual(s.objects[0].position, { x: 2, y: 0, z: 0 })
  assert.deepEqual(s.objects[0].scale, { x: 0.001, y: 0.001, z: 1000 })
  assert.equal(s.objects[0].animationLoop, 'loop')
  assert.equal(s.objects[0].animationSpeed, 10)
  assert.equal(s.camera.pitch, 89)
  assert.equal(s.camera.fov, 30)
  assert.equal(s.ambient.intensity, 0)
  assert.equal(s.ambient.kelvin, 1000)
  assert.equal(s.background, '#0b0d12')
  assert.equal(s.gyro, false)
  // A second pass changes nothing (what is saved is what is read back).
  assert.deepEqual(normalizeXr(JSON.parse(JSON.stringify(s))), s)
})

test('xrAssets lists what to preload: distinct visible models, and the panorama unless passthrough', () => {
  const s = newXrScene('vr_stage')
  s.pano.url = 'sky.jpg'
  s.objects = [newXrObject('a.glb', 'a.glb'), newXrObject('a.glb', 'again'), { ...newXrObject('b.glb', 'b'), visible: false }]
  assert.deepEqual(xrAssets(s), { models: ['a.glb'], screens: [], pano: { url: 'sky.jpg', kind: 'image' } })
  assert.equal(xrAssets({ ...s, mode: 'mr_passthrough' }).pano, null)
  assert.deepEqual(xrAssets(null), { models: [], screens: [], pano: null })
})

test('xrProblem: each mode needs its own material', () => {
  assert.match(xrProblem(null), /XR/)
  assert.match(xrProblem(newXrScene('360_pano')), /全景/)
  assert.match(xrProblem(newXrScene('mr_passthrough')), /模型/)
  const ok = newXrScene('vr_stage')
  ok.objects = [newXrObject('a.glb', 'a')]
  assert.equal(xrProblem(ok), null)
})

test('show-clock timing: panorama video and animation clips', () => {
  assert.equal(panoVideoTime(25, 10, true), 5)
  assert.ok(panoVideoTime(25, 10, false) < 10 && panoVideoTime(25, 10, false) > 9.9)
  assert.equal(panoVideoTime(-3, 10, true), 0)
  assert.equal(panoVideoTime(7, 0, true), 7)
  assert.equal(animationTime(12, 5, 'loop'), 2)
  assert.equal(animationTime(12, 5, 'once'), 5)
  assert.equal(animationTime(7, 5, 'pingpong'), 3)
  assert.equal(animationTime(3, 5, 'loop', 2), 1)
  assert.equal(animationTime(3, 0, 'loop'), 0)
})

test('light helpers', () => {
  const warm = kelvinToRgb(2700)
  const cool = kelvinToRgb(10000)
  assert.ok(warm[0] > warm[2], 'warm light is redder than blue')
  assert.ok(cool[2] > cool[0], 'cool light is bluer than red')
  assert.deepEqual(kelvinToRgb(6600).map((v) => Math.round(v * 100) / 100), [1, 1, 1])
  const up = lightDirection(0, 90)
  assert.ok(Math.abs(up.y - 1) < 1e-9 && Math.abs(up.x) < 1e-9)
  const right = lightDirection(90, 0)
  assert.ok(Math.abs(right.x - 1) < 1e-9)
})

test('small helpers', () => {
  assert.equal(wrapDegrees(190), -170)
  assert.equal(wrapDegrees(-190), 170)
  assert.equal(isModelUrl('/api/r2/o/theatre/cues/x/abc-Stage.GLB'), true)
  assert.equal(isModelUrl('a.glb?x=1'), true)
  assert.equal(isModelUrl('a.png'), false)
  assert.equal(newXrObject('a.glb', 'Chair.glb').name, 'Chair')
})

test('resolveXrScene: the bound library scene wins; the cue keeps its own copy as the fallback', async () => {
  const { resolveXrScene } = await import('../src/types/xr.ts')
  const own = newXrScene('360_pano')
  const lib = newXrScene('vr_stage')
  assert.equal(resolveXrScene(own, 's1', { s1: lib }), lib)
  assert.equal(resolveXrScene(own, 'gone', { s1: lib }), own)
  assert.equal(resolveXrScene(own, '', { s1: lib }), own)
  assert.equal(resolveXrScene(null, 's1', null), null)
})

test('hierarchy, timeline and interactions survive the database round trip', async () => {
  const { xrBranch, xrMovedPosition, xrOnStage, xrPlayable, newXrInteraction } = await import('../src/types/xr.ts')
  const s = normalizeXr({
    mode: 'vr_stage',
    objects: {
      0: { id: 'g', kind: 'group', name: 'Props' },
      1: { id: 'a', url: 'a.glb', parentId: 'g', material: { opacity: 0.4, color: '#ff0000', metalness: 2 }, timeline: { showAt: 2, hideAt: 9, move: { enabled: true, to: { x: 4 }, start: 1, duration: 2 } }, interactions: { 0: { trigger: 'gaze', action: 'toggle', targetId: 'h' }, 1: { action: 'bogus' } } },
      2: { id: 'h', url: 'h.png', kind: 'image', visible: false, parentId: 'missing' },
      3: { id: 'x', url: 'x.glb', parentId: 'y' },
      4: { id: 'y', url: 'y.glb', parentId: 'x' },
      5: { id: 'z', url: 'z.glb', visible: false },
    },
  })
  const by = Object.fromEntries(s.objects.map((o) => [o.id, o]))
  assert.equal(by.g.url, '')
  assert.equal(by.a.parentId, 'g')
  assert.equal(by.h.parentId, '', 'a missing parent is dropped')
  assert.ok(by.x.parentId === '' || by.y.parentId === '', 'a parent loop is broken')
  assert.deepEqual(by.a.material, { opacity: 0.4, color: '#ff0000', metalness: 1, roughness: null })
  assert.equal(by.a.interactions.length, 2)
  assert.equal(by.a.interactions[0].trigger, 'gaze')
  assert.equal(by.a.interactions[1].action, 'dialog')
  assert.deepEqual(normalizeXr(JSON.parse(JSON.stringify(s))), s)
  // Hidden objects load only when an interaction can switch them on.
  assert.deepEqual(xrPlayable(s).map((o) => o.id).sort(), ['a', 'g', 'h', 'x', 'y'])
  assert.deepEqual(xrAssets(s).screens, [{ url: 'h.png', kind: 'image' }])
  assert.deepEqual(xrBranch(s.objects, 'g'), ['g', 'a'])
  assert.equal(xrOnStage(by.a.timeline, 1), false)
  assert.equal(xrOnStage(by.a.timeline, 5), true)
  assert.equal(xrOnStage(by.a.timeline, 9), false)
  assert.equal(xrMovedPosition({ x: 0, y: 0, z: 0 }, by.a.timeline, 0).x, 0)
  assert.equal(xrMovedPosition({ x: 0, y: 0, z: 0 }, by.a.timeline, 2).x, 2)
  assert.equal(xrMovedPosition({ x: 0, y: 0, z: 0 }, by.a.timeline, 99).x, 4)
  assert.equal(newXrInteraction().action, 'dialog')
})
