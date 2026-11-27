/*
 * TTS Maker: script → spoken clip, by ElevenLabs. The browser calls the API directly with the user's own key
 * (kept in localStorage, never in the code) and the MP3 that comes back is stored on R2 as it is.
 *
 * Pauses are ElevenLabs' own SSML tag, written in the script as it is: <break time="1.0s" /> (at most 3 s each).
 */

export interface ElevenVoice {
  id: string
  label: string
  note: string
  /** ElevenLabs' category: premade, generated (Voice Design), cloned, professional … */
  category?: string
}

/** Used when there is no key yet or the list can't be fetched: premade voices every account can use through the API. Any other voice: paste its ID. */
export const ELEVEN_VOICES: ElevenVoice[] = [
  { id: '21m00Tcm4TlvDq8ikWAM', label: 'Rachel', note: '女聲', category: 'premade' },
  { id: 'EXAVITQu4vr4xnSDxMaL', label: 'Sarah', note: '女聲', category: 'premade' },
  { id: 'XrExE9yKIg1WjnnlVkGX', label: 'Matilda', note: '女聲', category: 'premade' },
  { id: 'pFZP5JQG7iQjIQuC4Bku', label: 'Lily', note: '女聲', category: 'premade' },
  { id: 'JBFqnCBsd6RMkjVDRZzb', label: 'George', note: '男聲', category: 'premade' },
  { id: 'nPczCjzI2devNBz1zQrb', label: 'Brian', note: '男聲', category: 'premade' },
  { id: 'TX3LPaxmHKxFdv7VOQHJ', label: 'Liam', note: '男聲', category: 'premade' },
  { id: 'pNInz6obpgDQGcFmaJgB', label: 'Adam', note: '男聲', category: 'premade' },
]

export const ELEVEN_MODEL = 'eleven_multilingual_v2'
export const DEFAULT_ELEVEN_VOICE = ELEVEN_VOICES[0].id
export const SPEED_RANGE = { min: 0.7, max: 1.2 }
/** The SSML pause the toolbar inserts; ElevenLabs allows 0.1–3 s per break. */
export const BREAK_RANGE = { min: 0.1, max: 3 }
export const breakTag = (seconds: number) => `<break time="${Math.min(BREAK_RANGE.max, Math.max(BREAK_RANGE.min, seconds)).toFixed(1)}s" />`

export interface ElevenSettings {
  apiKey: string
  voiceId: string
  /** 0…1 */
  stability: number
  /** 0…1 */
  similarity: number
  speed: number
}

/** What went wrong, in words for the person at the console. */
function failure(status: number, body: { detail?: { status?: string; message?: string } | string } | null): string {
  const detail = typeof body?.detail === 'string' ? body.detail : body?.detail?.message
  const code = typeof body?.detail === 'object' ? body.detail?.status : undefined
  if (code === 'quota_exceeded') return 'ElevenLabs 字元額度已用完（免費版每月有字元上限），請等下個月重置或升級方案'
  if (status === 401) return `API Key 錯誤或沒有權限，請重新貼上 sk_ 開頭的金鑰${detail ? `（${detail}）` : ''}`
  if (status === 402) return '這個聲音需要付費方案（免費版不能透過 API 使用社群庫聲音，402）：請改選「官方預設」或你自己用 Voice Design 建立的聲音'
  if (status === 429) return '請求太頻繁或免費額度已用盡（429），請稍後再試'
  if (status === 400 || status === 404 || status === 422) return `ElevenLabs 拒絕這次請求：${detail ?? `HTTP ${status}`}（請檢查 Voice ID 與台詞）`
  return `語音產生失敗（HTTP ${status}${detail ? `：${detail}` : ''}）`
}

/** Speak `text` (plain text with optional <break> tags) and return the MP3. */
export async function synthesizeEleven(text: string, s: ElevenSettings, signal?: AbortSignal): Promise<Blob> {
  const converted = text.trim()
  if (!converted) throw new Error('請輸入要朗讀的文字')
  if (!s.apiKey) throw new Error('請先貼上 ElevenLabs API Key')
  if (!s.voiceId) throw new Error('請選擇聲音或輸入 Voice ID')
  let res: Response
  try {
    res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(s.voiceId)}`, {
      method: 'POST',
      headers: { 'xi-api-key': s.apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({
        text: converted,
        model_id: ELEVEN_MODEL,
        voice_settings: { stability: s.stability, similarity_boost: s.similarity, speed: s.speed },
      }),
      signal,
    })
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err
    throw new Error('無法連線到 ElevenLabs，請檢查網路')
  }
  if (!res.ok) throw new Error(failure(res.status, await res.json().catch(() => null)))
  return new Blob([await res.arrayBuffer()], { type: 'audio/mpeg' })
}

/** Categories the free plan's API refuses (library / community voices), whatever the request asked for. */
const NOT_FREE = new Set(['high_quality', 'library', 'community', 'shared'])

/** The voice to start from: the person's own (Voice Design / cloned) first, else Rachel or another premade one, else the first. */
export function pickDefaultVoice(voices: ElevenVoice[]): string {
  const own = voices.find((v) => v.category === 'generated' || v.category === 'cloned')
  if (own) return own.id
  const premade = voices.filter((v) => v.category === 'premade')
  return (premade.find((v) => v.id === DEFAULT_ELEVEN_VOICE) ?? premade[0] ?? voices[0])?.id ?? ''
}

/**
 * The voices this key can speak with on the free plan: the account's own (Voice Design, clones) and the premade ones —
 * community-library voices are left out because the API refuses them (402).
 */
export async function listElevenVoices(apiKey: string, signal?: AbortSignal): Promise<ElevenVoice[]> {
  const out: ElevenVoice[] = []
  let page: string | undefined
  for (let i = 0; i < 5; i++) {
    const url = `https://api.elevenlabs.io/v2/voices?voice_type=non-community&page_size=100${page ? `&next_page_token=${encodeURIComponent(page)}` : ''}`
    let res: Response
    try {
      res = await fetch(url, { headers: { 'xi-api-key': apiKey }, signal })
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err
      throw new Error('無法連線到 ElevenLabs，請檢查網路')
    }
    if (!res.ok) throw new Error(failure(res.status, await res.json().catch(() => null)))
    const body = (await res.json()) as {
      voices?: { voice_id: string; name?: string; category?: string; labels?: { gender?: string; accent?: string } }[]
      has_more?: boolean
      next_page_token?: string | null
    }
    for (const v of body.voices ?? []) {
      if (v.category && NOT_FREE.has(v.category)) continue
      const gender = v.labels?.gender === 'female' ? '女聲' : v.labels?.gender === 'male' ? '男聲' : ''
      out.push({ id: v.voice_id, label: v.name || v.voice_id, note: [gender, v.labels?.accent].filter(Boolean).join('・'), category: v.category })
    }
    if (!body.has_more || !body.next_page_token) break
    page = body.next_page_token
  }
  return out
}
