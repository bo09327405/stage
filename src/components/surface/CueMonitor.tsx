import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import { useCueMonitorState, type TileState } from '../../hooks/useCueMonitorState'
import { formatTime } from '../../hooks/useServerNow'
import type { useTheatreEngine } from '../../hooks/useTheatreEngine'
import { CUE_TYPE_GLYPHS, type Cue } from '../../types/cue'
import { MODULE_LABELS, MONITOR_MODULES, type MonitorLayout } from '../../types/surface'
import { CueFreeCanvas, type NowInfo } from './CueFreeCanvas'
import { CueGrid } from './CueGrid'

type Engine = ReturnType<typeof useTheatreEngine>

const ignore = () => {}
/** After the operator scrolls the list by hand, don't auto-scroll it back for this long. */
const MANUAL_SCROLL_HOLD_MS = 4000

interface CueMonitorProps {
  engine: Engine
  cues: Cue[]
  /** Narrow layout for the Set Cue sidebar. */
  compact?: boolean
  open: boolean
  onToggle: () => void
  layout: MonitorLayout
  /** Persist layout changes; absent when there is no surface to store them on. */
  onLayoutChange?: (layout: MonitorLayout) => void
  /** Per-device height memory key, and the default height in px. */
  heightKey: string
  defaultHeight: number
  /** Fill the parent's height (side drawer) instead of using the draggable height. */
  fill?: boolean
  /** Extra buttons for the header (dock / undock, close). */
  headerExtra?: ReactNode
}


const readHeight = (key: string, fallback: number) => {
  try {
    const n = Number(localStorage.getItem(key))
    return n >= 120 && n <= 2000 ? n : fallback
  } catch {
    return fallback
  }
}

/**
 * Cue Flow Monitor: what's running (green, with progress and time left), what's next (yellow),
 * and the whole show — as a scrolling list or a customisable button grid. Tapping a cue sets it
 * on standby (or GOes it, if the grid is set up that way). It reads and writes the page's single
 * engine, so the cue list, the surface buttons and this monitor always agree.
 */
export function CueMonitor({
  engine,
  cues,
  compact = false,
  open,
  onToggle,
  layout,
  onLayoutChange,
  heightKey,
  defaultHeight,
  fill = false,
  headerExtra,
}: CueMonitorProps) {
  const { instances, newest, standby, tileState, timingOf, isPaused } = useCueMonitorState(engine)
  const [arranging, setArranging] = useState(false)
  const [height, setHeight] = useState(() => readHeight(heightKey, defaultHeight))

  /* ---------- scrolling: finger/wheel natively, mouse by dragging; keep standby in view ---------- */
  const listRef = useRef<HTMLDivElement>(null)
  const lastManual = useRef(0)
  const drag = useRef<{ y: number; top: number; moved: boolean } | null>(null)
  // Scroll events caused by our own auto-scroll must not count as the operator scrolling.
  const autoScrollUntil = useRef(0)
  const standbyId = standby?.id
  useEffect(() => {
    if (!open || arranging || !standbyId || Date.now() - lastManual.current < MANUAL_SCROLL_HOLD_MS) return
    autoScrollUntil.current = Date.now() + 1000
    listRef.current
      ?.querySelector<HTMLElement>(`[data-cue="${standbyId}"]`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [open, arranging, standbyId])

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (arranging || e.pointerType !== 'mouse' || !listRef.current) return
    drag.current = { y: e.clientY, top: listRef.current.scrollTop, moved: false }
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || !listRef.current) return
    const dy = e.clientY - d.y
    if (Math.abs(dy) > 4) d.moved = true
    if (d.moved) {
      listRef.current.scrollTop = d.top - dy
      lastManual.current = Date.now()
    }
  }
  const endDrag = () => {
    // Leave `moved` readable for the click that follows the pointer-up, then clear.
    setTimeout(() => (drag.current = null), 0)
  }

  const tap = (cue: Cue, action: MonitorLayout['tapAction'] = 'standby') => {
    if (drag.current?.moved) return // the pointer-up of a drag-scroll isn't a tap
    if (action === 'go') engine.go(cue).catch(ignore)
    else engine.standby(cue).catch(ignore)
  }

  /* ---------- height: drag the bottom edge ---------- */
  const resizing = useRef<{ y: number; h: number } | null>(null)
  const onResizeDown = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    resizing.current = { y: e.clientY, h: height }
  }
  const onResizeMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!resizing.current) return
    setHeight(Math.min(2000, Math.max(120, resizing.current.h + e.clientY - resizing.current.y)))
  }
  const onResizeUp = () => {
    resizing.current = null
    try {
      localStorage.setItem(heightKey, String(height))
    } catch {
      // Not remembered; harmless.
    }
  }

  const newestTiming = newest ? timingOf(newest) : null
  const grid = layout.mode === 'grid'
  const free = layout.mode === 'free'
  const nowInfo: NowInfo = {
    instances: instances.map((inst) => ({ inst, timing: timingOf(inst), paused: isPaused(inst) })),
    standby,
  }
  const setLayout = (changes: Partial<MonitorLayout>) => onLayoutChange?.({ ...layout, ...changes })

  return (
    <section className={`flex min-h-0 flex-col bg-black/40 ${fill ? 'h-full' : 'border-b border-line'}`} aria-label="Cue 走向監聽">
      {/* Summary strip */}
      <div className={`flex items-center gap-2 ${compact ? 'px-3 py-2' : 'px-4 py-2.5'}`}>
        <button type="button" onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-3 text-left" aria-expanded={open}>
          {!compact && <span className="shrink-0 text-[10px] font-semibold tracking-widest text-white/40 uppercase">Cue Monitor</span>}
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <span className={`h-2 w-2 shrink-0 rounded-full ${newest ? 'bg-go shadow-[0_0_6px_#30d158]' : 'bg-white/20'}`} />
            <span className="truncate text-sm">
              {newest ? (
                <>
                  <span className="font-mono text-go">Q{newest.cue.cueNumber}</span> {newest.cue.title}
                </>
              ) : (
                <span className="text-white/35">沒有執行中的 Cue</span>
              )}
            </span>
            {newestTiming && (
              <span className="shrink-0 font-mono text-xs text-go tabular">
                {newestTiming.remaining != null ? `-${formatTime(newestTiming.remaining)}` : formatTime(newestTiming.elapsed)}
              </span>
            )}
          </span>
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <span className="h-2 w-2 shrink-0 rounded-full bg-standby" />
            <span className="truncate text-sm">
              {standby ? (
                <>
                  <span className="font-mono text-standby">Q{standby.cueNumber}</span> {standby.title}
                </>
              ) : (
                <span className="text-white/35">未選取</span>
              )}
            </span>
          </span>
        </button>
        {open && (
          <div className="flex shrink-0 items-center gap-1">
            <div className="flex rounded-lg bg-white/[0.06] p-0.5" role="group" aria-label="監聽視窗樣式">
              {(['list', 'grid', 'free'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => {
                    setLayout({ mode: m })
                    if (m === 'list') setArranging(false)
                  }}
                  disabled={!onLayoutChange}
                  className={`min-h-8 rounded-md px-2 text-xs ${layout.mode === m ? 'bg-white/15 text-white' : 'text-white/50'}`}
                  title={m === 'list' ? '列表' : m === 'grid' ? '按鈕格' : '自由畫布'}
                  aria-label={m === 'list' ? '列表' : m === 'grid' ? '按鈕格' : '自由畫布'}
                >
                  {m === 'list' ? '☰' : m === 'grid' ? '▦' : '⬚'}
                </button>
              ))}
            </div>
            {(grid || free) && onLayoutChange && (
              <button
                type="button"
                onClick={() => setArranging(!arranging)}
                className={`min-h-9 rounded-lg px-2.5 text-xs font-semibold ${arranging ? 'bg-accent text-white' : 'bg-white/[0.06] text-white/70'}`}
              >
                {arranging ? '✓ 完成' : '✎ 編排'}
              </button>
            )}
          </div>
        )}
        {headerExtra}
        {!fill && (
          <button type="button" onClick={onToggle} className="shrink-0 px-1 text-xs text-white/40" aria-label={open ? '收合' : '展開'}>
            {open ? '▴' : '▾'}
          </button>
        )}
      </div>
      {newestTiming?.progress != null && (
        <div className="h-0.5 bg-white/[0.06]">
          <div className="h-full bg-go transition-[width] duration-100" style={{ width: `${newestTiming.progress * 100}%` }} />
        </div>
      )}

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={fill ? false : { height: 0 }}
            animate={{ height: 'auto' }}
            exit={{ height: 0 }}
            className={`relative overflow-hidden ${fill ? 'flex min-h-0 flex-1 flex-col' : ''}`}
          >
            {(grid || free) && arranging && <GridSettings layout={layout} setLayout={setLayout} />}
            <div
              ref={listRef}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerLeave={endDrag}
              onScroll={() => {
                if (!drag.current && Date.now() > autoScrollUntil.current) lastManual.current = Date.now()
              }}
              style={fill ? undefined : { height }}
              className={`overflow-y-auto overscroll-contain px-2 pb-3 select-none ${fill ? 'min-h-0 flex-1' : ''} ${arranging ? '' : 'touch-pan-y'}`}
            >
              {cues.length === 0 ? (
                <p className="p-4 text-center text-xs text-white/30">Cue 清單是空的</p>
              ) : free ? (
                <CueFreeCanvas
                  cues={cues}
                  layout={layout}
                  arranging={arranging}
                  tileState={tileState}
                  nowInfo={nowInfo}
                  onTap={(cue) => tap(cue, layout.tapAction)}
                  onLayoutChange={setLayout}
                />
              ) : grid ? (
                <CueGrid
                  cues={cues}
                  layout={layout}
                  arranging={arranging}
                  tileState={tileState}
                  onTap={(cue) => tap(cue, layout.tapAction)}
                  onLayoutChange={setLayout}
                />
              ) : (
                <ul className="space-y-1 pt-1">
                  {cues.map((cue) => (
                    <ListRow key={cue.id} cue={cue} state={tileState(cue)} onTap={() => tap(cue)} />
                  ))}
                </ul>
              )}
            </div>
            {/* Drag to resize the monitor */}
            {!fill && (
              <div
                onPointerDown={onResizeDown}
                onPointerMove={onResizeMove}
                onPointerUp={onResizeUp}
                onPointerCancel={onResizeUp}
                className="group flex h-3 cursor-row-resize touch-none items-center justify-center"
                role="separator"
                aria-orientation="horizontal"
                title="拖曳調整監聽視窗高度"
              >
                <span className="h-1 w-12 rounded-full bg-white/15 transition group-hover:bg-accent" />
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  )
}

function ListRow({ cue, state, onTap }: { cue: Cue; state: TileState; onTap: () => void }) {
  const { inst, timing, isStandby, paused } = state
  return (
    <li data-cue={cue.id}>
      <button
        type="button"
        onClick={onTap}
        className={`relative flex min-h-11 w-full items-center gap-2.5 overflow-hidden rounded-lg border px-2.5 text-left transition pointer-coarse:min-h-12 ${
          inst ? 'border-go/50 bg-go/[0.08]' : isStandby ? 'border-standby/60 bg-standby/[0.08]' : 'border-transparent bg-white/[0.03] hover:bg-white/[0.07]'
        }`}
        title="點選設為 Standby"
      >
        {timing?.progress != null && (
          <span
            className={`absolute inset-y-0 left-0 ${timing.phase === 'prewait' ? 'bg-standby/20' : 'bg-go/20'}`}
            style={{ width: `${timing.progress * 100}%` }}
          />
        )}
        <span className={`absolute inset-y-0 left-0 w-1 ${inst ? 'bg-go' : isStandby ? 'bg-standby' : 'bg-transparent'}`} />
        <span className="relative w-9 shrink-0 font-mono text-sm font-semibold text-white/80 tabular">{cue.cueNumber}</span>
        <span className="relative w-4 shrink-0 text-center text-xs text-white/45">{CUE_TYPE_GLYPHS[cue.type]}</span>
        <span className="relative min-w-0 flex-1 truncate text-sm">{cue.title || '（未命名）'}</span>
        {isStandby && !inst && (
          <span className="relative shrink-0 rounded bg-standby px-1.5 py-px text-[9px] font-bold tracking-wider text-black">NEXT</span>
        )}
        {paused && <span className="relative shrink-0 rounded bg-standby px-1.5 py-px text-[9px] font-bold text-black">❚❚</span>}
        {timing && (
          <span className={`relative shrink-0 font-mono text-xs tabular ${timing.phase === 'prewait' ? 'text-standby' : 'text-go'}`}>
            {timing.remaining != null ? `-${formatTime(timing.remaining)}` : formatTime(timing.elapsed)}
          </span>
        )}
      </button>
    </li>
  )
}

/** Grid size, tile height, text size and tap behaviour (shown while arranging). */
function GridSettings({ layout, setLayout }: { layout: MonitorLayout; setLayout: (c: Partial<MonitorLayout>) => void }) {
  const step = (key: 'columns', delta: number, min: number, max: number) =>
    setLayout({ [key]: Math.min(max, Math.max(min, layout[key] + delta)) })
  const btn = 'flex h-9 w-9 items-center justify-center rounded-lg bg-white/[0.07] text-white/80 active:bg-white/20'
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-y border-accent/30 bg-accent/[0.06] px-3 py-2 text-xs">
      <span className="flex items-center gap-1.5" title={layout.mode === 'free' ? '新 Cue 自動排入時的欄數' : undefined}>
        {layout.mode === 'free' ? '預設欄數' : '欄數'}
        <button type="button" className={btn} onClick={() => step('columns', -1, 1, 10)} aria-label="減少欄數">−</button>
        <span className="w-5 text-center font-mono font-semibold tabular">{layout.columns}</span>
        <button type="button" className={btn} onClick={() => step('columns', 1, 1, 10)} aria-label="增加欄數">＋</button>
      </span>
      <label className="flex items-center gap-2">
        {layout.mode === 'free' ? '預設高' : '格高'}
        <input
          type="range"
          min={48}
          max={240}
          step={4}
          value={layout.tileHeight}
          onChange={(e) => setLayout({ tileHeight: Number(e.target.value) })}
          className="w-24 accent-[#0a84ff]"
          aria-label="格子高度"
        />
        <span className="w-10 font-mono tabular">{layout.tileHeight}px</span>
      </label>
      <label className="flex items-center gap-2">
        字級
        <input
          type="range"
          min={0.7}
          max={2.2}
          step={0.1}
          value={layout.fontScale}
          onChange={(e) => setLayout({ fontScale: Number(e.target.value) })}
          className="w-24 accent-[#0a84ff]"
          aria-label="字體大小"
        />
        <span className="w-8 font-mono tabular">{layout.fontScale.toFixed(1)}×</span>
      </label>
      <span className="flex items-center gap-1 rounded-lg bg-white/[0.06] p-0.5">
        <span className="px-1.5 text-white/50">點擊</span>
        {(['standby', 'go'] as const).map((a) => (
          <button
            key={a}
            type="button"
            onClick={() => setLayout({ tapAction: a })}
            className={`min-h-8 rounded-md px-2 ${layout.tapAction === a ? (a === 'go' ? 'bg-go text-black' : 'bg-standby text-black') : 'text-white/55'}`}
          >
            {a === 'standby' ? '設為 Standby' : '直接 GO'}
          </button>
        ))}
      </span>
      {layout.mode === 'free' && (
        <span className="flex items-center gap-1 rounded-lg bg-white/[0.06] p-0.5">
          <span className="px-1.5 text-white/50">模組</span>
          {MONITOR_MODULES.map((m) => {
            const on = layout.modules.includes(m)
            return (
              <button
                key={m}
                type="button"
                aria-pressed={on}
                onClick={() => {
                  const free = { ...layout.free }
                  delete free[m]
                  setLayout({ modules: on ? layout.modules.filter((x) => x !== m) : [...layout.modules, m], free })
                }}
                className={`min-h-8 rounded-md px-2 ${on ? 'bg-white/15 text-white' : 'text-white/55'}`}
              >
                {on ? '✓ ' : '＋ '}
                {MODULE_LABELS[m]}
              </button>
            )
          })}
        </span>
      )}
      <button
        type="button"
        onClick={() => setLayout(layout.mode === 'free' ? { free: {} } : { order: [], spans: {} })}
        className="ml-auto min-h-8 rounded-lg px-2.5 text-white/45 hover:bg-white/10 hover:text-white"
      >
        重設排列
      </button>
    </div>
  )
}
