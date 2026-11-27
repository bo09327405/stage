import test from 'node:test'
import assert from 'node:assert/strict'
import { breakTag, listElevenVoices, synthesizeEleven } from '../src/studio/tts.ts'

test('break tags are clamped to ElevenLabs\' 0.1-3 s', () => {
  assert.equal(breakTag(1), '<break time="1.0s" />')
  assert.equal(breakTag(0.5), '<break time="0.5s" />')
  assert.equal(breakTag(9), '<break time="3.0s" />')
  assert.equal(breakTag(0), '<break time="0.1s" />')
})

test('request and error mapping', async (t) => {
  const real = globalThis.fetch
  t.after(() => (globalThis.fetch = real))
  const s = { apiKey: 'sk_x', voiceId: 'v1', stability: 0.5, similarity: 0.75, speed: 1 }
  let seen
  globalThis.fetch = async (url, init) => ((seen = { url, init }), new Response(new Uint8Array([1, 2]), { status: 200 }))
  const blob = await synthesizeEleven('嗨<break time="1.0s" />', s)
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

test('voice list: community voices excluded by the request, pages followed, 402 explained', async (t) => {
  const real = globalThis.fetch
  t.after(() => (globalThis.fetch = real))
  const urls = []
  globalThis.fetch = async (url, init) => {
    urls.push(String(url))
    assert.equal(init.headers['xi-api-key'], 'sk_x')
    return urls.length === 1
      ? Response.json({ voices: [{ voice_id: 'a', name: '台灣女聲', category: 'generated', labels: { gender: 'female', accent: 'taiwanese' } }], has_more: true, next_page_token: 'p2' })
      : Response.json({ voices: [{ voice_id: 'b', name: 'Rachel', category: 'premade' }], has_more: false })
  }
  const voices = await listElevenVoices('sk_x')
  assert.deepEqual(voices.map((v) => [v.id, v.category]), [['a', 'generated'], ['b', 'premade']])
  assert.match(urls[0], /v2\/voices\?voice_type=non-community&page_size=100$/)
  assert.match(urls[1], /next_page_token=p2/)
  globalThis.fetch = async () => new Response('{}', { status: 402 })
  await assert.rejects(synthesizeEleven('嗨', { apiKey: 'k', voiceId: 'v', stability: 0.5, similarity: 0.75, speed: 1 }), /付費方案/)
})
