import { useGlide } from '../../hooks/useGlide'
import { dimGain } from '../../utils/dim'
import { DimButton } from '../ui/DimButton'
import { useEffect, useRef, useState } from 'react'

const MIN_DB = -60
const MAX_DB = 20 * Math.log10(1.5) // +3.5 dB: the master's ceiling
const toDb = (g: number) => (g <= 0 ? -Infinity : 20 * Math.log10(g))
const fromDb = (db: number) => (db <= MIN_DB ? 0 : Math.min(1.5, 10 ** (db / 20)))
/** Meter position 0–1 for a linear peak, on a dB scale from −60 to +3.5. */
const meterPos = (peak: number) => Math.max(0, Math.min(1, (toDb(peak) - MIN_DB) / (MAX_DB - MIN_DB)))
const dbText = (g: number) => (g <= 0 ? '−∞' : `${toDb(g) >= 0 ? '+' : ''}${toDb(g).toFixed(1)}`)
const PEAK_HOLD_MS = 1200

/**
 * The Studio's master section: the master fader (the project's final output level, saved with
 * the project and used by the mixdown), a stereo peak meter with peak hold and a clip light, and
 * MUTE / DIM for this listener's speakers.
 */
export function MasterStrip({
  volume,
  onVolume,
  levels,
  mute,
  dim,
  dimDb,
  onMute,
  onDim,
  onDimDb,
}: {
  volume: number
  /** `undim`: the fader was moved while DIM was on — DIM switches off at this new volume. */
  onVolume: (v: number, undim?: boolean) => void
  levels: { l: number; r: number }
  mute: boolean
  dim: boolean
  dimDb: number
  onMute: () => void
  onDim: () => void
  onDimDb: (db: number) => void
}) {
  // Peak hold per channel, and a clip light that stays until clicked.
  const [hold, setHold] = useState({ l: 0, r: 0 })
  const holdAt = useRef({ l: 0, r: 0 })
  const [clip, setClip] = useState(false)
  useEffect(() => {
    const now = performance.now()
    setHold((h) => {
      const next = { ...h }
      for (const ch of ['l', 'r'] as const) {
        if (levels[ch] >= h[ch] || now - holdAt.current[ch] > PEAK_HOLD_MS) {
          next[ch] = levels[ch]
          holdAt.current[ch] = now
        }
      }
      return next.l === h.l && next.r === h.r ? h : next
    })
    if (levels.l > 1 || levels.r > 1) setClip(true)
  }, [levels])

  // While DIM is on the fader and readout show the level you hear (the fader value itself stays).
  const heard = volume * dimGain(dim, dimDb)
  const db = toDb(heard)
  const [dragging, setDragging] = useState(false)
  const shownDb = useGlide(Number.isFinite(db) ? Math.max(MIN_DB, db) : MIN_DB, dragging)
  const bar = (ch: 'l' | 'r') => {
    const pos = meterPos(levels[ch])
    return (
      <div className="relative h-[5px] w-full overflow-hidden rounded-full bg-white/10" data-master-meter={ch}>
        <div
          className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-75"
          style={{ width: `${pos * 100}%`, background: 'linear-gradient(to right, #30d158 0%, #30d158 72%, #ffd60a 86%, #ff453a 96%)', backgroundSize: '150px 100%' }}
        />
        <div className="absolute inset-y-0 w-[2px] bg-white/80" style={{ left: `calc(${meterPos(hold[ch]) * 100}% - 1px)`, opacity: hold[ch] > 0.001 ? 1 : 0 }} />
      </div>
    )
  }

  return (
    <div className={`flex h-10 items-center gap-2 rounded-lg px-2 ${mute ? 'bg-panic/15' : dim ? 'bg-standby/10' : 'bg-black/50'}`} data-master-strip>
      <span className="text-[9px] font-bold tracking-widest text-white/45">MASTER</span>
      <div className="flex w-[150px] flex-col gap-1">
        <input
          type="range"
          min={MIN_DB}
          max={MAX_DB}
          step={0.1}
          value={shownDb}
          onPointerDown={() => setDragging(true)}
          onPointerUp={() => setDragging(false)}
          onBlur={() => setDragging(false)}
          onChange={(e) => onVolume(Math.round(fromDb(Number(e.target.value)) * 1000) / 1000, dim)}
          onDoubleClick={() => onVolume(1)}
          className="h-3 w-full cursor-pointer accent-[#30d158]"
          aria-label="Master 音量"
          title="Master 音量（雙擊回到 0 dB）· 會影響整個 Studio 的輸出與混音匯出"
          data-master-fader
        />
        <div className="flex flex-col gap-[3px]" title="Master 輸出電平（L / R）">
          {bar('l')}
          {bar('r')}
        </div>
      </div>
      <span
        className={`w-12 text-right font-mono text-[11px] tabular ${dim ? 'text-standby' : volume > 1 ? 'text-standby' : 'text-white/70'}`}
        title={dim ? `DIM 中：實際聽到 ${dbText(heard)}（推桿原始值 ${dbText(volume)}）` : undefined}
        data-master-db
      >
        {dbText(heard)}
      </span>
      <button
        type="button"
        onClick={() => setClip(false)}
        className={`h-3 w-3 rounded-full ${clip ? 'bg-panic shadow-[0_0_8px_#ff453a]' : 'bg-white/15'}`}
        title={clip ? '曾經爆音（超過 0 dBFS）· 點一下清除' : '爆音指示'}
        aria-label="爆音指示"
        data-master-clip={clip ? '1' : '0'}
      />
      <DimButton
        area="studio"
        active={dim}
        db={dimDb}
        onToggle={onDim}
        onDbChange={onDimDb}
        scope="Studio 監聽：只影響你自己聽到的（不影響專案、混音匯出與其他人）"
        className="h-7 rounded-md px-1.5 text-[10px] font-bold whitespace-nowrap"
        activeClassName="bg-standby text-black"
        inactiveClassName="bg-white/[0.07] text-white/55 hover:bg-white/12"
      />
      <button
        type="button"
        onClick={onMute}
        aria-pressed={mute}
        className={`h-7 rounded-md px-1.5 text-[10px] font-bold ${mute ? 'bg-panic text-white' : 'bg-white/[0.07] text-white/55 hover:bg-white/12'}`}
        title="MUTE：靜音監聽（只影響你自己聽到的，不影響專案與匯出）"
        data-master-mute
      >
        MUTE
      </button>
    </div>
  )
}
