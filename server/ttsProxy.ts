import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import WebSocket from 'ws'
import { LOCAL_DEFAULT_VOICE, LOCAL_VOICES, localTts, localTtsAvailable } from './ttsLocal.ts'
import { GOOGLE_DEFAULT_VOICE, GOOGLE_VOICES, googleTts, googleTtsAvailable } from './ttsGoogle.ts'

/**
 * Text-to-speech for the DAW Studio: Microsoft neural voices — Taiwanese Mandarin (zh-TW) first,
 * plus English, Japanese, Korean, Mainland Mandarin and Cantonese.
 *
 *   GET  /api/tts/voices                        → { available, engine, voices: [{ id, label, gender, voiceName, lang, base? }] }
 *   POST /api/tts {text, voice, speed, pitch}   → one sentence as audio (the client joins sentences and pauses)
 *
 * Engine (TTS_ENGINE in .env.local; unset → google when google-credentials.json exists, else local):
 *   google          — Google Cloud Text-to-Speech (see ttsGoogle.ts): WaveNet Taiwanese voices,
 *                     Neural2 English / Japanese / Korean. Service-account key in
 *                     google-credentials.json (server-side only).
 *   local           — open-source Kokoro voices run on this machine (see ttsLocal.ts; model from
 *                     `npm run tts:setup`). No key, no network.
 *   azure           — Azure Speech (official API), needs AZURE_SPEECH_KEY and AZURE_SPEECH_REGION;
 *                     server-side only, never sent to the browser. Paused for now: only used when
 *                     TTS_ENGINE=azure is set explicitly.
 *   edge            — the endpoint Microsoft Edge uses for Read Aloud (no key, unofficial;
 *                     Microsoft currently refuses third-party clients with HTTP 403).
 *
 * Microsoft voices (azure / edge):
 * Only the voices below exist in the menu. Microsoft has three zh-TW neural voices (HsiaoChen,
 * HsiaoYu, YunJhe); 雅婷, 佳緹, 家豪 and 雲龍 are distinct variations of them made with pitch and
 * pace, and are marked as such.
 */

export interface TtsOptions {
  /** google | local | azure | edge (unset: google when its key file exists, else local). */
  engine?: string
  /** Project root (where tts-models/ lives). */
  root?: string
  azureKey?: string
  azureRegion?: string
  /** Edge client version for the fallback endpoint (it rejects old ones). */
  edgeVersion?: string
}

type Gender = 'female' | 'male'
interface VoiceDef {
  id: string
  label: string
  en: string
  gender: Gender
  /** The Microsoft voice that speaks it. */
  voiceName: string
  /** Its language (menu group, SSML xml:lang). */
  lang: string
  /** For variations: the voice it's based on (display name). */
  base?: string
  /** Relative pitch (Hz) and pace (%) that make a variation distinct. */
  pitch: number
  rate: number
}

const tw = (v: Omit<VoiceDef, 'lang'>): VoiceDef => ({ ...v, lang: 'zh-TW' })
const intl = (id: string, label: string, gender: Gender, voiceName: string): VoiceDef => ({ id, label, en: voiceName.split('-')[2].replace('Neural', ''), gender, voiceName, lang: voiceName.split('-').slice(0, 2).join('-'), pitch: 0, rate: 0 })

export const VOICES: VoiceDef[] = [
  tw({ id: 'yating', label: '雅婷', en: 'Yating', gender: 'female', voiceName: 'zh-TW-HsiaoChenNeural', base: '曉臻', pitch: 14, rate: 4 }),
  tw({ id: 'hsiaochen', label: '曉臻', en: 'HsiaoChen', gender: 'female', voiceName: 'zh-TW-HsiaoChenNeural', pitch: 0, rate: 0 }),
  tw({ id: 'hsiaoyu', label: '曉涵', en: 'HsiaoYu', gender: 'female', voiceName: 'zh-TW-HsiaoYuNeural', pitch: 0, rate: 0 }),
  tw({ id: 'zhiyu', label: '佳緹', en: 'ZhiYu', gender: 'female', voiceName: 'zh-TW-HsiaoYuNeural', base: '曉涵', pitch: -12, rate: -5 }),
  tw({ id: 'jiahao', label: '家豪', en: 'JiaHao', gender: 'male', voiceName: 'zh-TW-YunJheNeural', base: '雲哲', pitch: 22, rate: 7 }),
  tw({ id: 'yunjhe', label: '雲哲', en: 'YunJhe', gender: 'male', voiceName: 'zh-TW-YunJheNeural', pitch: 0, rate: 0 }),
  tw({ id: 'yunlung', label: '雲龍', en: 'YunLung', gender: 'male', voiceName: 'zh-TW-YunJheNeural', base: '雲哲', pitch: -16, rate: -6 }),
  // International voices (their own language; best with text in that language).
  intl('en-us-jenny', 'Jenny（美式英語）', 'female', 'en-US-JennyNeural'),
  intl('en-us-aria', 'Aria（美式英語）', 'female', 'en-US-AriaNeural'),
  intl('en-us-guy', 'Guy（美式英語）', 'male', 'en-US-GuyNeural'),
  intl('en-gb-sonia', 'Sonia（英式英語）', 'female', 'en-GB-SoniaNeural'),
  intl('en-gb-ryan', 'Ryan（英式英語）', 'male', 'en-GB-RyanNeural'),
  intl('ja-nanami', '七海（日語）', 'female', 'ja-JP-NanamiNeural'),
  intl('ja-keita', '圭太（日語）', 'male', 'ja-JP-KeitaNeural'),
  intl('ko-sunhi', '선히（韓語）', 'female', 'ko-KR-SunHiNeural'),
  intl('ko-injoon', '인준（韓語）', 'male', 'ko-KR-InJoonNeural'),
  intl('zh-cn-xiaoxiao', '曉曉（普通話・中國）', 'female', 'zh-CN-XiaoxiaoNeural'),
  intl('zh-cn-yunxi', '雲希（普通話・中國）', 'male', 'zh-CN-YunxiNeural'),
  intl('zh-hk-hiumaan', '曉曼（粵語）', 'female', 'zh-HK-HiuMaanNeural'),
  intl('zh-hk-wanlung', '雲龍（粵語）', 'male', 'zh-HK-WanLungNeural'),
]
export const DEFAULT_VOICE = 'yating'

const MAX_TEXT = 1000
const signed = (n: number, unit: string) => `${n >= 0 ? '+' : ''}${Math.round(n)}${unit}`
const escapeXml = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!)

/**
 * SSML for one sentence: the voice, its variation, the requested speed (0.5–2×) and pitch
 * (−50…+50 %, relative). The variation's own pitch is in Hz, so the user's pitch wraps it.
 */
function ssml(text: string, v: VoiceDef, speed: number, pitch = 0) {
  const rate = (Math.min(2, Math.max(0.5, speed)) - 1) * 100 + v.rate
  const userPitch = Math.min(50, Math.max(-50, pitch))
  const inner = `<prosody pitch='${signed(v.pitch, 'Hz')}' rate='${signed(rate, '%')}' volume='+0%'>${escapeXml(text)}</prosody>`
  return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${v.lang}'><voice name='${v.voiceName}'>${userPitch ? `<prosody pitch='${signed(userPitch, '%')}'>${inner}</prosody>` : inner}</voice></speak>`
}

/* ---------- Azure Speech (official) ---------- */

async function azure(text: string, v: VoiceDef, speed: number, pitch: number, key: string, region: string): Promise<{ audio: Buffer; type: string }> {
  const res = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': key,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'riff-24khz-16bit-mono-pcm',
      'User-Agent': 'theatre-cue',
    },
    body: ssml(text, v, speed, pitch),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(res.status === 401 ? 'Azure 金鑰或區域不正確' : res.status === 429 ? 'Azure 用量已達上限，請稍後再試' : `Azure 語音服務錯誤（HTTP ${res.status}）`)
  return { audio: Buffer.from(await res.arrayBuffer()), type: 'audio/wav' }
}

/* ---------- Edge Read Aloud (no key) ---------- */

const EDGE_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
const EDGE_FALLBACK_VERSIONS = ['143.0.3650.75', '145.0.3800.70']
/** Server clock minus ours, learned from a rejected request's Date header. */
let edgeSkew = 0

function edgeOnce(text: string, v: VoiceDef, speed: number, pitch: number, version: string): Promise<{ audio: Buffer; type: string } | { rejected: number; date?: string }> {
  let ticks = Math.floor((Date.now() + edgeSkew) / 1000) + 11644473600
  ticks -= ticks % 300
  const gec = createHash('sha256').update(`${BigInt(ticks) * 10000000n}${EDGE_TOKEN}`, 'ascii').digest('hex').toUpperCase()
  const major = version.split('.')[0]
  const url = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${EDGE_TOKEN}&ConnectionId=${randomUUID().replace(/-/g, '')}&Sec-MS-GEC=${gec}&Sec-MS-GEC-Version=1-${version}`
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, {
      headers: {
        Pragma: 'no-cache',
        'Cache-Control': 'no-cache',
        Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
        'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36 Edg/${major}.0.0.0`,
        Cookie: `muid=${randomBytes(16).toString('hex').toUpperCase()};`,
      },
    })
    const chunks: Buffer[] = []
    const timer = setTimeout(() => {
      ws.terminate()
      reject(new Error('語音服務逾時'))
    }, 30_000)
    const done = (fn: () => void) => {
      clearTimeout(timer)
      fn()
    }
    ws.on('unexpected-response', (_req, res) => done(() => resolve({ rejected: res.statusCode ?? 0, date: res.headers.date })))
    ws.on('open', () => {
      const ts = new Date().toString()
      ws.send(
        `X-Timestamp:${ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
          '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}',
      )
      ws.send(`X-RequestId:${randomUUID().replace(/-/g, '')}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${ts}Z\r\nPath:ssml\r\n\r\n${ssml(text, v, speed, pitch)}`)
    })
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (!isBinary) {
        if (data.toString().includes('Path:turn.end')) {
          ws.close()
          done(() => (chunks.length ? resolve({ audio: Buffer.concat(chunks), type: 'audio/mpeg' }) : reject(new Error('語音服務沒有回傳聲音'))))
        }
        return
      }
      const headerLength = data.readUInt16BE(0)
      if (data.subarray(2, 2 + headerLength).toString().includes('Path:audio')) chunks.push(data.subarray(2 + headerLength))
    })
    ws.on('error', (err) => done(() => reject(new Error(`無法連線到語音服務：${err.message}`))))
  })
}

async function edge(text: string, v: VoiceDef, speed: number, pitch: number, preferred?: string) {
  const versions = [...new Set([preferred, ...EDGE_FALLBACK_VERSIONS].filter((x): x is string => !!x))]
  for (const version of versions) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await edgeOnce(text, v, speed, pitch, version)
      if ('audio' in result) return result
      // 403 can mean our clock is off: adopt the server's time and retry once.
      if (result.rejected === 403 && result.date && attempt === 0) {
        const skew = Date.parse(result.date) - Date.now()
        if (Math.abs(skew - edgeSkew) > 60_000) {
          edgeSkew = skew
          continue
        }
      }
      break
    }
  }
  throw new Error(
    '微軟的免金鑰 Edge 語音端點拒絕了連線（HTTP 403，微軟已限制第三方使用）。請在 .env.local 設定 AZURE_SPEECH_KEY / AZURE_SPEECH_REGION，改用官方 Azure 語音服務（同樣的神經語音，免費方案每月 50 萬字）',
  )
}

/* ---------- routes ---------- */

export function ttsProxy(opts: TtsOptions = {}): Plugin {
  const root = opts.root ?? process.cwd()
  const engine = ['google', 'local', 'azure', 'edge'].includes(opts.engine ?? '') ? opts.engine! : googleTtsAvailable(root) ? 'google' : 'local'
  const useAzure = engine === 'azure'
  const local = engine === 'local' ? localTts(root) : null
  const google = engine === 'google' ? googleTts(root) : null

  async function readBody(req: IncomingMessage): Promise<string> {
    let body = ''
    for await (const chunk of req) {
      body += chunk
      if (body.length > 20_000) throw new Error('too large')
    }
    return body
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const json = (status: number, body: unknown) => {
      res.statusCode = status
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify(body))
    }
    const path = new URL(req.url ?? '', 'http://x').pathname
    if (req.method === 'GET' && (path === '/voices' || path === '/voices/')) {
      if (google) {
        const ready = googleTtsAvailable(root)
        return json(200, {
          available: ready,
          engine,
          defaultVoice: GOOGLE_DEFAULT_VOICE,
          ...(ready ? {} : { message: '找不到 google-credentials.json（Google Cloud 服務帳戶金鑰）' }),
          voices: GOOGLE_VOICES.map(({ id, label, en, gender, voiceName, lang, pitch }) => ({ id, label, en, gender, voiceName, lang, ...(pitch === false ? { pitch: false } : {}) })),
        })
      }
      if (local) {
        const ready = localTtsAvailable(root)
        return json(200, {
          available: ready,
          engine,
          defaultVoice: LOCAL_DEFAULT_VOICE,
          ...(ready ? {} : { message: '本機開源語音模型尚未安裝：請在專案資料夾執行 npm run tts:setup（約 215 MB），再重新整理頁面' }),
          voices: LOCAL_VOICES.map(({ id, label, en, gender, voiceName, lang }) => ({ id, label, en, gender, voiceName, lang })),
        })
      }
      if (useAzure && !(opts.azureKey && opts.azureRegion)) return json(200, { available: false, engine, voices: [], message: 'TTS_ENGINE=azure，但 .env.local 沒有 AZURE_SPEECH_KEY / AZURE_SPEECH_REGION' })
      return json(200, {
        available: true,
        engine,
        defaultVoice: DEFAULT_VOICE,
        voices: VOICES.map(({ id, label, en, gender, voiceName, lang, base }) => ({ id, label, en, gender, voiceName, lang, ...(base ? { base } : {}) })),
      })
    }
    if (req.method !== 'POST' || (path !== '/' && path !== '')) return json(404, { error: 'not found' })

    let payload: { text?: unknown; voice?: unknown; speed?: unknown; pitch?: unknown }
    try {
      payload = JSON.parse(await readBody(req))
    } catch {
      return json(400, { error: '請求格式錯誤' })
    }
    const text = typeof payload.text === 'string' ? payload.text.trim() : ''
    if (!text) return json(400, { error: '沒有要朗讀的文字' })
    if (text.length > MAX_TEXT) return json(400, { error: `單句最多 ${MAX_TEXT} 字` })
    const speed = Number(payload.speed) || 1
    const pitch = Number(payload.pitch) || 0
    if (google) {
      const voice = GOOGLE_VOICES.find((v) => v.id === payload.voice) ?? GOOGLE_VOICES.find((v) => v.id === GOOGLE_DEFAULT_VOICE)!
      try {
        const { audio, type } = await google.synthesize(text, voice, speed, pitch)
        res.statusCode = 200
        res.setHeader('content-type', type)
        res.setHeader('cache-control', 'no-store')
        return res.end(audio)
      } catch (err) {
        return json(502, { error: `語音產生失敗：${(err as Error).message}` })
      }
    }
    if (local) {
      if (!localTtsAvailable(root)) return json(503, { error: '本機開源語音模型尚未安裝：請執行 npm run tts:setup' })
      const voice = LOCAL_VOICES.find((v) => v.id === payload.voice) ?? LOCAL_VOICES.find((v) => v.id === LOCAL_DEFAULT_VOICE)!
      try {
        const { audio, type } = await local.synthesize(text, voice, speed, pitch)
        res.statusCode = 200
        res.setHeader('content-type', type)
        res.setHeader('cache-control', 'no-store')
        return res.end(audio)
      } catch (err) {
        return json(502, { error: `語音產生失敗：${(err as Error).message}` })
      }
    }
    // Only the voices in the table; anything else gets the default.
    const voice = VOICES.find((v) => v.id === payload.voice) ?? VOICES.find((v) => v.id === DEFAULT_VOICE)!
    try {
      const { audio, type } = useAzure ? await azure(text, voice, speed, pitch, opts.azureKey!, opts.azureRegion!) : await edge(text, voice, speed, pitch, opts.edgeVersion)
      res.statusCode = 200
      res.setHeader('content-type', type)
      res.setHeader('cache-control', 'no-store')
      res.end(audio)
    } catch (err) {
      json(502, { error: `語音產生失敗：${(err as Error).message}` })
    }
  }

  // Must return nothing: a function returned from configureServer is run as a post-hook.
  const mount = (server: { middlewares: { use: (path: string, fn: (req: IncomingMessage, res: ServerResponse) => void) => unknown } }) => {
    server.middlewares.use('/api/tts', (req, res) => {
      handle(req, res).catch(() => {
        res.statusCode = 500
        res.end()
      })
    })
  }
  return { name: 'tts-proxy', configureServer: mount, configurePreviewServer: mount }
}
