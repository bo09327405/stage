import { useEffect, useRef, useState } from 'react'
import { SAMPLE_RATE } from '../../studio/audio'
import { useProjectElevenKey } from '../../services/projectSecrets'
import { BREAK_RANGE, DEFAULT_ELEVEN_VOICE, ELEVEN_MODEL, ELEVEN_VOICES, SPEED_RANGE, breakTag, listElevenVoices, pickDefaultVoice, synthesizeEleven, type ElevenVoice } from '../../studio/tts'
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
 * and the MP3 is stored on R2 as it is. The API key is the person's own (kept in this browser only) when they have
 * one, else the project's default set by an admin. Pauses are SSML: <break time="1.0s" />.
 */
export function TtsPanel({
  projectId,
  onInsert,
  onPreview,
}: {
  projectId: string
  onInsert: (buffer: AudioBuffer, name: string, encoded: { blob: Blob; fileName: string }) => Promise<void>
  onPreview: (buffer: AudioBuffer) => void
}) {
  const [apiKey, setApiKey] = useState(() => readPref('theatre.tts.elevenKey') ?? '')
  const project = useProjectElevenKey(projectId)
  // The account's voices once a key works; until then (or if the list can't be fetched) the built-in premade ones.
  const [list, setList] = useState<{ voices: ElevenVoice[]; live: boolean; error: string | null; loading: boolean }>({ voices: ELEVEN_VOICES, live: false, error: null, loading: false })
  const [reload, setReload] = useState(0)
  const [voice, setVoice] = useState(() => readPref('theatre.tts.elevenVoice') ?? DEFAULT_ELEVEN_VOICE)
  const [customVoice, setCustomVoice] = useState(() => readPref('theatre.tts.elevenCustom') ?? '')
  const [speed, setSpeed] = useState(() => Math.min(SPEED_RANGE.max, Math.max(SPEED_RANGE.min, num('theatre.tts.elevenSpeed', 1))))
  const [stability, setStability] = useState(() => num('theatre.tts.elevenStability', 50))
  const [similarity, setSimilarity] = useState(() => num('theatre.tts.elevenSimilarity', 75))
  const [text, setText] = useState('各位觀眾，晚安。<break time="1.0s" />演出即將開始，請將手機調成靜音。')
  const [custom, setCustom] = useState(1.5)
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

  // Her own key first, the project's as the fallback.
  const personal = apiKey.trim()
  const effectiveKey = personal || project.key

  useEffect(() => {
    if (!effectiveKey) return
    const ctl = new AbortController()
    queueMicrotask(() => setList((l) => ({ ...l, loading: true, error: null })))
    listElevenVoices(effectiveKey, ctl.signal)
      .then((voices) => {
        if (voices.length === 0) throw new Error('這個帳號沒有可用的聲音')
        setList({ voices, live: true, error: null, loading: false })
        // A saved choice that is not in this account's list (a community voice, another key's voice) falls back to her own voice, else Rachel.
        setVoice((v) => (v === CUSTOM || voices.some((x) => x.id === v) ? v : pickDefaultVoice(voices)))
      })
      .catch((err: Error) => {
        if (err.name !== 'AbortError') setList({ voices: ELEVEN_VOICES, live: false, error: `${err.message}（改用內建聲音）`, loading: false })
      })
    return () => ctl.abort()
  }, [effectiveKey, reload])

  const voiceId = voice === CUSTOM ? customVoice.trim() : voice
  const chars = text.trim().length
  const preset = list.voices.find((v) => v.id === voice)
  const mine = list.voices.filter((v) => v.category === 'generated' || v.category === 'cloned' || v.category === 'professional')
  const premade = list.voices.filter((v) => v.category === 'premade')
  const other = list.voices.filter((v) => !mine.includes(v) && !premade.includes(v))
  const option = (v: ElevenVoice) => (
    <option key={v.id} value={v.id}>
      {v.label}
      {v.note ? `（${v.note}）` : ''}
    </option>
  )

  const insertPause = (seconds: number) => {
    const el = area.current
    const tag = breakTag(seconds)
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
        const blob = await synthesizeEleven(text, { apiKey: effectiveKey, voiceId, stability: stability / 100, similarity: similarity / 100, speed })
        const buffer = await new OfflineAudioContext(1, 1, SAMPLE_RATE).decodeAudioData(await blob.arrayBuffer())
        clip = lastClip.current = { key, blob, buffer }
      }
      if (mode === 'preview') onPreview(clip.buffer)
      else {
        setState((s) => ({ ...s, progress: '上傳到 Cloudflare R2…' }))
        const first = text.replace(/<break[^>]*>/g, '').trim()
        await onInsert(clip.buffer, `TTS・${first.slice(0, 12) || '語音'}`, { blob: clip.blob, fileName: `tts_${Date.now()}.mp3` })
      }
      setState({ busy: null, progress: mode === 'insert' ? '✓ 已加入音軌' : `✓ ${clip.buffer.duration.toFixed(2)} 秒`, error: null })
    } catch (err) {
      setState({ busy: null, progress: '', error: (err as Error).message })
    }
  }

  const input = 'w-full rounded-lg border border-white/15 bg-black/40 px-2.5 py-2 text-sm text-white outline-none focus:border-accent'
  const ready = !!effectiveKey && !!voiceId

  return (
    <div data-tts-panel>
      <Section title="TTS 語音產生器">
        <div className="space-y-1.5" data-tts-key>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-white/60" data-tts-key-status={personal ? 'personal' : project.key ? 'project' : 'none'}>
              {personal ? '🟢 使用個人自訂 API Key' : project.key ? '🔵 使用專案預設 API Key' : project.ready ? '⚪ 尚未設定 API Key' : '⚪ 讀取專案設定中…'}
            </span>
            {personal && (
              <button type="button" onClick={() => setApiKey('')} className="text-[11px] text-white/45 hover:text-white" data-tts-key-clear>
                [ 清除並改回專案預設 ]
              </button>
            )}
          </div>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="自訂 ElevenLabs API Key（選填）sk_…"
            autoComplete="off"
            spellCheck={false}
            className={`${input} font-mono`}
            aria-label="自訂 ElevenLabs API Key（選填）"
            data-tts-key-input
          />
          <p className="text-[10px] leading-relaxed text-white/35">
            個人金鑰只存在這個瀏覽器（localStorage），優先於專案預設。{!personal && !project.key && project.ready && '沒有金鑰時，請貼上自己的，或請管理員在專案卡片上設定專案預設金鑰。'}
          </p>
        </div>
        <label className="block">
          <span className="mb-1 flex items-center justify-between text-xs text-white/60">
            聲音
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault()
                setReload((n) => n + 1)
              }}
              disabled={!effectiveKey || list.loading}
              className="text-[11px] text-white/45 hover:text-white disabled:opacity-30"
              data-tts-voices-refresh
            >
              {list.loading ? '載入中…' : '[ 🔄 重新整理聲音清單 ]'}
            </button>
          </span>
          <select value={voice} onChange={(e) => setVoice(e.target.value)} className={`${input} appearance-none`} data-tts-voice>
            {mine.length > 0 && <optgroup label="我的自建聲音 (My Voices / Voice Design)">{mine.map(option)}</optgroup>}
            {premade.length > 0 && <optgroup label="官方預設聲音 (Premade Voices)">{premade.map(option)}</optgroup>}
            {other.length > 0 && <optgroup label="其他">{other.map(option)}</optgroup>}
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
        {list.error && <p className="text-[11px] text-standby">{list.error}</p>}
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
        <div className="space-y-1.5">
          <span className="block text-xs text-white/60">插入停頓（在游標位置）</span>
          <div className="flex flex-wrap items-center gap-1">
            {[0.5, 1, 2].map((sec) => (
              <button key={sec} type="button" onClick={() => insertPause(sec)} className="min-h-8 rounded-md bg-white/[0.07] px-2 text-[11px] text-white/75 hover:bg-white/15" data-insert-pause={sec}>
                [ +{sec.toFixed(1)}s 停頓 ]
              </button>
            ))}
            <span className="flex items-center gap-1">
              <input
                type="number"
                min={BREAK_RANGE.min}
                max={BREAK_RANGE.max}
                step={0.1}
                value={custom}
                onChange={(e) => setCustom(Math.max(BREAK_RANGE.min, Math.min(BREAK_RANGE.max, Number(e.target.value) || BREAK_RANGE.min)))}
                className="w-16 rounded-md border border-white/15 bg-black/40 px-1.5 py-1 text-center font-mono text-[11px] text-white"
                aria-label="自訂停頓秒數"
              />
              <button type="button" onClick={() => insertPause(custom)} className="min-h-8 rounded-md bg-accent/20 px-2 text-[11px] font-semibold text-accent hover:bg-accent hover:text-white">
                插入秒數
              </button>
            </span>
          </div>
          <p className="text-[10px] text-white/30">
            語法：<code className="text-white/55">{breakTag(1)}</code>（ElevenLabs 單次停頓 0.1–3 秒；更長請連續插入）
          </p>
        </div>
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
      </Section>
      <Section title="產生">
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
        {!ready && <p className="text-[11px] text-standby">{effectiveKey ? '請輸入 Voice ID' : '請先設定 ElevenLabs API Key'}</p>}
        {(state.progress || state.error) && (
          <p className={`text-xs ${state.error ? 'text-panic' : 'text-white/55'}`} data-tts-status>
            {state.error ?? state.progress}
          </p>
        )}
      </Section>
    </div>
  )
}
