import { useGlide } from '../../hooks/useGlide'
import { motion } from 'motion/react'
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type { Cue } from '../../types/cue'
import type { SurfaceWidget } from '../../types/surface'
import { describeAction, type ActionPhase } from '../../utils/surfaceActions'
import { AbletonKnob, KnobVisual } from './AbletonKnob'
import { widgetReadout } from '../../utils/liveParams'
import { DEFAULT_DENSITY, type GridDensity } from '../../utils/gridDensity'

interface SurfaceCanvasProps {
  widgets: SurfaceWidget[]
  columns: number
  editing: boolean
  selectedId: string | null
  cues: Cue[]
  onSelect: (id: string | null) => void
  /** Edit mode: commit a moved/resized widget. */
  onLayout: (widget: SurfaceWidget) => void
  /** Perform mode: a control was used. */
  onTrigger: (widget: SurfaceWidget, phase: ActionPhase, value: number) => void
  /** Perform mode: a fader was released at this value (persist it). */
  onFaderCommit: (widget: SurfaceWidget, value: number) => void
  /** Content of a button in "Cue Monitor" or "Note" display; `preview` = edit mode (no taps). */
  renderDisplay: (widget: SurfaceWidget, preview: boolean) => ReactNode
  /**
   * A fader's value taken from live show state instead of its own (Master faders follow the show
   * master, dimmed while DIM is on); null keeps the widget's stored value.
   */
  liveValue?: (widget: SurfaceWidget) => number | null
  /** This device's grid size (scale, gap, row height); see utils/gridDensity.ts. */
  density?: GridDensity
}

/** Buttons that show live content instead of firing actions. */
const isDisplay = (w: SurfaceWidget) => w.type === 'button' && w.display !== 'action'

type Gesture = {
  id: string
  mode: 'move' | 'resize'
  startX: number
  startY: number
  origin: Pick<SurfaceWidget, 'x' | 'y' | 'w' | 'h'>
}

/** Grid canvas holding buttons and faders. Edit mode drags/resizes on a snapping grid. */
export function SurfaceCanvas({
  widgets,
  columns,
  editing,
  selectedId,
  cues,
  onSelect,
  onLayout,
  onTrigger,
  onFaderCommit,
  renderDisplay,
  liveValue,
  density = DEFAULT_DENSITY,
}: SurfaceCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [gesture, setGesture] = useState<Gesture | null>(null)
  // Live geometry while dragging, before it's committed to Firebase.
  const [draft, setDraft] = useState<Pick<SurfaceWidget, 'id' | 'x' | 'y' | 'w' | 'h'> | null>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // The grid fits the panel width at 100 %; smaller is centred, larger scrolls sideways.
  const gap = density.gap
  const gridWidth = width * density.scale
  const cell = width > 0 ? Math.max(8, (gridWidth - gap * (columns - 1)) / columns) : 0
  // Touch screens never go below a 44 px row (the minimum comfortable finger target).
  const minRow = coarsePointer() ? 44 : 40
  const rowHeight = Math.min(170, Math.max(minRow, cell * density.row))
  const fullWidth = cell * columns + gap * (columns - 1)
  const placed = widgets.map((w) => (draft?.id === w.id ? { ...w, ...draft } : w))
  const rows = Math.max(8, ...placed.map((w) => w.y + w.h)) + (editing ? 3 : 0)

  const beginGesture = (e: ReactPointerEvent, widget: SurfaceWidget, mode: Gesture['mode']) => {
    if (!editing) return
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    onSelect(widget.id)
    setGesture({ id: widget.id, mode, startX: e.clientX, startY: e.clientY, origin: widget })
    setDraft({ id: widget.id, x: widget.x, y: widget.y, w: widget.w, h: widget.h })
  }

  const moveGesture = (e: ReactPointerEvent) => {
    if (!gesture || !cell) return
    const dCols = Math.round((e.clientX - gesture.startX) / (cell + gap))
    const dRows = Math.round((e.clientY - gesture.startY) / (rowHeight + gap))
    const o = gesture.origin
    setDraft(
      gesture.mode === 'move'
        ? { id: gesture.id, w: o.w, h: o.h, x: clamp(o.x + dCols, 0, columns - o.w), y: Math.max(0, o.y + dRows) }
        : { id: gesture.id, x: o.x, y: o.y, w: clamp(o.w + dCols, 1, columns - o.x), h: clamp(o.h + dRows, 1, 12) },
    )
  }

  const endGesture = () => {
    if (gesture && draft) {
      const widget = widgets.find((w) => w.id === gesture.id)
      const o = gesture.origin
      if (widget && (draft.x !== o.x || draft.y !== o.y || draft.w !== o.w || draft.h !== o.h)) onLayout({ ...widget, ...draft })
    }
    setGesture(null)
    setDraft(null)
  }

  return (
    <div ref={containerRef} className={`w-full ${density.scale > 1 ? 'overflow-x-auto pb-2' : ''}`} data-grid-scale={density.scale}>
    <div
      onPointerDown={() => editing && onSelect(null)}
      className="relative mx-auto"
      style={{
        width: fullWidth || '100%',
        height: rows * rowHeight + (rows - 1) * gap,
        ['--grid-columns' as string]: columns,
        ['--grid-gap' as string]: `${gap}px`,
        ['--grid-cell' as string]: `${cell}px`,
        ['--grid-row' as string]: `${rowHeight}px`,
        // Visible grid in edit mode.
        backgroundImage: editing && cell
          ? `linear-gradient(to right, rgba(255,255,255,0.05) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.05) 1px, transparent 1px)`
          : undefined,
        backgroundSize: editing && cell ? `${cell + gap}px ${rowHeight + gap}px` : undefined,
      }}
    >
      {cell > 0 &&
        placed.map((w) => (
          <div
            key={w.id}
            data-widget={w.id}
            data-widget-type={w.type}
            className="absolute"
            style={{
              left: w.x * (cell + gap),
              top: w.y * (rowHeight + gap),
              width: w.w * cell + (w.w - 1) * gap,
              height: w.h * rowHeight + (w.h - 1) * gap,
              transition: draft?.id === w.id ? 'none' : 'left 150ms, top 150ms, width 150ms, height 150ms',
              zIndex: draft?.id === w.id ? 10 : 1,
            }}
          >
            {editing ? (
              <div
                onPointerDown={(e) => beginGesture(e, w, 'move')}
                onPointerMove={moveGesture}
                onPointerUp={endGesture}
                onPointerCancel={endGesture}
                className={`relative h-full w-full cursor-grab touch-none rounded-2xl active:cursor-grabbing ${
                  selectedId === w.id ? 'ring-2 ring-accent ring-offset-2 ring-offset-ink' : ''
                }`}
              >
                {isDisplay(w) ? (
                  // Taps inside the preview must not reach its list; the whole block drags.
                  <div className="pointer-events-none h-full w-full">{renderDisplay(w, true)}</div>
                ) : (
                  <WidgetFace widget={w} cues={cues} preview />
                )}
                {/* Resize handle */}
                <span
                  onPointerDown={(e) => beginGesture(e, w, 'resize')}
                  onPointerMove={moveGesture}
                  onPointerUp={endGesture}
                  onPointerCancel={endGesture}
                  className="absolute right-0 bottom-0 flex h-8 w-8 cursor-nwse-resize touch-none items-end justify-end p-1.5"
                  aria-label="調整大小"
                >
                  <span className="h-3 w-3 rounded-br-md border-r-2 border-b-2 border-white/70" />
                </span>
              </div>
            ) : isDisplay(w) ? (
              renderDisplay(w, false)
            ) : w.type === 'button' ? (
              <SurfaceButton widget={w} cues={cues} onTrigger={onTrigger} />
            ) : w.type === 'knob' ? (
              <AbletonKnob widget={w} onTrigger={onTrigger} onCommit={onFaderCommit} />
            ) : (
              <SurfaceFader widget={w} external={liveValue?.(w) ?? null} onTrigger={onTrigger} onCommit={onFaderCommit} />
            )}
          </div>
        ))}
    </div>
    </div>
  )
}

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n))
const coarsePointer = () => typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches

/** Static rendering used in edit mode. */
function WidgetFace({ widget, cues, preview }: { widget: SurfaceWidget; cues: Cue[]; preview?: boolean }) {
  if (widget.type === 'fader') {
    return <FaderVisual widget={widget} value={widget.value} />
  }
  if (widget.type === 'knob') return <KnobVisual widget={widget} value={widget.value} />
  return <ButtonVisual widget={widget} cues={cues} pressed={false} dimmed={preview} />
}

function ButtonVisual({ widget, cues, pressed, dimmed }: { widget: SurfaceWidget; cues: Cue[]; pressed: boolean; dimmed?: boolean }) {
  const summary = widget.actions.map((a) => describeAction(a, cues)).join(' · ')
  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-1 overflow-hidden rounded-2xl border px-2 text-center transition-[box-shadow,background] duration-100 select-none"
      style={{
        borderColor: `${widget.color}80`,
        background: pressed
          ? widget.color
          : `linear-gradient(160deg, ${widget.color}${dimmed ? '30' : '45'}, ${widget.color}14)`,
        boxShadow: pressed ? `0 0 40px -6px ${widget.color}` : 'none',
        color: pressed ? '#000' : '#fff',
      }}
    >
      <span className="line-clamp-2 text-base leading-tight font-bold">{widget.label}</span>
      {summary && <span className="line-clamp-1 text-[10px] opacity-60">{summary}</span>}
      {widget.actions.length === 0 && <span className="text-[10px] opacity-40">未設定動作</span>}
    </div>
  )
}

function FaderVisual({
  widget,
  value,
  trackRef,
}: {
  widget: SurfaceWidget
  value: number
  /** The travel area; the interactive fader measures pointer position against it. */
  trackRef?: React.Ref<HTMLDivElement>
}) {
  const vertical = widget.h >= widget.w
  const pct = clamp(widget.max === widget.min ? 0 : (value - widget.min) / (widget.max - widget.min), 0, 1) * 100
  return (
    <div className="flex h-full w-full flex-col gap-1.5 overflow-hidden rounded-2xl border border-line bg-black/40 p-2 select-none">
      <div className="flex items-baseline justify-between gap-1 text-[11px]">
        <span className="truncate font-semibold text-white/80">{widget.label}</span>
        <span className="shrink-0 font-mono text-white/50 tabular" data-fader-readout>
          {widgetReadout(widget, value)}
        </span>
      </div>
      <div ref={trackRef} className="relative min-h-0 flex-1 overflow-hidden rounded-xl bg-white/[0.06]">
        <div
          className="absolute rounded-xl"
          style={{
            background: `linear-gradient(${vertical ? 'to top' : 'to right'}, ${widget.color}aa, ${widget.color})`,
            ...(vertical ? { left: 0, right: 0, bottom: 0, height: `${pct}%` } : { top: 0, bottom: 0, left: 0, width: `${pct}%` }),
          }}
        />
        {/* Cap */}
        <div
          className="absolute rounded-md bg-white shadow-lg"
          style={
            vertical
              ? { left: 4, right: 4, height: 8, bottom: `calc(${pct}% - 4px)` }
              : { top: 4, bottom: 4, width: 8, left: `calc(${pct}% - 4px)` }
          }
        />
      </div>
    </div>
  )
}

function SurfaceButton({
  widget,
  cues,
  onTrigger,
}: {
  widget: SurfaceWidget
  cues: Cue[]
  onTrigger: SurfaceCanvasProps['onTrigger']
}) {
  const [pressed, setPressed] = useState(false)
  const release = () => {
    if (!pressed) return
    setPressed(false)
    onTrigger(widget, 'release', 0)
  }
  return (
    // Pointer down (not click) so a show button fires the instant it's touched.
    <motion.button
      whileTap={{ scale: 0.96 }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        setPressed(true)
        onTrigger(widget, 'press', 1)
      }}
      onPointerUp={release}
      onPointerCancel={release}
      className="h-full w-full touch-none"
    >
      <ButtonVisual widget={widget} cues={cues} pressed={pressed} />
    </motion.button>
  )
}

function SurfaceFader({
  widget,
  external,
  onTrigger,
  onCommit,
}: {
  widget: SurfaceWidget
  /** Live value from show state (e.g. the show master, dimmed); glides when it changes on its own. */
  external: number | null
  onTrigger: SurfaceCanvasProps['onTrigger']
  onCommit: SurfaceCanvasProps['onFaderCommit']
}) {
  const [live, setLive] = useState<number | null>(null)
  const shown = useGlide(external ?? widget.value, live != null)
  const trackRef = useRef<HTMLDivElement>(null)
  const frame = useRef(0)
  const pending = useRef<number | null>(null)
  const vertical = widget.h >= widget.w

  useEffect(() => () => cancelAnimationFrame(frame.current), [])

  const valueAt = (e: ReactPointerEvent) => {
    const rect = trackRef.current!.getBoundingClientRect()
    const t = vertical ? 1 - (e.clientY - rect.top) / rect.height : (e.clientX - rect.left) / rect.width
    return widget.min + clamp(t, 0, 1) * (widget.max - widget.min)
  }

  // Send at most one update per animation frame while dragging.
  const emit = (value: number) => {
    setLive(value)
    pending.current = value
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      if (pending.current != null) onTrigger(widget, 'change', pending.current)
    })
  }

  const finish = () => {
    if (live != null) onCommit(widget, live)
    setLive(null)
  }

  return (
    <div
      className="h-full w-full touch-none"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        onTrigger(widget, 'press', valueAt(e))
        emit(valueAt(e))
      }}
      onPointerMove={(e) => live != null && emit(valueAt(e))}
      onPointerUp={finish}
      onPointerCancel={finish}
    >
      <FaderVisual widget={widget} value={live ?? shown} trackRef={trackRef} />
    </div>
  )
}
