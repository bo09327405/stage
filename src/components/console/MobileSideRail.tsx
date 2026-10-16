import { useEffect, useRef, useState } from 'react'
import { DimButton } from '../ui/DimButton'

const TICKS = [100, 75, 50, 25, 0]

/**
 * Left rail of the phone layout: DIM and a tall vertical Master fader (like a mixer channel). The
 * fader is a pointer-captured slider with touch-action: none, so dragging it never scrolls the page,
 * and it writes at most once per animation frame. While DIM is on it shows the dimmed level; moving
 * it switches DIM off at that level (same rule as the desktop Master fader).
 */
export function MobileSideRail({
  effective,
  dim,
  dimDb,
  muted,
  onMasterVolume,
  onDim,
  onDimDb,
}: {
  /** The level actually sent out (Master × DIM). */
  effective: number
  dim: boolean
  dimDb: number
  muted: boolean
  onMasterVolume: (volume: number, undim?: boolean) => void
  onDim: (dim: boolean) => void
  onDimDb: (db: number) => void
}) {
  const track = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<number | null>(null)
  const frame = useRef(0)
  const pending = useRef<number | null>(null)
  useEffect(() => () => cancelAnimationFrame(frame.current), [])

  const shown = drag ?? effective
  const fill = muted ? '#ff453a' : dim ? '#ffd60a' : '#34c759'

  const valueAt = (clientY: number) => {
    const r = track.current!.getBoundingClientRect()
    return Math.round(Math.min(100, Math.max(0, ((r.bottom - clientY) / r.height) * 100)))
  }
  const push = (v: number) => {
    setDrag(v)
    pending.current = v
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      if (pending.current != null) onMasterVolume(pending.current, dim)
    })
  }

  return (
    <div className="flex w-[72px] shrink-0 flex-col items-center gap-3 py-3" data-mobile-rail>
      <DimButton
        area="console"
        active={dim}
        db={dimDb}
        onToggle={() => onDim(!dim)}
        onDbChange={onDimDb}
        scope="Show Master：所有觀眾裝置與監聽"
        className="h-14 w-14 rounded-xl border-2 text-base font-bold tracking-wide transition"
        activeClassName="border-[#ffe066] bg-standby text-black"
        inactiveClassName="border-white/25 bg-white/[0.12] text-white/80"
      />
      <div className="flex min-h-[220px] w-full flex-1 items-stretch justify-center gap-1.5 pb-1">
        <div className="relative w-6 text-right font-mono text-[10px] text-white/35">
          {TICKS.map((t) => (
            <span key={t} className="absolute right-0 -translate-y-1/2" style={{ top: `${100 - t}%` }}>
              {t}
            </span>
          ))}
        </div>
        <div
          ref={track}
          role="slider"
          aria-label="Master volume"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(shown)}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId)
            push(valueAt(e.clientY))
          }}
          onPointerMove={(e) => {
            if (e.currentTarget.hasPointerCapture(e.pointerId)) push(valueAt(e.clientY))
          }}
          onPointerUp={() => setDrag(null)}
          onPointerCancel={() => setDrag(null)}
          className="relative w-9 touch-none overflow-hidden rounded-lg bg-[#2a2a2c] select-none"
        >
          <div className="absolute inset-x-0 bottom-0" style={{ height: `${shown}%`, background: fill }} />
          <div className="absolute inset-x-0 h-0.5 bg-white" style={{ bottom: `calc(${shown}% - 1px)` }} />
        </div>
      </div>
      <span className={`font-mono text-xs tabular ${muted ? 'text-panic' : dim ? 'text-standby' : 'text-white/60'}`}>
        {muted ? 'MUTE' : `${Math.round(shown)}%`}
      </span>
    </div>
  )
}
