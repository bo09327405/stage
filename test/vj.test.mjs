import test from 'node:test'
import assert from 'node:assert/strict'
import {
  addFx, applyTarget, clipPosition, layerGain, moveFx, newClip, newMix, normalizeMix, oscTarget, removeFx, targetKind, triggerClip, fxUniform, newFx, findFx,
} from '../src/types/vj.ts'

const clip = (over = {}) => newClip({ src: 'https://x/a.mp4', ...over })
const ctx = (resolve = () => null) => ({ now: 1000, selectedLayer: 0, resolveClip: resolve })

test('clip position: loop wraps, one-shot ends, hold stays on the last frame', () => {
  assert.equal(clipPosition({ playMode: 'loop', speed: 1 }, 25, 10).position, 5)
  assert.equal(clipPosition({ playMode: 'loop', speed: 2 }, 3, 10).position, 6)
  assert.deepEqual(clipPosition({ playMode: 'oneshot', speed: 1 }, 4, 10), { position: 4, ended: false })
  assert.equal(clipPosition({ playMode: 'oneshot', speed: 1 }, 10, 10).ended, true)
  const hold = clipPosition({ playMode: 'hold', speed: 1 }, 99, 10)
  assert.equal(hold.ended, false)
  assert.ok(hold.position < 10 && hold.position > 9.9)
  assert.deepEqual(clipPosition({ playMode: 'loop', speed: 1 }, 7, 0), { position: 7, ended: false })
})

test('crossfader scales only the layers on a side', () => {
  assert.equal(layerGain({ opacity: 0.8, side: 'thru' }, 1), 0.8)
  assert.equal(layerGain({ opacity: 1, side: 'A' }, 0.25), 0.75)
  assert.equal(layerGain({ opacity: 1, side: 'B' }, 0.25), 0.25)
  assert.equal(layerGain({ opacity: 0.5, side: 'B' }, 1), 0.5)
})

test('normalizeMix repairs what the database hands back', () => {
  assert.equal(normalizeMix(null), null)
  const mix = normalizeMix({ live: true, crossfader: 9, layers: { 1: { clip: { src: 'a.png', mediaKind: 'image', speed: 99 }, opacity: -3, blend: 'nope', fx: { 0: { type: 'strobe', params: { rate: 5 } }, 1: { type: 'bogus' } } } } })
  assert.equal(mix.layers.length, 3)
  assert.equal(mix.crossfader, 1)
  assert.equal(mix.layers[0].clip, null)
  const l = mix.layers[1]
  assert.equal(l.clip.speed, 4)
  assert.equal(l.opacity, 0)
  assert.equal(l.blend, 'normal')
  assert.equal(l.fx.length, 1)
  assert.equal(l.fx[0].params.rate, 1)
  assert.equal(typeof l.fx[0].params.depth, 'number')
})

test('effect chain: add, move, remove, find', () => {
  let mix = addFx(addFx(newMix(), 1, 'blur'), 1, 'glitch')
  const [a, b] = mix.layers[1].fx
  mix = moveFx(mix, 1, b.id, -1)
  assert.deepEqual(mix.layers[1].fx.map((f) => f.id), [b.id, a.id])
  assert.equal(findFx(mix, a.id).scope, 1)
  mix = removeFx(mix, 1, a.id)
  assert.equal(mix.layers[1].fx.length, 1)
  mix = addFx(mix, 'master', 'hue')
  assert.equal(findFx(mix, mix.masterFx[0].id).scope, 'master')
})

test('effect uniforms are in display units', () => {
  const fx = newFx('kaleido')
  fx.params.segments = 1
  assert.equal(fxUniform(fx)[0], 16)
  fx.params.segments = 0
  assert.equal(fxUniform(fx)[0], 2)
})

test('controller targets', () => {
  assert.equal(targetKind('layer.1.opacity'), 'continuous')
  assert.equal(targetKind('crossfader'), 'continuous')
  assert.equal(targetKind('fx.f1.rate'), 'continuous')
  assert.equal(targetKind('fx.f1.enabled'), 'trigger')
  assert.equal(targetKind('clip.d1.0,0'), 'trigger')

  let mix = newMix()
  mix = applyTarget(mix, 'layer.2.opacity', 0.4, ctx())
  assert.equal(mix.layers[1].opacity, 0.4)
  mix = applyTarget(mix, 'crossfader', 1, ctx())
  assert.equal(mix.crossfader, 1)

  const c = clip()
  mix = applyTarget(mix, 'clip.d1.0,0', 1, { now: 5000, selectedLayer: 2, resolveClip: (d, s) => (d === 'd1' && s === '0,0' ? c : null) })
  assert.equal(mix.layers[2].clip, c)
  assert.equal(mix.layers[2].startedAt, 5000)
  // Releasing the pad, or an unknown slot, changes nothing.
  assert.equal(applyTarget(mix, 'clip.d1.0,0', 0, ctx(() => c)), mix)
  assert.equal(applyTarget(mix, 'clip.d1.9,9', 1, ctx()), mix)
  mix = applyTarget(mix, 'layer.3.clear', 1, ctx())
  assert.equal(mix.layers[2].clip, null)

  mix = addFx(mix, 0, 'strobe')
  const id = mix.layers[0].fx[0].id
  mix = applyTarget(mix, `fx.${id}.rate`, 0.75, ctx())
  assert.equal(mix.layers[0].fx[0].params.rate, 0.75)
  mix = applyTarget(mix, `fx.${id}.enabled`, 1, ctx())
  assert.equal(mix.layers[0].fx[0].enabled, false)
  assert.equal(applyTarget(mix, 'fx.gone.rate', 1, ctx()), mix)
})

test('OSC default addresses', () => {
  assert.equal(oscTarget('/vj/layer/2/opacity'), 'layer.2.opacity')
  assert.equal(oscTarget('/vj/xfade'), 'crossfader')
  assert.equal(oscTarget('/vj/layer/x/opacity'), null)
  assert.equal(oscTarget('/sys/go'), null)
})

test('triggerClip leaves other layers alone', () => {
  const mix = triggerClip(newMix(), 1, clip(), 42)
  assert.equal(mix.layers[0].clip, null)
  assert.equal(mix.layers[1].startedAt, 42)
})
