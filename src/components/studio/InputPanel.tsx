import { useEffect, useRef, useState } from 'react'
import { dbLabel } from '../../studio/format'
import type { CalibrationResult, InputChain, InputDevice } from '../../studio/inputChain'
import { BUILTIN_PRESETS, type StripPreset } from '../../studio/presets'
import { NOTE_NAMES, TUNER_MODES, keyLabel, type StudioTrack, type TrackInput, type TunerMode, type TunerSettings } from '../../types/studio'
import { Knob } from './Knob'

export type ChainStatus = { state: 'off' | 'opening' | 'on' | 'error'; message?: string }

const KEYS: string[] = ['', ...NOTE_NAMES.flatMap((_, i) => [`${i}:major`, `${i}:minor`])]

/** Pitch readout: note name and cents off. */
function noteOf(hz: number) {
  if (!hz) return null
  const midi = 69 + 12 * Math.log2(hz / 440)
  const n = Math.round(midi)
  const cents = Math.round((midi - n) * 100)
  return { name: `${NOTE_NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`, cents }
}

/**
 * The microphone & input channel strip for the record-armed (or selected) track: device and
 * level, calibration and headphone monitoring; presets; Pre-gain / Reverb / Pan / Volume knobs;
 * Vocal Cleanup (noise removal) and Vocal Tuner (pitch correction).
 */
export function InputPanel({
  track,
  chain,
  status,
  devices,
  deviceId,
  stereo,
  monitoring,
  presets,
  selectedRegionCleanup,
  onDevice,
  onStereo,
  onMonitoring,
  onTrack,
  onInput,
  onApplyPreset,
  onSavePreset,
  onDeletePreset,
  onCleanupRegion,
  onClose,
}: {
  track: StudioTrack
  chain: InputChain | null
  status: ChainStatus
  devices: InputDevice[]
  deviceId: string
  stereo: boolean
  monitoring: boolean
  presets: StripPreset[]
  /** The selected region's clean-up flag, or null when no region is selected. */
  selectedRegionCleanup: boolean | null
  onDevice: (id: string) => void
  onStereo: (stereo: boolean) => void
  onMonitoring: (on: boolean) => void
  onTrack: (patch: Partial<StudioTrack>, label: string) => void
  onInput: (patch: Partial<TrackInput>, label: string) => void
  onApplyPreset: (p: StripPreset) => void
  onSavePreset: (name: string) => Promise<void>
  onDeletePreset: (p: StripPreset) => void
  onCleanupRegion: () => void
  onClose: () => void
}) {
  const input = track.input
  const tuner = input.tuner
  const setTuner = (patch: Partial<TunerSettings>, label: string) => onInput({ tuner: { ...tuner, ...patch } }, label)

  /* ---------- live meter ---------- */
  const [meter, setMeter] = useState({ peak: 0, rms: 0, hold: 0, clip: false, pitch: 0 })
  const holdRef = useRef({ value: 0, at: 0, clipAt: 0 })
  useEffect(() => {
    if (!chain) return
    let frame = 0
    const loop = () => {
      const { peak, rms } = chain.level()
      const now = performance.now()
      const h = holdRef.current
      if (peak >= h.value || now - h.at > 1200) {
        h.value = peak
        h.at = now
      }
      if (peak >= 0.98) h.clipAt = now
      setMeter({ peak, rms, hold: h.value, clip: now - h.clipAt < 1500, pitch: chain.pitch })
      frame = requestAnimationFrame(loop)
    }
    frame = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(frame)
  }, [chain])
  const pct = (v: number) => Math.max(0, Math.min(100, ((20 * Math.log10(Math.max(v, 1e-6)) + 60) / 60) * 100))

  /* ---------- calibrate ---------- */
  const [calib, setCalib] = useState<{ phase: 'quiet' | 'speak'; progress: number } | { result: CalibrationResult } | { error: string } | null>(null)
  const calibrate = async () => {
    if (!chain) return
    try {
      const result = await chain.calibrate((phase, progress) => setCalib({ phase, progress }))
      setCalib({ result })
      onInput({ preGain: result.preGain, gateDb: result.gateDb }, '校準輸入')
    } catch (err) {
      setCalib({ error: (err as Error).message })
    }
  }

  /* ---------- presets ---------- */
  const [presetId, setPresetId] = useState('')
  const [saving, setSaving] = useState<string | null>(null)
  const all = [...BUILTIN_PRESETS, ...presets]

  const card = 'flex shrink-0 flex-col gap-2 rounded-xl border border-white/[0.07] bg-[#1b1b1b] p-3'
  const title = 'text-[10px] font-bold tracking-widest text-white/45 uppercase'
  const toggle = (on: boolean) => `min-h-8 rounded-lg px-3 text-xs font-semibold transition ${on ? 'bg-accent text-white' : 'bg-white/[0.07] text-white/65 hover:bg-white/12'}`
  const note = noteOf(meter.pitch)

  return (
    <section className="shrink-0 border-t border-line bg-[#121212]" aria-label="麥克風與輸入設定" data-input-panel>
      <header className="flex flex-wrap items-center gap-2 border-b border-white/[0.06] px-3 py-1.5">
        <span className="text-xs font-semibold text-white/80">🎙 輸入</span>
        <span className="flex items-center gap-1.5 rounded-md bg-white/[0.06] px-2 py-0.5 text-xs text-white/75">
          <span className="h-2 w-2 rounded-full" style={{ background: track.color }} />
          {track.name}
        </span>
        <span className="text-[11px] text-white/35">設定會錄進檔案（Pre-gain / 降噪 / 修音）</span>
        <div className="ml-auto flex items-center gap-1.5">
          <select
            value={presetId}
            onChange={(e) => {
              const p = all.find((x) => x.id === e.target.value)
              setPresetId(e.target.value)
              if (p) onApplyPreset(p)
            }}
            className="h-8 max-w-56 rounded-lg border border-white/12 bg-black/50 px-2 text-xs text-white"
            aria-label="預設集"
            data-preset-select
          >
            <option value="">預設集 Presets…</option>
            <optgroup label="內建">
              {BUILTIN_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </optgroup>
            {presets.length > 0 && (
              <optgroup label="團隊自訂">
                {presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          {saving === null ? (
            <button type="button" onClick={() => setSaving(`${track.name} 設定`)} className="h-8 rounded-lg bg-white/[0.07] px-2.5 text-xs text-white/75 hover:bg-white/12" data-save-preset>
              Save Preset…
            </button>
          ) : (
            <form
              className="flex items-center gap-1"
              onSubmit={async (e) => {
                e.preventDefault()
                if (!saving.trim()) return
                await onSavePreset(saving.trim())
                setSaving(null)
              }}
            >
              <input autoFocus value={saving} onChange={(e) => setSaving(e.target.value)} className="h-8 w-36 rounded-lg border border-accent bg-black px-2 text-xs text-white outline-none" aria-label="預設集名稱" data-preset-name />
              <button type="submit" className="h-8 rounded-lg bg-accent px-2.5 text-xs font-semibold text-white">
                儲存
              </button>
              <button type="button" onClick={() => setSaving(null)} className="h-8 rounded-lg px-2 text-xs text-white/50 hover:bg-white/10">
                取消
              </button>
            </form>
          )}
          {presets.find((p) => p.id === presetId) && (
            <button type="button" onClick={() => onDeletePreset(presets.find((p) => p.id === presetId)!)} className="h-8 rounded-lg px-2 text-xs text-white/35 hover:bg-panic/15 hover:text-panic" title="刪除此自訂預設集">
              🗑
            </button>
          )}
          <button type="button" onClick={onClose} className="h-8 w-8 rounded-lg text-white/45 hover:bg-white/10 hover:text-white" aria-label="關閉輸入面板">
            ✕
          </button>
        </div>
      </header>

      <div className="flex gap-2 overflow-x-auto p-2.5">
        {/* Device, meter, calibrate, monitoring */}
        <div className={`${card} w-72`} data-input-device>
          <span className={title}>輸入裝置 Input</span>
          <select
            value={deviceId}
            onChange={(e) => onDevice(e.target.value)}
            className="h-8 w-full rounded-lg border border-white/12 bg-black/50 px-2 text-xs text-white"
            aria-label="麥克風"
            data-device-select
          >
            <option value="">系統預設</option>
            {devices.filter((d) => d.id !== 'default').map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
          <div className="flex items-center gap-1 text-[11px]">
            {([true, false] as const).map((s) => (
              <button key={String(s)} type="button" onClick={() => onStereo(s)} aria-pressed={stereo === s} className={`h-7 flex-1 rounded-md ${stereo === s ? 'bg-white/15 text-white' : 'bg-white/[0.05] text-white/50'}`}>
                {s ? '立體聲 Stereo' : '單聲道 Mono'}
              </button>
            ))}
          </div>
          {/* Level meter: −60 … 0 dBFS, peak hold, clip light */}
          <div className="space-y-1" data-input-meter>
            <div className="relative h-3 overflow-hidden rounded-full bg-black/60">
              <div className="absolute inset-y-0 left-0 bg-gradient-to-r from-go via-[#c7e000] to-panic" style={{ width: `${pct(meter.peak)}%`, transition: 'width 60ms linear' }} />
              <div className="absolute inset-y-0 left-0 bg-white/25" style={{ width: `${pct(meter.rms)}%` }} />
              <div className="absolute inset-y-0 w-0.5 bg-white" style={{ left: `${pct(meter.hold)}%` }} />
            </div>
            <div className="flex justify-between font-mono text-[9px] text-white/35">
              <span>-60</span>
              <span>-24</span>
              <span>-12</span>
              <span className={meter.clip ? 'font-bold text-panic' : ''}>{meter.clip ? 'CLIP' : '0 dB'}</span>
            </div>
          </div>
          <p className="text-[10px] text-white/40" data-input-status>
            {status.state === 'opening'
              ? '開啟麥克風…'
              : status.state === 'error'
                ? <span className="text-panic">{status.message}</span>
                : status.state === 'on' && chain
                  ? `${chain.deviceLabel} · ${chain.channels === 2 ? '立體聲輸入' : '單聲道輸入'} · 峰值 ${meter.peak > 0 ? dbLabel(meter.peak) : '—'}`
                  : '麥克風未開啟'}
          </p>
          <div className="flex gap-1.5">
            <button type="button" onClick={calibrate} disabled={!chain || (!!calib && 'phase' in calib)} className="h-8 flex-1 rounded-lg bg-white/[0.07] text-xs font-semibold text-white/80 hover:bg-white/12 disabled:opacity-40" data-calibrate>
              ⚙ Calibrate
            </button>
            <button
              type="button"
              onClick={() => onMonitoring(!monitoring)}
              aria-pressed={monitoring}
              className={`h-8 flex-1 rounded-lg text-xs font-semibold ${monitoring ? 'bg-go text-black' : 'bg-white/[0.07] text-white/80 hover:bg-white/12'}`}
              title="耳機監聽：即時聽到經過處理的麥克風聲音（請戴耳機，避免喇叭回授）"
              data-monitoring
            >
              🎧 {monitoring ? '監聽中' : 'Monitoring'}
            </button>
          </div>
          {calib && (
            <p className="text-[10px] leading-snug text-white/60" data-calibration>
              {'phase' in calib
                ? calib.phase === 'quiet'
                  ? `① 請保持安靜，量測環境噪音… ${Math.round(calib.progress * 100)}%`
                  : `② 請用平常的音量說話或唱歌… ${Math.round(calib.progress * 100)}%`
                : 'result' in calib
                  ? `✓ 噪音 ${calib.result.noiseDb} dBFS · 峰值 ${calib.result.peakDb} dBFS → Pre-gain ${calib.result.preGain > 0 ? '+' : ''}${calib.result.preGain} dB，降噪門檻 ${calib.result.gateDb} dB`
                  : <span className="text-panic">{calib.error}</span>}
            </p>
          )}
        </div>

        {/* Knobs */}
        <div className={card} data-strip-knobs>
          <span className={title}>聲道 Channel</span>
          <div className="flex gap-1">
            <Knob label="Pre-gain" value={input.preGain} min={-12} max={24} step={0.5} defaultValue={0} format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`} color="#ffd43b" onChange={(v) => onInput({ preGain: v }, '前級增益')} />
            <Knob label="Reverb" value={track.fx.reverb} min={0} max={1} step={0.01} defaultValue={0} format={(v) => `${Math.round(v * 100)}%`} color="#bf5af2" onChange={(v) => onTrack({ fx: { ...track.fx, reverb: v } }, `「${track.name}」殘響`)} />
            <Knob
              label="Pan"
              value={track.pan}
              min={-1}
              max={1}
              step={0.02}
              defaultValue={0}
              bipolar
              format={(v) => (Math.abs(v) < 0.01 ? 'C' : v < 0 ? `L${Math.round(-v * 100)}` : `R${Math.round(v * 100)}`)}
              color="#4dabf7"
              onChange={(v) => onTrack({ pan: v }, `「${track.name}」聲相`)}
            />
            <Knob label="Volume" value={track.volume} min={0} max={1.5} step={0.01} defaultValue={1} format={dbLabel} onChange={(v) => onTrack({ volume: v }, `「${track.name}」音量`)} />
          </div>
        </div>

        {/* Vocal cleanup */}
        <div className={`${card} w-52`} data-vocal-cleanup>
          <span className={title}>Vocal Cleanup 人聲清理</span>
          <button
            type="button"
            onClick={() => onInput({ noiseRemoval: !input.noiseRemoval }, input.noiseRemoval ? '關閉消除雜音' : '消除雜音')}
            aria-pressed={input.noiseRemoval}
            className={`min-h-11 rounded-xl text-sm font-semibold transition ${input.noiseRemoval ? 'bg-go text-black' : 'bg-white/[0.07] text-white/80 hover:bg-white/12'}`}
            data-remove-noise
          >
            {input.noiseRemoval ? '✓ Remove noise 消除雜音' : '✧ Remove noise 消除雜音'}
          </button>
          <p className="text-[10px] leading-snug text-white/40">即時去除低頻轟鳴、高頻嘶聲，並在無人聲時壓低環境噪音（門檻 {input.gateDb} dB，可用 Calibrate 自動設定）。</p>
          <button
            type="button"
            onClick={onCleanupRegion}
            disabled={selectedRegionCleanup === null}
            className="min-h-8 rounded-lg bg-white/[0.05] text-[11px] text-white/65 hover:bg-white/12 disabled:opacity-35"
            title="對已錄好的片段做清理（非破壞性）"
          >
            {selectedRegionCleanup ? '✓ 已清理選取片段' : '清理選取的片段'}
          </button>
        </div>

        {/* Vocal tuner */}
        <div className={`${card} w-80`} data-vocal-tuner>
          <div className="flex items-center gap-2">
            <span className={title}>Vocal Tuner 修音</span>
            <button
              type="button"
              onClick={() => setTuner({ enabled: !tuner.enabled }, tuner.enabled ? '關閉修音' : '開啟修音')}
              aria-pressed={tuner.enabled}
              className={`ml-auto h-6 w-11 rounded-full p-0.5 transition ${tuner.enabled ? 'bg-go' : 'bg-white/15'}`}
              aria-label="修音開關"
              data-tuner-enabled
            >
              <span className={`block h-5 w-5 rounded-full bg-white transition ${tuner.enabled ? 'translate-x-5' : ''}`} />
            </button>
          </div>
          <div className={`flex gap-3 ${tuner.enabled ? '' : 'pointer-events-none opacity-40'}`}>
            <div className="flex flex-1 flex-col gap-1.5">
              <button
                type="button"
                onClick={() => setTuner({ realtime: !tuner.realtime }, tuner.realtime ? '修音改為錄完套用' : '即時修音')}
                aria-pressed={tuner.realtime}
                className={toggle(tuner.realtime)}
                title="Realtime：唱的同時修音（監聽聽得到）；關閉時在錄音結束後套用"
                data-tuner-realtime
              >
                {tuner.realtime ? '● Realtime 即時' : '○ 錄完後套用'}
              </button>
              <select value={tuner.mode} onChange={(e) => setTuner({ mode: e.target.value as TunerMode }, '修音模式')} className="h-8 rounded-lg border border-white/12 bg-black/50 px-2 text-xs text-white" aria-label="修音模式" data-tuner-mode>
                {(Object.keys(TUNER_MODES) as TunerMode[]).map((m) => (
                  <option key={m} value={m}>
                    {TUNER_MODES[m].label}
                  </option>
                ))}
              </select>
              <select value={tuner.key} onChange={(e) => setTuner({ key: e.target.value }, '修音調性')} className="h-8 rounded-lg border border-white/12 bg-black/50 px-2 text-xs text-white" aria-label="調性" data-tuner-key>
                {KEYS.map((k) => (
                  <option key={k} value={k}>
                    {keyLabel(k)}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col items-center gap-1">
              <Knob
                label="Amount"
                value={tuner.mode === 'robotic' ? 1 : tuner.amount}
                min={0}
                max={1}
                step={0.01}
                defaultValue={0.8}
                format={(v) => `${Math.round(v * 100)}%`}
                color="#30d158"
                onChange={(v) => setTuner({ amount: v }, '修音強度')}
              />
              <span className="font-mono text-[10px] text-white/55" data-tuner-pitch title="即時偵測到的音高">
                {tuner.enabled && tuner.realtime && note ? `${note.name} ${note.cents >= 0 ? '+' : ''}${note.cents}¢` : '—'}
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
