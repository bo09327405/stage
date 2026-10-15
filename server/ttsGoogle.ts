import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { TextToSpeechClient } from '@google-cloud/text-to-speech'

/**
 * Google Cloud Text-to-Speech for the DAW Studio.
 *
 * Credentials: the service-account key google-credentials.json in the project root (git-ignored,
 * never served to the browser — see vite.config.ts). It's handed straight to the SDK client, so
 * nothing else in the process picks it up from the environment.
 *
 * Voices: Google has no Neural2 voice for any Chinese (checked against its live voice list:
 * cmn-TW has WaveNet / Standard only). For Chinese text there are the Taiwanese WaveNet voices and
 * Chirp 3 HD — Google's newest generation, a tier above Neural2, Mandarin with a Mainland accent,
 * reads Traditional characters, no pitch control. Neural2 for English, Japanese and Korean.
 * Output: MP3.
 */

export const GOOGLE_KEY_FILE = 'google-credentials.json'

export interface GoogleVoice {
  id: string
  label: string
  en: string
  gender: 'female' | 'male'
  /** Google voice name, e.g. cmn-TW-Wavenet-A. */
  voiceName: string
  /** Menu language (zh-TW groups first). */
  lang: string
  /** Google language code, e.g. cmn-TW. */
  languageCode: string
  /** Chirp 3 HD voices take no pitch. */
  pitch?: false
}

const v = (voiceName: string, label: string, gender: GoogleVoice['gender'], lang: string, extra: Partial<GoogleVoice> = {}): GoogleVoice => ({
  id: `google-${voiceName}`,
  label,
  en: voiceName,
  gender,
  voiceName,
  lang,
  languageCode: voiceName.split('-').slice(0, 2).join('-'),
  ...extra,
})

export const GOOGLE_VOICES: GoogleVoice[] = [
  v('cmn-TW-Wavenet-A', '台灣女聲 A（WaveNet）', 'female', 'zh-TW'),
  v('cmn-TW-Wavenet-B', '台灣男聲 B（WaveNet）', 'male', 'zh-TW'),
  v('cmn-TW-Wavenet-C', '台灣男聲 C（WaveNet）', 'male', 'zh-TW'),
  v('cmn-TW-Standard-A', '台灣女聲 A（標準）', 'female', 'zh-TW'),
  v('cmn-TW-Standard-B', '台灣男聲 B（標準）', 'male', 'zh-TW'),
  v('cmn-TW-Standard-C', '台灣男聲 C（標準）', 'male', 'zh-TW'),
  v('en-US-Neural2-F', 'US Female F（Neural2）', 'female', 'en-US'),
  v('en-US-Neural2-H', 'US Female H（Neural2）', 'female', 'en-US'),
  v('en-US-Neural2-D', 'US Male D（Neural2）', 'male', 'en-US'),
  v('en-US-Neural2-J', 'US Male J（Neural2）', 'male', 'en-US'),
  v('en-GB-Neural2-A', 'UK Female A（Neural2）', 'female', 'en-GB'),
  v('en-GB-Neural2-B', 'UK Male B（Neural2）', 'male', 'en-GB'),
  v('ja-JP-Neural2-B', '日語女聲 B（Neural2）', 'female', 'ja-JP'),
  v('ja-JP-Neural2-C', '日語男聲 C（Neural2）', 'male', 'ja-JP'),
  v('ko-KR-Neural2-A', '韓語女聲 A（Neural2）', 'female', 'ko-KR'),
  v('ko-KR-Neural2-C', '韓語男聲 C（Neural2）', 'male', 'ko-KR'),
  // Chirp 3 HD Mandarin; descriptions are Google's own for each voice.
  v('cmn-CN-Chirp3-HD-Aoede', '女聲 Aoede・輕快（Chirp 3 HD）', 'female', 'zh-CN', { pitch: false }),
  v('cmn-CN-Chirp3-HD-Kore', '女聲 Kore・沉穩（Chirp 3 HD）', 'female', 'zh-CN', { pitch: false }),
  v('cmn-CN-Chirp3-HD-Leda', '女聲 Leda・年輕（Chirp 3 HD）', 'female', 'zh-CN', { pitch: false }),
  v('cmn-CN-Chirp3-HD-Zephyr', '女聲 Zephyr・明亮（Chirp 3 HD）', 'female', 'zh-CN', { pitch: false }),
  v('cmn-CN-Chirp3-HD-Charon', '男聲 Charon・知性（Chirp 3 HD）', 'male', 'zh-CN', { pitch: false }),
  v('cmn-CN-Chirp3-HD-Puck', '男聲 Puck・活潑（Chirp 3 HD）', 'male', 'zh-CN', { pitch: false }),
  v('cmn-CN-Chirp3-HD-Orus', '男聲 Orus・堅定（Chirp 3 HD）', 'male', 'zh-CN', { pitch: false }),
  v('cmn-CN-Chirp3-HD-Fenrir', '男聲 Fenrir・熱情（Chirp 3 HD）', 'male', 'zh-CN', { pitch: false }),
]
export const GOOGLE_DEFAULT_VOICE = 'google-cmn-TW-Wavenet-A'

export const googleKeyPath = (root: string) => join(root, GOOGLE_KEY_FILE)
export const googleTtsAvailable = (root: string) => existsSync(googleKeyPath(root))

/** Readable message for a failed call (gRPC status codes). */
function describe(err: { code?: number; details?: string; message?: string }) {
  const detail = err.details || err.message || ''
  if (err.code === 7) return /billing/i.test(detail) ? 'Google Cloud 專案尚未啟用帳單（Text-to-Speech 需要）' : 'Google Cloud 服務帳戶沒有權限，或專案尚未啟用 Text-to-Speech API'
  if (err.code === 16) return 'Google Cloud 金鑰無效或已停用（請重新下載服務帳戶 JSON）'
  if (err.code === 8) return 'Google Cloud 語音用量已達上限，請稍後再試'
  if (err.code === 3) return `Google Cloud 不接受這個請求：${detail}`
  return detail || 'Google Cloud 語音服務錯誤'
}

export function googleTts(root: string) {
  // Loaded on first use (the SDK is large), with the key file given directly to this client.
  let client: Promise<TextToSpeechClient> | null = null
  const load = () => (client ??= import('@google-cloud/text-to-speech').then((m) => new m.TextToSpeechClient({ keyFilename: googleKeyPath(root) })))

  /** One sentence → MP3. `speed` 0.5–2×; `pitch` −50…+50 (% of an octave → ±6 semitones). */
  async function synthesize(text: string, voice: GoogleVoice, speed: number, pitch: number): Promise<{ audio: Buffer; type: string }> {
    const c = await load()
    const semitones = (Math.min(50, Math.max(-50, pitch)) / 100) * 12
    try {
      const [res] = await c.synthesizeSpeech({
        input: { text },
        voice: { languageCode: voice.languageCode, name: voice.voiceName },
        audioConfig: {
          audioEncoding: 'MP3',
          speakingRate: Math.min(2, Math.max(0.5, speed)),
          ...(voice.pitch === false ? {} : { pitch: Math.round(semitones * 10) / 10 }),
        },
      })
      if (!res.audioContent) throw new Error('Google Cloud 沒有回傳聲音')
      return { audio: Buffer.from(res.audioContent as Uint8Array), type: 'audio/mpeg' }
    } catch (err) {
      throw new Error(describe(err as { code?: number; details?: string; message?: string }))
    }
  }

  return { synthesize }
}
