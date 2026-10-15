import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { matchPreset, type SizePreset, type SizeSlider, type SizeValues } from '../../utils/gridDensity'

interface MenuProps<T extends SizeValues> {
  value: T
  onChange: (v: T) => void
  presets: Record<string, SizePreset<T>>
  sliders: SizeSlider<T>[]
  /** Explanation under the sliders. */
  note: string
  /** Icon only (narrow places). */
  compact?: boolean
  /** data-grid-size-button value (tests). */
  id?: string
}

/** "▦" button and its popover: size presets plus fine control (panel grid, Executor sidebar). */
export function GridSizeMenu<T extends SizeValues>({ value, onChange, presets, sliders, note, compact, id = 'panel' }: MenuProps<T>) {
  const [open, setOpen] = useState<DOMRect | null>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const preset = matchPreset(value, presets)
  return (
    <>
      <button
        ref={btn}
        type="button"
        onClick={(e) => setOpen(open ? null : e.currentTarget.getBoundingClientRect())}
        className={`flex shrink-0 items-center gap-1.5 rounded-lg text-xs ${compact ? 'h-8 px-2' : 'min-h-10 px-3'} ${open ? 'bg-white/15 text-white' : compact ? 'text-white/60 hover:bg-white/10 hover:text-white' : 'bg-white/[0.06] text-white/70 hover:bg-white/10'}`}
        aria-expanded={!!open}
        title={`網格大小：${preset ? presets[preset].label : '自訂'}`}
        data-grid-size-button={id}
      >
        <GridIcon />
        {!compact && (
          <span className="whitespace-nowrap">
            網格 · {preset ? presets[preset].label : '自訂'}
          </span>
        )}
      </button>
      {open && <GridPopup rect={open} anchor={btn} value={value} onChange={onChange} presets={presets} sliders={sliders} note={note} onClose={() => setOpen(null)} id={id} />}
    </>
  )
}

function GridPopup<T extends SizeValues>({
  rect,
  anchor,
  value,
  onChange,
  presets,
  sliders,
  note,
  onClose,
  id,
}: Omit<MenuProps<T>, 'compact'> & { rect: DOMRect; anchor: React.RefObject<HTMLElement | null>; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  useLayoutEffect(() => {
    close.current = onClose
  })
  useEffect(() => {
    const away = (e: Event) => !box.current?.contains(e.target as Node) && !anchor.current?.contains(e.target as Node) && close.current()
    const key = (e: KeyboardEvent) => e.key === 'Escape' && close.current()
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('pointerdown', away, true)
      window.removeEventListener('keydown', key)
    }
  }, [anchor])
  const W = 288
  const preset = matchPreset(value, presets)
  return createPortal(
    <div
      ref={box}
      className="fixed z-[80] space-y-3 rounded-xl border border-white/10 bg-[#2a2a2c]/95 p-3 text-[13px] text-white shadow-2xl backdrop-blur-xl"
      style={{ width: W, left: Math.max(8, Math.min(rect.left, window.innerWidth - W - 8)), top: rect.bottom + 6 }}
      role="dialog"
      aria-label="網格大小"
      data-grid-menu={id}
    >
      <div className="flex items-baseline gap-2">
        <span className="text-[12px] font-semibold text-white/75">網格大小</span>
        <span className="text-[10px] text-white/35">只影響這台裝置的顯示</span>
      </div>
      <div className="grid grid-cols-3 gap-1 rounded-lg bg-black/40 p-1" role="radiogroup" aria-label="預設大小">
        {Object.entries(presets).map(([p, def]) => (
          <button
            key={p}
            type="button"
            role="radio"
            aria-checked={preset === p}
            onClick={() => onChange(def.value)}
            className={`rounded-md py-1.5 text-center ${preset === p ? 'bg-white/15 text-white' : 'text-white/55 hover:text-white'}`}
            data-grid-preset={p}
          >
            <div className="text-[13px] font-semibold">{def.label}</div>
            <div className="text-[9px] text-white/40">{def.hint}</div>
          </button>
        ))}
      </div>
      {sliders.map((s) => (
        <label key={s.field} className="block">
          <div className="mb-1 flex justify-between text-[11px] text-white/55">
            <span>{s.label}</span>
            <span className="font-mono text-white/80 tabular">{s.format(value[s.field])}</span>
          </div>
          <input
            type="range"
            min={s.min}
            max={s.max}
            step={s.step}
            value={value[s.field]}
            onChange={(e) => onChange({ ...value, [s.field]: Number(e.target.value) })}
            className="w-full accent-accent"
            aria-label={s.label}
            data-grid-slider={s.field}
          />
        </label>
      ))}
      <p className="text-[10px] leading-relaxed text-white/35">{note}</p>
    </div>,
    document.body,
  )
}

const GridIcon = () => (
  <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
    <rect x="3" y="3" width="14" height="14" rx="2" />
    <path d="M3 8.5h14M3 13.5h14M8.5 3v14M13.5 3v14" />
  </svg>
)
