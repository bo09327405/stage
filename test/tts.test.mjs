import test from 'node:test'
import assert from 'node:assert/strict'
import { synthesizeEleven, toElevenText } from '../src/studio/tts.ts'

test('pause tags become ElevenLabs break tags', () => {
  assert.equal(toElevenText('晚安。((⏱=1000))開始'), '晚安。 <break time="1.0s" /> 開始')
  assert.equal(toElevenText('a((⏱=500))b'), 'a <break time="0.5s" /> b')
})

test('a pause over 3 s is chained', () => {
  assert.equal(toElevenText('((⏱=7000))').trim(), '<break time="3.0s" /> <break time="3.0s" /> <break time="1.0s" />')
})

test('request and error mapping', async (t) => {
  const real = globalThis.fetch
  t.after(() => (globalThis.fetch = real))
  const s = { apiKey: 'sk_x', voiceId: 'v1', stability: 0.5, similarity: 0.75, speed: 1 }
  let seen
  globalThis.fetch = async (url, init) => ((seen = { url, init }), new Response(new Uint8Array([1, 2]), { status: 200 }))
  const blob = await synthesizeEleven('嗨((⏱=1000))', s)
  assert.equal(blob.type, 'audio/mpeg')
  assert.equal(seen.url, 'https://api.elevenlabs.io/v1/text-to-speech/v1')
  assert.equal(seen.init.headers['xi-api-key'], 'sk_x')
  const body = JSON.parse(seen.init.body)
  assert.equal(body.model_id, 'eleven_multilingual_v2')
  assert.deepEqual(body.voice_settings, { stability: 0.5, similarity_boost: 0.75, speed: 1 })
  assert.match(body.text, /<break time="1.0s" \/>/)

  const fail = (status, json) => (globalThis.fetch = async () => new Response(JSON.stringify(json), { status }))
  fail(401, { detail: { status: 'invalid_api_key', message: 'bad' } })
  await assert.rejects(synthesizeEleven('嗨', s), /API Key 錯誤/)
  fail(401, { detail: { status: 'quota_exceeded', message: 'q' } })
  await assert.rejects(synthesizeEleven('嗨', s), /額度已用完/)
  fail(429, {})
  await assert.rejects(synthesizeEleven('嗨', s), /429/)
})
