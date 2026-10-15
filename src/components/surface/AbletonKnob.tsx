import { useEffect, useRef, useState } from 'react'
import type { SurfaceWidget } from '../../types/surface'
import { paramDef, toNorm, widgetNorm as norm, widgetReadout as knobReadout } from '../../utils/liveParams'
import type { ActionPhase } from '../../utils/surfaceActions'

/** Pixels of vertical drag for the full range (Shift: ten times finer). */
const DRAG_RANGE = 200
const SWEEP = 270
const START = -135

const clamp01 = (n: number) => Math.max(0, Math.min(1, n))
const paramOf = (w: SurfaceWidget) => {
  const a = w.actions.find((x) => x.kind === 'param')
  return a?.kind === 'param' ? a.target : null
}

/** Where double-click returns: the bound parameter's default, else the bottom of the range. */
function resetValue(w: SurfaceWidget) {
  const t = paramOf(w)
  if (!t) return w.min
  return w.min + clamp01(toNorm(t, paramDef(t).def)) * (w.max - w.min)
}

/** Bipolar parameters (pan, EQ) draw their arc from 12 o'clock. */
function isBipolar(w: SurfaceWidget) {
  const t = paramOf(w)
  if (!t) return false
  const d = paramDef(t)
  return d.min < 0 && d.max > 0
}

const polar = (deg: number, r: number) => {
  const a = ((deg - 90) * Math.PI) / 180
  return { x: 50 + r * Math.cos(a), y: 50 + r * Math.sin(a) }
}
const arc = (from: number, to: number, r: number) => {
  if (Math.abs(to - from) < 0.01) return ''
  const [a, b] = from < to ? [from, to] : [to, from]
  const p = polar(a, r)
  const q = polar(b, r)
  return `M ${p.x} ${p.y} A ${r} ${r} 0 ${b - a > 180 ? 1 : 0} 1 ${q.x} ${q.y}`
}

/** The knob drawing, Ableton Live style: a 270° track, a value arc and a pointer line. */
export function KnobVisual({ widget, value, active }: { widget: SurfaceWidget; value: number; active?: boolean }) {
  const n = norm(widget, value)
  const angle = START + n * SWEEP
  const origin = isBipolar(widget) ? 0 : START
  const tip = polar(angle, 30)
  const inner = polar(angle, 12)
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-0.5 overflow-hidden rounded-2xl border border-line bg-black/40 p-1.5 select-none" data-knob-visual>
      <span className="w-full truncate text-center text-[11px] font-semibold text-white/80">{widget.label}</span>
      <svg viewBox="0 0 100 100" className="min-h-0 w-full flex-1" aria-hidden>
        <path d={arc(START, START + SWEEP, 38)} fill="none" stroke="rgba(255,255,255,0.14)" strokeWidth={8} strokeLinecap="round" />
        <path d={arc(origin, angle, 38)} fill="none" stroke={widget.color} strokeWidth={8} strokeLinecap="round" style={{ filter: active ? `drop-shadow(0 0 4px ${widget.color})` : undefined }} />
        <circle cx={50} cy={50} r={27} fill="#1c1c1e" stroke="rgba(255,255,255,0.12)" strokeWidth={1.5} />
        <line x1={inner.x} y1={inner.y} x2={tip.x} y2={tip.y} stroke="#fff" strokeWidth={4} strokeLinecap="round" />
      </svg>
      <span className={`font-mono text-[11px] tabular ${active ? 'text-white' : 'text-white/55'}`} data-knob-readout>
        {knobReadout(widget, value)}
      </span>
    </div>
  )
}

/**
 * An interactive knob: drag up / down (Shift for fine), scroll wheel, double-click to reset.
 * Sends at most one change per frame and commits the value when the gesture ends.
 */
export function AbletonKnob({
  widget,
  onTrigger,
  onCommit,
}: {
  widget: SurfaceWidget
  onTrigger: (widget: SurfaceWidget, phase: ActionPhase, value: number) => void
  onCommit: (widget: SurfaceWidget, value: number) => void
}) {
  const [live, setLive] = useState<number | null>(null)
  const liveRef = useRef<number | null>(null)
  const drag = useRef<{ y: number; n: number; fine: boolean } | null>(null)
  const frame = useRef(0)
  const wheelTimer = useRef(0)
  const range = widget.max - widget.min

  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current)
      clearTimeout(wheelTimer.current)
    },
    [],
  )

  const emit = (value: number) => {
    liveRef.current = value
    setLive(value)
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      if (liveRef.current != null) onTrigger(widget, 'change', liveRef.current)
    })
  }
  const finish = () => {
    drag.current = null
    if (liveRef.current != null) onCommit(widget, liveRef.current)
    liveRef.current = null
    setLive(null)
  }
  const current = live ?? widget.value

  return (
    <div
      className="h-full w-full cursor-ns-resize touch-none"
      role="slider"
      aria-label={widget.label}
      aria-valuemin={widget.min}
      aria-valuemax={widget.max}
      aria-valuenow={current}
      aria-valuetext={knobReadout(widget, current)}
      tabIndex={0}
      data-knob={widget.id}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        drag.current = { y: e.clientY, n: norm(widget, widget.value), fine: e.shiftKey }
        onTrigger(widget, 'press', widget.value)
        emit(widget.value)
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d) return
        const n = clamp01(d.n + (d.y - e.clientY) / (d.fine ? DRAG_RANGE * 10 : DRAG_RANGE))
        // Rebase when Shift changes so switching precision doesn't jump.
        if (e.shiftKey !== d.fine) drag.current = { y: e.clientY, n, fine: e.shiftKey }
        emit(widget.min + n * range)
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
      onDoubleClick={() => {
        const v = resetValue(widget)
        onTrigger(widget, 'change', v)
        onCommit(widget, v)
      }}
      onWheel={(e) => {
        const base = liveRef.current ?? widget.value
        const step = (e.shiftKey ? 0.002 : 0.02) * Math.sign(-e.deltaY || e.deltaX)
        emit(widget.min + clamp01(norm(widget, base) + step) * range)
        clearTimeout(wheelTimer.current)
        wheelTimer.current = window.setTimeout(finish, 250)
      }}
      onKeyDown={(e) => {
        const step = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowDown' || e.key === 'ArrowLeft' ? -1 : 0
        if (!step) return
        e.preventDefault()
        const v = widget.min + clamp01(norm(widget, widget.value) + step * (e.shiftKey ? 0.01 : 0.05)) * range
        onTrigger(widget, 'change', v)
        onCommit(widget, v)
      }}
    >
      <KnobVisual widget={widget} value={current} active={live != null} />
    </div>
  )
}
