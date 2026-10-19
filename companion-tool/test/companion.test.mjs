import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildArgs, cleanOptions, parseProgress } from '../lib/ffmpeg.mjs'
import { createCompanion, insideFolder, safeName } from '../lib/server.mjs'

// A stand-in for ffmpeg / ffprobe: reports progress like the real `-progress pipe:1`, writes the output file.
const FAKE_FFMPEG = `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args[0] === '-version') { console.log('ffmpeg version fake-1.0'); process.exit(0) }
const out = args[args.length - 1]
if (args.includes('FAIL.mp4') || args.some((a) => a.includes('badfile'))) { console.error('Invalid data found when processing input'); process.exit(1) }
const fs = require('node:fs')
let t = 0
const slow = args.some((a) => a.includes('slow'))
const step = () => {
  t += 2.5
  process.stdout.write('out_time_us=' + Math.round(t * 1e6) + '\\nprogress=continue\\n')
  if (t >= 10) { fs.writeFileSync(out, 'CONVERTED:' + args.join(' ')); process.stdout.write('progress=end\\n'); process.exit(0) }
  setTimeout(step, slow ? 400 : 20)
}
step()
`
const FAKE_FFPROBE = `#!/usr/bin/env node
console.log('10.000000')
`

let dir, bin, comp, base
const TOKEN = 'abc123'
const ORIGIN = 'https://bo09327405.github.io'

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'companion-'))
  bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'ffmpeg'), FAKE_FFMPEG.replace("const fs = require('node:fs')", "const fs = require('node:fs')"))
  writeFileSync(join(bin, 'ffprobe'), FAKE_FFPROBE)
  chmodSync(join(bin, 'ffmpeg'), 0o755)
  chmodSync(join(bin, 'ffprobe'), 0o755)
  const watch = join(dir, 'inbox')
  mkdirSync(watch)
  writeFileSync(join(watch, 'sound.wav'), 'RIFF....')
  writeFileSync(join(watch, 'slow-take.mov'), 'MOV....')
  writeFileSync(join(watch, 'badfile.mp4'), 'x')
  writeFileSync(join(watch, 'notes.txt'), 'not media')
  comp = createCompanion({ watchDir: watch, token: TOKEN, ffmpeg: join(bin, 'ffmpeg'), ffprobe: join(bin, 'ffprobe') })
  const addr = await comp.listen(0)
  base = `http://127.0.0.1:${addr.port}`
})
after(async () => comp.close())

const api = (path, init = {}) => fetch(base + path, { ...init, headers: { 'x-companion-token': TOKEN, origin: ORIGIN, ...(init.headers ?? {}) } })

test('ffmpeg arguments for each output', () => {
  assert.deepEqual(buildArgs('in.mov', 'out.mp3', { format: 'mp3', bitrate: 320 }), ['-i', 'in.mov', '-vn', '-c:a', 'libmp3lame', '-b:a', '320k', 'out.mp3'])
  const wav = buildArgs('a.mp4', 'o.wav', { format: 'wav', channels: 'mono', sampleRate: 48000, normalize: true })
  assert.ok(wav.includes('pcm_s24le') && wav.includes('-ac') && wav.includes('48000') && wav.includes('loudnorm=I=-16:TP=-1.5:LRA=11'))
  const mp4 = buildArgs('a.mkv', 'o.mp4', { format: 'mp4' })
  assert.ok(mp4.includes('libx264') && mp4.includes('aac') && mp4.includes('+faststart') && !mp4.includes('-vn'))
  assert.deepEqual(cleanOptions({ format: 'exe', bitrate: 9, channels: 'x', sampleRate: 1 }), { format: 'mp3', bitrate: 192, channels: 'keep', sampleRate: 'keep', normalize: false })
})

test('progress lines from ffmpeg are parsed', () => {
  assert.deepEqual(parseProgress('frame=1\nout_time_us=2500000\nprogress=continue\n'), { seconds: 2.5, done: false })
  assert.deepEqual(parseProgress('out_time_ms=5000000\n'), { seconds: 5, done: false })
  assert.equal(parseProgress('progress=end\n').done, true)
  assert.equal(parseProgress('speed=1x\n'), null)
})

test('file names cannot leave the watch folder', () => {
  assert.equal(safeName('../../etc/passwd'), 'passwd')
  assert.equal(safeName('..\\..\\x.wav'), 'x.wav')
  assert.equal(safeName('.hidden.wav'), 'hidden.wav')
  assert.equal(insideFolder('/tmp/in', '../../secret.wav'), '/tmp/in/secret.wav')
  assert.ok(insideFolder('/tmp/in', 'ok.wav').startsWith('/tmp/in/'))
})

test('health needs no token; everything else does', async () => {
  const health = await (await fetch(`${base}/health`, { headers: { origin: ORIGIN } })).json()
  assert.deepEqual([health.ok, health.needsToken], [true, true])
  assert.equal((await fetch(`${base}/files`, { headers: { origin: ORIGIN } })).status, 401)
  assert.equal((await fetch(`${base}/files`, { headers: { origin: ORIGIN, 'x-companion-token': 'wrong' } })).status, 401)
  assert.equal((await api('/files')).status, 200)
})

test('CORS: only the web app origins; private-network preflight answered', async () => {
  const evil = await fetch(`${base}/health`, { headers: { origin: 'https://evil.example' } })
  assert.equal(evil.status, 403)
  const pre = await fetch(`${base}/convert`, { method: 'OPTIONS', headers: { origin: ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-private-network': 'true' } })
  assert.equal(pre.status, 204)
  assert.equal(pre.headers.get('access-control-allow-origin'), ORIGIN)
  assert.equal(pre.headers.get('access-control-allow-private-network'), 'true')
  assert.match(pre.headers.get('access-control-allow-headers'), /X-Companion-Token/)
})

test('lists only media files', async () => {
  const { files } = await (await api('/files')).json()
  const names = files.map((f) => f.name).sort()
  assert.deepEqual(names, ['badfile.mp4', 'slow-take.mov', 'sound.wav'])
})

test('upload into the inbox, rejecting other types and traversal', async () => {
  const ok = await api('/inbox/uploaded.mp3', { method: 'PUT', body: 'ID3-data' })
  assert.equal(ok.status, 201)
  assert.equal(readFileSync(join(comp.watchDir, 'uploaded.mp3'), 'utf8'), 'ID3-data')
  assert.equal((await api('/inbox/run.sh', { method: 'PUT', body: 'rm -rf' })).status, 415)
  await api('/inbox/..%2F..%2Fescaped.mp3', { method: 'PUT', body: 'x' })
  assert.equal(existsSync(join(comp.watchDir, '..', 'escaped.mp3')), false)
})

test('convert: progress events, then the converted file can be downloaded', async () => {
  const res = await api('/convert', { method: 'POST', body: JSON.stringify({ file: 'sound.wav', options: { format: 'mp3', bitrate: 320 } }) })
  assert.equal(res.status, 202)
  const job = await res.json()
  const events = await api(`/jobs/${job.id}/events`)
  const text = await events.text() // the stream ends when the job does
  const seen = text.split('\n\n').filter(Boolean).map((b) => JSON.parse(b.replace(/^data: /, '')))
  const percents = seen.map((e) => e.percent)
  assert.ok(percents.some((p) => p > 0 && p < 100), `progress in between: ${percents}`)
  assert.equal(seen.at(-1).type, 'done')
  assert.equal(seen.at(-1).out, 'sound.mp3')
  const file = await api(`/jobs/${job.id}/file`)
  assert.equal(file.status, 200)
  assert.match(await file.text(), /^CONVERTED:.*libmp3lame.*320k/)
  // a second conversion of the same name doesn't overwrite
  const second = await (await api('/convert', { method: 'POST', body: JSON.stringify({ file: 'sound.wav', options: { format: 'mp3' } }) })).json()
  await (await api(`/jobs/${second.id}/events`)).text()
  assert.equal((await (await api(`/jobs/${second.id}`)).json()).out, 'sound-2.mp3')
})

test('errors are reported, unknown / outside files refused', async () => {
  const bad = await (await api('/convert', { method: 'POST', body: JSON.stringify({ file: 'badfile.mp4' }) })).json()
  const text = await (await api(`/jobs/${bad.id}/events`)).text()
  const last = JSON.parse(text.trim().split('\n\n').at(-1).replace(/^data: /, ''))
  assert.equal(last.type, 'error')
  assert.match(last.error, /Invalid data/)
  assert.equal((await api('/convert', { method: 'POST', body: JSON.stringify({ file: 'nope.wav' }) })).status, 404)
  assert.equal((await api('/convert', { method: 'POST', body: JSON.stringify({ file: '../../etc/hosts' }) })).status, 404)
  assert.equal((await api('/convert', { method: 'POST', body: JSON.stringify({ file: 'notes.txt' }) })).status, 404)
})

test('a running conversion can be cancelled', async () => {
  const job = await (await api('/convert', { method: 'POST', body: JSON.stringify({ file: 'slow-take.mov', options: { format: 'mp4' } }) })).json()
  await new Promise((r) => setTimeout(r, 700)) // let it start
  const cancelled = await api(`/jobs/${job.id}`, { method: 'DELETE' })
  assert.equal(cancelled.status, 200)
  const text = await (await api(`/jobs/${job.id}/events`)).text()
  assert.equal(JSON.parse(text.trim().split('\n\n').at(-1).replace(/^data: /, '')).type, 'cancelled')
})
