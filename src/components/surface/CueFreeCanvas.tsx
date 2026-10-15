import { useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react'
import { formatTime } from '../../hooks/useServerNow'
import { CUE_TYPE_GLYPHS, type ActiveCue, type Cue } from '../../types/cue'
import { FREE_COLUMNS, FREE_ROW_PX, MODULE_LABELS, type FreeRect, type MonitorLayout, type MonitorModule } from '../../types/surface'
import type { InstanceTiming } from '../../utils/cueTiming'
import { Tile } from './CueGrid'
import type { TileState } from '../../hooks/useCueMonitorState'

const MIN_W = 3
const MIN_H = 4
/** Extra empty rows below the content while arranging, so items can be dragged further down. */
const ARRANGE_SLACK_ROWS = 24

export interface NowInfo {
  instances: { inst: ActiveCue; timing: InstanceTiming; paused: boolean }[]
  standby: Cue | null
}

interface CueFreeCanvasProps {
  cues: Cue[]
  layout: MonitorLayout
  arranging: boolean
  tileState: (cue: Cue) => TileState
  nowInfo: NowInfo
  onTap: (cue: Cue) => void
  onLayoutChange: (changes: Partial<MonitorLayout>) => void
}

const clampRect = (r: FreeRect): FreeRect => {
  const w = Math.min(FREE_COLUMNS, Math.max(MIN_W, Math.round(Number(r.w) || MIN_W)))
  return {
    w,
    h: Math.min(200, Math.max(MIN_H, Math.round(Number(r.h) || MIN_H))),
    x: Math.min(FREE_COLUMNS - w, Math.max(0, Math.round(Number(r.x) || 0))),
    y: Math.min(2000, Math.max(0, Math.round(Number(r.y) || 0))),
  }
}

/**
 * Where every item sits: saved rectangles first, then anything not yet placed (new cues, newly
 * enabled modules) flows into rows below them, sized from the grid's column count and tile height.
 */
function resolveRects(ids: string[], layout: MonitorLayout): Record<string, FreeRect> {
  const rects: Record<string, FreeRect> = {}
  let bottom = 0
  const unplaced: string[] = []
  for (const id of ids) {
    const saved = layout.free[id]
    if (saved) {
      rects[id] = clampRect(saved)
      bottom = Math.max(bottom, rects[id].y + rects[id].h)
    } else {
      unplaced.push(id)
    }
  }
  const cols = layout.columns
  const w = Math.max(MIN_W, Math.floor(FREE_COLUMNS / cols))
  const h = Math.max(MIN_H, Math.ceil(layout.tileHeight / FREE_ROW_PX))
  unplaced.forEach((id, i) => {
    rects[id] = { x: (i % cols) * w, y: bottom + Math.floor(i / cols) * h, w, h }
  })
  return rects
}

type Gesture = { id: string; kind: 'move' | 'e' | 's' | 'se'; x: number; y: number; start: FreeRect; unit: number; moved: boolean }

/**
 * The Cue Monitor as a freeform canvas. Arrange mode: drag any tile or status module to any
 * position, and resize it from its right edge, bottom edge or corner (finger or mouse). Positions
 * snap to a 48-column × 8 px grid, so the layout scales with the window width and stays tidy.
 */
export function CueFreeCanvas({ cues, layout, arranging, tileState, nowInfo, onTap, onLayoutChange }: CueFreeCanvasProps) {
  const ids = [...layout.modules, ...cues.map((c) => c.id)]
  const saved = resolveRects(ids, layout)
  const [draft, setDraftState] = useState<{ id: string; rect: FreeRect } | null>(null)
  // Readable from the pointer-up handler even if the last move hasn't re-rendered yet.
  const draftRef = useRef<{ id: string; rect: FreeRect } | null>(null)
  const setDraft = (d: { id: string; rect: FreeRect } | null) => {
    draftRef.current = d
    setDraftState(d)
  }
  const [selected, setSelected] = useState<string | null>(null)
  const canvas = useRef<HTMLDivElement>(null)
  const gesture = useRef<Gesture | null>(null)
  const rects = draft ? { ...saved, [draft.id]: draft.rect } : saved
  const byId = new Map(cues.map((c) => [c.id, c]))

  const contentRows = Math.max(0, ...Object.values(rects).map((r) => r.y + r.h))
  const height = (contentRows + (arranging ? ARRANGE_SLACK_ROWS : 1)) * FREE_ROW_PX

  /** Save one item's rectangle; every item's current position is written too, so nothing reflows. */
  const commit = (id: string, rect: FreeRect) => {
    const free: Record<string, FreeRect> = {}
    for (const key of ids) free[key] = saved[key]
    free[id] = clampRect(rect)
    onLayoutChange({ free })
  }

  const begin = (e: PointerEvent<HTMLElement>, id: string, kind: Gesture['kind']) => {
    if (!arranging || !canvas.current) return
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    setSelected(id)
    gesture.current = { id, kind, x: e.clientX, y: e.clientY, start: saved[id], unit: canvas.current.clientWidth / FREE_COLUMNS, moved: false }
  }
  const move = (e: PointerEvent<HTMLElement>) => {
    const g = gesture.current
    if (!g) return
    const dx = Math.round((e.clientX - g.x) / g.unit)
    const dy = Math.round((e.clientY - g.y) / FREE_ROW_PX)
    if (dx || dy) g.moved = true
    const s = g.start
    const rect =
      g.kind === 'move'
        ? { ...s, x: s.x + dx, y: s.y + dy }
        : // Resizing grows from the fixed left edge and stops at the canvas edge.
          { ...s, w: g.kind === 's' ? s.w : Math.min(FREE_COLUMNS - s.x, s.w + dx), h: g.kind === 'e' ? s.h : s.h + dy }
    setDraft({ id: g.id, rect: clampRect(rect) })
  }
  const end = () => {
    const g = gesture.current
    gesture.current = null
    const d = draftRef.current
    if (g?.moved && d?.id === g.id) commit(g.id, d.rect)
    setDraft(null)
  }

  const sel = arranging && selected && rects[selected] ? selected : null

  return (
    <div className="pt-1">
      {sel && (
        <RectEditor
          label={byId.get(sel) ? `Q${byId.get(sel)!.cueNumber}` : MODULE_LABELS[sel as MonitorModule]}
          rect={rects[sel]}
          onChange={(rect) => commit(sel, rect)}
          onClose={() => setSelected(null)}
        />
      )}
      <div
        ref={canvas}
        onPointerDown={() => arranging && setSelected(null)}
        className={`relative w-full ${arranging ? 'rounded-lg bg-[length:calc(100%/12)_32px] [background-image:linear-gradient(to_right,rgba(255,255,255,0.05)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.05)_1px,transparent_1px)]' : ''}`}
        style={{ height, '--tile-font': layout.fontScale } as CSSProperties}
        data-free-canvas
      >
        {ids.map((id) => {
          const r = rects[id]
          const cue = byId.get(id)
          const active = draft?.id === id
          return (
            <div
              key={id}
              data-free-item={id}
              data-cue={cue ? id : undefined}
              className={`absolute p-1 ${active ? 'z-20' : sel === id ? 'z-10' : ''}`}
              style={{
                left: `${(r.x / FREE_COLUMNS) * 100}%`,
                width: `${(r.w / FREE_COLUMNS) * 100}%`,
                top: r.y * FREE_ROW_PX,
                height: r.h * FREE_ROW_PX,
                transition: active ? 'none' : 'left 120ms, top 120ms, width 120ms, height 120ms',
              }}
            >
              {cue ? (
                <Tile cue={cue} state={tileState(cue)} tapAction={layout.tapAction} arranging={arranging} onTap={() => onTap(cue)} dragging={active || sel === id} />
              ) : (
                <ModulePanel module={id as MonitorModule} info={nowInfo} highlighted={active || sel === id} arranging={arranging} />
              )}
              {arranging && (
                <>
                  <div
                    onPointerDown={(e) => begin(e, id, 'move')}
                    onPointerMove={move}
                    onPointerUp={end}
                    onPointerCancel={end}
                    className={`absolute inset-1 touch-none rounded-xl ${active ? 'cursor-grabbing' : 'cursor-grab'}`}
                    aria-label={`移動 ${cue ? `Q${cue.cueNumber}` : MODULE_LABELS[id as MonitorModule]}`}
                  />
                  <Handle kind="e" label="調整寬度" onDown={(e) => begin(e, id, 'e')} onMove={move} onUp={end} />
                  <Handle kind="s" label="調整高度" onDown={(e) => begin(e, id, 's')} onMove={move} onUp={end} />
                  <Handle kind="se" label="調整大小" onDown={(e) => begin(e, id, 'se')} onMove={move} onUp={end} />
                  {active && (
                    <span className="pointer-events-none absolute top-2 left-2 rounded bg-accent px-1.5 py-0.5 font-mono text-[10px] text-white">
                      {r.w}×{r.h * FREE_ROW_PX}px
                    </span>
                  )}
                </>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Handle({
  kind,
  label,
  onDown,
  onMove,
  onUp,
}: {
  kind: 'e' | 's' | 'se'
  label: string
  onDown: (e: PointerEvent<HTMLElement>) => void
  onMove: (e: PointerEvent<HTMLElement>) => void
  onUp: () => void
}) {
  const place = {
    e: 'top-1/2 -right-0.5 h-10 w-3 -translate-y-1/2 cursor-ew-resize',
    s: 'left-1/2 -bottom-0.5 h-3 w-10 -translate-x-1/2 cursor-ns-resize',
    se: '-right-0.5 -bottom-0.5 h-5 w-5 cursor-nwse-resize pointer-coarse:h-7 pointer-coarse:w-7',
  }[kind]
  return (
    <div
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      className={`absolute z-10 flex touch-none items-center justify-center ${place}`}
      role="slider"
      aria-label={label}
      data-handle={kind}
    >
      <span className={`rounded-full bg-accent shadow ${kind === 'se' ? 'h-3 w-3 border-2 border-white' : kind === 'e' ? 'h-7 w-1' : 'h-1 w-7'}`} />
    </div>
  )
}

/** Exact numbers for the selected item: X / Y / width / height. */
function RectEditor({ label, rect, onChange, onClose }: { label: string; rect: FreeRect; onChange: (r: FreeRect) => void; onClose: () => void }) {
  const field = (key: keyof FreeRect, name: string, scale: number, max: number) => (
    <label className="flex items-center gap-1">
      <span className="text-white/50">{name}</span>
      <input
        key={`${key}-${rect[key]}`}
        type="text"
        inputMode="numeric"
        defaultValue={rect[key] * scale}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        onBlur={(e) => {
          const n = Number(e.currentTarget.value)
          if (Number.isFinite(n)) onChange({ ...rect, [key]: Math.min(max, Math.round(n / scale)) })
        }}
        className="w-14 rounded-md border border-white/20 bg-black px-1.5 py-1 text-center font-mono text-white outline-none focus:border-accent"
        data-rect-field={key}
        aria-label={name}
      />
    </label>
  )
  return (
    <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-accent/40 bg-accent/[0.08] px-2.5 py-1.5 text-xs" data-rect-editor>
      <span className="font-semibold text-white">{label}</span>
      {field('x', 'X(格)', 1, FREE_COLUMNS - 1)}
      {field('y', 'Y(px)', FREE_ROW_PX, 16000)}
      {field('w', '寬(格/48)', 1, FREE_COLUMNS)}
      {field('h', '高(px)', FREE_ROW_PX, 1600)}
      <button type="button" onClick={onClose} className="ml-auto h-7 w-7 rounded-md text-white/50 hover:bg-white/10" aria-label="關閉尺寸設定">
        ✕
      </button>
    </div>
  )
}

function ModulePanel({ module, info, highlighted, arranging }: { module: MonitorModule; info: NowInfo; highlighted: boolean; arranging: boolean }) {
  const font = (rem: number) => ({ fontSize: `calc(${rem}rem * var(--tile-font, 1))` })
  const frame = (tone: string, children: ReactNode) => (
    <div
      className={`flex h-full w-full flex-col overflow-hidden rounded-xl border p-2.5 ${tone} ${arranging ? 'border-dashed' : ''} ${highlighted ? 'ring-2 ring-accent' : ''}`}
      data-module={module}
    >
      <span className="mb-1 shrink-0 font-bold tracking-widest text-white/45 uppercase" style={font(0.55)}>
        {MODULE_LABELS[module]}
      </span>
      {children}
    </div>
  )

  if (module === '__next') {
    const cue = info.standby
    return frame(
      'border-standby/60 bg-standby/[0.07]',
      cue ? (
        <span className="flex min-h-0 flex-1 flex-col justify-center">
          <span className="font-mono font-bold text-standby tabular" style={font(1.8)}>
            Q{cue.cueNumber}
          </span>
          <span className="line-clamp-2 font-semibold text-white" style={font(1)}>
            {cue.title || '（未命名）'}
          </span>
        </span>
      ) : (
        <span className="text-white/35" style={font(0.85)}>
          未選取
        </span>
      ),
    )
  }

  return frame(
    'border-go/50 bg-go/[0.06]',
    info.instances.length === 0 ? (
      <span className="text-white/35" style={font(0.85)}>
        沒有執行中的 Cue
      </span>
    ) : (
      <ul className="min-h-0 flex-1 space-y-1 overflow-hidden">
        {info.instances.map(({ inst, timing, paused }) => (
          <li key={inst.instanceId} className="relative overflow-hidden rounded-md bg-black/30 px-2 py-1">
            {timing.progress != null && (
              <span
                className={`absolute inset-y-0 left-0 ${timing.phase === 'prewait' ? 'bg-standby/25' : 'bg-go/25'}`}
                style={{ width: `${timing.progress * 100}%` }}
              />
            )}
            <span className="relative flex items-center gap-2" style={font(0.85)}>
              <span className="font-mono font-semibold text-go tabular">Q{inst.cue.cueNumber}</span>
              <span className="text-white/40">{CUE_TYPE_GLYPHS[inst.cue.type]}</span>
              <span className="min-w-0 flex-1 truncate text-white">{inst.cue.title || '（未命名）'}</span>
              {paused && <span className="text-standby">❚❚</span>}
              <span className={`font-mono tabular ${timing.phase === 'prewait' ? 'text-standby' : 'text-go'}`}>
                {timing.remaining != null ? `-${formatTime(timing.remaining)}` : formatTime(timing.elapsed)}
              </span>
            </span>
          </li>
        ))}
      </ul>
    ),
  )
}
