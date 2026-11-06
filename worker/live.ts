/**
 * /api/live/*: Cloudflare Realtime SFU for the audience live camera. The browser never sees the app secret;
 * these routes forward its WebRTC offers to Cloudflare and return the answers.
 *
 * Audience phones are not signed in, so every call is tied to a real running live cue instead: the caller names its
 * signaling node (projects/{pid}/versions/{vid}/live/{iid}) and the Worker checks, with the database's public read
 * of that node, that a camera was really named there — and that only that phone may publish, and viewers may only
 * pull the session that node announces.
 *
 *   GET  /api/live/ice                        STUN (+ TURN when configured) servers
 *   POST /api/live/session                    {node, audienceId}                          → {sessionId}
 *   POST /api/live/publish                    {node, audienceId, sessionId, sdp, tracks}   → {sdp}   (camera phone)
 *   POST /api/live/subscribe                  {node, sessionId, trackNames}                → {sdp, tracks}  (viewer; offer)
 *   POST /api/live/renegotiate                {node, sessionId, sdp}                       → {}  (viewer's answer)
 */

interface Env {
  DATABASE_URL: string
  ALLOWED_ORIGINS: string
  /** Realtime SFU app: `wrangler secret put CF_REALTIME_APP_SECRET`, and CF_REALTIME_APP_ID in [vars]. */
  CF_REALTIME_APP_ID?: string
  CF_REALTIME_APP_SECRET?: string
  /** Optional TURN (for networks that block direct UDP): Realtime → TURN key. */
  CF_TURN_KEY_ID?: string
  CF_TURN_KEY_TOKEN?: string
}

const API = 'https://rtc.live.cloudflare.com/v1'
const NODE = /^projects\/[\w-]+\/versions\/[\w-]+\/live\/[\w-]+$/
interface IceServer {
  urls: string | string[]
  username?: string
  credential?: string
}
const STUN: IceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }]

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

interface Body {
  node?: string
  audienceId?: string
  sessionId?: string
  sdp?: string
  tracks?: { mid?: string; trackName?: string }[]
  trackNames?: string[]
}

async function realtime(env: Env, method: string, path: string, body?: unknown) {
  const res = await fetch(`${API}/apps/${env.CF_REALTIME_APP_ID}${path}`, {
    method,
    headers: { authorization: `Bearer ${env.CF_REALTIME_APP_SECRET}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  return { ok: res.ok, status: res.status, data }
}

async function dbRead<T>(env: Env, path: string): Promise<T | null> {
  const res = await fetch(`${env.DATABASE_URL.replace(/\/+$/, '')}/${path}.json`)
  return res.ok ? ((await res.json()) as T | null) : null
}

export async function liveRoute(req: Request, env: Env, url: URL): Promise<Response> {
  if (!env.CF_REALTIME_APP_ID || !env.CF_REALTIME_APP_SECRET) return json(503, { error: '直播伺服器尚未設定（CF_REALTIME_APP_ID / CF_REALTIME_APP_SECRET）' })
  // Browsers only: a page on an allowed origin (CORS alone doesn't stop a script, but it keeps casual misuse out).
  const origin = req.headers.get('origin')
  if (!origin || !env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).includes(origin)) return json(403, { error: 'origin not allowed' })

  if (url.pathname === '/api/live/ice' && req.method === 'GET') {
    if (!env.CF_TURN_KEY_ID || !env.CF_TURN_KEY_TOKEN) return json(200, { iceServers: STUN })
    const res = await fetch(`${API}/turn/keys/${env.CF_TURN_KEY_ID}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.CF_TURN_KEY_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ttl: 6 * 3600 }),
    })
    const data = (await res.json().catch(() => null)) as { iceServers?: IceServer[] | IceServer } | null
    const servers = data?.iceServers ? (Array.isArray(data.iceServers) ? data.iceServers : [data.iceServers]) : []
    return json(200, { iceServers: servers.length ? servers : STUN })
  }
  if (req.method !== 'POST') return json(404, { error: 'not found' })

  const body = (await req.json().catch(() => null)) as Body | null
  if (!body?.node || !NODE.test(body.node) || body.node.length > 200) return json(400, { error: 'bad node' })
  const operator = await dbRead<{ audienceId?: string }>(env, `${body.node}/operator`)
  if (!operator?.audienceId) return json(403, { error: 'no live camera is running here' })

  switch (url.pathname) {
    case '/api/live/session': {
      const r = await realtime(env, 'POST', '/sessions/new')
      return r.ok ? json(200, { sessionId: r.data.sessionId }) : json(502, { error: 'session failed', detail: r.data })
    }
    case '/api/live/publish': {
      if (body.audienceId !== operator.audienceId) return json(403, { error: 'not the camera phone' })
      if (!body.sessionId || !body.sdp || !body.tracks?.length || body.tracks.length > 2) return json(400, { error: 'bad request' })
      const r = await realtime(env, 'POST', `/sessions/${encodeURIComponent(body.sessionId)}/tracks/new`, {
        sessionDescription: { type: 'offer', sdp: body.sdp },
        tracks: body.tracks.map((t) => ({ location: 'local', mid: t.mid, trackName: t.trackName })),
      })
      const sd = r.data.sessionDescription as { sdp?: string } | undefined
      return r.ok && sd?.sdp ? json(200, { sdp: sd.sdp }) : json(502, { error: 'publish failed', detail: r.data })
    }
    case '/api/live/subscribe': {
      if (!body.sessionId || !body.trackNames?.length || body.trackNames.length > 2) return json(400, { error: 'bad request' })
      // Viewers may only pull the session the node announces.
      const sfu = await dbRead<{ sessionId?: string }>(env, `${body.node}/sfu`)
      if (!sfu?.sessionId) return json(409, { error: 'camera not publishing yet' })
      const r = await realtime(env, 'POST', `/sessions/${encodeURIComponent(body.sessionId)}/tracks/new`, {
        tracks: body.trackNames.map((trackName) => ({ location: 'remote', sessionId: sfu.sessionId, trackName })),
      })
      const sd = r.data.sessionDescription as { sdp?: string } | undefined
      return r.ok && sd?.sdp ? json(200, { sdp: sd.sdp, tracks: r.data.tracks ?? [] }) : json(502, { error: 'subscribe failed', detail: r.data })
    }
    case '/api/live/renegotiate': {
      if (!body.sessionId || !body.sdp) return json(400, { error: 'bad request' })
      const r = await realtime(env, 'PUT', `/sessions/${encodeURIComponent(body.sessionId)}/renegotiate`, { sessionDescription: { type: 'answer', sdp: body.sdp } })
      return r.ok ? json(200, {}) : json(502, { error: 'renegotiate failed', detail: r.data })
    }
    default:
      return json(404, { error: 'not found' })
  }
}
