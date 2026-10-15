import { motion } from 'motion/react'
import { useEffect, useRef, useState, type PointerEvent } from 'react'
import type { useTheatreEngine } from '../../hooks/useTheatreEngine'
import type { useTriggerRouter } from '../../hooks/useTriggerRouter'
import type { Cue, Hit } from '../../types/cue'
import type { ShowRef } from '../../types/project'
import { SurfaceWorkspace } from '../surface/SurfaceWorkspace'

const WIDTH_KEY = 'theatre.controlSidebarWidth'
const MIN_WIDTH = 340
const MAX_WIDTH = 960

const readStored = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
const writeStored = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Not remembered; harmless.
  }
}

/**
 * The control surface docked beside the Set Cue editor (split view on wide screens, a full
 * overlay on narrow ones). It renders the same SurfaceWorkspace as the /surface page but drives
 * the console's own engine, so GO / Pause / Panic / Select here and in the cue list are one state.
 */
export function ControlSidebar({
  show,
  engine,
  cues,
  hits,
  router,
  onClose,
}: {
  show: ShowRef
  engine: ReturnType<typeof useTheatreEngine>
  cues: Cue[]
  hits: Hit[]
  router: ReturnType<typeof useTriggerRouter>
  onClose: () => void
}) {
  const [width, setWidth] = useState(() => {
    const stored = Number(readStored(WIDTH_KEY))
    return stored >= MIN_WIDTH && stored <= MAX_WIDTH ? stored : 480
  })
  const surfaceKey = `theatre.sidebarSurface.${show.projectId}`
  const [initialSurface] = useState(() => readStored(surfaceKey))

  // Resize by dragging the left edge.
  const resize = useRef<{ x: number; width: number } | null>(null)
  const onResizeDown = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    resize.current = { x: e.clientX, width }
  }
  const onResizeMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!resize.current) return
    const next = resize.current.width + (resize.current.x - e.clientX)
    setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.min(next, window.innerWidth - 320))))
  }
  const onResizeUp = () => {
    resize.current = null
  }
  useEffect(() => {
    writeStored(WIDTH_KEY, String(width))
  }, [width])

  return (
    <motion.aside
      initial={{ x: 60, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 60, opacity: 0, transition: { duration: 0.18 } }}
      transition={{ type: 'spring', stiffness: 420, damping: 38 }}
      style={{ '--sidebar-w': `${width}px` } as React.CSSProperties}
      data-safe-fixed className="fixed inset-y-0 right-0 z-50 w-full border-l border-line bg-ink shadow-2xl lg:relative lg:inset-auto lg:z-auto lg:w-[var(--sidebar-w)] lg:shrink-0 lg:shadow-none"
      aria-label="控台側欄"
    >
      <div
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeUp}
        onPointerCancel={onResizeUp}
        className="group absolute inset-y-0 -left-1.5 z-20 hidden w-3 cursor-col-resize touch-none lg:block"
        title="拖曳調整側欄寬度"
        role="separator"
        aria-orientation="vertical"
        aria-valuenow={width}
      >
        <span className="absolute inset-y-0 left-1.5 w-px bg-line transition group-hover:w-0.5 group-hover:bg-accent" />
      </div>

      <SurfaceWorkspace
        show={show}
        engine={engine}
        cues={cues}
        hits={hits}
        router={router}
        variant="sidebar"
        initialSurfaceId={initialSurface}
        onSurfaceChange={(id) => (id ? writeStored(surfaceKey, id) : undefined)}
        headerStart={<span className="text-xs font-semibold tracking-wider text-white/50">🎛 控台</span>}
        headerEnd={
          <>
            <a
              href={`/surface?project=${show.projectId}&version=${show.versionId}`}
              target="_blank"
              rel="noreferrer"
              className="flex min-h-10 items-center rounded-lg bg-white/[0.06] px-2.5 text-xs text-white/60 hover:bg-white/10 hover:text-white"
              title="在新分頁開啟獨立的控制面板頁"
            >
              ↗
            </a>
            <button
              onClick={onClose}
              className="flex min-h-10 w-10 items-center justify-center rounded-lg text-white/50 hover:bg-white/10 hover:text-white"
              aria-label="關閉控台側欄"
            >
              ✕
            </button>
          </>
        }
      />
    </motion.aside>
  )
}
