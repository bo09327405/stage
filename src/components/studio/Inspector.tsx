import { useEffect, useRef, useState, type ReactNode } from 'react'
import { dbLabel, timecode } from '../../studio/format'
import { DEFAULT_EQ, DEFAULT_FX, TRACK_COLORS, type StudioEq, type StudioFx, type StudioProject, type StudioRegion, type StudioTrack } from '../../types/studio'

export type InspectorTab = 'props' | 'fx' | 'library' | 'tts'

const TABS: { id: InspectorTab; label: string }[] = [
  { id: 'props', label: '屬性' },
  { id: 'fx', label: 'EQ · FX' },
  { id: 'library', label: '素材' },
  { id: 'tts', label: 'TTS' },
]

/** Right sidebar: tabs for properties, EQ / effects, the media library and the TTS maker. */
export function Inspector({ tab, onTab, children }: { tab: InspectorTab; onTab: (t: InspectorTab) => void; children: ReactNode }) {
  return (
    <aside className="flex h-full min-h-0 flex-col border-l border-line bg-[#151515]" aria-label="工具與屬性" data-inspector>
      <div className="grid shrink-0 grid-cols-4 gap-1 border-b border-line p-1.5" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => onTab(t.id)}
            className={`min-h-8 rounded-md text-xs font-semibold ${tab === t.id ? 'bg-white/15 text-white' : 'text-white/45 hover:text-white/80'}`}
            data-inspector-tab={t.id}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </aside>
  )
}

/* ---------- shared bits ---------- */

export function Section({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="space-y-2.5 border-b border-line px-4 py-3">
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-semibold tracking-widest text-white/45 uppercase">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  )
}

/** A labelled range slider that reports while dragging and once more when released (for undo merging). */
export function Slider({
  label,
  value,
  min,
  max,
  step,
  display,
  onChange,
  onCommit,
  reset,
  accent = '#0a84ff',
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  display: string
  onChange?: (v: number) => void
  /** Called when the drag ends (heavy changes — e.g. pitch — apply only then). */
  onCommit?: (v: number) => void
  reset?: number
  accent?: string
}) {
  const [local, setLocal] = useState<number | null>(null)
  const shown = local ?? value
  return (
    <label className="block" data-slider={label}>
      <span className="mb-1 flex items-center justify-between text-xs text-white/60">
        {label}
        <span className="font-mono text-[11px] text-white/80 tabular">{display}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={shown}
        onChange={(e) => {
          const v = Number(e.target.value)
          setLocal(v)
          onChange?.(v)
        }}
        onPointerUp={() => {
          if (local !== null) onCommit?.(local)
          setLocal(null)
        }}
        onKeyUp={() => {
          if (local !== null) onCommit?.(local)
          setLocal(null)
        }}
        onDoubleClick={() => {
          if (reset === undefined) return
          onChange?.(reset)
          onCommit?.(reset)
        }}
        className="h-1.5 w-full"
        style={{ accentColor: accent }}
        aria-label={label}
      />
    </label>
  )
}

function Toggle({ label, on, onClick, hint }: { label: string; on: boolean; onClick: () => void; hint?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      title={hint}
      className={`min-h-9 rounded-lg px-3 text-xs font-semibold ${on ? 'bg-accent text-white' : 'bg-white/[0.06] text-white/65 hover:bg-white/12'}`}
    >
      {label}
    </button>
  )
}

/* ---------- properties ---------- */

export function PropertiesPanel({
  studio,
  region,
  selectionCount,
  track,
  onRegion,
  onTrack,
  onMaster,
}: {
  studio: StudioProject
  region: StudioRegion | null
  selectionCount: number
  track: StudioTrack | null
  onRegion: (patch: Partial<StudioRegion>, label: string, coalesce?: string) => void
  onTrack: (patch: Partial<StudioTrack>, label: string) => void
  onMaster: (volume: number) => void
}) {
  const [name, setName] = useState(region?.name ?? '')
  const [comment, setComment] = useState(region?.comment ?? '')
  const [syncedFor, setSyncedFor] = useState<string | null>(region?.id ?? null)
  if ((region?.id ?? null) !== syncedFor) {
    setSyncedFor(region?.id ?? null)
    setName(region?.name ?? '')
    setComment(region?.comment ?? '')
  }

  return (
    <div data-props-panel>
      {region ? (
        <Section title={selectionCount > 1 ? `片段（已選 ${selectionCount} 個，編輯第一個）` : '片段'}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name.trim() && name !== region.name && onRegion({ name: name.trim() }, `片段重新命名為「${name.trim()}」`)}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            className="w-full rounded-lg border border-white/15 bg-black/40 px-2.5 py-1.5 text-sm text-white outline-none focus:border-accent"
            aria-label="片段名稱"
            data-region-name
          />
          <dl className="grid grid-cols-3 gap-1 font-mono text-[10px] text-white/45">
            <div>
              <dt>位置</dt>
              <dd className="text-white/80">{timecode(region.start)}</dd>
            </div>
            <div>
              <dt>長度</dt>
              <dd className="text-white/80">{timecode(region.duration)}</dd>
            </div>
            <div>
              <dt>來源</dt>
              <dd className="truncate text-white/80">{{ file: '檔案', recording: '錄音', tts: 'TTS' }[region.kind]}</dd>
            </div>
          </dl>
          <Slider label="增益" value={region.gain} min={0} max={2} step={0.01} display={dbLabel(region.gain)} reset={1} onChange={(v) => onRegion({ gain: v }, '片段增益', `gain:${region.id}`)} />
          <div className="grid grid-cols-2 gap-3">
            <Slider label="淡入" value={region.fadeIn} min={0} max={Math.max(0.1, region.duration / 2)} step={0.01} display={`${region.fadeIn.toFixed(2)}s`} reset={0} onChange={(v) => onRegion({ fadeIn: v }, '淡入', `fi:${region.id}`)} />
            <Slider label="淡出" value={region.fadeOut} min={0} max={Math.max(0.1, region.duration / 2)} step={0.01} display={`${region.fadeOut.toFixed(2)}s`} reset={0} onChange={(v) => onRegion({ fadeOut: v }, '淡出', `fo:${region.id}`)} />
          </div>
          <Slider
            label="音高 Pitch"
            value={region.pitch}
            min={-12}
            max={12}
            step={1}
            display={`${region.pitch > 0 ? '+' : ''}${region.pitch} 半音`}
            reset={0}
            onCommit={(v) => v !== region.pitch && onRegion({ pitch: v }, `音高 ${v > 0 ? '+' : ''}${v}`)}
            accent="#bf5af2"
          />
          <div className="flex flex-wrap gap-1.5">
            <Toggle label="⇆ 反轉" on={region.reverse} onClick={() => onRegion({ reverse: !region.reverse }, region.reverse ? '取消反轉' : '反轉片段')} />
            <Toggle label="✧ 人聲清理" on={region.cleanup} onClick={() => onRegion({ cleanup: !region.cleanup }, region.cleanup ? '取消人聲清理' : '人聲清理')} hint="去低頻雜音、靜音閘門、增加清晰度與輕度壓縮" />
            <Toggle label="🔇 靜音" on={region.muted} onClick={() => onRegion({ muted: !region.muted }, region.muted ? '取消靜音片段' : '靜音片段')} />
          </div>
          <div className="flex items-center justify-between text-xs text-white/55">
            <span>音量自動化：{region.automation.length} 個節點</span>
            {region.automation.length > 0 && (
              <button type="button" onClick={() => onRegion({ automation: [] }, '清除自動化')} className="rounded px-2 py-1 text-white/45 hover:bg-white/10 hover:text-white">
                清除
              </button>
            )}
          </div>
          <label className="block">
            <span className="mb-1 block text-xs text-white/60">註解</span>
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              onBlur={() => comment !== region.comment && onRegion({ comment }, comment ? '新增註解' : '移除註解')}
              rows={2}
              className="w-full resize-y rounded-lg border border-white/15 bg-black/40 px-2.5 py-1.5 text-xs text-white outline-none focus:border-accent"
              placeholder="例如：第二幕換景時用"
              data-region-comment
            />
          </label>
        </Section>
      ) : (
        <p className="border-b border-line px-4 py-3 text-xs text-white/35">點選時間軸上的片段以編輯屬性</p>
      )}
      {track && (
        <Section title="音軌">
          <div className="flex flex-wrap gap-1.5">
            {TRACK_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => onTrack({ color: c }, '音軌顏色')}
                className={`h-7 w-7 rounded-full ${track.color === c ? 'ring-2 ring-white ring-offset-2 ring-offset-[#151515]' : ''}`}
                style={{ background: c }}
                aria-label={`顏色 ${c}`}
              />
            ))}
          </div>
          <Slider label="音量" value={track.volume} min={0} max={1.5} step={0.01} display={dbLabel(track.volume)} reset={1} onChange={(v) => onTrack({ volume: v }, `音軌「${track.name}」音量`)} accent="#30d158" />
          <Slider
            label="聲相 Pan"
            value={track.pan}
            min={-1}
            max={1}
            step={0.02}
            display={track.pan === 0 ? 'C' : track.pan < 0 ? `L ${Math.round(-track.pan * 100)}` : `R ${Math.round(track.pan * 100)}`}
            reset={0}
            onChange={(v) => onTrack({ pan: v }, `音軌「${track.name}」聲相`)}
          />
        </Section>
      )}
      <Section title="主輸出">
        <Slider label="主音量" value={studio.masterVolume} min={0} max={1.5} step={0.01} display={dbLabel(studio.masterVolume)} reset={1} onChange={onMaster} accent="#30d158" />
      </Section>
    </div>
  )
}

/* ---------- EQ & effects ---------- */

const PRESETS: { label: string; eq: StudioEq; fx: Partial<StudioFx> }[] = [
  { label: '人聲', eq: { low: -3, mid: -2, midFreq: 350, high: 3 }, fx: { highpass: 90, compressor: true } },
  { label: '電話 / 廣播', eq: { low: -18, mid: 6, midFreq: 1500, high: -12 }, fx: { highpass: 450, compressor: true } },
  { label: '遠方', eq: { low: -6, mid: -3, midFreq: 2000, high: -10 }, fx: { reverb: 0.55 } },
  { label: '大廳迴響', eq: DEFAULT_EQ, fx: { reverb: 0.4, delay: 0.12, delayTime: 0.28, feedback: 0.3 } },
]

/** The track's EQ response (high-pass + shelves + bell), drawn from the real filter maths. */
function EqCurve({ eq, highpass }: { eq: StudioEq; highpass: number }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = canvas.current
    if (!c) return
    const ctx = new OfflineAudioContext(1, 1, 48000)
    const filters = [
      new BiquadFilterNode(ctx, { type: 'highpass', frequency: highpass > 0 ? highpass : 10, Q: 0.7 }),
      new BiquadFilterNode(ctx, { type: 'lowshelf', frequency: 200, gain: eq.low }),
      new BiquadFilterNode(ctx, { type: 'peaking', frequency: eq.midFreq, Q: 1, gain: eq.mid }),
      new BiquadFilterNode(ctx, { type: 'highshelf', frequency: 4500, gain: eq.high }),
    ]
    const w = 300
    const h = 110
    const freqs = new Float32Array(w).map((_, i) => 20 * 1000 ** (i / (w - 1)))
    const total = new Float32Array(w).fill(1)
    const mag = new Float32Array(w)
    const phase = new Float32Array(w)
    for (const f of filters) {
      f.getFrequencyResponse(freqs, mag, phase)
      for (let i = 0; i < w; i++) total[i] *= mag[i]
    }
    const dpr = window.devicePixelRatio || 1
    c.width = w * dpr
    c.height = h * dpr
    const g = c.getContext('2d')!
    g.scale(dpr, dpr)
    g.clearRect(0, 0, w, h)
    const y = (db: number) => h / 2 - (db / 24) * (h / 2)
    g.strokeStyle = 'rgba(255,255,255,0.08)'
    for (const f of [100, 1000, 10000]) {
      const x = (Math.log10(f / 20) / 3) * w
      g.beginPath()
      g.moveTo(x, 0)
      g.lineTo(x, h)
      g.stroke()
    }
    g.beginPath()
    g.moveTo(0, y(0))
    g.lineTo(w, y(0))
    g.stroke()
    g.beginPath()
    total.forEach((m, i) => {
      const db = Math.max(-24, Math.min(24, 20 * Math.log10(Math.max(1e-5, m))))
      if (i === 0) g.moveTo(i, y(db))
      else g.lineTo(i, y(db))
    })
    g.strokeStyle = '#30d158'
    g.lineWidth = 2
    g.stroke()
    g.fillStyle = 'rgba(255,255,255,0.35)'
    g.font = '9px monospace'
    g.fillText('100', (Math.log10(5) / 3) * w + 2, h - 3)
    g.fillText('1k', (Math.log10(50) / 3) * w + 2, h - 3)
    g.fillText('10k', (Math.log10(500) / 3) * w + 2, h - 3)
  }, [eq.low, eq.mid, eq.midFreq, eq.high, highpass])
  return <canvas ref={canvas} className="h-[110px] w-full rounded-lg bg-black/50" data-eq-curve />
}

export function FxPanel({ track, onTrack }: { track: StudioTrack | null; onTrack: (patch: Partial<StudioTrack>, label: string) => void }) {
  if (!track) return <p className="px-4 py-3 text-xs text-white/35">選取一個音軌以設定 EQ 與效果器</p>
  const eq = (patch: Partial<StudioEq>) => onTrack({ eq: { ...track.eq, ...patch } }, `「${track.name}」EQ`)
  const fx = (patch: Partial<StudioFx>, label = `「${track.name}」效果器`) => onTrack({ fx: { ...track.fx, ...patch } }, label)
  const db = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`
  return (
    <div data-fx-panel>
      <Section
        title={`EQ · ${track.name}`}
        right={
          <button type="button" onClick={() => onTrack({ eq: DEFAULT_EQ, fx: DEFAULT_FX }, `重設「${track.name}」EQ 與效果`)} className="text-[11px] text-white/40 hover:text-white">
            全部重設
          </button>
        }
      >
        <EqCurve eq={track.eq} highpass={track.fx.highpass} />
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => onTrack({ eq: p.eq, fx: { ...DEFAULT_FX, ...p.fx } }, `套用預設「${p.label}」`)}
              className="min-h-8 rounded-md bg-white/[0.06] px-2.5 text-[11px] text-white/70 hover:bg-white/12"
            >
              {p.label}
            </button>
          ))}
        </div>
        <Slider label="低頻 Low (200 Hz)" value={track.eq.low} min={-18} max={18} step={0.5} display={db(track.eq.low)} reset={0} onChange={(v) => eq({ low: v })} accent="#30d158" />
        <Slider label="中頻 Mid" value={track.eq.mid} min={-18} max={18} step={0.5} display={db(track.eq.mid)} reset={0} onChange={(v) => eq({ mid: v })} accent="#30d158" />
        <Slider
          label="中頻頻率"
          value={Math.log10(track.eq.midFreq)}
          min={Math.log10(120)}
          max={Math.log10(8000)}
          step={0.01}
          display={`${track.eq.midFreq >= 1000 ? `${(track.eq.midFreq / 1000).toFixed(1)}k` : Math.round(track.eq.midFreq)} Hz`}
          reset={3}
          onChange={(v) => eq({ midFreq: Math.round(10 ** v) })}
          accent="#30d158"
        />
        <Slider label="高頻 High (4.5 kHz)" value={track.eq.high} min={-18} max={18} step={0.5} display={db(track.eq.high)} reset={0} onChange={(v) => eq({ high: v })} accent="#30d158" />
      </Section>
      <Section title="效果器 FX">
        <Slider
          label="低切 High-pass"
          value={track.fx.highpass}
          min={0}
          max={1000}
          step={10}
          display={track.fx.highpass ? `${track.fx.highpass} Hz` : '關'}
          reset={0}
          onChange={(v) => fx({ highpass: v })}
        />
        <Toggle label={`壓縮器 ${track.fx.compressor ? '開' : '關'}`} on={track.fx.compressor} onClick={() => fx({ compressor: !track.fx.compressor }, track.fx.compressor ? '關閉壓縮器' : '開啟壓縮器')} />
        <Slider label="殘響 Reverb" value={track.fx.reverb} min={0} max={1} step={0.01} display={`${Math.round(track.fx.reverb * 100)}%`} reset={0} onChange={(v) => fx({ reverb: v })} accent="#bf5af2" />
        <Slider label="延遲 Delay" value={track.fx.delay} min={0} max={1} step={0.01} display={`${Math.round(track.fx.delay * 100)}%`} reset={0} onChange={(v) => fx({ delay: v })} accent="#bf5af2" />
        <div className="grid grid-cols-2 gap-3">
          <Slider label="延遲時間" value={track.fx.delayTime} min={0.02} max={1.5} step={0.01} display={`${Math.round(track.fx.delayTime * 1000)} ms`} reset={0.3} onChange={(v) => fx({ delayTime: v })} accent="#bf5af2" />
          <Slider label="回授" value={track.fx.feedback} min={0} max={0.9} step={0.01} display={`${Math.round(track.fx.feedback * 100)}%`} reset={0.35} onChange={(v) => fx({ feedback: v })} accent="#bf5af2" />
        </div>
      </Section>
    </div>
  )
}
