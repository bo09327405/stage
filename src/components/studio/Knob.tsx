import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'

/**
 * A rotary knob: drag up / down (Shift for fine steps), scroll, or use the arrow keys; double-click
 * resets. `onChange` fires while turning, `onCommit` once when the gesture ends.
 */
export function Knob({
  label,
  value,
  min,
  max,
  step = 0.01,
  defaultValue,
  format,
  color = '#30d158',
  size = 54,
  bipolar = false,
  onChange,
  onCommit,
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  defaultValue: number
  format: (v: number) => string
  color?: string
  size?: number
  /** Draw the arc from the centre (pan). */
  bipolar?: boolean
  onChange: (v: number) => void
  onCommit?: (v: number) => void
}) {
  const [local, setLocal] = useState<number | null>(null)
  const shown = local ?? value
  const drag = useRef<{ y: number; start: number } | null>(null)
  const latest = useRef(shown)
  const box = useRef<HTMLDivElement>(null)
  const clamp = (v: number) => Math.min(max, Math.max(min, Math.round(v / step) * step))
  const set = (v: number) => {
    const c = clamp(v)
    latest.current = c
    setLocal(c)
    onChange(c)
  }
  const finish = () => {
    if (local !== null || drag.current) onCommit?.(latest.current)
    drag.current = null
    setLocal(null)
  }

  // Wheel needs a non-passive listener to stop the page from scrolling.
  const handlers = useRef({ set, finish, shown, step, max, min })
  useEffect(() => {
    handlers.current = { set, finish, shown, step, max, min }
  })
  useEffect(() => {
    const el = box.current
    if (!el) return
    let timer: ReturnType<typeof setTimeout>
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const h = handlers.current
      h.set(h.shown - Math.sign(e.deltaY) * Math.max(h.step, (h.max - h.min) / 100))
      clearTimeout(timer)
      timer = setTimeout(() => handlers.current.finish(), 350)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const onDown = (e: PointerEvent) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { y: e.clientY, start: shown }
    latest.current = shown
  }
  const onMove = (e: PointerEvent) => {
    if (!drag.current) return
    const range = max - min
    set(drag.current.start + ((drag.current.y - e.clientY) / (e.shiftKey ? 800 : 160)) * range)
  }
  const onKey = (e: KeyboardEvent) => {
    const big = (max - min) / 20
    const delta = { ArrowUp: step, ArrowRight: step, ArrowDown: -step, ArrowLeft: -step, PageUp: big, PageDown: -big }[e.key]
    if (delta === undefined) return
    e.preventDefault()
    set(shown + delta * (e.shiftKey ? 1 : Math.max(1, Math.round(big / step / 4))))
  }

  // 270° sweep from 7:30 to 4:30.
  const r = size / 2 - 5
  const c = size / 2
  const angle = (v: number) => -135 + ((v - min) / (max - min)) * 270
  const point = (deg: number) => {
    const rad = ((deg - 90) * Math.PI) / 180
    return [c + r * Math.cos(rad), c + r * Math.sin(rad)]
  }
  const arc = (a: number, b: number) => {
    const [x1, y1] = point(a)
    const [x2, y2] = point(b)
    return `M${x1},${y1} A${r},${r} 0 ${Math.abs(b - a) > 180 ? 1 : 0} ${b > a ? 1 : 0} ${x2},${y2}`
  }
  const now = angle(shown)
  const from = bipolar ? angle((min + max) / 2) : -135
  const [px, py] = point(now)

  return (
    <div className="flex w-[76px] flex-col items-center gap-1 select-none" data-knob={label}>
      <div
        ref={box}
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={Math.round(shown * 1000) / 1000}
        aria-valuetext={format(shown)}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={finish}
        onPointerCancel={finish}
        onKeyDown={onKey}
        onKeyUp={() => local !== null && finish()}
        onDoubleClick={() => {
          set(defaultValue)
          onCommit?.(clamp(defaultValue))
          setLocal(null)
        }}
        className="cursor-ns-resize touch-none rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent"
        title={`${label}：上下拖曳調整（Shift 微調）· 雙擊還原`}
      >
        <svg width={size} height={size}>
          <circle cx={c} cy={c} r={r - 7} fill="#2a2a2a" stroke="#000" strokeWidth={1} />
          <path d={arc(-135, 135)} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth={4} strokeLinecap="round" />
          {Math.abs(now - from) > 0.5 && <path d={now > from ? arc(from, now) : arc(now, from)} fill="none" stroke={color} strokeWidth={4} strokeLinecap="round" />}
          <line x1={c} y1={c} x2={c + (px - c) * 0.62} y2={c + (py - c) * 0.62} stroke="#fff" strokeWidth={2.5} strokeLinecap="round" />
        </svg>
      </div>
      <span className="text-[10px] font-semibold tracking-wide text-white/55">{label}</span>
      <span className="font-mono text-[10px] text-white/85 tabular" data-knob-value>
        {format(shown)}
      </span>
    </div>
  )
}
