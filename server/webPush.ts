/*
 * Web Push (RFC 8030 / 8291 / VAPID RFC 8292) with WebCrypto only — no Node dependencies, so it runs in
 * the Cloudflare Worker. Used to ring Intercom CALLs on phones whose web app is in the background.
 */

export interface PushSubscriptionJson {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

export interface VapidKeys {
  /** Private key as a JWK (the Worker secret). */
  privateJwk: object
  /** Public key, base64url of the 65-byte uncompressed point (also the browser's applicationServerKey). */
  publicKey: string
  /** mailto: / https: contact for the push service. */
  subject: string
}

const enc = new TextEncoder()

const b64u = (bytes: ArrayBuffer | Uint8Array) => {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let s = ''
  for (const b of u) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const fromB64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8))
}

/** RFC 8291 "aes128gcm" encrypted body for one subscription. */
async function encrypt(sub: PushSubscriptionJson, payload: Uint8Array): Promise<Uint8Array> {
  const uaPublic = fromB64u(sub.keys.p256dh)
  const authSecret = fromB64u(sub.keys.auth)
  const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as unknown as { publicKey: never; privateKey: never }
  const asPublic = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer)
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey } as never, pair.privateKey, 256))

  const salt = crypto.getRandomValues(new Uint8Array(16))
  const prk = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32)
  const cek = await hkdf(salt, prk, enc.encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, prk, enc.encode('Content-Encoding: nonce\0'), 12)

  // One record: payload + the 0x02 "last record" delimiter.
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt'])
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(payload, new Uint8Array([2]))))
  const header = new Uint8Array(21)
  header.set(salt, 0)
  new DataView(header.buffer).setUint32(16, 4096)
  header[20] = asPublic.length
  return concat(header, asPublic, cipher)
}

/** VAPID Authorization header value for a push service origin. */
async function vapidAuth(endpoint: string, vapid: VapidKeys) {
  const aud = new URL(endpoint).origin
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: vapid.subject })))
  const key = await crypto.subtle.importKey('jwk', vapid.privateJwk as never, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${head}.${claims}`))
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${vapid.publicKey}`
}

export interface PushResult {
  ok: boolean
  status: number
  /** The subscription is gone (unsubscribed / expired): delete it. */
  gone: boolean
}

/** Sends one push message. `urgent`: wake a sleeping phone now (a CALL is time-critical, so a short TTL too). */
export async function sendWebPush(sub: PushSubscriptionJson, message: unknown, vapid: VapidKeys, opts: { ttl?: number; urgent?: boolean } = {}): Promise<PushResult> {
  const body = await encrypt(sub, enc.encode(JSON.stringify(message)))
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      authorization: await vapidAuth(sub.endpoint, vapid),
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: String(opts.ttl ?? 30),
      urgency: opts.urgent ? 'high' : 'normal',
    },
    body,
  })
  return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410 }
}
