import { notionFailure, notionIdOf, readNotionPage } from '../server/notionCore.ts'
import { ttsRoute } from './tts.ts'
import { callerFromHeaders, projectAccess, projectOfKey, type Caller } from '../server/projectAccess.ts'

/**
 * Cloudflare Worker version of server/r2Proxy.ts: the same /api/r2/* routes and access rules,
 * but the bucket is a Worker binding (no S3 keys), and requests come cross-origin from the
 * GitHub Pages site, so the caller's Firebase ID token arrives as an Authorization header.
 */

interface Env {
  BUCKET: R2Bucket
  DATABASE_URL: string
  CLOUDINARY_CLOUD: string
  ALLOWED_ORIGINS: string
  PUBLIC_BASE_URL?: string
  /** Google Cloud service-account key (JSON) for /api/tts — set with `wrangler secret put GOOGLE_SA_JSON`. */
  GOOGLE_SA_JSON?: string
  TTS_DAILY_CHARS?: string
}

const PUBLIC_PREFIX = 'theatre/public/'
const isLiveKey = (key: string) => key.startsWith(PUBLIC_PREFIX) && key.includes('/live/')
const LIVE_CACHE = 'no-cache, must-revalidate'
const MAX_UPLOAD = 250 * 1024 * 1024
const MAX_DELETE = 500
const DELETABLE = ['theatre/projects/', 'theatre/setcue-projects/', 'theatre/daw/', 'theatre/public/', 'theatre/modules/', 'theatre/cues/', 'theatre/hits/', 'theatre/_trash/']

const validKey = (key: string) =>
  key.startsWith('theatre/') && key.length <= 490 && !key.includes('..') && !/[\\?#]/.test(key) && ![...key].some((c) => c.charCodeAt(0) < 32)
const deletable = (key: string) => validKey(key) && DELETABLE.some((p) => key.startsWith(p) && key.length > p.length)
const encodeKey = (key: string) => key.split('/').map(encodeURIComponent).join('/')
const r2Url = (key: string) => `/api/r2/o/${encodeKey(key)}`

const TYPES: Record<string, string> = {
  wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
  flac: 'audio/flac', aif: 'audio/aiff', aiff: 'audio/aiff', webm: 'audio/webm', mp4: 'video/mp4', mov: 'video/quicktime',
  json: 'application/json', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
}
const typeOf = (key: string) => TYPES[key.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream'
/** Any signed-in user may add files to the shared Default folders (deleting stays admin-only). */
const isDefaultKey = (key: string) => mediaFolderOf(key) === 'Default'
const mediaFolderOf = (key: string) => /^theatre\/(?:daw|cues|hits)\/([^/]+)\//.exec(key)?.[1] ?? null

function corsHeaders(req: Request, env: Env, open = false): Headers {
  const h = new Headers()
  const origin = req.headers.get('origin')
  const allowed = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim())
  if (open) h.set('access-control-allow-origin', '*')
  else if (origin && allowed.includes(origin)) {
    h.set('access-control-allow-origin', origin)
    h.set('vary', 'Origin')
  }
  h.set('access-control-allow-methods', 'GET, HEAD, POST, OPTIONS')
  h.set('access-control-allow-headers', 'Authorization, Content-Type, Range, If-None-Match, If-Modified-Since')
  h.set('access-control-expose-headers', 'Content-Length, Content-Range, Accept-Ranges, Content-Type, ETag')
  h.set('access-control-max-age', '86400')
  return h
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    const open = url.pathname.startsWith('/api/r2/pub/')
    const cors = corsHeaders(req, env, open)
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
    let res: Response
    try {
      res = await handle(req, env, url)
    } catch (err) {
      res = json(500, { error: (err as Error).message })
    }
    const out = new Response(res.body, res)
    cors.forEach((v, k) => out.headers.set(k, v))
    return out
  },
} satisfies ExportedHandler<Env>

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

/**
 * GET /api/notion?id=<page id>: a published Notion page as simple blocks (the same reader the dev server
 * uses; no token needed — the page just has to be "Shared to web"). Complete pages are cached at the
 * edge for 45 s, so reopening a note is instant and Notion isn't asked on every click.
 */
async function notionRoute(req: Request, url: URL): Promise<Response> {
  if (req.method !== 'GET') return json(405, { error: 'invalid_url', message: 'method not allowed' })
  const id = notionIdOf(url.searchParams.get('id'))
  if (!id) return json(400, { error: 'invalid_url', message: '網址中找不到 Notion 頁面 ID' })
  const key = new Request(`https://notion-cache.invalid/${id.replace(/-/g, '').toLowerCase()}`)
  const cache = caches.default
  const hit = await cache.match(key)
  if (hit) {
    const res = new Response(hit.body, hit)
    res.headers.set('cache-control', 'no-store')
    res.headers.set('x-cache', 'HIT')
    return res
  }
  try {
    const page = await readNotionPage(id)
    // A page with blocks still missing is not cached: the app retries and should really ask again.
    if (page.unresolved === 0) {
      await cache.put(key, new Response(JSON.stringify(page), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=45' } }))
    }
    return json(200, page)
  } catch (err) {
    const f = notionFailure(err)
    return json(f.status, f.body)
  }
}

async function handle(req: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname === '/api/notion') return notionRoute(req, url)
  if (url.pathname === '/api/tts' || url.pathname.startsWith('/api/tts/')) return ttsRoute(req, env, url)
  if (!url.pathname.startsWith('/api/r2/')) return json(404, { error: 'not found' })
  const path = url.pathname.slice('/api/r2'.length)
  const access = projectAccess(env.DATABASE_URL)
  const caller = callerFromHeaders(req.headers.get('authorization'), null)

  if (path === '/status') return json(200, { configured: true, bucket: 'binding', publicBaseUrl: env.PUBLIC_BASE_URL?.replace(/\/+$/, '') || null })

  // Published audio: public, only under theatre/public/.
  if (path.startsWith('/pub/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(405, { error: 'method not allowed' })
    const key = decodeURIComponent(path.slice(5))
    if (!validKey(key) || !key.startsWith(PUBLIC_PREFIX)) return json(404, { error: 'not found' })
    return serve(req, env, key, isLiveKey(key) ? LIVE_CACHE : 'public, max-age=3600', true)
  }

  // Writes only from the allowed site origins (the browser always sends Origin on cross-origin posts).
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.get('origin')
    if (!origin || !env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).includes(origin)) return json(403, { error: '拒絕跨站請求' })
  }

  const mayDelete = async (key: string, c: Caller): Promise<boolean> => {
    if (await access.isAdmin(c)) return true
    if (!(await access.signedIn(c))) return false
    const owner = projectOfKey(key)
    if (owner?.kind === 'setcue-file') return false
    if (owner?.kind === 'daw-file') return (await access.canWrite(owner.pid, c)) && (await access.projectKind(owner.pid, c)) !== 'studio'
    if (owner?.kind === 'public') return access.canWrite(owner.pid, c)
    const module = /^theatre\/modules\/([\w-]+)\.json$/.exec(key)
    if (module) return access.ownsModule(module[1], c)
    const folder = mediaFolderOf(key)
    return !!folder && (await access.writableFolders(c)).has(folder)
  }

  const listFilter = async (prefix: string, c: Caller): Promise<((key: string) => Promise<boolean>) | 'all' | null> => {
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

  if (path === '/delete' && req.method === 'POST') {
    let keys: unknown
    try {
      keys = ((await req.json()) as { keys?: unknown }).keys
    } catch {
      return json(400, { error: '格式錯誤' })
    }
    if (!Array.isArray(keys) || keys.length === 0 || keys.length > MAX_DELETE || !keys.every((k) => typeof k === 'string')) return json(400, { error: `keys 必須是 1–${MAX_DELETE} 個路徑` })
    const bad = (keys as string[]).find((k) => !deletable(k))
    if (bad) return json(400, { error: `不能刪除這個路徑：${bad}（只允許 ${DELETABLE.join('、')}）` })
    for (const k of new Set(keys as string[])) {
      if (!(await mayDelete(k, caller))) return json(403, { error: `沒有權限刪除：${k}（整個專案的檔案只有管理員能刪除；其他檔案限專案成員）` })
    }
    const deleted = [...new Set(keys as string[])]
    await env.BUCKET.delete(deleted)
    return json(200, { deleted })
  }

  if (path === '/copy' && req.method === 'POST') {
    if (!(await access.isAdmin(caller))) return json(403, { error: '只有管理員可以複製或移動檔案' })
    const { from = '', to = '' } = (await req.json().catch(() => ({}))) as { from?: string; to?: string }
    if (!validKey(from) || !validKey(to) || from === to) return json(400, { error: '檔案路徑不合法' })
    const src = await env.BUCKET.get(from)
    if (!src) return json(404, { error: '來源檔案不存在' })
    await env.BUCKET.put(to, src.body, { httpMetadata: { contentType: src.httpMetadata?.contentType || typeOf(to) } })
    return json(200, { key: to, url: r2Url(to), bytes: src.size })
  }

  if (path === '/upload' && req.method === 'POST') {
    const key = url.searchParams.get('key') ?? ''
    if (!validKey(key)) return json(400, { error: '檔案路徑不合法（必須在 theatre/ 底下）' })
    if (!(await access.signedIn(caller))) return json(401, { error: '請先登入' })
    const owner = projectOfKey(key)
    if (owner && !(await access.canWrite(owner.pid, caller))) return json(403, { error: '沒有權限：不是專案成員，或專案已鎖定為唯讀' })
    const folder = mediaFolderOf(key)
    if (folder && !isDefaultKey(key) && !(await access.isAdmin(caller)) && !(await access.writableFolders(caller)).has(folder)) return json(403, { error: '沒有權限上傳到這個專案（專案已鎖定為唯讀，或你不是成員）' })
    const declared = Number(req.headers.get('content-length') ?? 0)
    if (declared > MAX_UPLOAD) return json(413, { error: '檔案太大（上限 250 MB）' })
    const body = await req.arrayBuffer()
    if (body.byteLength > MAX_UPLOAD) return json(413, { error: '檔案太大（上限 250 MB）' })
    const sent = req.headers.get('content-type') ?? ''
    const contentType = /^(audio|video|image)\/[\w.+-]+$|^application\/json$/.test(sent) ? sent : typeOf(key)
    await env.BUCKET.put(key, body, { httpMetadata: { contentType, ...(isLiveKey(key) ? { cacheControl: LIVE_CACHE } : {}) } })
    return json(200, { key, url: r2Url(key), bytes: body.byteLength, contentType })
  }

  if (path === '/import' && req.method === 'POST') {
    const key = url.searchParams.get('key') ?? ''
    if (!validKey(key)) return json(400, { error: '檔案路徑不合法（必須在 theatre/ 底下）' })
    if (!(await access.signedIn(caller))) return json(401, { error: '請先登入' })
    const target = mediaFolderOf(key)
    if (!isDefaultKey(key) && !(await access.isAdmin(caller)) && (!target || !(await access.writableFolders(caller)).has(target))) return json(403, { error: '沒有權限匯入到這個專案（專案已鎖定為唯讀，或你不是成員）' })
    let source: URL | null = null
    try {
      const u = new URL(url.searchParams.get('url') ?? '')
      if (u.protocol === 'https:' && u.hostname === 'res.cloudinary.com' && !!env.CLOUDINARY_CLOUD && u.pathname.startsWith(`/${env.CLOUDINARY_CLOUD}/`) && /\/(image|video|raw)\/upload\//.test(u.pathname)) source = u
    } catch {
      /* invalid url */
    }
    if (!source) return json(400, { error: '只能匯入本帳號 Cloudinary 的檔案（https://res.cloudinary.com/…）' })
    const upstream = await fetch(source, { redirect: 'error' })
    if (!upstream.ok) return json(502, { error: `讀取 Cloudinary 檔案失敗（HTTP ${upstream.status}）` })
    if (Number(upstream.headers.get('content-length') ?? 0) > MAX_UPLOAD) return json(413, { error: '檔案太大（上限 250 MB）' })
    const body = await upstream.arrayBuffer()
    if (body.byteLength > MAX_UPLOAD) return json(413, { error: '檔案太大（上限 250 MB）' })
    const up = (upstream.headers.get('content-type') ?? '').split(';')[0].trim()
    const contentType = /^(audio|video|image)\/[\w.+-]+$/.test(up) ? up : typeOf(key)
    await env.BUCKET.put(key, body, { httpMetadata: { contentType } })
    return json(200, { key, url: r2Url(key), bytes: body.byteLength, contentType })
  }

  if (path === '/list' && req.method === 'GET') {
    const prefix = url.searchParams.get('prefix') ?? ''
    if (!/^theatre\//.test(prefix) || prefix.includes('..')) return json(400, { error: '只能列出 theatre/ 底下的資料夾' })
    const kind = url.searchParams.get('kind') === 'raw' ? 'raw' : 'media'
    const folder = prefix.endsWith('/') ? prefix : `${prefix}/`
    const filter = await listFilter(folder, caller)
    if (!filter) return json(403, { configured: true, error: '沒有權限列出這個資料夾' })
    const listed: { key: string; size: number; lastModified: number }[] = []
    let cursor: string | undefined
    for (let page = 0; page < 10; page++) {
      const r = await env.BUCKET.list({ prefix: folder, cursor, limit: 1000 })
      for (const o of r.objects) listed.push({ key: o.key, size: o.size, lastModified: o.uploaded.getTime() })
      if (!r.truncated) break
      cursor = r.cursor
    }
    const allowed = filter === 'all' ? listed : (await Promise.all(listed.map(async (o) => ((await filter(o.key)) ? o : null)))).filter((o): o is (typeof listed)[number] => !!o)
    const items = allowed
      .filter((o) => !o.key.endsWith('/'))
      .filter((o) => (kind === 'raw' ? typeOf(o.key) === 'application/json' : /^(audio|video|image)\//.test(typeOf(o.key))))
      .map((o) => ({ ...o, name: o.key.split('/').pop()!, url: r2Url(o.key), contentType: typeOf(o.key) }))
    return json(200, { configured: true, items })
  }

  if (path.startsWith('/o/') && (req.method === 'GET' || req.method === 'HEAD')) {
    const key = decodeURIComponent(path.slice(3))
    if (!validKey(key)) return json(400, { error: '檔案路徑不合法' })
    const owner = projectOfKey(key)
    if (owner && owner.kind !== 'public') {
      if (!(await access.isMember(owner.pid, caller)) && !(await access.isAdmin(caller))) return json(403, { error: '沒有這個專案的存取權' })
    }
    if (key.startsWith('theatre/modules/') && !(await access.signedIn(caller))) return json(401, { error: '請先登入' })
    return serve(req, env, key, 'private, max-age=3600', false)
  }
  return json(404, { error: 'not found' })
}

/** Stream an object (Range supported, so audio and video can seek). */
async function serve(req: Request, env: Env, key: string, cacheControl: string, forceType: boolean): Promise<Response> {
  const obj = await env.BUCKET.get(key, { range: req.headers, onlyIf: req.headers })
  if (!obj) return json(404, { error: forceType ? '檔案不存在或已取消發布' : '檔案不存在' })
  const h = new Headers()
  obj.writeHttpMetadata(h)
  h.set('etag', obj.httpEtag)
  h.set('last-modified', obj.uploaded.toUTCString())
  h.set('accept-ranges', 'bytes')
  h.set('cache-control', cacheControl)
  if (forceType) {
    h.set('content-type', typeOf(key))
    h.set('content-disposition', `inline; filename="${key.split('/').pop()}"`)
    h.set('x-content-type-options', 'nosniff')
  }
  if (!('body' in obj)) return new Response(null, { status: 304, headers: h })
  let status = 200
  const range = (obj as R2ObjectBody & { range?: { offset?: number; length?: number; suffix?: number } }).range
  if (range && req.headers.get('range')) {
    const start = range.offset ?? (range.suffix !== undefined ? obj.size - range.suffix : 0)
    const length = range.length ?? obj.size - start
    h.set('content-range', `bytes ${start}-${start + length - 1}/${obj.size}`)
    h.set('content-length', String(length))
    status = 206
  } else {
    h.set('content-length', String(obj.size))
  }
  return new Response(req.method === 'HEAD' ? null : (obj as R2ObjectBody).body, { status, headers: h })
}
