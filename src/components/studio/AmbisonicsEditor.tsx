import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AmbiAuditioner, type AmbiRenderer } from '../../studio/ambisonics'
import { auditionBuffer } from '../../studio/spatial'
import { ambisonicChannels, normalizeAmbisonics, normalizeRotation, type AmbisonicOrder, type AmbisonicsConfig, type Rotation } from '../../types/spatialAudio'
import { Section } from './Inspector'
import { Knob } from './Knob'
import { SoundfieldRadar } from './SoundfieldRadar'

const ORDERS: { id: AmbisonicOrder; label: string; hint: string }[] = [
  { id: 1, label: '1 階 FOA · 4ch', hint: '行動裝置最省效能（預設）' },
  { id: 2, label: '2 階 SOA · 9ch', hint: '' },
  { id: 3, label: '3 階 HOA · 16ch', hint: '解析度最高，運算最重' },
]

const AXES: { key: keyof Rotation; label: string; min: number; max: number; hint: string }[] = [
  { key: 'yaw', label: 'Yaw 水平', min: -180, max: 180, hint: '＋＝聲場順時針轉（前方的聲音移到右邊）' },
  { key: 'pitch', label: 'Pitch 俯仰', min: -90, max: 90, hint: '＋＝聲場往上抬（前方的聲音移到上方）' },
  { key: 'roll', label: 'Roll 翻滾', min: -180, max: 180, hint: '＋＝右側往下傾' },
]

const deg = (v: number) => `${v > 0 ? '+' : ''}${Math.round(v * 10) / 10}°`

function Seg<T extends string | number>({ items, value, onChange }: { items: { id: T; label: string; hint?: string; disabled?: boolean }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="flex gap-1" role="tablist">
      {items.map((it) => (
        <button
          key={String(it.id)}
          type="button"
          role="tab"
          aria-selected={value === it.id}
          disabled={it.disabled}
          title={it.hint}
          onClick={() => onChange(it.id)}
          className={`min-h-8 flex-1 rounded-md px-1.5 text-[11px] font-semibold disabled:opacity-30 ${value === it.id ? 'bg-white/15 text-white' : 'bg-white/[0.05] text-white/50 hover:text-white/80'}`}
        >
          {it.label}
        </button>
      ))}
    </div>
  )
}

export interface AmbisonicsEditorProps {
  title: string
  resetKey: string
  value: AmbisonicsConfig
  onSave: (next: AmbisonicsConfig, label: string) => void
  /** Channels of the sound this soundfield plays (to warn when they do not match the order). */
  channels?: number | null
  audition: {
    context: () => AudioContext
    output: () => AudioNode
    /** The soundfield to loop (null = a click train in front). */
    buffer: () => Promise<AudioBuffer | null>
    hasOwnSound: boolean
  }
  /** The renderer of the running studio mix, for the radar while the transport plays. */
  liveRenderer?: () => AmbiRenderer | null
  /** Extra section at the end (the studio's bus: tracks encoded into this soundfield). */
  bus?: (api: { draft: AmbisonicsConfig; commit: (next: AmbisonicsConfig, label: string) => void }) => ReactNode
}

/**
 * Ambisonics soundfield editor: order and channel layout, the rotation that turns the field so its front faces the stage
 * (knobs and numbers, heard live through the same Omnitone decoder the audience gets), the energy radar and head-tracking.
 */
export function AmbisonicsEditor({ title, resetKey, value, onSave, channels, audition, liveRenderer, bus }: AmbisonicsEditorProps) {
  const [draft, setDraft] = useState<AmbisonicsConfig>(value)
  const draftRef = useRef(draft)
  const [gesture, setGesture] = useState(false)
  useEffect(() => {
    draftRef.current = draft
  })
  const storedKey = `${resetKey}:${JSON.stringify(value)}`
  const [syncedKey, setSyncedKey] = useState(storedKey)
  if (syncedKey !== storedKey && !gesture) {
    setSyncedKey(storedKey)
    setDraft(value)
  }
  const [lastKey, setLastKey] = useState(resetKey)
  const [auditioning, setAuditioning] = useState(false)
  const [note, setNote] = useState('')
  if (lastKey !== resetKey) {
    setLastKey(resetKey)
    setAuditioning(false)
  }

  /* ---------- audition ---------- */
  const aud = useRef<AmbiAuditioner | null>(null)
  useEffect(() => () => aud.current?.stop(), [resetKey])
  const toggleAudition = async () => {
    if (auditioning) {
      aud.current?.stop()
      setAuditioning(false)
      return
    }
    try {
      const ctx = audition.context()
      await ctx.resume()
      aud.current ??= new AmbiAuditioner(ctx, audition.output())
      const buffer = audition.hasOwnSound ? await audition.buffer() : null
      await aud.current.start(buffer, draftRef.current, auditionBuffer(ctx))
      setAuditioning(true)
      setNote(audition.hasOwnSound && (!buffer || buffer.numberOfChannels < 4) ? '這個聲音不是 4 聲道以上，改用前方的測試音來試聽旋轉' : '')
    } catch (err) {
      setNote(`無法試聽：${(err as Error).message}`)
    }
  }
  const getCov = () => aud.current?.renderer?.covariance() ?? liveRenderer?.()?.covariance() ?? null

  /* ---------- editing ---------- */
  const preview = (next: AmbisonicsConfig) => {
    setGesture(true)
    draftRef.current = next
    setDraft(next)
    aud.current?.update(next)
  }
  const commit = (next: AmbisonicsConfig, label: string) => {
    setGesture(false)
    const clean = normalizeAmbisonics(next)
    draftRef.current = clean
    setDraft(clean)
    aud.current?.update(clean)
    onSave(clean, label)
  }
  const rotate = (axis: keyof Rotation, v: number) => normalizeAmbisonics({ ...draftRef.current, rotationOffset: normalizeRotation({ ...draftRef.current.rotationOffset, [axis]: v }) })
  // A different order or layout is a different decoder: re-start the audition with it.
  const restructure = (next: AmbisonicsConfig, label: string) => {
    commit(next, label)
    if (auditioning) {
      aud.current?.stop()
      setAuditioning(false)
    }
  }

  const expected = ambisonicChannels(draft.order)
  const mismatch = channels != null && channels !== expected
  const rot = draft.rotationOffset

  return (
    <div data-ambisonics-panel>
      <Section title={`Ambisonics 聲場 · ${title}`}>
        <p className="text-[11px] leading-relaxed text-white/45">
          球面聲場以 Omnitone 解碼成雙耳立體聲（請戴耳機）。旋轉校正會讓聲場的「前方」對準舞台 −Z；觀眾端也用同一個解碼器。
        </p>
        {channels != null && (
          <p className={`rounded-md px-2.5 py-1.5 text-[11px] ${mismatch ? 'bg-amber-500/15 text-amber-200' : 'bg-white/[0.06] text-white/60'}`}>
            聲音檔：{channels} 聲道
            {mismatch ? `，但設定的階數需要 ${expected} 聲道（${channels > expected ? '多的聲道會被忽略' : '缺的聲道會是靜音'}）` : `（${draft.order} 階 Ambisonics）`}
          </p>
        )}
      </Section>

      <Section title="聲場格式">
        <Seg items={ORDERS} value={draft.order} onChange={(order) => restructure(normalizeAmbisonics({ ...draftRef.current, order }), `Ambisonics ${order} 階`)} />
        <Seg
          items={[
            { id: 'ACN_SN3D' as const, label: 'AmbiX（ACN · SN3D）', hint: '標準 AmbiX 聲道順序與正規化' },
            { id: 'FUMA' as const, label: 'FuMa（轉成 AmbiX）', hint: 'Furse-Malham：只支援 1 階，播放時自動轉碼', disabled: draft.order !== 1 },
          ]}
          value={draft.channelLayout}
          onChange={(channelLayout) => restructure({ ...draftRef.current, channelLayout }, channelLayout === 'FUMA' ? 'FuMa 聲道格式' : 'AmbiX 聲道格式')}
        />
      </Section>

      <Section
        title="旋轉校正"
        right={
          <button type="button" onClick={() => commit({ ...draftRef.current, rotationOffset: { yaw: 0, pitch: 0, roll: 0 } }, '重設旋轉')} className="text-[11px] text-white/40 hover:text-white">
            重設
          </button>
        }
      >
        <div className="grid grid-cols-3 gap-2">
          {AXES.map((a) => (
            <div key={a.key} className="flex flex-col items-center gap-1" title={a.hint}>
              <Knob
                label={a.label}
                value={rot[a.key]}
                min={a.min}
                max={a.max}
                step={1}
                defaultValue={0}
                format={deg}
                color="#4dabf7"
                bipolar
                onChange={(v) => preview(rotate(a.key, v))}
                onCommit={(v) => commit(rotate(a.key, v), `${a.label} 校正`)}
              />
              <input
                type="number"
                value={rot[a.key]}
                min={a.min}
                max={a.max}
                step={1}
                aria-label={`${a.label} 角度`}
                onChange={(e) => e.target.value !== '' && commit(rotate(a.key, Number(e.target.value)), `${a.label} 校正`)}
                className="w-16 rounded-md border border-white/15 bg-black/40 px-1.5 py-1 text-center font-mono text-[11px] text-white outline-none focus:border-accent"
              />
            </div>
          ))}
        </div>
        <p className="text-[10px] leading-relaxed text-white/35">Yaw ＋＝前方的聲音移到右邊，Pitch ＋＝移到上方，Roll ＋＝右側下傾。轉動時可直接按下面的試聽，聽方位變化。</p>
      </Section>

      <Section title="聲能分布 Energy Radar">
        <SoundfieldRadar getCov={getCov} rotation={rot} />
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={toggleAudition}
            aria-pressed={auditioning}
            className={`min-h-8 rounded-md px-3 text-[11px] font-semibold ${auditioning ? 'bg-accent text-white' : 'bg-white/[0.07] text-white/70 hover:bg-white/14'}`}
          >
            {auditioning ? '■ 停止' : '▶ 試聽'}
          </button>
          <span className="text-[10px] text-white/35">{audition.hasOwnSound ? '循環播放這個音軌的聲場' : '沒有聲音檔，使用前方的測試音'}</span>
        </div>
        {note && <p className="text-[11px] text-amber-300/80">{note}</p>}
      </Section>

      <Section title="觀眾端 · 頭部追蹤">
        <button
          type="button"
          aria-pressed={draft.bindHeadTracking}
          onClick={() => commit({ ...draftRef.current, bindHeadTracking: !draft.bindHeadTracking }, draft.bindHeadTracking ? '關閉頭部追蹤' : '開啟頭部追蹤')}
          className={`min-h-8 rounded-md px-3 text-[11px] font-semibold ${draft.bindHeadTracking ? 'bg-accent text-white' : 'bg-white/[0.07] text-white/70 hover:bg-white/14'}`}
        >
          {draft.bindHeadTracking ? '✓ 聲場跟隨觀眾轉頭' : '聲場固定朝向舞台'}
        </button>
        <p className="text-[10px] leading-relaxed text-white/35">觀眾開啟陀螺儀或進入 XR 時，整個聲場隨視角旋轉，聲音留在原本的方位。</p>
      </Section>

      {bus && <Section title="匯流：把軌跡音軌編碼進這個聲場">{bus({ draft, commit })}</Section>}
    </div>
  )
}
