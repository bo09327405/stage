import { SAMPLE_RATE, concatBuffers } from './audio'

/*
 * TTS Maker: script → spoken clip.
 *
 * Pauses come from the text itself:
 *   ，、；：,;:        short pause (default 0.3 s)
 *   。！？!?…  . (not in a number)  and line breaks   long pause (default 0.8 s)
 *   ((⏱=3000))         an explicit pause in milliseconds (replaces the punctuation pause before it)
 * Each sentence is synthesized on its own, trimmed of the engine's own silence, and joined with
 * exactly these pauses — so timing is predictable for cueing.
 */

/** One menu voice (the server's table): Microsoft neural zh-TW, or a variation of one. */
export interface TtsVoice {
  id: string
  /** 雅婷 */
  label: string
  /** Yating */
  en: string
  gender: 'female' | 'male'
  /** The Microsoft voice that speaks it, e.g. zh-TW-HsiaoChenNeural. */
  voiceName: string
  /** For variations: the voice it is based on (曉臻 …). */
  base?: string
  /** Its language, e.g. zh-TW, en-US (menu groups). */
  lang?: string
  /** false: this voice takes no pitch (e.g. Google Chirp 3 HD). */
  pitch?: false
}

export type TtsEngine = 'google' | 'local' | 'azure' | 'edge'

export const DEFAULT_TTS_VOICE = 'yating'

export type TtsSegment = { type: 'speech'; text: string } | { type: 'pause'; seconds: number; explicit: boolean }

export interface PauseRules {
  comma: number
  period: number
}

export const DEFAULT_PAUSES: PauseRules = { comma: 0.3, period: 0.8 }

/** The tag inserted for an explicit pause. */
export const pauseTag = (ms: number) => `((⏱=${Math.round(ms)}))`

const TAG = /\(\(\s*⏱\s*=\s*(\d+(?:\.\d+)?)\s*\)\)/g
const COMMA = '，、；：,;:'
const PERIOD = '。！？!?…'

export function parseScript(text: string, rules: PauseRules = DEFAULT_PAUSES): TtsSegment[] {
  const out: TtsSegment[] = []
  let speech = ''
  const flush = () => {
    const t = speech.trim()
    if (t) out.push({ type: 'speech', text: t })
    speech = ''
  }
  const pause = (seconds: number, explicit: boolean) => {
    flush()
    const last = out.at(-1)
    if (last?.type === 'pause') {
      // An explicit tag right after punctuation means "this long instead".
      if (explicit && !last.explicit) Object.assign(last, { seconds, explicit: true })
      else if (explicit) last.seconds += seconds
      else last.seconds = Math.max(last.seconds, seconds)
      return
    }
    if (out.length === 0 && !explicit) return // no pause before anything is said
    out.push({ type: 'pause', seconds, explicit })
  }

  let i = 0
  const tags = [...text.matchAll(TAG)]
  let nextTag = 0
  while (i < text.length) {
    const tag = tags[nextTag]
    if (tag && tag.index === i) {
      pause(Number(tag[1]) / 1000, true)
      i += tag[0].length
      nextTag++
      continue
    }
    const ch = text[i]
    const isDecimal = ch === '.' && /\d/.test(text[i - 1] ?? '') && /\d/.test(text[i + 1] ?? '')
    if (COMMA.includes(ch)) {
      speech += ch
      pause(rules.comma, false)
    } else if (PERIOD.includes(ch) || (ch === '.' && !isDecimal) || ch === '\n') {
      if (ch !== '\n') speech += ch
      pause(rules.period, false)
    } else speech += ch
    i++
  }
  flush()
  // A trailing punctuation pause is just silence at the end of the clip.
  while (out.at(-1)?.type === 'pause' && !(out.at(-1) as { explicit: boolean }).explicit) out.pop()
  return out
}

export const scriptDuration = (segments: TtsSegment[]) => segments.reduce((s, x) => s + (x.type === 'pause' ? x.seconds : 0), 0)

/** Static hosting (GitHub Pages…) has no speech server; it is not a failure to retry. */
const STATIC_HOST = /\.github\.io$|\.pages\.dev$|\.netlify\.app$/i
export const NO_TTS_ONLINE = '線上版沒有語音合成服務。TTS 需要在本機以 npm run dev 開啟 Studio 才能使用；已經生成並加入音軌的語音不受影響。'

export async function listVoices(): Promise<{ available: boolean; voices: TtsVoice[]; engine?: TtsEngine; defaultVoice?: string; message?: string }> {
  try {
    const res = await fetch('/api/tts/voices')
    return (await res.json()) as { available: boolean; voices: TtsVoice[]; engine: TtsEngine; defaultVoice: string }
  } catch {
    // Not JSON (the host's 404 page) or no connection.
    const message = STATIC_HOST.test(location.hostname) ? NO_TTS_ONLINE : '無法連線到語音服務（請確認 npm run dev 仍在執行）'
    return { available: false, voices: [], message }
  }
}

/** Cut the engine's leading / trailing silence so pauses are exactly what the script says. */
function trimSilence(b: AudioBuffer, threshold = 10 ** (-50 / 20), keep = 0.02): AudioBuffer {
  const data = b.getChannelData(0)
  let start = 0
  let end = data.length - 1
  while (start < end && Math.abs(data[start]) < threshold) start++
  while (end > start && Math.abs(data[end]) < threshold) end--
  const pad = Math.round(keep * b.sampleRate)
  start = Math.max(0, start - pad)
  end = Math.min(data.length - 1, end + pad)
  const out = new AudioBuffer({ numberOfChannels: b.numberOfChannels, length: Math.max(1, end - start + 1), sampleRate: b.sampleRate })
  for (let c = 0; c < b.numberOfChannels; c++) out.getChannelData(c).set(b.getChannelData(c).subarray(start, end + 1))
  return out
}

const decoder = () => new OfflineAudioContext(1, 1, SAMPLE_RATE)

async function speak(text: string, voice: string, speed: number, pitch: number, signal?: AbortSignal): Promise<AudioBuffer> {
  const res = await fetch('/api/tts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, voice, speed, pitch }),
    signal,
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `語音產生失敗（HTTP ${res.status}）`)
  }
  return trimSilence(await decoder().decodeAudioData(await res.arrayBuffer()))
}

/** Synthesize a whole script into one mono clip. `onProgress(done, total)` per sentence. */
export async function synthesize(
  segments: TtsSegment[],
  { voice, speed = 1, pitch = 0, signal, onProgress }: { voice: string; speed?: number; pitch?: number; signal?: AbortSignal; onProgress?: (done: number, total: number) => void },
): Promise<AudioBuffer> {
  const speech = segments.filter((s): s is Extract<TtsSegment, { type: 'speech' }> => s.type === 'speech')
  if (speech.length === 0) throw new Error('請輸入要朗讀的文字')
  let done = 0
  // A few sentences at a time keeps it quick without flooding the server.
  const results = new Map<TtsSegment, AudioBuffer>()
  const queue = [...speech]
  await Promise.all(
    Array.from({ length: Math.min(3, queue.length) }, async () => {
      for (let s = queue.shift(); s; s = queue.shift()) {
        results.set(s, await speak(s.text, voice, speed, pitch, signal))
        onProgress?.(++done, speech.length)
      }
    }),
  )
  return concatBuffers(
    segments.map((s) => (s.type === 'pause' ? { silence: s.seconds } : results.get(s)!)),
    SAMPLE_RATE,
    1,
  )
}
