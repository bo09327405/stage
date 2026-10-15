import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

/**
 * Open-source text-to-speech, run locally: Kokoro (multi-language v1.1, int8) through
 * sherpa-onnx — Mandarin and English neural voices on the CPU, no API key, no network.
 *
 * The model lives in tts-models/ (download it with `npm run tts:setup`). It's loaded on first use
 * and requests are synthesized one at a time (one model, one CPU job at a time).
 *
 * Kokoro's Mandarin front end reads Simplified Chinese, so Traditional text is converted first
 * (OpenCC, Taiwan → Mainland); the clip is the same, only the dictionary lookup changes. Kokoro has
 * no pitch control: pitch is shifted by resampling, with the speed asked of the model adjusted so
 * the clip keeps its length.
 */

export const LOCAL_MODEL = 'kokoro-int8-multi-lang-v1_1'

export interface LocalVoice {
  id: string
  label: string
  en: string
  gender: 'female' | 'male'
  /** Kokoro speaker id. */
  sid: number
  /** Kokoro voice name, e.g. zf_001. */
  voiceName: string
  lang: 'zh-CN' | 'en-US' | 'en-GB'
}

/*
 * Speakers of kokoro-multi-lang-v1_1: 0 af_maple, 1 af_sol, 2 bf_vale (English); 3–57 zf_* (Mandarin,
 * female); 58–102 zm_* (Mandarin, male). A selection, spread across the range.
 */
const zf = (n: number, sid: number, label: string): LocalVoice => ({ id: `kokoro-zf-${n}`, label, en: `zf_${String(n).padStart(3, '0')}`, gender: 'female', sid, voiceName: `zf_${String(n).padStart(3, '0')}`, lang: 'zh-CN' })
const zm = (n: number, sid: number, label: string): LocalVoice => ({ id: `kokoro-zm-${n}`, label, en: `zm_${String(n).padStart(3, '0')}`, gender: 'male', sid, voiceName: `zm_${String(n).padStart(3, '0')}`, lang: 'zh-CN' })

export const LOCAL_VOICES: LocalVoice[] = [
  // Descriptions from each voice's measured pitch (女 163–300 Hz, 男 102–147 Hz).
  zf(1, 3, '女聲 1・明亮'),
  zf(2, 4, '女聲 2'),
  zf(3, 5, '女聲 3'),
  zf(4, 6, '女聲 4'),
  zf(5, 7, '女聲 5'),
  zf(6, 8, '女聲 6・沉穩'),
  zf(17, 11, '女聲 7・高亢'),
  zf(22, 15, '女聲 8'),
  zm(9, 58, '男聲 1'),
  zm(10, 59, '男聲 2'),
  zm(11, 60, '男聲 3'),
  zm(12, 61, '男聲 4・清亮'),
  zm(13, 62, '男聲 5'),
  zm(14, 63, '男聲 6・低沉'),
  { id: 'kokoro-af-maple', label: 'Maple（英語）', en: 'Maple', gender: 'female', sid: 0, voiceName: 'af_maple', lang: 'en-US' },
  { id: 'kokoro-af-sol', label: 'Sol（英語）', en: 'Sol', gender: 'female', sid: 1, voiceName: 'af_sol', lang: 'en-US' },
  { id: 'kokoro-bf-vale', label: 'Vale（英式英語）', en: 'Vale', gender: 'female', sid: 2, voiceName: 'bf_vale', lang: 'en-GB' },
]
export const LOCAL_DEFAULT_VOICE = 'kokoro-zf-1'

const require = createRequire(import.meta.url)

interface GeneratedAudio {
  samples: Float32Array
  sampleRate: number
}
interface OfflineTtsHandle {
  sampleRate: number
  generateAsync(req: { text: string; sid: number; speed: number }): Promise<GeneratedAudio>
}

export function localModelDir(root: string) {
  return join(root, 'tts-models', LOCAL_MODEL)
}

export function localTtsAvailable(root: string) {
  return existsSync(join(localModelDir(root), 'model.int8.onnx'))
}

export function localTts(root: string) {
  const dir = localModelDir(root)
  let engine: Promise<OfflineTtsHandle> | null = null
  let toSimplified: ((s: string) => string) | null = null
  // One synthesis at a time.
  let queue: Promise<unknown> = Promise.resolve()

  const load = () =>
    (engine ??= (async () => {
      const sherpa = require('sherpa-onnx-node') as { OfflineTts: { createAsync(config: unknown): Promise<OfflineTtsHandle> } }
      const f = (name: string) => join(dir, name)
      return sherpa.OfflineTts.createAsync({
        model: {
          kokoro: {
            model: f('model.int8.onnx'),
            voices: f('voices.bin'),
            tokens: f('tokens.txt'),
            dataDir: f('espeak-ng-data'),
            lexicon: [f('lexicon-us-en.txt'), f('lexicon-zh.txt')].join(','),
          },
          numThreads: 2,
          provider: 'cpu',
          debug: false,
        },
        ruleFsts: ['date-zh.fst', 'phone-zh.fst', 'number-zh.fst']
          .map(f)
          .filter((p) => existsSync(p))
          .join(','),
        maxNumSentences: 1,
      }).catch((err: Error) => {
        engine = null
        throw new Error(`本機語音模型載入失敗：${err.message}`)
      })
    })())

  const simplified = (text: string) => {
    if (!toSimplified) {
      const OpenCC = require('opencc-js') as { Converter(o: { from: string; to: string }): (s: string) => string }
      toSimplified = OpenCC.Converter({ from: 'tw', to: 'cn' })
    }
    return toSimplified(text)
  }

  /** One sentence → 16-bit mono WAV at the model's rate. `pitch`: −50…+50 (% of an octave). */
  async function synthesize(text: string, voice: LocalVoice, speed: number, pitch: number): Promise<{ audio: Buffer; type: string }> {
    const run = async () => {
      const tts = await load()
      const ratio = 2 ** (Math.min(50, Math.max(-50, pitch)) / 100)
      const input = voice.lang === 'zh-CN' ? simplified(text) : text
      // Resampling by `ratio` raises the pitch and shortens the clip by the same factor: ask the
      // model for proportionally slower speech so the length comes out as requested.
      const { samples, sampleRate } = await tts.generateAsync({ text: input, sid: voice.sid, speed: Math.min(2, Math.max(0.5, speed)) / ratio })
      return wav(ratio === 1 ? samples : resample(samples, ratio), sampleRate)
    }
    const job = queue.then(run, run)
    queue = job.catch(() => {})
    return { audio: await job, type: 'audio/wav' }
  }

  return { synthesize }
}

/** Play `samples` `ratio` times faster (linear interpolation): pitch × ratio, length ÷ ratio. */
function resample(samples: Float32Array, ratio: number) {
  const out = new Float32Array(Math.max(1, Math.floor(samples.length / ratio)))
  for (let i = 0; i < out.length; i++) {
    const x = i * ratio
    const j = Math.floor(x)
    const a = samples[j] ?? 0
    const b = samples[j + 1] ?? a
    out[i] = a + (b - a) * (x - j)
  }
  return out
}

function wav(samples: Float32Array, sampleRate: number) {
  const buf = Buffer.alloc(44 + samples.length * 2)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + samples.length * 2, 4)
  buf.write('WAVEfmt ', 8)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(samples.length * 2, 40)
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2)
  return buf
}
