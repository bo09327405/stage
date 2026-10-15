import { GOOGLE_DEFAULT_VOICE, GOOGLE_VOICES } from '../server/ttsGoogleVoices.ts'
import { callerFromHeaders, projectAccess } from '../server/projectAccess.ts'

/**
 * Text-to-speech on the Worker (Google Cloud TTS over REST), so the Studio's TTS tab works on the
 * hosted site too:
 *
 *   GET  /api/tts/voices   the voice menu (same shape as the dev server's)
 *   POST /api/tts          { text, voice, speed, pitch } → audio/mpeg
 *
 * The service-account key lives only in the Worker secret GOOGLE_SA_JSON (never in the bundle or the
 * repository). Google bills per character, so synthesis needs a signed-in user (checked against the
 * Realtime Database like every other route) and each user has a daily character allowance
 * (TTS_DAILY_CHARS, default 30 000), counted in R2.
 */

export interface TtsEnv {
  BUCKET: R2Bucket
  DATABASE_URL: string
  ALLOWED_ORIGINS: string
  GOOGLE_SA_JSON?: string
  TTS_DAILY_CHARS?: string
}

const MAX_TEXT = 1000
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform'

interface ServiceAccount {
  client_email: string
  private_key: string
  token_uri?: string
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

const b64url = (data: ArrayBuffer | string) => {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data)
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function serviceAccount(env: TtsEnv): ServiceAccount | null {
  try {
    const sa = JSON.parse(env.GOOGLE_SA_JSON ?? '') as ServiceAccount
    return sa.client_email && sa.private_key ? sa : null
  } catch {
    return null
  }
}

// Access tokens last an hour; one isolate reuses its token until shortly before it expires.
let token: { value: string; exp: number } | null = null

async function accessToken(sa: ServiceAccount): Promise<string> {
  if (token && token.exp > Date.now() + 60_000) return token.value
  const now = Math.floor(Date.now() / 1000)
  const aud = sa.token_uri ?? 'https://oauth2.googleapis.com/token'
  const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud, iat: now, exp: now + 3600 }))}`
  const pem = sa.private_key.replace(/-----(BEGIN|END) PRIVATE KEY-----|\s/g, '')
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0))
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned))
  const res = await fetch(aud, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${b64url(sig)}` }),
  })
  const body = (await res.json().catch(() => null)) as { access_token?: string; expires_in?: number } | null
  if (!res.ok || !body?.access_token) throw new Error('Google Cloud 金鑰無效或已停用（請重新下載服務帳戶 JSON 並更新 Worker secret）')
  token = { value: body.access_token, exp: Date.now() + (body.expires_in ?? 3600) * 1000 }
  return token.value
}

/** Readable message for a failed Google call (REST status). */
function describe(status: number, detail: string) {
  if (status === 403) return /billing/i.test(detail) ? 'Google Cloud 專案尚未啟用帳單（Text-to-Speech 需要）' : 'Google Cloud 服務帳戶沒有權限，或專案尚未啟用 Text-to-Speech API'
  if (status === 401) return 'Google Cloud 金鑰無效或已停用'
  if (status === 429) return 'Google Cloud 語音用量已達上限，請稍後再試'
  if (status === 400) return `Google Cloud 不接受這個請求：${detail}`
  return detail || 'Google Cloud 語音服務錯誤'
}

/** Today's characters used by this user, and the key that stores them (UTC day). */
async function usage(env: TtsEnv, uid: string) {
  const key = `theatre/_quota/tts/${uid.replace(/[^\w-]/g, '_')}-${new Date().toISOString().slice(0, 10)}.json`
  const used = Number(((await (await env.BUCKET.get(key))?.json<{ chars?: number }>().catch(() => null))?.chars) ?? 0)
  return { key, used: Number.isFinite(used) ? used : 0 }
}

export async function ttsRoute(req: Request, env: TtsEnv, url: URL): Promise<Response> {
  const sa = serviceAccount(env)
  const path = url.pathname.replace(/\/+$/, '')

  if (req.method === 'GET' && path === '/api/tts/voices') {
    if (!sa) return json(200, { available: false, voices: [], message: '線上語音服務尚未設定。' })
    return json(200, {
      available: true,
      engine: 'google',
      defaultVoice: GOOGLE_DEFAULT_VOICE,
      voices: GOOGLE_VOICES.map(({ id, label, en, gender, voiceName, lang, pitch }) => ({ id, label, en, gender, voiceName, lang, ...(pitch === false ? { pitch: false } : {}) })),
    })
  }
  if (req.method !== 'POST' || path !== '/api/tts') return json(404, { error: 'not found' })

  // Writes only from the site's own origins, and only for signed-in people (Google bills per character).
  const origin = req.headers.get('origin')
  if (!origin || !env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).includes(origin)) return json(403, { error: '拒絕跨站請求' })
  if (!sa) return json(503, { error: '線上語音服務尚未設定' })
  const caller = callerFromHeaders(req.headers.get('authorization'), null)
  if (!caller.uid || !(await projectAccess(env.DATABASE_URL).signedIn(caller))) return json(401, { error: '請先登入' })

  let payload: { text?: unknown; voice?: unknown; speed?: unknown; pitch?: unknown }
  try {
    payload = await req.json()
  } catch {
    return json(400, { error: '請求格式錯誤' })
  }
  const text = typeof payload.text === 'string' ? payload.text.trim() : ''
  if (!text) return json(400, { error: '沒有要朗讀的文字' })
  if (text.length > MAX_TEXT) return json(400, { error: `單句最多 ${MAX_TEXT} 字` })

  const limit = Number(env.TTS_DAILY_CHARS) || 30_000
  const q = await usage(env, caller.uid)
  if (q.used + text.length > limit) return json(429, { error: `今天的語音額度已用完（每人每天 ${limit} 字，已用 ${q.used} 字），明天會重新計算` })

  const voice = GOOGLE_VOICES.find((v) => v.id === payload.voice) ?? GOOGLE_VOICES.find((v) => v.id === GOOGLE_DEFAULT_VOICE)!
  const speed = Math.min(2, Math.max(0.5, Number(payload.speed) || 1))
  const semitones = (Math.min(50, Math.max(-50, Number(payload.pitch) || 0)) / 100) * 12
  try {
    const res = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
      method: 'POST',
      headers: { authorization: `Bearer ${await accessToken(sa)}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        input: { text },
        voice: { languageCode: voice.languageCode, name: voice.voiceName },
        audioConfig: { audioEncoding: 'MP3', speakingRate: speed, ...(voice.pitch === false ? {} : { pitch: Math.round(semitones * 10) / 10 }) },
      }),
    })
    const body = (await res.json().catch(() => null)) as { audioContent?: string; error?: { message?: string } } | null
    if (!res.ok || !body?.audioContent) return json(502, { error: `語音產生失敗：${describe(res.status, body?.error?.message ?? '')}` })
    // Count only what was actually synthesized.
    await env.BUCKET.put(q.key, JSON.stringify({ chars: q.used + text.length }), { httpMetadata: { contentType: 'application/json' } })
    const bytes = Uint8Array.from(atob(body.audioContent), (c) => c.charCodeAt(0))
    return new Response(bytes, { headers: { 'content-type': 'audio/mpeg', 'cache-control': 'no-store' } })
  } catch (err) {
    return json(502, { error: `語音產生失敗：${(err as Error).message}` })
  }
}
