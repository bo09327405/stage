import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import type { useTheatreEngine } from '../../hooks/useTheatreEngine'
import type { ScriptSource } from '../../services/script'
import type { Cue } from '../../types/cue'
import { NotesViewer } from './NotesViewer'
import { noteSkin, useStageDark } from './stageTheme'
import { useNotePrefs } from './useNotePrefs'

/** Default share of the surface row, and the limits of the drawer's width. */
const DEFAULT_FRACTION = 0.26
const MIN_PX = 240
const MAX_FRACTION = 0.7
/** Width of the folded tab, and how narrow a drag must go to fold the drawer. */
const TAB_W = 36
const COLLAPSE_AT = 150
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

const readPref = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
const writePref = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Not remembered; harmless.
  }
}

/**
 * The script / notes drawer of the control surface. Reading mode follows the show (cue points light
 * up, the standby cue's line scrolls into view); edit mode is a plain text area saved as you type.
 *
 * Drag its left edge to resize (the width is remembered as a share of the surface); drag it
 * narrow, or press ▸, and it slides away to a thin tab at the edge — click or pull the tab to bring
 * it back. In a dark stage (DIM / blackout) it dims itself so it doesn't glare.
 */
export function NotesPanel({
  engine,
  cues,
  text,
  onSave,
  source,
  notionUrl,
  onSaveSource,
  prefKey,
  overlay,
  collapsed,
  onCollapsedChange,
  onHide,
}: {
  engine: ReturnType<typeof useTheatreEngine>
  cues: Cue[]
  text: string
  onSave: (text: string) => Promise<void>
  source: ScriptSource
  notionUrl: string
  onSaveSource: (source: ScriptSource, notionUrl?: string) => Promise<void>
  prefKey: string
  /** Narrow host (Set Cue sidebar): float over the surface instead of taking a column. */
  overlay: boolean
  /** Folded to a tab at the edge. */
  collapsed: boolean
  onCollapsedChange: (collapsed: boolean) => void
  onHide: () => void
}) {
  // View settings (A− / A+, follow, look) and the dark-stage look, shared with the viewer inside.
  const prefs = useNotePrefs(prefKey)
  const dark = useStageDark(engine, prefs.theme)
  const skin = noteSkin(dark)

  /* ---------- width: a share of the surface row, dragged from the left edge ---------- */
  const shell = useRef<HTMLElement>(null)
  const [rowWidth, setRowWidth] = useState(0)
  const [fraction, setFraction] = useState(() => {
    const v = Number(readPref(`${prefKey}.width`))
    return v >= 0.1 && v <= 0.9 ? v : DEFAULT_FRACTION
  })
  useEffect(() => {
    const row = shell.current?.parentElement
    if (!row) return
    const observer = new ResizeObserver(([entry]) => setRowWidth(entry.contentRect.width))
    observer.observe(row)
    return () => observer.disconnect()
  }, [])
  const maxPx = rowWidth ? Math.max(MIN_PX, rowWidth * MAX_FRACTION) : 640
  const openWidth = rowWidth ? clamp(fraction * rowWidth, MIN_PX, maxPx) : 340
  const saveWidth = (px: number) => {
    if (!rowWidth) return
    const f = clamp(px, MIN_PX, maxPx) / rowWidth
    setFraction(f)
    writePref(`${prefKey}.width`, f.toFixed(4))
  }

  // Live width while the edge (or the folded tab) is being dragged.
  const [drag, setDrag] = useState<{ width: number; collapsing: boolean } | null>(null)
  const gesture = useRef<{ x: number; start: number; moved: boolean; width: number } | null>(null)
  const onEdgeDown = (e: PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    const start = collapsed ? TAB_W : openWidth
    gesture.current = { x: e.clientX, start, moved: false, width: start }
  }
  const onEdgeMove = (e: PointerEvent<HTMLElement>) => {
    const g = gesture.current
    if (!g) return
    const dx = g.x - e.clientX
    if (Math.abs(dx) > 3) g.moved = true
    if (!g.moved) return
    g.width = clamp(g.start + dx, TAB_W, maxPx)
    setDrag({ width: g.width, collapsing: g.width < COLLAPSE_AT })
  }
  const onEdgeUp = () => {
    const g = gesture.current
    gesture.current = null
    setDrag(null)
    if (!g) return
    if (!g.moved) {
      // A click on the folded tab opens it.
      if (collapsed) onCollapsedChange(false)
      return
    }
    if (g.width < COLLAPSE_AT) return onCollapsedChange(true)
    saveWidth(g.width)
    if (collapsed) onCollapsedChange(false)
  }
  const onEdgeKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      if (collapsed) return onCollapsedChange(false)
      saveWidth(openWidth + (e.key === 'ArrowLeft' ? 24 : -24))
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onCollapsedChange(!collapsed)
    } else if (e.key === 'Home') {
      saveWidth(DEFAULT_FRACTION * rowWidth)
    }
  }
  const edgeHandlers = { onPointerDown: onEdgeDown, onPointerMove: onEdgeMove, onPointerUp: onEdgeUp, onPointerCancel: onEdgeUp }

  // The drawer's visible width; its content keeps at least MIN_PX so it slides out rather than squashes.
  const shownWidth = drag ? drag.width : collapsed ? TAB_W : openWidth
  const innerWidth = Math.max(MIN_PX, drag ? drag.width : openWidth)

  const btn = 'flex h-8 min-w-8 shrink-0 items-center justify-center rounded-md px-1.5 text-xs whitespace-nowrap text-white/60 hover:bg-white/10 hover:text-white'

  return (
    <motion.aside
      ref={shell}
      initial={{ width: 0, opacity: 0 }}
      animate={{ width: shownWidth, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={drag ? { duration: 0 } : { type: 'spring', stiffness: 380, damping: 40 }}
      // Narrow hosts float the drawer over the surface; wide ones give it a column of its own.
      className={`shrink-0 overflow-hidden border-l transition-colors duration-700 ${skin.shell} ${
        overlay ? 'absolute inset-y-0 right-0 z-30 shadow-2xl' : 'relative'
      }`}
      aria-label="劇本筆記"
      data-notes-panel
      data-collapsed={collapsed ? '1' : '0'}
      data-stage={dark ? 'dark' : 'normal'}
    >
      {/* Resize / fold edge */}
      <div
        {...edgeHandlers}
        onKeyDown={onEdgeKey}
        onDoubleClick={() => saveWidth(DEFAULT_FRACTION * rowWidth)}
        role="separator"
        aria-orientation="vertical"
        aria-label="拖曳調整筆記寬度（往右拖到底收合；雙擊還原預設寬度）"
        aria-valuenow={Math.round(shownWidth)}
        tabIndex={collapsed ? -1 : 0}
        title="拖曳調整寬度 · 往右拖到底收合 · 雙擊還原"
        className={`group absolute inset-y-0 left-0 z-20 flex w-3 cursor-col-resize touch-none items-center justify-center outline-none ${collapsed && !drag ? 'hidden' : ''}`}
        data-notes-resize
      >
        <span className={`absolute inset-y-0 left-0 w-px transition-colors ${drag ? (drag.collapsing ? 'bg-standby' : 'bg-accent') : 'bg-white/10 group-hover:bg-accent group-focus-visible:bg-accent'}`} />
        <span
          className={`relative flex h-12 w-1.5 flex-col items-center justify-center gap-1 rounded-full transition-colors ${
            drag ? (drag.collapsing ? 'bg-standby' : 'bg-accent') : 'bg-white/20 group-hover:bg-accent group-focus-visible:bg-accent'
          }`}
        >
          <span className="h-0.5 w-0.5 rounded-full bg-black/60" />
          <span className="h-0.5 w-0.5 rounded-full bg-black/60" />
          <span className="h-0.5 w-0.5 rounded-full bg-black/60" />
        </span>
      </div>
      {drag?.collapsing && (
        <span className="pointer-events-none absolute top-3 left-4 z-30 rounded-full bg-standby px-2 py-0.5 text-[10px] font-bold whitespace-nowrap text-black">放開即收合</span>
      )}

      <div className="flex h-full flex-col" style={{ width: innerWidth }} inert={collapsed && !drag} data-notes-inner>
        <NotesViewer
          engine={engine}
          cues={cues}
          note={{ text, source, notionUrl, saveText: onSave, saveSource: onSaveSource }}
          prefs={prefs}
          variant="panel"
          title="📝 筆記"
          actions={
            <>
              <button type="button" onClick={() => onCollapsedChange(true)} className={btn} title="收合到右側邊緣" aria-label="收合筆記">
                ▸
              </button>
              <button type="button" onClick={onHide} className={btn} title="隱藏筆記區" aria-label="隱藏筆記">
                ✕
              </button>
            </>
          }
        />
      </div>

      {/* Folded: a tab at the edge — click it, or pull it out to the width you want. */}
      <AnimatePresence>
        {collapsed && (
          // Stays mounted while it is being pulled (it holds the pointer), just invisible.
          <motion.button
            type="button"
            initial={{ opacity: 0 }}
            animate={{ opacity: drag ? 0 : 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            {...edgeHandlers}
            onKeyDown={onEdgeKey}
            className={`absolute inset-0 z-20 flex cursor-col-resize touch-none flex-col items-center gap-3 py-3 text-white/60 hover:bg-white/10 hover:text-white ${skin.shell}`}
            aria-label="展開劇本筆記（點擊或往左拉出）"
            title="點擊展開，或往左拉出"
            data-notes-tab
          >
            <span className="text-sm">◂</span>
            <span>📝</span>
            <span className="text-[10px] font-semibold tracking-widest [writing-mode:vertical-rl]">劇本 / 筆記</span>
          </motion.button>
        )}
      </AnimatePresence>
    </motion.aside>
  )
}
