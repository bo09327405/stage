import { createHash, createHmac } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { Plugin } from 'vite'
import { callerOf, projectAccess, projectOfKey, type Caller } from './projectAccess.ts'

/**
 * Cloudflare R2 storage through the dev / preview server.
 *
 * The R2 keys live only here (read from .env.local, no VITE_ prefix), so the browser never sees
 * them. Requests to R2 are signed with AWS Signature V4 (R2 speaks the S3 API).
 *
 *   GET  /api/r2/status                      → { configured, bucket }
 *   POST /api/r2/upload?key=theatre/…         body = the file → { key, url, bytes, contentType }
 *   GET  /api/r2/o/<key>                      the file, streamed (Range supported, so audio seeks)
 *   GET  /api/r2/list?prefix=theatre/…/&kind=media|raw   → { items: [{ key, name, size, lastModified, url }] }
 *   POST /api/r2/import?key=theatre/…&url=https://res.cloudinary.com/<cloud>/…
 *                                             copy a Set Cue file into the studio's R2 folder
 *   POST /api/r2/delete   body { keys: [...] } → { deleted: [...] }  (only the deletable prefixes below)
 *   POST /api/r2/copy     body { from, to }  → { key, url, bytes }   admins only (the global file manager)
 *   GET|HEAD|OPTIONS /api/r2/pub/<key>       published audio (theatre/public/ only): public, CORS,
 *                                             Range, long cache — embeddable in Notion and elsewhere
 *
 * Auto-saved project files: theatre/projects/{showId}/{studioId}.json (DAW Studio) and
 * theatre/setcue-projects/{showId}.json (Set Cue). Both are overwritten in place with /upload.
 *
 * This is the DAW Studio's storage. Cloudinary (/api/cloudinary/*) is for Set Cue and the audience;
 * the only crossing is /import, one way, from this account's Cloudinary into R2.
 * Only keys under "theatre/" can be written or read, so the proxy can't be used to reach anything
 * else in the bucket.
 *
 * Access (decided by the Realtime Database rules, see projectAccess.ts):
 *   · project files (theatre/projects/{pid}/…, theatre/setcue-projects/{pid}.json): members only
 *   · listing, uploading, importing, deleting: signed-in users, limited to their own projects
 *     (admins: everything); a whole Set Cue project file, or the studio file of a standalone
 *     Studio project, can only be deleted by an admin
 *   · media files (audio / video / images) stay readable by URL — audience devices play them
 *     without signing in; their keys are unguessable, like Cloudinary URLs
 */

export interface R2Options {
  endpoint?: string
  bucket?: string
  accessKeyId?: string
  secretAccessKey?: string
  /** Cloudinary cloud name: /import only copies from this account's delivery URLs. */
  cloudinaryCloud?: string
  /** Realtime Database URL: access checks are asked of it with the caller's own token. */
  databaseUrl?: string
  /**
   * Optional public base URL for published audio (an R2 public bucket domain or custom domain
   * mapped to this bucket, e.g. https://audio.example.com). Without it, published files are served
   * by this server at /api/r2/pub/<key>.
   */
  publicBaseUrl?: string
}

/** Published (publicly readable) files live here; nothing else is ever served without the app. */
export const PUBLIC_PREFIX = 'theatre/public/'
/**
 * Fixed-URL published audio (theatre/public/{show}/live/{studio}.mp3) is overwritten whenever the
 * studio changes, so players must always revalidate it; snapshot files never change.
 */
const isLiveKey = (key: string) => key.startsWith(PUBLIC_PREFIX) && key.includes('/live/')
const LIVE_CACHE = 'no-cache, must-revalidate'

const MAX_UPLOAD = 250 * 1024 * 1024
/** Keys the proxy accepts: under theatre/, no "..", no control or URL-special characters. */
const validKey = (key: string) =>
  key.startsWith('theatre/') && key.length <= 490 && !key.includes('..') && !/[\\?#]/.test(key) && ![...key].some((c) => c.charCodeAt(0) < 32)

/**
 * What may be deleted: DAW project files, Set Cue project files, studio audio and control-panel
 * modules. Set Cue media
 * (theatre/cues/…) is never deleted through the proxy.
 */
const DELETABLE = ['theatre/projects/', 'theatre/setcue-projects/', 'theatre/daw/', 'theatre/public/', 'theatre/modules/', 'theatre/cues/', 'theatre/hits/', 'theatre/_trash/']
const deletable = (key: string) => validKey(key) && DELETABLE.some((p) => key.startsWith(p) && key.length > p.length)
const MAX_DELETE = 500

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest()
/** RFC 3986 encoding, as SigV4 expects (slashes kept between key segments). */
const encode = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
const encodeKey = (key: string) => key.split('/').map(encode).join('/')

const TYPES: Record<string, string> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  aif: 'audio/aiff',
  aiff: 'audio/aiff',
  webm: 'audio/webm',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  json: 'application/json',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
}
const typeOf = (key: string) => TYPES[key.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream'

/** A tiny S3 client for one R2 bucket (path-style URLs, region "auto"). */
export function r2Client(opts: Required<R2Options>) {
  const origin = opts.endpoint.replace(/\/+$/, '')
  const host = new URL(origin).host

  function sign(method: string, key: string, query: Record<string, string> = {}, extraHeaders: Record<string, string> = {}) {
    const now = new Date()
    const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, '')
    const day = amzDate.slice(0, 8)
    const path = `/${encode(opts.bucket)}${key ? `/${encodeKey(key)}` : ''}`
    const canonicalQuery = Object.keys(query)
      .sort()
      .map((k) => `${encode(k)}=${encode(query[k])}`)
      .join('&')
    const headers: Record<string, string> = { host, 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', 'x-amz-date': amzDate, ...extraHeaders }
    const names = Object.keys(headers).map((h) => h.toLowerCase()).sort()
    const canonicalHeaders = names.map((h) => `${h}:${String(headers[Object.keys(headers).find((k) => k.toLowerCase() === h)!]).trim()}\n`).join('')
    const signedHeaders = names.join(';')
    const canonical = [method, path, canonicalQuery, canonicalHeaders, signedHeaders, 'UNSIGNED-PAYLOAD'].join('\n')
    const scope = `${day}/auto/s3/aws4_request`
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n')
    const kSigning = hmac(hmac(hmac(hmac(`AWS4${opts.secretAccessKey}`, day), 'auto'), 's3'), 'aws4_request')
    const signature = createHmac('sha256', kSigning).update(toSign).digest('hex')
    const url = `${origin}${path}${canonicalQuery ? `?${canonicalQuery}` : ''}`
    const { host: _host, ...sendHeaders } = headers
    return { url, headers: { ...sendHeaders, authorization: `AWS4-HMAC-SHA256 Credential=${opts.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` } }
  }

  return {
    async put(key: string, body: Buffer, contentType: string, cacheControl?: string) {
      const { url, headers } = sign('PUT', key, {}, { 'content-type': contentType, ...(cacheControl ? { 'cache-control': cacheControl } : {}) })
      const res = await fetch(url, { method: 'PUT', headers, body: new Uint8Array(body), signal: AbortSignal.timeout(120_000) })
      if (!res.ok) throw new Error(`R2 上傳失敗（HTTP ${res.status}）${(await res.text()).slice(0, 200)}`)
    },
    async get(key: string, forward: Record<string, string>) {
      const { url, headers } = sign('GET', key)
      // The timeout covers waiting for R2 to answer — not the download itself, which can be a long
      // audio stream (a whole-request timeout would cut playback after a minute).
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 30_000)
      try {
        return await fetch(url, { headers: { ...headers, ...forward }, signal: ctrl.signal })
      } finally {
        clearTimeout(timer)
      }
    },
    async remove(key: string) {
      const { url, headers } = sign('DELETE', key)
      const res = await fetch(url, { method: 'DELETE', headers, signal: AbortSignal.timeout(20_000) })
      if (!res.ok && res.status !== 404) throw new Error(`R2 刪除失敗（HTTP ${res.status}）`)
    },
    async list(prefix: string) {
      const items: { key: string; size: number; lastModified: number }[] = []
      let token: string | undefined
      for (let page = 0; page < 10; page++) {
        const query: Record<string, string> = { 'list-type': '2', prefix, 'max-keys': '1000' }
        if (token) query['continuation-token'] = token
        const { url, headers } = sign('GET', '', query)
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) })
        const xml = await res.text()
        if (!res.ok) throw new Error(`R2 列表失敗（HTTP ${res.status}）${/<Message>([^<]*)/.exec(xml)?.[1] ?? ''}`)
        for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
          const tag = (t: string) => new RegExp(`<${t}>([^<]*)</${t}>`).exec(m[1])?.[1] ?? ''
          items.push({ key: tag('Key').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'"), size: Number(tag('Size')), lastModified: Date.parse(tag('LastModified')) || 0 })
        }
        token = /<NextContinuationToken>([^<]*)/.exec(xml)?.[1]
        if (!/<IsTruncated>true/.test(xml) || !token) break
      }
      return items
    },
  }
}

/**
 * Stream an R2 response body to the client. Errors (R2 dropping the connection) end the response
 * instead of crashing the server, and a client that goes away stops the download from R2.
 */
function pipeBody(body: ReadableStream<Uint8Array>, req: IncomingMessage, res: ServerResponse) {
  const stream = Readable.fromWeb(body as import('node:stream/web').ReadableStream)
  stream.on('error', () => res.destroy())
  res.on('close', () => stream.destroy())
  req.on('aborted', () => stream.destroy())
  stream.pipe(res)
}

export const r2Url = (key: string) => `/api/r2/o/${encodeKey(key)}`

export function r2Proxy(opts: R2Options): Plugin {
  const configured = !!(opts.endpoint && opts.bucket && opts.accessKeyId && opts.secretAccessKey)
  const client = configured ? r2Client(opts as Required<R2Options>) : null
  const access = projectAccess(opts.databaseUrl)
  /** Media folder name of a key under theatre/daw|cues|hits/<folder>/…, if any. */
  const mediaFolderOf = (key: string) => /^theatre\/(?:daw|cues|hits)\/([^/]+)\//.exec(key)?.[1] ?? null

  /** May this caller delete this key? (deletable() has already checked the prefix.) */
  async function mayDelete(key: string, c: Caller): Promise<boolean> {
    if (await access.isAdmin(c)) return true
    if (!(await access.signedIn(c))) return false
    const owner = projectOfKey(key)
    if (owner?.kind === 'setcue-file') return false // a whole Set Cue project: admins only
    if (owner?.kind === 'daw-file') return (await access.canWrite(owner.pid, c)) && (await access.projectKind(owner.pid, c)) !== 'studio'
    if (owner?.kind === 'public') return access.canWrite(owner.pid, c)
    const module = /^theatre\/modules\/([\w-]+)\.json$/.exec(key)
    if (module) return access.ownsModule(module[1], c)
    const folder = mediaFolderOf(key)
    // Media in a project's own folders (cue files, hits, studio audio): its members, unless the
    // project is read-only (Studio 素材 panel). The shared Default folder is never in
    // writableFolders, so it stays admins only (global file manager).
    return !!folder && (await access.writableFolders(c)).has(folder)
  }

  /** May this caller list this prefix, and if only partly, which items? */
  async function listFilter(prefix: string, c: Caller): Promise<((key: string) => Promise<boolean>) | 'all' | null> {
    if (await access.isAdmin(c)) return 'all'
    if (!(await access.signedIn(c))) return null
    if (prefix.startsWith('theatre/modules/')) return 'all'
    if (/^theatre\/(projects|setcue-projects|public)\/$/.test(prefix)) {
      return async (key) => {
        const owner = projectOfKey(key)
        return !!owner && access.isMember(owner.pid, c)
      }
    }
    const scoped = /^theatre\/(?:projects|public)\/([\w-]+)\//.exec(prefix)
    if (scoped) return (await access.isMember(scoped[1], c)) ? 'all' : null
    if (/^theatre\/(daw|cues|hits)\//.test(prefix)) {
      const mine = await access.folders(c)
      return async (key) => {
        const folder = mediaFolderOf(key)
        return !!folder && mine.has(folder)
      }
    }
    return null
  }

  /** A delivery URL from this app's own Cloudinary account (never any other host). */
  const importable = (raw: string) => {
    try {
      const u = new URL(raw)
      return u.protocol === 'https:' && u.hostname === 'res.cloudinary.com' && !!opts.cloudinaryCloud && u.pathname.startsWith(`/${opts.cloudinaryCloud}/`) && /\/(image|video|raw)\/upload\//.test(u.pathname) ? u : null
    } catch {
      return null
    }
  }

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(body))
  }

  async function readBody(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      size += (chunk as Buffer).length
      if (size > MAX_UPLOAD) throw Object.assign(new Error('檔案太大（上限 250 MB）'), { status: 413 })
      chunks.push(chunk as Buffer)
    }
    return Buffer.concat(chunks)
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '', 'http://x')
    const path = url.pathname
    if (path === '/status') return json(res, 200, { configured, bucket: configured ? opts.bucket : null, publicBaseUrl: opts.publicBaseUrl?.replace(/\/+$/, '') || null })
    if (!client) return json(res, 503, { configured: false, error: 'R2 尚未設定（.env.local 的 R2_* 變數）' })

    // Published audio: readable by anyone (Notion, other sites), only under theatre/public/.
    if (path.startsWith('/pub/')) {
      res.setHeader('access-control-allow-origin', '*')
      res.setHeader('access-control-allow-methods', 'GET, HEAD, OPTIONS')
      res.setHeader('access-control-allow-headers', 'Range')
      res.setHeader('access-control-expose-headers', 'Content-Length, Content-Range, Accept-Ranges, Content-Type')
      if (req.method === 'OPTIONS') {
        res.statusCode = 204
        return res.end()
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' })
      const key = decodeURIComponent(path.slice(5))
      if (!validKey(key) || !key.startsWith(PUBLIC_PREFIX)) return json(res, 404, { error: 'not found' })
      const forward: Record<string, string> = {}
      for (const h of ['range', 'if-none-match', 'if-modified-since']) if (typeof req.headers[h] === 'string') forward[h] = req.headers[h] as string
      const upstream = await client.get(key, forward)
      if (upstream.status === 404) return json(res, 404, { error: '檔案不存在或已取消發布' })
      res.statusCode = upstream.status
      // The type comes from the extension, so a .mp3 is always audio/mpeg (what embed players check).
      res.setHeader('content-type', typeOf(key))
      for (const h of ['content-length', 'content-range', 'etag', 'last-modified']) {
        const v = upstream.headers.get(h)
        if (v) res.setHeader(h, v)
      }
      res.setHeader('accept-ranges', 'bytes')
      res.setHeader('content-disposition', `inline; filename="${key.split('/').pop()}"`)
      res.setHeader('cache-control', isLiveKey(key) ? LIVE_CACHE : 'public, max-age=3600')
      res.setHeader('x-content-type-options', 'nosniff')
      if (req.method === 'HEAD' || !upstream.body) return res.end()
      pipeBody(upstream.body, req, res)
      return
    }
    // Writes must come from this app's own pages (blocks cross-site form / fetch posts).
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin
      if (origin && origin !== 'null') {
        let host = ''
        try {
          host = new URL(origin).host
        } catch {
          /* invalid origin */
        }
        // Over HTTP/2 (Vite with https) there is no Host header, only :authority.
        const reqHost = req.headers.host ?? (req.headers[':authority'] as string | undefined)
        if (host !== reqHost) return json(res, 403, { error: '拒絕跨站請求' })
      }
    }

    if (path === '/delete' && req.method === 'POST') {
      let keys: unknown
      try {
        keys = (JSON.parse((await readBody(req)).toString('utf8')) as { keys?: unknown }).keys
      } catch {
        return json(res, 400, { error: '格式錯誤' })
      }
      if (!Array.isArray(keys) || keys.length === 0 || keys.length > MAX_DELETE || !keys.every((k) => typeof k === 'string')) return json(res, 400, { error: `keys 必須是 1–${MAX_DELETE} 個路徑` })
      const bad = (keys as string[]).find((k) => !deletable(k))
      if (bad) return json(res, 400, { error: `不能刪除這個路徑：${bad}（只允許 ${DELETABLE.join('、')}）` })
      const caller = callerOf(req)
      for (const k of new Set(keys as string[])) {
        if (!(await mayDelete(k, caller))) return json(res, 403, { error: `沒有權限刪除：${k}（整個專案的檔案只有管理員能刪除；其他檔案限專案成員）` })
      }
      const deleted: string[] = []
      try {
        for (const key of new Set(keys as string[])) {
          await client.remove(key)
          deleted.push(key)
        }
        return json(res, 200, { deleted })
      } catch (err) {
        return json(res, 502, { deleted, error: (err as Error).message })
      }
    }

    // Copy an object to a new key (admins: moving / assigning files in the global file manager).
    if (path === '/copy' && req.method === 'POST') {
      if (!(await access.isAdmin(callerOf(req)))) return json(res, 403, { error: '只有管理員可以複製或移動檔案' })
      let from = ''
      let to = ''
      try {
        ;({ from = '', to = '' } = JSON.parse((await readBody(req)).toString('utf8')) as { from?: string; to?: string })
      } catch {
        return json(res, 400, { error: '格式錯誤' })
      }
      if (!validKey(from) || !validKey(to) || from === to) return json(res, 400, { error: '檔案路徑不合法' })
      try {
        const upstream = await client.get(from, {})
        if (upstream.status === 404) return json(res, 404, { error: '來源檔案不存在' })
        if (!upstream.ok) return json(res, 502, { error: `讀取來源失敗（HTTP ${upstream.status}）` })
        const body = Buffer.from(await upstream.arrayBuffer())
        const contentType = (upstream.headers.get('content-type') ?? '').split(';')[0].trim() || typeOf(to)
        await client.put(to, body, contentType)
        return json(res, 200, { key: to, url: r2Url(to), bytes: body.length })
      } catch (err) {
        return json(res, 502, { error: (err as Error).message })
      }
    }

    if (path === '/upload' && req.method === 'POST') {
      const key = url.searchParams.get('key') ?? ''
      if (!validKey(key)) return json(res, 400, { error: '檔案路徑不合法（必須在 theatre/ 底下）' })
      const caller = callerOf(req)
      if (!(await access.signedIn(caller))) return json(res, 401, { error: '請先登入' })
      // Project files and media folders: only projects the caller may edit (members of a project
      // that isn't locked / a template / archived; admins anything).
      const owner = projectOfKey(key)
      if (owner && !(await access.canWrite(owner.pid, caller))) return json(res, 403, { error: '沒有權限：不是專案成員，或專案已鎖定為唯讀' })
      const folder = mediaFolderOf(key)
      if (folder && folder !== 'Default' && !(await access.isAdmin(caller)) && !(await access.writableFolders(caller)).has(folder)) return json(res, 403, { error: '沒有權限上傳到這個專案（專案已鎖定為唯讀，或你不是成員）' })
      try {
        const body = await readBody(req)
        const contentType = /^(audio|video|image)\/[\w.+-]+$|^application\/json$/.test(req.headers['content-type'] ?? '') ? req.headers['content-type']! : typeOf(key)
        // Stored with the object too, for when it's served straight from an R2 public domain.
        await client.put(key, body, contentType, isLiveKey(key) ? LIVE_CACHE : undefined)
        return json(res, 200, { key, url: r2Url(key), bytes: body.length, contentType })
      } catch (err) {
        const e = err as Error & { status?: number }
        return json(res, e.status ?? 502, { error: e.message })
      }
    }

    if (path === '/import' && req.method === 'POST') {
      const key = url.searchParams.get('key') ?? ''
      if (!validKey(key)) return json(res, 400, { error: '檔案路徑不合法（必須在 theatre/ 底下）' })
      const importer = callerOf(req)
      if (!(await access.signedIn(importer))) return json(res, 401, { error: '請先登入' })
      const target = mediaFolderOf(key)
      if (target !== 'Default' && !(await access.isAdmin(importer)) && (!target || !(await access.writableFolders(importer)).has(target))) return json(res, 403, { error: '沒有權限匯入到這個專案（專案已鎖定為唯讀，或你不是成員）' })
      const source = importable(url.searchParams.get('url') ?? '')
      if (!source) return json(res, 400, { error: '只能匯入本帳號 Cloudinary 的檔案（https://res.cloudinary.com/…）' })
      try {
        const upstream = await fetch(source, { redirect: 'error', signal: AbortSignal.timeout(120_000) })
        if (!upstream.ok) return json(res, 502, { error: `讀取 Cloudinary 檔案失敗（HTTP ${upstream.status}）` })
        const declared = Number(upstream.headers.get('content-length') ?? 0)
        if (declared > MAX_UPLOAD) return json(res, 413, { error: '檔案太大（上限 250 MB）' })
        const body = Buffer.from(await upstream.arrayBuffer())
        if (body.length > MAX_UPLOAD) return json(res, 413, { error: '檔案太大（上限 250 MB）' })
        const upstreamType = (upstream.headers.get('content-type') ?? '').split(';')[0].trim()
        const contentType = /^(audio|video|image)\/[\w.+-]+$/.test(upstreamType) ? upstreamType : typeOf(key)
        await client.put(key, body, contentType)
        return json(res, 200, { key, url: r2Url(key), bytes: body.length, contentType })
      } catch (err) {
        return json(res, 502, { error: (err as Error).message })
      }
    }

    if (path === '/list' && req.method === 'GET') {
      const prefix = url.searchParams.get('prefix') ?? ''
      if (!/^theatre\//.test(prefix) || prefix.includes('..')) return json(res, 400, { error: '只能列出 theatre/ 底下的資料夾' })
      const kind = url.searchParams.get('kind') === 'raw' ? 'raw' : 'media'
      const folder = prefix.endsWith('/') ? prefix : `${prefix}/`
      const filter = await listFilter(folder, callerOf(req))
      if (!filter) return json(res, 403, { configured: true, error: '沒有權限列出這個資料夾' })
      try {
        const listed = await client.list(folder)
        const allowed = filter === 'all' ? listed : (await Promise.all(listed.map(async (o) => ((await filter(o.key)) ? o : null)))).filter((o): o is (typeof listed)[number] => !!o)
        const items = allowed
          .filter((o) => !o.key.endsWith('/'))
          .filter((o) => (kind === 'raw' ? typeOf(o.key) === 'application/json' : /^(audio|video|image)\//.test(typeOf(o.key))))
          .map((o) => ({ ...o, name: o.key.split('/').pop()!, url: r2Url(o.key), contentType: typeOf(o.key) }))
        return json(res, 200, { configured: true, items })
      } catch (err) {
        return json(res, 502, { configured: true, error: (err as Error).message })
      }
    }

    if (path.startsWith('/o/') && (req.method === 'GET' || req.method === 'HEAD')) {
      const key = decodeURIComponent(path.slice(3))
      if (!validKey(key)) return json(res, 400, { error: '檔案路徑不合法' })
      // Project files hold a whole project: members (and admins) only.
      const owner = projectOfKey(key)
      if (owner && owner.kind !== 'public') {
        const caller = callerOf(req)
        if (!(await access.isMember(owner.pid, caller)) && !(await access.isAdmin(caller))) return json(res, 403, { error: '沒有這個專案的存取權' })
      }
      if (key.startsWith('theatre/modules/') && !(await access.signedIn(callerOf(req)))) return json(res, 401, { error: '請先登入' })
      // Pass Range / conditional headers through, so audio and video can seek and be cached.
      const forward: Record<string, string> = {}
      for (const h of ['range', 'if-none-match', 'if-modified-since']) if (typeof req.headers[h] === 'string') forward[h] = req.headers[h] as string
      const upstream = await client.get(key, forward)
      res.statusCode = upstream.status
      for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
        const v = upstream.headers.get(h)
        if (v) res.setHeader(h, v)
      }
      if (!upstream.headers.get('accept-ranges')) res.setHeader('accept-ranges', 'bytes')
      res.setHeader('cache-control', 'private, max-age=3600')
      if (upstream.status === 404) return json(res, 404, { error: '檔案不存在' })
      if (req.method === 'HEAD' || !upstream.body) return res.end()
      pipeBody(upstream.body, req, res)
      return
    }
    json(res, 404, { error: 'not found' })
  }

  // Must return nothing: a function returned from configureServer is run as a post-hook.
  const mount = (server: { middlewares: { use: (path: string, fn: (req: IncomingMessage, res: ServerResponse) => void) => unknown } }) => {
    server.middlewares.use('/api/r2', (req, res) => {
      handle(req, res).catch((err) => {
        if (!res.headersSent) json(res, 500, { error: (err as Error).message })
        else res.end()
      })
    })
  }
  return { name: 'r2-proxy', configureServer: mount, configurePreviewServer: mount }
}
