import { createServer as createHttp } from 'node:http'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, statSync, watch } from 'node:fs'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { basename, extname, join, resolve, sep } from 'node:path'
import { MEDIA_EXTS, cleanOptions, ffmpegVersion, runFfmpeg } from './ffmpeg.mjs'

/*
 * The companion's HTTP API (localhost only). The web app talks to it like this:
 *
 *   GET    /health                 is it running? (no token needed; says whether a token is required)
 *   GET    /info                   ffmpeg version, watch folder, auto mode                       [token]
 *   GET    /files                  media files waiting in the watch folder                       [token]
 *   PUT    /inbox/<name>           put a file there (streamed from the page)                      [token]
 *   POST   /convert                { file, options } → { id }                                     [token]
 *   GET    /jobs, /jobs/<id>       job status                                                     [token]
 *   GET    /jobs/<id>/events       Server-Sent Events: progress / done / error                    [token]
 *   GET    /jobs/<id>/file         the converted file                                             [token]
 *   DELETE /jobs/<id>              cancel                                                         [token]
 *
 * Safety: it listens on 127.0.0.1 only, answers only the web app's own origins (CORS allow-list, plus Chrome's
 * "private network access" preflight), needs a pairing token, and only ever reads / writes inside the watch folder.
 */

export const VERSION = '1.0.0'
const MAX_UPLOAD = 8 * 1024 * 1024 * 1024
const DEFAULT_ORIGINS = ['https://bo09327405.github.io', 'http://localhost:5173', 'https://localhost:5173', 'http://localhost:5174', 'https://localhost:5174', 'http://127.0.0.1:5173', 'https://127.0.0.1:5173']

/** A file name that stays inside a folder: no directories, no leading dots, no odd characters. */
export function safeName(name) {
  // The last path segment, whichever separator the page used (a Windows path may reach a macOS / Linux server).
  const base = basename(String(name ?? '').split('\\').pop() ?? '').replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '_').replace(/^\.+/, '')
  return base.slice(0, 160)
}

/** `dir/name`, refusing anything that would resolve outside `dir`. */
export function insideFolder(dir, name) {
  const root = resolve(dir)
  const target = resolve(root, safeName(name))
  return target.startsWith(root + sep) ? target : null
}

const isMedia = (name) => MEDIA_EXTS.includes(extname(name).slice(1).toLowerCase())

export function createCompanion({ watchDir, token = null, origins = [], ffmpeg = 'ffmpeg', ffprobe = 'ffprobe', auto = null, log = () => {} }) {
  const root = resolve(watchDir)
  const outDir = join(root, 'converted')
  mkdirSync(outDir, { recursive: true })
  const allowed = new Set([...DEFAULT_ORIGINS, ...origins])
  const jobs = new Map()
  const queue = []
  let running = false
  const listeners = new Map() // jobId → Set<(event) => void>

  const emit = (job, type, extra = {}) => {
    const event = { type, ...publicJob(job), ...extra }
    for (const l of listeners.get(job.id) ?? []) l(event)
  }
  const publicJob = (j) => ({ id: j.id, file: j.file, status: j.status, percent: j.percent, out: j.out, bytes: j.bytes, error: j.error, options: j.options })

  function outputPath(file, format) {
    const stem = safeName(file).replace(/\.[^.]+$/, '') || 'media'
    let name = `${stem}.${format}`
    let n = 2
    while (existsSync(join(outDir, name))) name = `${stem}-${n++}.${format}`
    return join(outDir, name)
  }

  async function pump() {
    if (running) return
    const job = queue.shift()
    if (!job) return
    running = true
    job.status = 'running'
    job.percent = 0
    emit(job, 'progress')
    const input = insideFolder(root, job.file)
    try {
      if (!input || !existsSync(input)) throw new Error('找不到這個檔案（必須放在監看資料夾裡）')
      const output = outputPath(job.file, job.options.format)
      job.out = basename(output)
      await runFfmpeg({
        ffmpeg,
        ffprobe,
        input,
        output,
        options: job.options,
        handle: job.handle,
        onProgress: (p) => {
          if (p !== null && p !== job.percent) {
            job.percent = p
            emit(job, 'progress')
          }
        },
      })
      job.bytes = statSync(output).size
      job.percent = 100
      job.status = 'done'
      emit(job, 'done')
      log(`✓ ${job.file} → converted/${job.out}`)
    } catch (err) {
      job.status = err.message === 'cancelled' ? 'cancelled' : 'error'
      job.error = err.message === 'cancelled' ? '已取消' : err.message
      emit(job, job.status === 'cancelled' ? 'cancelled' : 'error')
      log(`✗ ${job.file}: ${job.error}`)
    } finally {
      running = false
      void pump()
    }
  }

  function enqueue(file, rawOptions) {
    const job = { id: randomBytes(5).toString('hex'), file: safeName(file), options: cleanOptions(rawOptions), status: 'queued', percent: 0, out: null, bytes: 0, error: null, handle: {} }
    jobs.set(job.id, job)
    queue.push(job)
    emit(job, 'queued')
    void pump()
    return job
  }

  const checkToken = (req, url) => {
    if (!token) return true
    const given = String(req.headers['x-companion-token'] ?? url.searchParams.get('token') ?? '')
    const a = Buffer.from(given)
    const b = Buffer.from(token)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers })
    res.end(JSON.stringify(body))
  }

  const server = createHttp(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const origin = req.headers.origin
    // CORS: only the web app's own origins (a missing Origin = curl / a local script, still needs the token).
    const cors = {}
    if (origin) {
      if (!allowed.has(origin)) return send(res, 403, { error: 'origin_not_allowed' })
      cors['access-control-allow-origin'] = origin
      cors['vary'] = 'Origin'
      cors['access-control-expose-headers'] = 'Content-Disposition, Content-Length'
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...cors,
        'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'access-control-allow-headers': 'Content-Type, X-Companion-Token',
        // Chrome: a public https page reaching a local server asks for this first ("private network access").
        'access-control-allow-private-network': 'true',
        'access-control-max-age': '600',
      })
      return res.end()
    }
    const reply = (status, body) => send(res, status, body, cors)

    try {
      if (url.pathname === '/health') return reply(200, { ok: true, name: 'theatre-cue-companion', version: VERSION, needsToken: !!token })
      if (!checkToken(req, url)) return reply(401, { error: 'bad_token', message: '配對碼不正確' })

      if (url.pathname === '/info') {
        return reply(200, { version: VERSION, ffmpeg: await ffmpegVersion(ffmpeg), watchDir: root, outDir, auto: auto ? cleanOptions(auto) : null })
      }
      if (url.pathname === '/files' && req.method === 'GET') {
        const files = readdirSync(root, { withFileTypes: true })
          .filter((d) => d.isFile() && isMedia(d.name) && !d.name.startsWith('.'))
          .map((d) => ({ name: d.name, bytes: statSync(join(root, d.name)).size, modified: statSync(join(root, d.name)).mtimeMs }))
          .sort((a, b) => b.modified - a.modified)
        return reply(200, { files })
      }
      const put = /^\/inbox\/(.+)$/.exec(url.pathname)
      if (put && req.method === 'PUT') {
        const name = safeName(decodeURIComponent(put[1]))
        if (!isMedia(name)) return reply(415, { error: 'unsupported', message: '不支援的檔案類型' })
        if (Number(req.headers['content-length'] ?? 0) > MAX_UPLOAD) return reply(413, { error: 'too_large' })
        const target = insideFolder(root, name)
        if (!target) return reply(400, { error: 'bad_name' })
        let bytes = 0
        const out = createWriteStream(target)
        req.on('data', (c) => (bytes += c.length))
        req.pipe(out)
        out.on('finish', () => reply(201, { name, bytes }))
        out.on('error', (e) => reply(500, { error: e.message }))
        return
      }
      if (url.pathname === '/convert' && req.method === 'POST') {
        let text = ''
        for await (const c of req) {
          text += c
          if (text.length > 20_000) return reply(413, { error: 'too_large' })
        }
        const body = JSON.parse(text || '{}')
        const name = safeName(body.file)
        const target = insideFolder(root, name)
        if (!target || !existsSync(target) || !isMedia(name)) return reply(404, { error: 'file_not_found', message: '找不到這個檔案（必須放在監看資料夾裡）' })
        const job = enqueue(name, body.options)
        return reply(202, publicJob(job))
      }
      if (url.pathname === '/jobs' && req.method === 'GET') return reply(200, { jobs: [...jobs.values()].map(publicJob) })

      const m = /^\/jobs\/([0-9a-f]+)(\/events|\/file)?$/.exec(url.pathname)
      if (m) {
        const job = jobs.get(m[1])
        if (!job) return reply(404, { error: 'no_such_job' })
        if (!m[2] && req.method === 'GET') return reply(200, publicJob(job))
        if (!m[2] && req.method === 'DELETE') {
          if (job.status === 'queued') queue.splice(queue.indexOf(job), 1)
          if (job.status === 'queued') {
            job.status = 'cancelled'
            job.error = '已取消'
            emit(job, 'cancelled')
          } else job.handle.kill?.()
          return reply(200, publicJob(job))
        }
        if (m[2] === '/file') {
          if (job.status !== 'done') return reply(409, { error: 'not_ready' })
          const file = join(outDir, job.out)
          res.writeHead(200, { ...cors, 'content-type': 'application/octet-stream', 'content-length': statSync(file).size, 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(job.out)}` })
          return createReadStream(file).pipe(res)
        }
        if (m[2] === '/events') {
          res.writeHead(200, { ...cors, 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
          const write = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`)
          write({ type: 'status', ...publicJob(job) })
          if (['done', 'error', 'cancelled'].includes(job.status)) return res.end()
          const set = listeners.get(job.id) ?? new Set()
          listeners.set(job.id, set)
          const fn = (event) => {
            write(event)
            if (['done', 'error', 'cancelled'].includes(event.type)) {
              set.delete(fn)
              res.end()
            }
          }
          set.add(fn)
          req.on('close', () => set.delete(fn))
          return
        }
      }
      return reply(404, { error: 'not_found' })
    } catch (err) {
      return reply(500, { error: String(err?.message ?? err) })
    }
  })

  // Automatic mode: every new media file that lands in the folder is converted with these options.
  let watcher = null
  const seen = new Set()
  if (auto) {
    const consider = (name) => {
      if (!name || !isMedia(name) || name.startsWith('.') || seen.has(name)) return
      const file = join(root, name)
      let last = -1
      // Wait until the copy has finished (the size stops changing).
      const check = setInterval(() => {
        try {
          const size = statSync(file).size
          if (size > 0 && size === last) {
            clearInterval(check)
            seen.add(name)
            enqueue(name, auto)
            log(`⟳ 自動轉檔：${name}`)
          }
          last = size
        } catch {
          clearInterval(check)
        }
      }, 800)
    }
    watcher = watch(root, (_event, name) => consider(name))
  }

  return {
    server,
    enqueue,
    jobs,
    watchDir: root,
    outDir,
    listen: (port, host = '127.0.0.1') => new Promise((ok) => server.listen(port, host, () => ok(server.address()))),
    close: () => {
      watcher?.close()
      return new Promise((ok) => server.close(() => ok()))
    },
  }
}
