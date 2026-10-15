import { motion } from 'motion/react'
import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { useTheatreEngine } from '../../../hooks/useTheatreEngine'
import type { Cue } from '../../../types/cue'
import { TRIG_LABELS, cueAfter, executorNumbers, formatCueNumber, orderedCues, sourceLabel, type Sequence } from '../../../types/sequence'
import type { Surface } from '../../../types/surface'
import { SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN, clampWidth, type ExecSidebarPrefs } from '../../../utils/execSidebar'
import { ExecutorStrip } from './ExecutorView'
import { GridSizeMenu } from '../GridSize'
import { EXEC_GRID_PRESETS, EXEC_GRID_SLIDERS, execGridColumns, useExecGrid } from '../../../utils/execGrid'
import type { useExecutors } from './useExecutors'

type Engine = ReturnType<typeof useTheatreEngine>
type Exec = ReturnType<typeof useExecutors>

/**
 * The executors docked beside the control panel's grid: strips that flow into as many columns as
 * the width allows, and the selected executor's sequence. Programming (Store) stays on the
 * Executor page.
 */
export function ExecutorSidebar({
  engine,
  exec,
  surface,
  cues,
  prefs,
  onPrefs,
  onOpenPage,
}: {
  engine: Engine
  exec: Exec
  surface: Surface
  cues: Cue[]
  prefs: ExecSidebarPrefs
  onPrefs: (change: Partial<ExecSidebarPrefs>) => void
  onOpenPage: () => void
}) {
  const [selected, setSelected] = useState(() => Number(Object.keys(surface.executors)[0]) || 1)
  const [message, setMessage] = useState<string | null>(null)
  const [grid, setGrid] = useExecGrid()
  const seqOf = (no: number) => {
    const id = surface.executors[String(no)]?.sequenceId
    return (id && surface.sequences[id]) || null
  }
  // Loaded executors first; the empty ones follow (still usable once a sequence is loaded).
  const numbers = [...executorNumbers].sort((a, b) => Number(!seqOf(a)) - Number(!seqOf(b)) || a - b)

  return (
    <motion.aside
      initial={{ opacity: 0, x: prefs.side === 'left' ? -16 : 16 }}
      animate={{ opacity: 1, x: 0 }}
      className="flex min-h-0 shrink-0 flex-col bg-panel/60"
      // Rendered after the grid; docked left, flex order puts it (and its splitter) first.
      style={{ width: prefs.width, maxWidth: '85vw', order: prefs.side === 'left' ? -2 : 0 }}
      aria-label="Executor 側邊欄"
      data-exec-sidebar={prefs.side}
    >
      <header className="flex items-center gap-1 border-b border-line px-3 py-2">
        <span className="min-w-0 truncate text-[11px] font-bold tracking-[0.2em] text-white/55">🎚 EXECUTOR</span>
        <span className="ml-auto" />
        <GridSizeMenu
          value={grid}
          onChange={setGrid}
          presets={EXEC_GRID_PRESETS}
          sliders={EXEC_GRID_SLIDERS}
          note="每排數量「自動」時依欄寬排列；推桿、GO、PAUSE 依大小等比例縮放。與 Executor 頁共用此設定。"
          compact={prefs.width < 380}
          id="exec"
        />
        <button
          type="button"
          onClick={() => onPrefs({ side: prefs.side === 'left' ? 'right' : 'left' })}
          className="flex h-8 shrink-0 items-center rounded-md px-2 text-xs whitespace-nowrap text-white/60 hover:bg-white/10 hover:text-white"
          title={prefs.side === 'left' ? '改停靠右側' : '改停靠左側'}
          data-sidebar-side
        >
          {prefs.side === 'left' ? '⇥ 靠右' : '⇤ 靠左'}
        </button>
        <button type="button" onClick={onOpenPage} className="flex h-8 shrink-0 items-center rounded-md px-2 text-xs text-white/60 hover:bg-white/10 hover:text-white" title="開啟 Executor 頁（Programmer、Store、完整序列表）" data-sidebar-page>
          ⤢
        </button>
        <button type="button" onClick={() => onPrefs({ open: false })} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-white/45 hover:bg-white/10 hover:text-white" aria-label="收合 Executor 側邊欄" data-sidebar-close>
          ✕
        </button>
      </header>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {message && (
          <p className="rounded-lg bg-panic/10 px-3 py-2 text-xs text-panic" role="status">
            {message}
          </p>
        )}
        <div
          className={`grid ${grid.cols ? 'overflow-x-auto' : ''}`}
          style={{ gridTemplateColumns: execGridColumns(grid), gap: grid.gap, ['--exec-col' as string]: `${grid.col}px`, ['--exec-gap' as string]: `${grid.gap}px`, ['--exec-scale' as string]: grid.scale }}
          data-sidebar-strips
        >
          {numbers.map((no) => (
            <ExecutorStrip
              key={no}
              no={no}
              seq={seqOf(no)}
              engine={engine}
              exec={exec}
              cues={cues}
              selected={selected === no}
              storeArmed={false}
              onPress={() => setSelected(no)}
              onError={(t) => {
                setMessage(t)
                window.setTimeout(() => setMessage(null), 4000)
              }}
              fill
              scale={grid.scale}
            />
          ))}
        </div>
        <SequenceList no={selected} seq={seqOf(selected)} engine={engine} exec={exec} cues={cues} onError={setMessage} />
      </div>
    </motion.aside>
  )
}

/** The selected executor's cues: current / next, trig, length; tap GOTO to fire one. */
function SequenceList({ no, seq, engine, exec, cues, onError }: { no: number; seq: Sequence | null; engine: Engine; exec: Exec; cues: Cue[]; onError: (t: string) => void }) {
  const run = engine.showState.executors[String(no)]
  const currentId = seq && run?.sequenceId === seq.id ? run.cueId : null
  const nextId = seq ? cueAfter(seq, currentId)?.id : null
  const list = orderedCues(seq)
  return (
    <section className="overflow-hidden rounded-xl border border-line bg-black/20" data-sidebar-sequence={no}>
      <div className="flex items-baseline gap-2 border-b border-line px-3 py-2">
        <span className="font-mono text-[11px] font-bold text-white/45">EXEC {no}</span>
        <span className="min-w-0 truncate text-sm font-semibold">{seq ? seq.name : <span className="text-white/35">沒有載入序列</span>}</span>
        {seq && <span className="ml-auto shrink-0 font-mono text-[10px] text-white/35">{list.length} Cue</span>}
      </div>
      {seq && list.length > 0 && (
        <ul className="divide-y divide-line/60">
          {list.map((c) => {
            const current = c.id === currentId
            const next = c.id === nextId
            return (
              <li key={c.id} className={`flex items-center gap-2 px-2.5 py-1.5 text-xs ${current ? 'bg-go/[0.12]' : ''}`} data-sidebar-cue={c.id} data-state={current ? 'current' : next ? 'next' : undefined}>
                <span className="w-3 shrink-0 text-center">{current ? <span className="text-go">▶</span> : next ? <span className="text-white/40">▸</span> : ''}</span>
                <span className={`w-9 shrink-0 font-mono font-bold ${current ? 'text-go' : 'text-white/60'}`}>{formatCueNumber(c.number)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-white/85">{c.name || sourceLabel(c.source, cues)}</span>
                  <span className="block truncate text-[10px] text-white/35">
                    {TRIG_LABELS[c.trig]}
                    {c.trig === 'time' ? ` ${c.trigTime}s` : ''} · Fade {c.fadeIn}s{c.duration ? ` · ${Math.round(c.duration * 10) / 10}s` : ''}
                  </span>
                </span>
                <button type="button" onClick={() => exec.gotoCue(no, c).catch((err: Error) => onError(err.message))} className="h-7 shrink-0 rounded-md px-2 text-[10px] font-bold text-go hover:bg-go/15" title="GOTO：直接觸發" data-sidebar-goto={c.id}>
                  GOTO
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

/** The bar between the sidebar and the grid: drag (or arrow keys) to resize, double-click to reset. */
export function SidebarSplitter({ prefs, onPrefs }: { prefs: ExecSidebarPrefs; onPrefs: (change: Partial<ExecSidebarPrefs>) => void }) {
  const drag = useRef<{ x: number; width: number } | null>(null)
  const [active, setActive] = useState(false)
  const sign = prefs.side === 'left' ? 1 : -1
  const move = (e: ReactPointerEvent) => {
    if (!drag.current) return
    onPrefs({ width: clampWidth(drag.current.width + sign * (e.clientX - drag.current.x)) })
  }
  const end = () => {
    drag.current = null
    setActive(false)
  }
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="調整 Executor 側邊欄寬度"
      aria-valuemin={SIDEBAR_MIN}
      aria-valuemax={SIDEBAR_MAX}
      aria-valuenow={prefs.width}
      tabIndex={0}
      onPointerDown={(e) => {
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        drag.current = { x: e.clientX, width: prefs.width }
        setActive(true)
      }}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => onPrefs({ width: SIDEBAR_DEFAULT })}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 50 : 10
        if (e.key === 'ArrowLeft') onPrefs({ width: prefs.width - sign * step })
        else if (e.key === 'ArrowRight') onPrefs({ width: prefs.width + sign * step })
        else return
        e.preventDefault()
      }}
      className={`group relative z-10 flex w-2 shrink-0 cursor-col-resize touch-none items-center justify-center border-line outline-none focus-visible:bg-accent/40 ${prefs.side === 'left' ? 'border-r' : 'border-l'} ${active ? 'bg-accent/50' : 'hover:bg-accent/30'}`}
      style={{ order: prefs.side === 'left' ? -1 : 0 }}
      title="拖曳調整寬度（雙擊恢復預設）"
      data-sidebar-splitter
    >
      <span className={`h-10 w-0.5 rounded-full ${active ? 'bg-white' : 'bg-white/25 group-hover:bg-white/60'}`} />
      {active && <span className="pointer-events-none absolute top-2 left-1/2 -translate-x-1/2 rounded bg-black/80 px-1.5 py-0.5 font-mono text-[10px] whitespace-nowrap text-white">{prefs.width}px</span>}
    </div>
  )
}
