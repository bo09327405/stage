import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'

/**
 * Cloudinary routes on the dev / preview server — for Set Cue and audience uploads only (the DAW
 * Studio stores everything on R2 through /api/r2/*):
 *
 *   GET /api/cloudinary/status                          → { configured, cloudName, retention }
 *   GET /api/cloudinary/folder?path=theatre/cues/Default → { configured, items } (Search API)
 *   GET /api/cloudinary/moderation?type=image|video&publicId=theatre/…
 *                                                       → { configured, status, checks }
 *
 * These use the Admin API, which needs the account's API key and secret; those must never reach
 * the browser, so they are read here from CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET in .env.local
 * (no VITE_ prefix, so Vite never bundles them). Without them the routes answer
 * { configured: false } and the app falls back to its own index / operator review.
 *
 * Retention: there is deliberately no delete, invalidate or "clear cache" route. Audience files are
 * kept on Cloudinary permanently. Only assets under theatre/ can be listed or looked up.
 */

interface Options {
  cloudName?: string
  apiKey?: string
  apiSecret?: string
}

interface SearchResource {
  public_id: string
  secure_url: string
  resource_type: 'image' | 'video' | 'raw'
  format?: string
  bytes?: number
  duration?: number
  created_at?: string
  folder?: string
  asset_folder?: string
  display_name?: string
  filename?: string
  is_audio?: boolean
  width?: number
}

const CACHE_MS = 30_000
const AUDIO_FORMATS = new Set(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'aif', 'aiff', 'weba'])

/** Map a Search API resource to the app's media library entry shape. */
export function toMediaEntry(r: SearchResource, folder: string) {
  const format = (r.format ?? '').toLowerCase()
  const kind = r.resource_type === 'image' ? 'image' : r.is_audio || AUDIO_FORMATS.has(format) || (r.resource_type === 'video' && !r.width && !!r.duration) ? 'audio' : 'video'
  const base = r.display_name || r.filename || r.public_id.split('/').at(-1) || r.public_id
  return {
    id: `cld:${r.resource_type}:${r.public_id}`,
    kind,
    url: r.secure_url,
    publicId: r.public_id,
    folder: r.asset_folder ?? r.folder ?? folder,
    name: format && !base.toLowerCase().endsWith(`.${format}`) ? `${base}.${format}` : base,
    duration: r.duration ?? 0,
    bytes: r.bytes ?? 0,
    source: 'link' as const,
    createdAt: r.created_at ? Date.parse(r.created_at) : 0,
  }
}

async function search(opts: Required<Options>, expression: string) {
  const res = await fetch(`https://api.cloudinary.com/v1_1/${opts.cloudName}/resources/search`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Basic ${Buffer.from(`${opts.apiKey}:${opts.apiSecret}`).toString('base64')}`,
    },
    body: JSON.stringify({ expression, max_results: 500, sort_by: [{ created_at: 'desc' }] }),
    signal: AbortSignal.timeout(15_000),
  })
  const body = (await res.json().catch(() => ({}))) as { resources?: SearchResource[]; error?: { message?: string } }
  if (!res.ok) {
    const reason = res.status === 401 ? 'API Key / Secret 不正確' : (body.error?.message ?? `HTTP ${res.status}`)
    throw new Error(`Cloudinary 拒絕列出資料夾：${reason}`)
  }
  return body.resources ?? []
}

export function cloudinaryProxy(opts: Options): Plugin {
  const configured = !!(opts.cloudName && opts.apiKey && opts.apiSecret)
  // Per plugin instance, so new credentials (a config reload) never see another account's listing.
  const cache = new Map<string, { at: number; body: unknown }>()

  const auth = () => `Basic ${Buffer.from(`${opts.apiKey}:${opts.apiSecret}`).toString('base64')}`

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const send = (status: number, body: unknown) => {
      res.statusCode = status
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(JSON.stringify(body))
    }
    const url = new URL(req.url ?? '', 'http://x')
    const params = url.searchParams
    if (req.method !== 'GET') return send(405, { error: 'method not allowed' })
    if (url.pathname === '/status') return send(200, { configured, cloudName: opts.cloudName ?? null, retention: 'permanent' })
    if (url.pathname === '/moderation') return moderation(params, send)
    if (url.pathname !== '/folder') return send(404, { error: 'not found' })
    if (!configured) return send(200, { configured: false })
    const folder = (params.get('path') ?? '').replace(/^\/+|\/+$/g, '')
    if (!/^theatre\/[\w\- ./一-鿿]+$/.test(folder) || folder.includes('..')) {
      return send(400, { configured: true, error: '只能列出 theatre/ 底下的資料夾' })
    }
    const cacheKey = folder
    const hit = cache.get(cacheKey)
    if (hit && Date.now() - hit.at < CACHE_MS) return send(200, hit.body)
    try {
      const quoted = `"${folder.replace(/"/g, '\\"')}"`
      // Dynamic-folder accounts file assets by asset_folder; fixed-folder ones by folder (public id path).
      let resources = await search(opts as Required<Options>, `asset_folder=${quoted}`).catch(() => [] as SearchResource[])
      if (resources.length === 0) resources = await search(opts as Required<Options>, `folder=${quoted}`)
      const items = resources.filter((r) => r.resource_type !== 'raw').map((r) => toMediaEntry(r, folder))
      const body = { configured: true, items }
      cache.set(cacheKey, { at: Date.now(), body })
      send(200, body)
    } catch (err) {
      send(200, { configured: true, error: (err as Error).message })
    }
  }

  /** AI moderation result of one audience file (Admin API resource lookup). */
  async function moderation(params: URLSearchParams, send: (status: number, body: unknown) => void) {
    if (!configured) return send(200, { configured: false })
    const type = params.get('type') === 'image' ? 'image' : 'video'
    const publicId = params.get('publicId') ?? ''
    if (!publicId.startsWith('theatre/') || publicId.includes('..') || /[?#\\]/.test(publicId)) return send(400, { configured: true, error: '只能查詢 theatre/ 底下的檔案' })
    try {
      const res = await fetch(`https://api.cloudinary.com/v1_1/${opts.cloudName}/resources/${type}/upload/${publicId.split('/').map(encodeURIComponent).join('/')}`, {
        headers: { authorization: auth() },
        signal: AbortSignal.timeout(15_000),
      })
      const body = (await res.json().catch(() => ({}))) as { moderation?: { kind: string; status: string }[]; error?: { message?: string } }
      if (!res.ok) return send(200, { configured: true, error: res.status === 401 ? 'API Key / Secret 不正確' : (body.error?.message ?? `HTTP ${res.status}`) })
      const checks = body.moderation ?? []
      const status = checks.some((m) => m.status === 'rejected') ? 'rejected' : checks.length && checks.every((m) => m.status === 'approved') ? 'approved' : 'pending'
      send(200, { configured: true, status, checks })
    } catch (err) {
      send(200, { configured: true, error: (err as Error).message })
    }
  }

  // Must return nothing: a function returned from configureServer is run as a post-hook.
  const mount = (server: { middlewares: { use: (path: string, fn: (req: IncomingMessage, res: ServerResponse) => void) => unknown } }) => {
    server.middlewares.use('/api/cloudinary', (req, res) => {
      handle(req, res).catch(() => {
        res.statusCode = 500
        res.end()
      })
    })
  }
  return { name: 'cloudinary-proxy', configureServer: mount, configurePreviewServer: mount }
}
