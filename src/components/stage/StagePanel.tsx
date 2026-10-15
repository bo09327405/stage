import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import type { useTheatreEngine } from '../../hooks/useTheatreEngine'
import type { Cue } from '../../types/cue'
import type { ShowRef } from '../../types/project'
import { StageViewer, type StageFrame } from './StageViewer'

/** Default share of the host row, and the limits of the drawer's width (same feel as the Notes drawer). */
const DEFAULT_FRACTION = 0.28
const MIN_PX = 260
const MAX_FRACTION = 0.7
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
 * "Stage" drawer: a live simulation of what the audience sees — phones (9:16) or the projection
 * screen (16:9) — and hears: with sound on (🔊, the default) cue audio, video sound and hits play
 * through this computer in step with the picture, using the audience devices' audio engine.
 * It doesn't count as an audience device.
 *
 * Works like the Notes drawer: drag the left edge to resize, drag it narrow (or ▸) to fold it to a
 * tab at the edge, click or pull the tab to bring it back.
 */
export function StagePanel({
  engine,
  show,
  cues,
  prefKey,
  overlay = false,
  collapsed,
  onCollapsedChange,
  onHide,
}: {
  engine: ReturnType<typeof useTheatreEngine>
  show: ShowRef
  cues: Cue[]
  prefKey: string
  /** Narrow host: float over the content instead of taking a column. */
  overlay?: boolean
  collapsed: boolean
  onCollapsedChange: (collapsed: boolean) => void
  onHide: () => void
}) {
  const [frame, setFrame] = useState<StageFrame>(() => (readPref(`${prefKey}.frame`) === 'screen' ? 'screen' : 'phone'))
  useEffect(() => writePref(`${prefKey}.frame`, frame), [prefKey, frame])

  /* ---------- width / fold (as in NotesPanel) ---------- */
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
  const shownWidth = drag ? drag.width : collapsed ? TAB_W : openWidth
  const innerWidth = Math.max(MIN_PX, drag ? drag.width : openWidth)

  const btn = 'flex h-8 min-w-8 shrink-0 items-center justify-center rounded-md px-1.5 text-xs whitespace-nowrap text-white/60 hover:bg-white/10 hover:text-white'
  const playback = engine.playbackState

  return (
    <motion.aside
      ref={shell}
      initial={{ width: 0, opacity: 0 }}
      animate={{ width: shownWidth, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={drag ? { duration: 0 } : { type: 'spring', stiffness: 380, damping: 40 }}
      className={`shrink-0 overflow-hidden border-l border-line bg-[#0b0b0b] ${overlay ? 'absolute inset-y-0 right-0 z-30 shadow-2xl' : 'relative'}`}
      aria-label="Stage 模擬觀眾畫面"
      data-stage-panel
      data-collapsed={collapsed ? '1' : '0'}
    >
      <div
        {...edgeHandlers}
        onKeyDown={onEdgeKey}
        onDoubleClick={() => saveWidth(DEFAULT_FRACTION * rowWidth)}
        role="separator"
        aria-orientation="vertical"
        aria-label="拖曳調整 Stage 寬度（往右拖到底收合；雙擊還原預設寬度）"
        aria-valuenow={Math.round(shownWidth)}
        tabIndex={collapsed ? -1 : 0}
        title="拖曳調整寬度 · 往右拖到底收合 · 雙擊還原"
        className={`group absolute inset-y-0 left-0 z-20 flex w-3 cursor-col-resize touch-none items-center justify-center outline-none ${collapsed && !drag ? 'hidden' : ''}`}
        data-stage-resize
      >
        <span className={`absolute inset-y-0 left-0 w-px transition-colors ${drag ? (drag.collapsing ? 'bg-standby' : 'bg-accent') : 'bg-white/10 group-hover:bg-accent group-focus-visible:bg-accent'}`} />
        <span className={`relative h-12 w-1.5 rounded-full transition-colors ${drag ? (drag.collapsing ? 'bg-standby' : 'bg-accent') : 'bg-white/20 group-hover:bg-accent group-focus-visible:bg-accent'}`} />
      </div>
      {drag?.collapsing && <span className="pointer-events-none absolute top-3 left-4 z-30 rounded-full bg-standby px-2 py-0.5 text-[10px] font-bold whitespace-nowrap text-black">放開即收合</span>}

      <div className="flex h-full flex-col" style={{ width: innerWidth }} inert={collapsed && !drag} data-stage-inner>
        <StageViewer
          engine={engine}
          show={show}
          cues={cues}
          variant="panel"
          frame={frame}
          onFrameChange={setFrame}
          actions={
            <>
              <button type="button" onClick={() => onCollapsedChange(true)} className={btn} title="收合到右側邊緣" aria-label="收合 Stage">
                ▸
              </button>
              <button type="button" onClick={onHide} className={btn} title="隱藏 Stage" aria-label="隱藏 Stage">
                ✕
              </button>
            </>
          }
        />
      </div>

      <AnimatePresence>
        {collapsed && (
          <motion.button
            type="button"
            initial={{ opacity: 0 }}
            animate={{ opacity: drag ? 0 : 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            {...edgeHandlers}
            onKeyDown={onEdgeKey}
            className="absolute inset-0 z-20 flex cursor-col-resize touch-none flex-col items-center gap-3 bg-[#0b0b0b] py-3 text-white/60 hover:bg-white/10 hover:text-white"
            aria-label="展開 Stage（點擊或往左拉出）"
            title="點擊展開，或往左拉出"
            data-stage-tab
          >
            <span className="text-sm">◂</span>
            <span>🎭</span>
            <span className={`h-1.5 w-1.5 rounded-full ${playback === 'playing' ? 'bg-go' : playback === 'paused' ? 'bg-standby' : 'bg-white/25'}`} />
            <span className="text-[10px] font-semibold tracking-widest [writing-mode:vertical-rl]">Stage 模擬</span>
          </motion.button>
        )}
      </AnimatePresence>
    </motion.aside>
  )
}
