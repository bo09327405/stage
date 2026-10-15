import { motion } from 'motion/react'
import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useGlide } from '../../hooks/useGlide'

// Touch screens (pointer-coarse) get taller fields and larger text.
export const fieldClass =
  'w-full rounded-lg border border-line bg-black/40 px-3 py-2 text-sm text-white outline-none transition placeholder:text-white/25 focus:border-accent/80 focus:bg-black/60 pointer-coarse:py-3 pointer-coarse:text-base'

export function Label({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <span className="mb-1.5 flex items-baseline justify-between text-[11px] font-medium tracking-wide text-white/50 uppercase">
      <span>{children}</span>
      {hint && <span className="normal-case tracking-normal text-white/30">{hint}</span>}
    </span>
  )
}

/** Horizontal fader styled like a hardware fader. */
export function Fader({
  value,
  onChange,
  min = 0,
  max = 100,
  step = 1,
  fill = '#f5f5f7',
  label,
}: {
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  step?: number
  fill?: string
  label: string
}) {
  const pct = ((value - min) / (max - min)) * 100
  return (
    <input
      type="range"
      aria-label={label}
      className="fader h-5 w-full"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      style={{ '--fader-pct': `${pct}%`, '--fader-fill': fill } as CSSProperties}
    />
  )
}

/**
 * A fader bound to remote state: shows the local value while dragging and
 * writes out at most once per animation frame so a drag doesn't flood the database.
 * When the value changes on its own (e.g. DIM on / off) the fader glides there.
 */
export function LiveFader({
  value,
  write,
  ...props
}: Omit<Parameters<typeof Fader>[0], 'onChange'> & { write: (value: number) => void }) {
  const [dragValue, setDragValue] = useState<number | null>(null)
  const shown = useGlide(value, dragValue != null)
  const pending = useRef<number | null>(null)
  const frame = useRef(0)

  useEffect(() => () => cancelAnimationFrame(frame.current), [])

  const schedule = (v: number) => {
    pending.current = v
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      if (pending.current != null) write(pending.current)
    })
  }

  return (
    <div onPointerUp={() => setDragValue(null)} onKeyUp={() => setDragValue(null)} onBlur={() => setDragValue(null)}>
      <Fader
        {...props}
        value={dragValue ?? shown}
        onChange={(v) => {
          setDragValue(v)
          schedule(v)
        }}
      />
    </div>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  description?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex min-h-12 w-full items-center justify-between gap-4 rounded-lg border border-line bg-black/30 px-3 py-2.5 text-left transition hover:bg-white/[0.03] pointer-coarse:min-h-14"
    >
      <span>
        <span className="block text-sm text-white">{label}</span>
        {description && <span className="block text-xs text-white/40">{description}</span>}
      </span>
      <span className={`relative h-6 w-10 shrink-0 rounded-full transition-colors ${checked ? 'bg-go' : 'bg-white/15'}`}>
        <motion.span
          className="absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow"
          animate={{ x: checked ? 16 : 0 }}
          transition={{ type: 'spring', stiffness: 600, damping: 35 }}
        />
      </span>
    </button>
  )
}

/** Numeric input (seconds by default) with large −/+ steppers for touch screens. */
export function NumberField({
  label,
  value,
  onChange,
  suffix = 's',
  step = 0.1,
  stepperStep,
  compact = false,
  min = 0,
  max,
  hint,
}: {
  label: string
  value: number
  onChange: (value: number) => void
  suffix?: string
  step?: number
  /** Increment for the −/+ buttons; defaults to 1 for second-based fields. */
  stepperStep?: number
  /** Hide the −/+ steppers (for tight two-column layouts). */
  compact?: boolean
  min?: number
  max?: number
  hint?: string
}) {
  const [text, setText] = useState(String(value))
  // Re-sync when the value changes from outside (switching cues, waveform drags, steppers).
  const [lastValue, setLastValue] = useState(value)
  if (value !== lastValue) {
    setLastValue(value)
    setText(String(value))
  }

  const inputId = useId()
  const clamp = (n: number) => Math.max(min, max != null ? Math.min(max, n) : n)
  const bump = (delta: number) => {
    const next = clamp(Math.round((value + delta) * 100) / 100)
    setLastValue(next)
    setText(String(next))
    onChange(next)
  }
  const inc = stepperStep ?? (suffix === 's' ? 1 : step)
  const stepperClass =
    'flex w-10 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.06] text-lg text-white/80 hover:bg-white/10 active:bg-white/20 pointer-coarse:w-12'

  // Not wrapped in a <label>: a label's first focusable child (the "−" button) would be clicked
  // whenever the label text is tapped. The label is tied to the input by id instead.
  return (
    <div className="block" data-field={label}>
      <label htmlFor={inputId} className="block">
        <Label hint={hint}>{label}</Label>
      </label>
      <div className="flex gap-1.5">
        {!compact && (
          <button type="button" className={stepperClass} onClick={() => bump(-inc)} aria-label={`${label} 減少`}>
            −
          </button>
        )}
        <div className="relative min-w-[3.5rem] flex-1">
          <input
            id={inputId}
            // Bright, bordered, and never narrower than three digits, so it always reads as a field.
            className={`w-full min-w-[3.5rem] rounded-lg border border-white/20 bg-[#0b0b0b] py-2 text-center font-mono text-base font-semibold text-white tabular caret-go outline-none transition placeholder:text-white/25 hover:border-white/35 focus:border-go focus:bg-black focus:ring-2 focus:ring-go/30 pointer-coarse:py-3 ${
              suffix ? 'pr-7 pl-2' : 'px-2'
            }`}
            role="spinbutton"
            aria-valuenow={value}
            // A text input with a numeric keypad, not type="number": number inputs have no
            // selection API (the caret jumps while typing) and change value on mouse-wheel scroll.
            type="text"
            inputMode={min < 0 ? 'text' : 'decimal'}
            autoComplete="off"
            spellCheck={false}
            aria-valuemin={min}
            aria-valuemax={max}
            value={text}
            // Typing replaces the value instead of being spliced into it.
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => {
              // Accept only what can become a number: digits, one dot, a leading minus.
              const raw = e.target.value.replace(/[^0-9.-]/g, '')
              if (!/^-?\d*\.?\d*$/.test(raw)) return
              setText(raw)
              if (raw === '' || raw === '-' || raw === '.' || raw === '-.') return
              const clamped = clamp(Number(raw))
              setLastValue(clamped)
              onChange(clamped)
            }}
            onKeyDown={(e) => {
              // Arrow keys step like the −/+ buttons.
              if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                e.preventDefault()
                bump(e.key === 'ArrowUp' ? inc : -inc)
              } else if (e.key === 'Enter') {
                e.currentTarget.blur()
              }
            }}
            // Show what was actually stored (clamped, "" → 0) once editing ends.
            onBlur={() => {
              if (text === '' || text === '-' || text === '.') onChange(clamp(0))
              setText(String(value))
            }}
          />
          {suffix && (
            <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-xs text-white/30">{suffix}</span>
          )}
        </div>
        {!compact && (
          <button type="button" className={stepperClass} onClick={() => bump(inc)} aria-label={`${label} 增加`}>
            +
          </button>
        )}
      </div>
    </div>
  )
}

/** Large segmented choice, used for enums such as stop-others and follow mode. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  columns = 3,
}: {
  options: { id: T; label: string; description?: string }[]
  value: T
  onChange: (id: T) => void
  columns?: number
}) {
  return (
    <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          onClick={() => onChange(o.id)}
          className={`min-h-11 rounded-lg border px-2 py-2 text-xs transition pointer-coarse:min-h-13 pointer-coarse:text-sm ${
            value === o.id ? 'border-accent bg-accent/15 text-white' : 'border-line bg-black/30 text-white/50 hover:text-white/80'
          }`}
        >
          <span className="block font-medium">{o.label}</span>
          {o.description && <span className="mt-0.5 block text-[10px] text-white/35">{o.description}</span>}
        </button>
      ))}
    </div>
  )
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: { id: T; label: string }[]
  value: T
  onChange: (id: T) => void
}) {
  return (
    <div className="flex gap-1 rounded-lg bg-black/40 p-1" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={tab.id === value}
          onClick={() => onChange(tab.id)}
          className={`relative flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition pointer-coarse:py-2.5 pointer-coarse:text-sm ${
            tab.id === value ? 'text-white' : 'text-white/45 hover:text-white/75'
          }`}
        >
          {tab.id === value && (
            <motion.span
              layoutId="tab-pill"
              className="absolute inset-0 rounded-md bg-white/10"
              transition={{ type: 'spring', stiffness: 500, damping: 40 }}
            />
          )}
          <span className="relative">{tab.label}</span>
        </button>
      ))}
    </div>
  )
}
