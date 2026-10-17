import { callerFromHeaders } from '../server/projectAccess.ts'
import { sendWebPush, type PushSubscriptionJson, type VapidKeys } from '../server/webPush.ts'

interface Env {
  DATABASE_URL: string
  /** Public VAPID key (also baked into the app as VITE_VAPID_PUBLIC_KEY). */
  VAPID_PUBLIC?: string
  /** Private VAPID key as a JWK — `wrangler secret put VAPID_PRIVATE_JWK`. */
  VAPID_PRIVATE_JWK?: string
}

interface DeviceRecord {
  sub?: PushSubscriptionJson
  memberId?: string
  channel?: string
  updatedAt?: number
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

const MAX_DEVICES = 60
const STALE_MS = 45 * 24 * 3600 * 1000
const recent = new Map<string, number>()

const meets = (a?: string, b?: string) => !a || !b || a === 'all' || b === 'all' || a === b
const clip = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : '')

/**
 * POST /api/push/call: a signed-in crew member rang the Intercom CALL — push it to every other device of
 * that project that opted in (its subscription is stored under projects/{pid}/intercom/push/{deviceId}),
 * so phones with the web app in the background buzz. The database decides who may do this: the
 * subscriptions are read with the caller's own ID token, which only project members can do.
 */
export async function pushRoute(req: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname !== '/api/push/call' || req.method !== 'POST') return json(404, { error: 'not found' })
  const caller = callerFromHeaders(req.headers.get('authorization'), null)
  if (!caller.token || !caller.uid) return json(401, { error: 'sign_in_required' })
  if (!env.VAPID_PUBLIC || !env.VAPID_PRIVATE_JWK) return json(200, { sent: 0, reason: 'push_not_configured' })

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  const projectId = clip(body?.projectId, 80)
  if (!/^[\w-]{1,80}$/.test(projectId)) return json(400, { error: 'invalid_project' })

  // At most one ring per caller every 2 s, so a held button can't flood phones.
  const last = recent.get(caller.uid) ?? 0
  if (Date.now() - last < 2000) return json(429, { error: 'too_fast' })
  recent.set(caller.uid, Date.now())

  const db = env.DATABASE_URL.replace(/\/+$/, '')
  const auth = `auth=${encodeURIComponent(caller.token)}`
  const listRes = await fetch(`${db}/projects/${projectId}/intercom/push.json?${auth}`)
  if (listRes.status === 401 || listRes.status === 403) return json(403, { error: 'not_a_member' })
  if (!listRes.ok) return json(502, { error: 'database_unavailable' })
  const devices = ((await listRes.json()) ?? {}) as Record<string, DeviceRecord>

  const fromDevice = clip(body?.fromDevice, 80)
  const target = clip(body?.target, 80) || '*'
  const channel = clip(body?.channel, 8)
  const name = clip(body?.name, 24) || 'Intercom'
  const role = clip(body?.role, 24)
  const direct = target !== '*'

  const vapid: VapidKeys = { privateJwk: JSON.parse(env.VAPID_PRIVATE_JWK) as JsonWebKey, publicKey: env.VAPID_PUBLIC, subject: 'mailto:noreply@theatre-cue.invalid' }
  const message = {
    type: 'call',
    title: direct ? `📞 ${name} 呼叫你` : `📞 ${name} 呼叫全體`,
    body: role ? `${role} · 點開回到 Intercom` : '點開回到 Intercom',
    projectId,
    at: Date.now(),
  }

  let sent = 0
  const dead: string[] = []
  const jobs = Object.entries(devices)
    .filter(([id, d]) => {
      if (!d?.sub?.endpoint || !d.sub.keys?.p256dh || !d.sub.keys?.auth || id === fromDevice) return false
      if (!d.sub.endpoint.startsWith('https://')) return false
      if (d.updatedAt && Date.now() - d.updatedAt > STALE_MS) {
        dead.push(id)
        return false
      }
      return direct ? d.memberId === target : meets(channel, d.channel)
    })
    .slice(0, MAX_DEVICES)
    .map(async ([id, d]) => {
      try {
        const r = await sendWebPush(d.sub!, message, vapid, { ttl: 30, urgent: true })
        if (r.ok) sent++
        else if (r.gone) dead.push(id)
      } catch {
        // One bad endpoint must not stop the others.
      }
    })
  await Promise.all(jobs)
  // Forget subscriptions the push service says are gone (same token, same rules).
  await Promise.all(dead.map((id) => fetch(`${db}/projects/${projectId}/intercom/push/${encodeURIComponent(id)}.json?${auth}`, { method: 'DELETE' }).catch(() => {})))
  return json(200, { sent })
}
