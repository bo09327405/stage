import { useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import { formatTime } from '../../hooks/useServerNow'
import { CUE_TYPE_GLYPHS, type Cue } from '../../types/cue'
import type { MonitorLayout } from '../../types/surface'
import type { TileState } from '../../hooks/useCueMonitorState'

interface CueGridProps {
  cues: Cue[]
  layout: MonitorLayout
  arranging: boolean
  tileState: (cue: Cue) => TileState
  onTap: (cue: Cue) => void
  onLayoutChange: (changes: Partial<MonitorLayout>) => void
}

/** Cues in the layout's custom order; new cues (not yet placed) follow in cue-list order. */
function orderedCues(cues: Cue[], order: string[]): Cue[] {
  const byId = new Map(cues.map((c) => [c.id, c]))
  const placed = order.map((id) => byId.get(id)).filter((c): c is Cue => !!c)
  const placedIds = new Set(placed.map((c) => c.id))
  return [...placed, ...cues.filter((c) => !placedIds.has(c.id))]
}

/**
 * The Cue Monitor as a button grid. Perform mode: tap a tile (standby or GO, per layout).
 * Arrange mode: drag tiles to reorder (finger or mouse) and resize each one with its W/H steppers.
 */
export function CueGrid({ cues, layout, arranging, tileState, onTap, onLayoutChange }: CueGridProps) {
  const list = orderedCues(cues, layout.order)
  // Order while a tile is being dragged.
  const [draft, setDraft] = useState<string[] | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const draftRef = useRef<string[] | null>(null)
  const ids = draft ?? list.map((c) => c.id)
  const byId = new Map(cues.map((c) => [c.id, c]))

  const span = (id: string) => layout.spans[id] ?? { w: 1, h: 1 }
  const setSpan = (id: string, w: number, h: number) => {
    const spans = { ...layout.spans }
    if (w === 1 && h === 1) delete spans[id]
    else spans[id] = { w, h }
    onLayoutChange({ spans })
  }

  const startDrag = (e: PointerEvent<HTMLElement>, id: string) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    const start = list.map((c) => c.id)
    draftRef.current = start
    setDraft(start)
    setDragId(id)
  }
  const moveDrag = (e: PointerEvent<HTMLElement>) => {
    if (!dragId || !draftRef.current) return
    // Which tile is under the finger? Insert the dragged tile at its position.
    const target = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-tile]')?.dataset.tile
    if (!target || target === dragId) return
    const next = draftRef.current.filter((id) => id !== dragId)
    next.splice(next.indexOf(target) + (draftRef.current.indexOf(target) > draftRef.current.indexOf(dragId) ? 1 : 0), 0, dragId)
    draftRef.current = next
    setDraft(next)
  }
  const endDrag = () => {
    if (dragId && draftRef.current) onLayoutChange({ order: draftRef.current })
    draftRef.current = null
    setDraft(null)
    setDragId(null)
  }

  return (
    <div
      className="grid gap-2 pt-1"
      style={
        {
          gridTemplateColumns: `repeat(${layout.columns}, minmax(0, 1fr))`,
          gridAutoRows: `${layout.tileHeight}px`,
          gridAutoFlow: 'dense',
          '--tile-font': layout.fontScale,
        } as CSSProperties
      }
    >
      {ids.map((id) => {
        const cue = byId.get(id)
        if (!cue) return null
        const { w, h } = span(id)
        return (
          <div
            key={id}
            data-tile={id}
            data-cue={id}
            style={{ gridColumn: `span ${Math.min(w, layout.columns)}`, gridRow: `span ${h}` }}
            className={`relative min-w-0 ${dragId === id ? 'z-10 opacity-80' : ''}`}
          >
            <Tile cue={cue} state={tileState(cue)} tapAction={layout.tapAction} arranging={arranging} onTap={() => onTap(cue)} dragging={dragId === id} />
            {arranging && (
              <>
                {/* Whole tile is the drag handle while arranging */}
                <div
                  onPointerDown={(e) => startDrag(e, id)}
                  onPointerMove={moveDrag}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                  className={`absolute inset-0 touch-none rounded-xl ${dragId === id ? 'cursor-grabbing' : 'cursor-grab'}`}
                  aria-label={`拖曳排列 Q${cue.cueNumber}`}
                />
                <SpanControls
                  w={w}
                  h={h}
                  maxW={layout.columns}
                  onChange={(nw, nh) => setSpan(id, nw, nh)}
                />
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}

export function Tile({
  cue,
  state,
  tapAction,
  arranging,
  dragging,
  onTap,
}: {
  cue: Cue
  state: TileState
  tapAction: MonitorLayout['tapAction']
  arranging: boolean
  dragging: boolean
  onTap: () => void
}) {
  const { inst, timing, isStandby, paused } = state
  const status = inst ? (paused ? 'PAUSED' : timing?.phase === 'prewait' ? 'PRE-WAIT' : 'ACTIVE') : isStandby ? 'NEXT' : 'IDLE'
  const tone = inst
    ? 'border-go bg-go/[0.12] shadow-[0_0_24px_-8px_#30d158]'
    : isStandby
      ? 'border-standby bg-standby/[0.10]'
      : 'border-white/10 bg-white/[0.04] hover:bg-white/[0.08]'
  const font = (rem: number) => ({ fontSize: `calc(${rem}rem * var(--tile-font, 1))` })

  return (
    <button
      type="button"
      onClick={onTap}
      disabled={arranging}
      className={`relative flex h-full w-full flex-col justify-between overflow-hidden rounded-xl border p-2.5 pb-3.5 text-left transition ${tone} ${
        arranging ? 'border-dashed' : 'active:scale-[0.98]'
      } ${dragging ? 'ring-2 ring-accent' : ''}`}
      title={tapAction === 'go' ? '點擊直接 GO 此 Cue' : '點擊設為 Standby'}
    >
      {timing?.progress != null && (
        <span
          className={`absolute inset-x-0 bottom-0 h-1.5 origin-left ${timing.phase === 'prewait' ? 'bg-standby' : 'bg-go'}`}
          style={{ transform: `scaleX(${timing.progress})` }}
        />
      )}
      <span className="flex items-start justify-between gap-1">
        <span className="font-mono leading-none font-bold text-white tabular" style={font(1.35)}>
          {cue.cueNumber}
        </span>
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 font-bold tracking-wider ${
            status === 'IDLE' ? 'text-white/30' : status === 'NEXT' || status === 'PAUSED' || status === 'PRE-WAIT' ? 'bg-standby text-black' : 'bg-go text-black'
          }`}
          style={font(0.55)}
        >
          {status}
        </span>
      </span>
      <span className="min-w-0">
        <span className="line-clamp-2 leading-tight font-semibold text-white/90" style={font(0.85)}>
          <span className="mr-1 text-white/40">{CUE_TYPE_GLYPHS[cue.type]}</span>
          {cue.title || '（未命名）'}
        </span>
        {timing && (
          <span className={`mt-0.5 block font-mono tabular ${timing.phase === 'prewait' ? 'text-standby' : 'text-go'}`} style={font(0.75)}>
            {timing.remaining != null ? `-${formatTime(timing.remaining)}` : formatTime(timing.elapsed)}
          </span>
        )}
      </span>
    </button>
  )
}

/** W/H steppers shown on each tile while arranging. */
function SpanControls({ w, h, maxW, onChange }: { w: number; h: number; maxW: number; onChange: (w: number, h: number) => void }) {
  const btn = 'flex h-7 w-7 items-center justify-center rounded-md bg-black/70 text-xs text-white hover:bg-accent'
  return (
    <div className="absolute right-1 bottom-1 z-10 flex items-center gap-0.5 rounded-lg bg-black/60 p-0.5 text-[10px] text-white/70 backdrop-blur">
      <span className="px-1">寬</span>
      <button type="button" className={btn} onClick={() => onChange(Math.max(1, w - 1), h)} aria-label="變窄">−</button>
      <span className="w-3 text-center font-mono">{w}</span>
      <button type="button" className={btn} onClick={() => onChange(Math.min(maxW, w + 1), h)} aria-label="變寬">＋</button>
      <span className="px-1">高</span>
      <button type="button" className={btn} onClick={() => onChange(w, Math.max(1, h - 1))} aria-label="變矮">−</button>
      <span className="w-3 text-center font-mono">{h}</span>
      <button type="button" className={btn} onClick={() => onChange(w, Math.min(4, h + 1))} aria-label="變高">＋</button>
    </div>
  )
}
