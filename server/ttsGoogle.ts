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

import type { GoogleVoice } from './ttsGoogleVoices.ts'

export { GOOGLE_DEFAULT_VOICE, GOOGLE_VOICES, type GoogleVoice } from './ttsGoogleVoices.ts'

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
