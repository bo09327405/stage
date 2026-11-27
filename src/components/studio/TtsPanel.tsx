import { useEffect, useMemo, useRef, useState } from 'react'
import { SAMPLE_RATE } from '../../studio/audio'
import { DEFAULT_ELEVEN_VOICE, ELEVEN_MODEL, ELEVEN_VOICES, SPEED_RANGE, pauseTag, synthesizeEleven, toElevenText } from '../../studio/tts'
import { Section, Slider } from './Inspector'

const readPref = (k: string) => {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}
const writePref = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v)
  } catch {
    // not remembered
  }
}

const CUSTOM = '__custom'
const num = (k: string, fallback: number) => {
  const v = readPref(k)
  return v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : fallback
}

/**
 * TTS Maker: write a line, pick an ElevenLabs voice, and get a clip on the timeline. The browser talks to ElevenLabs
 * with the user's own API key (kept in this browser only) and the MP3 is stored on R2 as it is.
 * ((⏱=3000)) inserts an exact 3-second pause anywhere (sent as <break time="3.0s" />).
 */
export function TtsPanel({
  onInsert,
  onPreview,
}: {
  onInsert: (buffer: AudioBuffer, name: string, encoded: { blob: Blob; fileName: string }) => Promise<void>
  onPreview: (buffer: AudioBuffer) => void
}) {
  const [apiKey, setApiKey] = useState(() => readPref('theatre.tts.elevenKey') ?? '')
  const [keyOpen, setKeyOpen] = useState(() => !readPref('theatre.tts.elevenKey'))
  const [voice, setVoice] = useState(() => readPref('theatre.tts.elevenVoice') ?? DEFAULT_ELEVEN_VOICE)
  const [customVoice, setCustomVoice] = useState(() => readPref('theatre.tts.elevenCustom') ?? '')
  const [speed, setSpeed] = useState(() => Math.min(SPEED_RANGE.max, Math.max(SPEED_RANGE.min, num('theatre.tts.elevenSpeed', 1))))
  const [stability, setStability] = useState(() => num('theatre.tts.elevenStability', 50))
  const [similarity, setSimilarity] = useState(() => num('theatre.tts.elevenSimilarity', 75))
  const [text, setText] = useState('各位觀眾，晚安。((⏱=1000))演出即將開始，請將手機調成靜音。')
  const [custom, setCustom] = useState(1500)
  const [state, setState] = useState<{ busy: 'preview' | 'insert' | null; progress: string; error: string | null }>({ busy: null, progress: '', error: null })
  const area = useRef<HTMLTextAreaElement>(null)
  // The last clip made, reused if nothing changed (preview then insert costs one synthesis, one batch of the monthly quota).
  const lastClip = useRef<{ key: string; blob: Blob; buffer: AudioBuffer } | null>(null)

  useEffect(() => {
    writePref('theatre.tts.elevenKey', apiKey.trim())
    writePref('theatre.tts.elevenVoice', voice)
    writePref('theatre.tts.elevenCustom', customVoice)
    writePref('theatre.tts.elevenSpeed', String(speed))
    writePref('theatre.tts.elevenStability', String(stability))
    writePref('theatre.tts.elevenSimilarity', String(similarity))
  }, [apiKey, voice, customVoice, speed, stability, similarity])

  const voiceId = voice === CUSTOM ? customVoice.trim() : voice
  const converted = useMemo(() => toElevenText(text), [text])
  const chars = converted.replace(/\s+/g, ' ').trim().length
  const preset = ELEVEN_VOICES.find((v) => v.id === voice)

  const insertPause = (ms: number) => {
    const el = area.current
    const tag = pauseTag(ms)
    const at = el?.selectionStart ?? text.length
    const end = el?.selectionEnd ?? at
    setText(text.slice(0, at) + tag + text.slice(end))
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(at + tag.length, at + tag.length)
    })
  }

  const make = async (mode: 'preview' | 'insert') => {
    const key = JSON.stringify([text, voiceId, speed, stability, similarity])
    setState({ busy: mode, progress: '', error: null })
    try {
      let clip = lastClip.current?.key === key ? lastClip.current : null
      if (!clip) {
        setState((s) => ({ ...s, progress: '向 ElevenLabs 產生語音…' }))
        const blob = await synthesizeEleven(text, { apiKey: apiKey.trim(), voiceId, stability: stability / 100, similarity: similarity / 100, speed })
        const buffer = await new OfflineAudioContext(1, 1, SAMPLE_RATE).decodeAudioData(await blob.arrayBuffer())
        clip = lastClip.current = { key, blob, buffer }
      }
      if (mode === 'preview') onPreview(clip.buffer)
      else {
        setState((s) => ({ ...s, progress: '上傳到 Cloudflare R2…' }))
        const first = text.replace(/\(\([^)]*\)\)/g, '').trim()
        await onInsert(clip.buffer, `TTS・${first.slice(0, 12) || '語音'}`, { blob: clip.blob, fileName: `tts_${Date.now()}.mp3` })
      }
      setState({ busy: null, progress: mode === 'insert' ? '✓ 已加入音軌' : `✓ ${clip.buffer.duration.toFixed(2)} 秒`, error: null })
    } catch (err) {
      setState({ busy: null, progress: '', error: (err as Error).message })
    }
  }

  const input = 'w-full rounded-lg border border-white/15 bg-black/40 px-2.5 py-2 text-sm text-white outline-none focus:border-accent'
  const ready = !!apiKey.trim() && !!voiceId

  return (
    <div data-tts-panel>
      <Section
        title="TTS 語音產生器"
        right={
          <button type="button" onClick={() => setKeyOpen((o) => !o)} className="text-[11px] text-white/45 hover:text-white" aria-expanded={keyOpen} data-tts-key-toggle>
            {apiKey.trim() ? '🔑 API Key' : '🔑 設定 API Key'} {keyOpen ? '▴' : '▾'}
          </button>
        }
      >
        {keyOpen && (
          <label className="block" data-tts-key>
            <span className="mb-1 block text-xs text-white/60">ElevenLabs API Key</span>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk_…"
              autoComplete="off"
              spellCheck={false}
              className={`${input} font-mono`}
              data-tts-key-input
            />
            <span className="mt-1 block text-[10px] leading-relaxed text-white/35">金鑰只存在這個瀏覽器（localStorage），不會寫進程式碼或專案；在 elevenlabs.io 的 Developers → API Keys 建立。</span>
          </label>
        )}
        <label className="block">
          <span className="mb-1 block text-xs text-white/60">聲音</span>
          <select value={voice} onChange={(e) => setVoice(e.target.value)} className={`${input} appearance-none`} data-tts-voice>
            {ELEVEN_VOICES.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}（{v.note}）
              </option>
            ))}
            <option value={CUSTOM}>自訂 Voice ID…</option>
          </select>
        </label>
        {voice === CUSTOM && (
          <input
            type="text"
            value={customVoice}
            onChange={(e) => setCustomVoice(e.target.value)}
            placeholder="貼上 ElevenLabs Voices 頁面的 Voice ID"
            spellCheck={false}
            className={`${input} font-mono`}
            aria-label="自訂 Voice ID"
            data-tts-custom-voice
          />
        )}
        <p className="text-[10px] text-white/35" data-tts-voice-info>
          {preset ? `${preset.label} · ` : ''}
          {ELEVEN_MODEL} · ElevenLabs AI Voice
        </p>
        <Slider label="語速" value={speed} min={SPEED_RANGE.min} max={SPEED_RANGE.max} step={0.05} display={`${speed.toFixed(2)}×`} reset={1} onChange={setSpeed} />
        <div className="grid grid-cols-2 gap-3">
          <Slider label="穩定度 Stability" value={stability} min={0} max={100} step={1} display={`${stability}%`} reset={50} onChange={setStability} />
          <Slider label="相似度 Similarity" value={similarity} min={0} max={100} step={1} display={`${similarity}%`} reset={75} onChange={setSimilarity} />
        </div>
        <p className="-mt-1 text-[10px] text-white/30">穩定度低＝語氣起伏大、戲劇張力強；高＝平穩一致。</p>
        <textarea
          ref={area}
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={6}
          className={`${input} resize-y leading-relaxed`}
          placeholder="輸入要朗讀的台詞…"
          data-tts-text
        />
        <p className="text-right font-mono text-[10px] text-white/40" data-tts-chars>
          {chars} 字元（免費版每月約 10,000 字元）
        </p>
        <div className="space-y-1.5">
          <span className="block text-xs text-white/60">插入停頓（在游標位置）</span>
          <div className="flex flex-wrap items-center gap-1">
            {[500, 1000, 2000, 3000].map((ms) => (
              <button key={ms} type="button" onClick={() => insertPause(ms)} className="min-h-8 rounded-md bg-white/[0.07] px-2 text-[11px] text-white/75 hover:bg-white/15" data-insert-pause={ms}>
                ⏱ {ms / 1000}s
              </button>
            ))}
            <span className="flex items-center gap-1">
              <input
                type="number"
                min={100}
                max={60000}
                step={100}
                value={custom}
                onChange={(e) => setCustom(Math.max(100, Math.min(60000, Number(e.target.value) || 0)))}
                className="w-16 rounded-md border border-white/15 bg-black/40 px-1.5 py-1 text-center font-mono text-[11px] text-white"
                aria-label="自訂停頓毫秒"
              />
              <button type="button" onClick={() => insertPause(custom)} className="min-h-8 rounded-md bg-accent/20 px-2 text-[11px] font-semibold text-accent hover:bg-accent hover:text-white">
                插入 ms
              </button>
            </span>
          </div>
          <p className="text-[10px] text-white/30">
            語法：<code className="text-white/55">{pauseTag(3000)}</code> 送出時轉成 <code className="text-white/55">{'<break time="3.0s" />'}</code>（單次最長 3 秒，更長會自動接續）
          </p>
        </div>
      </Section>
      <Section title="送出內容預覽">
        <p className="whitespace-pre-wrap break-words rounded-lg bg-black/30 px-2.5 py-2 text-[11px] leading-relaxed text-white/70" data-tts-converted>
          {converted.trim() || '（空）'}
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => make('preview')}
            disabled={!!state.busy || !ready}
            className="min-h-10 flex-1 rounded-lg bg-white/[0.08] text-xs font-semibold text-white hover:bg-white/15 disabled:opacity-40"
            data-tts-preview
          >
            {state.busy === 'preview' ? '產生中…' : '▶ 產生並試聽'}
          </button>
          <button
            type="button"
            onClick={() => make('insert')}
            disabled={!!state.busy || !ready}
            className="min-h-10 flex-1 rounded-lg bg-accent text-xs font-semibold text-white hover:brightness-110 disabled:opacity-40"
            data-tts-insert
          >
            {state.busy === 'insert' ? '處理中…' : '＋ 加入音軌'}
          </button>
        </div>
        {!ready && <p className="text-[11px] text-standby">{apiKey.trim() ? '請輸入 Voice ID' : '請先在上方設定 ElevenLabs API Key'}</p>}
        {(state.progress || state.error) && (
          <p className={`text-xs ${state.error ? 'text-panic' : 'text-white/55'}`} data-tts-status>
            {state.error ?? state.progress}
          </p>
        )}
      </Section>
    </div>
  )
}
