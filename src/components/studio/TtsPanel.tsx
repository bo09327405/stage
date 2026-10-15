import { useEffect, useMemo, useRef, useState } from 'react'
import { DEFAULT_PAUSES, DEFAULT_TTS_VOICE, listVoices, parseScript, pauseTag, scriptDuration, synthesize, type PauseRules, type TtsEngine, type TtsVoice } from '../../studio/tts'
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

/**
 * TTS Maker: write a line, pick a Taiwanese Mandarin voice, and get a clip on the timeline.
 * Commas pause briefly and full stops longer (both adjustable); ((⏱=3000)) inserts an exact
 * 3-second pause anywhere.
 */
export function TtsPanel({ onInsert, onPreview }: { onInsert: (buffer: AudioBuffer, name: string) => Promise<void>; onPreview: (buffer: AudioBuffer) => void }) {
  const [voices, setVoices] = useState<TtsVoice[] | null>(null)
  const [unavailable, setUnavailable] = useState<string | null>(null)
  const [engine, setEngine] = useState<TtsEngine | null>(null)
  const [voice, setVoice] = useState(() => readPref('theatre.tts.voice') ?? DEFAULT_TTS_VOICE)
  const [speed, setSpeed] = useState(() => Number(readPref('theatre.tts.speed')) || 1)
  // Relative pitch, −50…+50 %.
  const [pitch, setPitch] = useState(() => Number(readPref('theatre.tts.pitch')) || 0)
  const [pauses, setPauses] = useState<PauseRules>(() => {
    try {
      return { ...DEFAULT_PAUSES, ...JSON.parse(readPref('theatre.tts.pauses') ?? '{}') }
    } catch {
      return DEFAULT_PAUSES
    }
  })
  const [text, setText] = useState('各位觀眾，晚安。((⏱=1000))演出即將開始，請將手機調成靜音。')
  const [custom, setCustom] = useState(1500)
  const [state, setState] = useState<{ busy: 'preview' | 'insert' | null; progress: string; error: string | null }>({ busy: null, progress: '', error: null })
  const area = useRef<HTMLTextAreaElement>(null)
  // The last clip made, reused if nothing changed (preview then insert costs one synthesis).
  const lastClip = useRef<{ key: string; buffer: AudioBuffer } | null>(null)

  useEffect(() => {
    listVoices().then((r) => {
      setVoices(r.voices)
      setEngine(r.engine ?? null)
      if (!r.available) setUnavailable(r.message ?? '沒有可用的語音')
      // A voice saved from the old engine (or none yet) falls back to the default, 雅婷.
      setVoice((v) => (r.voices.some((x) => x.id === v) ? v : (r.defaultVoice ?? r.voices[0]?.id ?? '')))
    })
  }, [])
  useEffect(() => {
    writePref('theatre.tts.voice', voice)
    writePref('theatre.tts.speed', String(speed))
    writePref('theatre.tts.pitch', String(pitch))
    writePref('theatre.tts.pauses', JSON.stringify(pauses))
  }, [voice, speed, pitch, pauses])

  const segments = useMemo(() => parseScript(text, pauses), [text, pauses])
  const pauseTotal = scriptDuration(segments)

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
    const key = JSON.stringify([text, voice, speed, pitch, pauses])
    setState({ busy: mode, progress: '', error: null })
    try {
      let buffer = lastClip.current?.key === key ? lastClip.current.buffer : null
      if (!buffer) {
        buffer = await synthesize(segments, { voice, speed, pitch, onProgress: (d, t) => setState((s) => ({ ...s, progress: `產生語音 ${d}/${t}` })) })
        lastClip.current = { key, buffer }
      }
      if (mode === 'preview') onPreview(buffer)
      else {
        setState((s) => ({ ...s, progress: '上傳到 Cloudflare R2…' }))
        const firstLine = segments.find((s) => s.type === 'speech')
        await onInsert(buffer, `TTS・${firstLine && firstLine.type === 'speech' ? firstLine.text.slice(0, 12) : '語音'}`)
      }
      setState({ busy: null, progress: mode === 'insert' ? '✓ 已加入音軌' : `✓ ${buffer.duration.toFixed(2)} 秒`, error: null })
    } catch (err) {
      setState({ busy: null, progress: '', error: (err as Error).message })
    }
  }

  // The main group: Taiwanese voices (Microsoft), or the Mandarin voices of the local open-source model.
  const primaryLang = engine === 'local' ? 'zh-CN' : 'zh-TW'
  const taiwan = voices?.filter((v) => (v.lang ?? 'zh-TW') === primaryLang) ?? []
  const female = taiwan.filter((v) => v.gender === 'female')
  const male = taiwan.filter((v) => v.gender === 'male')
  // International voices, one menu group per language.
  const LANGS: Record<string, string> = { 'en-US': '英語（美國）', 'en-GB': '英語（英國）', 'ja-JP': '日語', 'ko-KR': '韓語', 'zh-CN': '普通話（中國）', 'zh-HK': '粵語（香港）' }
  const others: [string, TtsVoice[]][] = []
  for (const v of voices ?? []) {
    const lang = v.lang ?? 'zh-TW'
    if (lang === primaryLang) continue
    const group = others.find(([l]) => l === lang)
    if (group) group[1].push(v)
    else others.push([lang, [v]])
  }
  const chosen = voices?.find((v) => v.id === voice)
  const optionLabel = (v: TtsVoice) =>
    engine === 'google' ? `${v.gender === 'female' ? '👩' : '👨'} ${v.label}` : engine === 'local' ? `${v.gender === 'female' ? '👩' : '👨'} ${v.label}（${v.voiceName}）` : `${v.gender === 'female' ? '👩' : '👨'} ${v.label} (Taiwan ${v.gender === 'female' ? 'Female' : 'Male'} - ${v.en})`

  // No speech server here (e.g. GitHub Pages): one calm card instead of a form that can't work.
  if (unavailable) {
    return (
      <div data-tts-panel>
        <Section title="TTS 語音產生器">
          <p className="rounded-lg bg-standby/10 px-3 py-3 text-xs leading-relaxed text-standby" data-tts-unavailable>
            {unavailable}
          </p>
        </Section>
      </div>
    )
  }

  return (
    <div data-tts-panel>
      <Section title="TTS 語音產生器">
        <label className="block">
          <span className="mb-1 block text-xs text-white/60">聲音</span>
          <select
            value={voice}
            onChange={(e) => setVoice(e.target.value)}
            className="w-full appearance-none rounded-lg border border-white/15 bg-black/40 px-2.5 py-2 text-sm text-white outline-none focus:border-accent"
            data-tts-voice
          >
            {voices === null && <option>載入中…</option>}
            {female.length > 0 && (
              <optgroup label={engine === 'local' ? '中文女聲' : '台灣女聲'}>
                {female.map((v) => (
                  <option key={v.id} value={v.id}>
                    {optionLabel(v)}
                  </option>
                ))}
              </optgroup>
            )}
            {male.length > 0 && (
              <optgroup label={engine === 'local' ? '中文男聲' : '台灣男聲'}>
                {male.map((v) => (
                  <option key={v.id} value={v.id}>
                    {optionLabel(v)}
                  </option>
                ))}
              </optgroup>
            )}
            {/* Languages with both genders get a female and a male group. */}
            {others.flatMap(([lang, list]) => {
              const name = (lang === 'zh-CN' && engine === 'google' ? '中文 Chirp 3 HD（普通話口音）' : LANGS[lang]) ?? lang
              const split = list.some((v) => v.gender === 'female') && list.some((v) => v.gender === 'male')
              const groups = split
                ? [
                    { key: `${lang}-f`, label: `${name}・女聲`, voices: list.filter((v) => v.gender === 'female') },
                    { key: `${lang}-m`, label: `${name}・男聲`, voices: list.filter((v) => v.gender === 'male') },
                  ]
                : [{ key: lang, label: name, voices: list }]
              return groups.map((g) => (
                <optgroup key={g.key} label={g.label}>
                  {g.voices.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label}
                    </option>
                  ))}
                </optgroup>
              ))
            })}
          </select>
        </label>
        {chosen && (
          <p className="text-[10px] text-white/35" data-tts-voice-info>
            {chosen.voiceName}
            {chosen.base ? ` · 以「${chosen.base}」調整音高與語速` : ''} · {engine === 'google' ? 'Google Cloud Text-to-Speech' : engine === 'local' ? 'Kokoro 開源語音（本機執行，免金鑰）' : engine === 'azure' ? 'Azure 語音服務' : 'Microsoft Edge 語音（免金鑰）'}
          </p>
        )}
        <Slider label="語速" value={speed} min={0.5} max={2} step={0.05} display={`${speed.toFixed(2)}×`} reset={1} onChange={setSpeed} />
        <div className={chosen?.pitch === false ? 'pointer-events-none opacity-35' : ''} aria-disabled={chosen?.pitch === false} data-tts-pitch>
          <Slider label="音高" value={pitch} min={-50} max={50} step={1} display={`${pitch > 0 ? '+' : ''}${pitch}%`} reset={0} onChange={setPitch} />
        </div>
        {chosen?.pitch === false && <p className="-mt-1 text-[10px] text-white/35">這個聲音不支援調整音高</p>}
        <textarea
          ref={area}
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={6}
          className="w-full resize-y rounded-lg border border-white/15 bg-black/40 px-2.5 py-2 text-sm leading-relaxed text-white outline-none focus:border-accent"
          placeholder="輸入要朗讀的台詞…"
          data-tts-text
        />
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
                min={50}
                max={60000}
                step={50}
                value={custom}
                onChange={(e) => setCustom(Math.max(50, Math.min(60000, Number(e.target.value) || 0)))}
                className="w-16 rounded-md border border-white/15 bg-black/40 px-1.5 py-1 text-center font-mono text-[11px] text-white"
                aria-label="自訂停頓毫秒"
              />
              <button type="button" onClick={() => insertPause(custom)} className="min-h-8 rounded-md bg-accent/20 px-2 text-[11px] font-semibold text-accent hover:bg-accent hover:text-white">
                插入 ms
              </button>
            </span>
          </div>
          <p className="text-[10px] text-white/30">
            語法：<code className="text-white/55">{pauseTag(3000)}</code> = 停頓 3 秒（取代前一個標點的停頓）
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Slider label="逗點停頓 ，、；：" value={pauses.comma} min={0} max={2} step={0.05} display={`${pauses.comma.toFixed(2)}s`} reset={DEFAULT_PAUSES.comma} onChange={(v) => setPauses((p) => ({ ...p, comma: v }))} />
          <Slider label="句點停頓 。！？" value={pauses.period} min={0} max={3} step={0.05} display={`${pauses.period.toFixed(2)}s`} reset={DEFAULT_PAUSES.period} onChange={(v) => setPauses((p) => ({ ...p, period: v }))} />
        </div>
      </Section>
      <Section title={`斷句預覽 · 停頓共 ${pauseTotal.toFixed(1)}s`}>
        <div className="flex flex-wrap gap-1" data-tts-segments>
          {segments.map((s, i) =>
            s.type === 'pause' ? (
              <span key={i} className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${s.explicit ? 'bg-standby/20 text-standby' : 'bg-white/10 text-white/50'}`}>
                ⏱{s.seconds}s
              </span>
            ) : (
              <span key={i} className="rounded bg-accent/15 px-1.5 py-0.5 text-[11px] text-white/85">
                {s.text}
              </span>
            ),
          )}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => make('preview')}
            disabled={!!state.busy || !voice}
            className="min-h-10 flex-1 rounded-lg bg-white/[0.08] text-xs font-semibold text-white hover:bg-white/15 disabled:opacity-40"
            data-tts-preview
          >
            {state.busy === 'preview' ? '產生中…' : '▶ 產生並試聽'}
          </button>
          <button
            type="button"
            onClick={() => make('insert')}
            disabled={!!state.busy || !voice}
            className="min-h-10 flex-1 rounded-lg bg-accent text-xs font-semibold text-white hover:brightness-110 disabled:opacity-40"
            data-tts-insert
          >
            {state.busy === 'insert' ? '處理中…' : '＋ 加入音軌'}
          </button>
        </div>
        {(state.progress || state.error) && (
          <p className={`text-xs ${state.error ? 'text-panic' : 'text-white/55'}`} data-tts-status>
            {state.error ?? state.progress}
          </p>
        )}
      </Section>
    </div>
  )
}
