import { AnimatePresence, Reorder, useDragControls } from 'motion/react'
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent } from 'react'
import { useCoarsePointer } from '../../hooks/useMedia'
import { formatTime } from '../../hooks/useServerNow'
import { CUE_TYPE_GLYPHS, cueRunLength, instanceClock, type ActiveCue, type Cue } from '../../types/cue'
import { numberBetween } from '../../utils/cueNumbering'
import { instanceTiming } from '../../utils/cueTiming'

interface CueListProps {
  cues: Cue[]
  /** Latest running instance per cue id. */
  running: Map<string, ActiveCue>
  now: number
  standbyId: string | null
  selectedId: string | null
  /** While paused, rows show a PAUSED tag and per-cue fade-out is unavailable. */
  paused: boolean
  /** Multi-selection for bulk operations. */
  checked: Set<string>
  onCheckedChange: (ids: Set<string>) => void
  onSelect: (cue: Cue) => void
  /** Phone edit mode: a tap ticks the cue (for batch edit / delete) instead of selecting it. */
  selectMode?: boolean
  onStandby: (cue: Cue) => void
  /** Swipe-left tray: delete this cue (the caller confirms). */
  onDelete?: (cue: Cue) => void
  onStop: (instanceId: string) => void
  /** Pause / unpause one running cue on its own. */
  onPauseToggle: (instance: ActiveCue) => void
  /** A drag-reorder dropped `id` between two cues; give it this number. */
  onRenumber: (numbers: Record<string, number>) => void
}

/**
 * The cue list. Mouse: click = edit, double-click = standby. Touch (Go Button style): a tap only SELECTS
 * the cue as the next GO target (standby) and a long press opens its editor, so scrolling or a stray
 * touch never opens a dialog. Drag a row (mouse) or its ☰ handle (touch)
 * to move it: it is renumbered between its new neighbours. Checkboxes, Ctrl/⌘-click and
 * Shift-click build a multi-selection for the bulk toolbar.
 */
export function CueList({
  cues,
  running,
  now,
  standbyId,
  selectedId,
  paused,
  checked,
  onCheckedChange,
  onSelect,
  selectMode,
  onStandby,
  onDelete,
  onStop,
  onPauseToggle,
  onRenumber,
}: CueListProps) {
  const coarse = useCoarsePointer()
  const [draft, setDraftState] = useState<string[] | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const draftRef = useRef<string[] | null>(null)
  const anchor = useRef<string | null>(null)
  // Set when a press turned into a drag, so the click that follows the drop is ignored.
  const suppressClick = useRef(false)
  const setDraft = (ids: string[] | null) => {
    draftRef.current = ids
    setDraftState(ids)
  }
  const byId = new Map(cues.map((c) => [c.id, c]))
  const liveIds = cues.map((c) => c.id)
  const order = draft ? draft.filter((id) => byId.has(id)) : liveIds

  if (cues.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-10 text-center">
        <div className="text-4xl text-white/10">♪</div>
        <p className="text-sm text-white/40">Cue 清單是空的</p>
        <p className="text-xs text-white/25">點右上角「＋ 新增 Cue」開始建立演出</p>
      </div>
    )
  }

  const beginDrag = (id: string) => {
    setDraggingId(id)
    setDraft(liveIds)
    const end = () => {
      window.removeEventListener('pointerup', end, true)
      window.removeEventListener('pointercancel', end, true)
      const ids = draftRef.current ?? liveIds
      const from = liveIds.indexOf(id)
      const to = ids.indexOf(id)
      if (to !== from && to >= 0) {
        // Swallow the click the browser may send right after this pointer-up, but only that one.
        suppressClick.current = true
        setTimeout(() => (suppressClick.current = false), 0)
        const prev = to > 0 ? byId.get(ids[to - 1])!.cueNumber : null
        const next = to < ids.length - 1 ? byId.get(ids[to + 1])!.cueNumber : null
        onRenumber({ [id]: numberBetween(prev, next) })
      }
      setDraggingId(null)
      // Keep the dropped order on screen until Firebase echoes the new number back.
      setTimeout(() => setDraft(null), 400)
    }
    window.addEventListener('pointerup', end, true)
    window.addEventListener('pointercancel', end, true)
  }

  const toggle = (id: string, range: boolean) => {
    const next = new Set(checked)
    if (range && anchor.current && liveIds.includes(anchor.current)) {
      const [a, b] = [liveIds.indexOf(anchor.current), liveIds.indexOf(id)].sort((x, y) => x - y)
      for (const rid of liveIds.slice(a, b + 1)) next.add(rid)
    } else if (next.has(id)) {
      next.delete(id)
    } else {
      next.add(id)
    }
    anchor.current = id
    onCheckedChange(next)
  }

  return (
    <Reorder.Group axis="y" values={order} onReorder={setDraft} className="space-y-1.5 p-3 pointer-coarse:space-y-0 pointer-coarse:divide-y pointer-coarse:divide-white/10 pointer-coarse:p-0">
      <AnimatePresence initial={false}>
        {order.map((id) => {
          const cue = byId.get(id)!
          return (
            <CueRow
              key={id}
              cue={cue}
              instance={running.get(id) ?? null}
              now={now}
              isStandby={id === standbyId}
              isSelected={id === selectedId}
              isChecked={checked.has(id)}
              dragging={draggingId === id}
              coarse={coarse}
              selectMode={!!selectMode}
              paused={paused}
              onBeginDrag={() => beginDrag(id)}
              onRowClick={(e) => {
                if (suppressClick.current) {
                  suppressClick.current = false
                  return
                }
                if (e.metaKey || e.ctrlKey) toggle(id, false)
                else if (e.shiftKey) toggle(id, true)
                else if (selectMode) toggle(id, false)
                else if (coarse) onStandby(cue)
                else onSelect(cue)
              }}
              onCheck={(range) => toggle(id, range)}
              onStandby={() => onStandby(cue)}
              onEdit={() => onSelect(cue)}
              onDelete={onDelete ? () => onDelete(cue) : undefined}
              onStop={onStop}
              onPauseToggle={onPauseToggle}
            />
          )
        })}
      </AnimatePresence>
    </Reorder.Group>
  )
}

function CueRow({
  cue,
  instance,
  now,
  isStandby,
  isSelected,
  isChecked,
  dragging,
  coarse,
  selectMode,
  paused,
  onBeginDrag,
  onRowClick,
  onCheck,
  onStandby,
  onEdit,
  onDelete,
  onStop,
  onPauseToggle,
}: {
  cue: Cue
  instance: ActiveCue | null
  now: number
  isStandby: boolean
  isSelected: boolean
  isChecked: boolean
  dragging: boolean
  coarse: boolean
  selectMode: boolean
  paused: boolean
  onBeginDrag: () => void
  onRowClick: (e: ReactMouseEvent) => void
  onCheck: (range: boolean) => void
  onStandby: () => void
  onEdit: () => void
  onDelete?: () => void
  onStop: (instanceId: string) => void
  onPauseToggle: (instance: ActiveCue) => void
}) {
  const controls = useDragControls()
  const press = useRef<{ x: number; y: number; started: boolean } | null>(null)

  // Touch swipe: right = Standby, left = open the Edit / Delete tray. The row keeps vertical
  // scrolling (touch-action: pan-y); a mostly-horizontal move takes over the gesture.
  const SWIPE_ACT = 84
  const TRAY = 222
  const [dx, setDx] = useState(0)
  const [tray, setTray] = useState(false)
  const swipe = useRef<{ x: number; y: number; id: number; active: boolean; base: number } | null>(null)
  const swallowClick = useRef(false)
  // Long press (touch): open the editor. Any finger travel beyond the slop is a scroll / swipe instead.
  const LONG_PRESS_MS = 450
  const SLOP = 9
  const hold = useRef<{ timer: number; x: number; y: number } | null>(null)
  const cancelHold = () => {
    if (hold.current) window.clearTimeout(hold.current.timer)
    hold.current = null
  }
  useEffect(() => cancelHold, [])
  const onSwipeDown = (e: PointerEvent<HTMLLIElement>) => {
    if (e.pointerType === 'mouse' || (e.target as HTMLElement).closest?.('button, input, a')) return
    swipe.current = { x: e.clientX, y: e.clientY, id: e.pointerId, active: false, base: tray ? -TRAY : 0 }
    cancelHold()
    if (tray || selectMode) return
    hold.current = {
      x: e.clientX,
      y: e.clientY,
      timer: window.setTimeout(() => {
        hold.current = null
        swipe.current = null
        swallowClick.current = true
        window.setTimeout(() => (swallowClick.current = false), 400)
        navigator.vibrate?.(20)
        onEdit()
      }, LONG_PRESS_MS),
    }
  }
  const onSwipeMove = (e: PointerEvent<HTMLLIElement>) => {
    const s = swipe.current
    if (hold.current && Math.hypot(e.clientX - hold.current.x, e.clientY - hold.current.y) > SLOP) cancelHold()
    if (!s || s.id !== e.pointerId) return
    const mx = e.clientX - s.x
    if (!s.active) {
      if (Math.abs(mx) < 14 || Math.abs(mx) < Math.abs(e.clientY - s.y) * 1.6) return
      s.active = true
      e.currentTarget.setPointerCapture(e.pointerId)
    }
    setDx(Math.max(-TRAY - 24, Math.min(SWIPE_ACT + 40, s.base + mx)))
  }
  const onSwipeEnd = () => {
    cancelHold()
    const s = swipe.current
    swipe.current = null
    if (!s?.active) return
    swallowClick.current = true
    window.setTimeout(() => (swallowClick.current = false), 80)
    if (dx > SWIPE_ACT) {
      navigator.vibrate?.(15)
      onStandby()
      setTray(false)
    } else if (dx < -SWIPE_ACT) {
      setTray(true)
    } else {
      setTray(false)
    }
    setDx(0)
  }

  // Mouse: press anywhere on the row (not on its buttons) and move ~4 px to start a drag, so a
  // plain click still opens the editor. Touch uses the ☰ handle so the list can still scroll.
  const onRowPointerDown = (e: PointerEvent<HTMLLIElement>) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return
    if ((e.target as HTMLElement).closest?.('button, input, a')) return
    press.current = { x: e.clientX, y: e.clientY, started: false }
  }
  const onRowPointerMove = (e: PointerEvent<HTMLLIElement>) => {
    const p = press.current
    if (!p || p.started) return
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > 4) {
      p.started = true
      onBeginDrag()
      controls.start(e)
    }
  }
  const onRowPointerUp = () => {
    press.current = null
  }
  // An individually paused cue runs on its own frozen clock.
  const timing = instance ? instanceTiming(instance, instanceClock(instance, now)) : null
  const cuePaused = !!instance && (paused || instance.pausedAt != null)
  const length = cueRunLength(cue)
  const barColor =
    timing?.phase === 'prewait'
      ? 'bg-standby/25'
      : timing?.phase === 'stopping' || timing?.phase === 'postwait'
        ? 'bg-white/10'
        : 'bg-go/25'

  return (
    <Reorder.Item
      value={cue.id}
      dragListener={false}
      dragControls={controls}
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: -20 }}
      whileDrag={{ scale: 1.015, zIndex: 20, boxShadow: '0 18px 40px -12px rgba(0,0,0,0.85)' }}
      transition={{ type: 'spring', stiffness: 500, damping: 40 }}
      onPointerDown={(e) => {
        onRowPointerDown(e)
        onSwipeDown(e)
      }}
      onPointerMove={(e) => {
        onRowPointerMove(e)
        onSwipeMove(e)
      }}
      onPointerUp={() => {
        onRowPointerUp()
        onSwipeEnd()
      }}
      onPointerCancel={onSwipeEnd}
      onClick={(e) => {
        if (swallowClick.current) return
        if (tray) return setTray(false)
        onRowClick(e)
      }}
      onDoubleClick={onStandby}
      data-cue-row={cue.id}
      className={`group relative cursor-default overflow-hidden rounded-xl border transition-colors select-none pointer-coarse:touch-pan-y pointer-coarse:rounded-none pointer-coarse:border-0 [-webkit-touch-callout:none] ${
        dragging
          ? 'border-accent bg-[#1b2433]'
          : instance
            ? 'border-go/50 bg-go/[0.06]'
            : isStandby
              ? 'border-standby/50 bg-standby/[0.05] pointer-coarse:bg-white/[0.16]'
              : isChecked
                ? 'border-accent/40 bg-accent/[0.08]'
                : 'border-transparent bg-white/[0.025] hover:bg-white/[0.05]'
      } ${isSelected && !coarse ? 'ring-1 ring-accent/70' : ''}`}
    >
      {/* Progress fill */}
      {timing && (
        <span
          className={`absolute inset-y-0 left-0 ${barColor} ${timing.progress == null ? 'animate-pulse' : ''}`}
          style={{ width: timing.progress == null ? '100%' : `${timing.progress * 100}%` }}
        />
      )}
      {/* Left status strip */}
      <span
        className={`absolute inset-y-0 left-0 w-1 ${instance ? 'bg-go' : isStandby ? 'bg-standby' : 'bg-transparent'}`}
      />

      {/* Swipe hints: Standby behind a right swipe, Edit / Delete behind a left swipe */}
      {dx > 0 && <span className="absolute inset-y-0 left-0 flex items-center bg-standby/90 px-5 text-sm font-bold text-black" style={{ width: Math.max(dx, 0) }}>STANDBY</span>}
      {(dx < 0 || tray) && (
        <div className="absolute inset-y-0 right-0 flex" style={{ width: TRAY }}>
          <button type="button" onClick={(e) => { e.stopPropagation(); setTray(false); onCheck(false) }} className="flex-1 bg-white/20 text-sm font-bold text-white">{isChecked ? '取消勾選' : '勾選'}</button>
          <button type="button" onClick={(e) => { e.stopPropagation(); setTray(false); onEdit() }} className="flex-1 bg-accent text-sm font-bold text-white">編輯</button>
          <button type="button" onClick={(e) => { e.stopPropagation(); setTray(false); onDelete?.() }} disabled={!onDelete} className="flex-1 bg-panic text-sm font-bold text-white disabled:opacity-40">刪除</button>
        </div>
      )}
      <div
        className={`relative flex min-h-14 items-center gap-3 py-2.5 pr-3 pl-3 pointer-coarse:min-h-24 pointer-coarse:items-start pointer-coarse:py-3 ${dx === 0 ? 'transition-transform duration-200' : ''}`}
        style={{ transform: `translate3d(${dx !== 0 ? dx : tray ? -TRAY : 0}px,0,0)`, willChange: 'transform' }}
      >
        {/* Touch drag handle (mouse users drag the whole row) */}
        <button
          type="button"
          onPointerDown={(e) => {
            e.preventDefault()
            onBeginDrag()
            controls.start(e)
          }}
          onClick={(e) => e.stopPropagation()}
          className="hidden h-10 w-7 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-white/35 hover:bg-white/10 pointer-coarse:flex"
          aria-label={`拖曳排序 Q${cue.cueNumber}`}
        >
          ☰
        </button>
        <input
          type="checkbox"
          checked={isChecked}
          onChange={() => {}}
          onClick={(e) => {
            e.stopPropagation()
            onCheck(e.shiftKey)
          }}
          className={`h-4 w-4 shrink-0 cursor-pointer accent-[#0a84ff] ${selectMode ? 'pointer-coarse:mt-2.5 pointer-coarse:h-6 pointer-coarse:w-6' : 'pointer-coarse:hidden'}`}
          aria-label={`選取 Q${cue.cueNumber}`}
        />
        {/* Touch: round number badge (green = playing, orange = selected / next GO, red = idle) */}
        <span
          className={`hidden h-11 min-w-11 shrink-0 items-center justify-center self-start rounded-full px-1 text-xl font-bold text-white pointer-coarse:flex ${
            instance ? 'bg-[#1fae45]' : isStandby ? 'bg-[#f5a623]' : 'bg-[#d92e27]'
          }`}
          title={cue.type}
          data-cue-badge
        >
          {cue.cueNumber}
        </span>
        <span className="w-12 shrink-0 font-mono text-lg font-semibold text-white/80 tabular pointer-coarse:hidden">{cue.cueNumber}</span>
        <span
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-sm pointer-coarse:hidden ${
            instance ? 'bg-go text-black' : 'bg-white/[0.06] text-white/60'
          }`}
          title={cue.type}
        >
          {CUE_TYPE_GLYPHS[cue.type]}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-white">{cue.title || '（未命名）'}</span>
            {cue.group && (
              <span className="shrink-0 rounded-full border border-white/15 px-2 py-px text-[10px] text-white/55">{cue.group}</span>
            )}
            {isStandby && !instance && (
              <span className="rounded bg-standby px-1.5 py-px text-[9px] font-bold tracking-wider text-black">STANDBY</span>
            )}
            {cuePaused && (
              <span className="rounded bg-standby px-1.5 py-px text-[9px] font-bold tracking-wider text-black">❚❚ PAUSED</span>
            )}
            {timing?.phase === 'prewait' && (
              <span className="rounded bg-standby/20 px-1.5 py-px text-[9px] font-bold tracking-wider text-standby">PRE-WAIT</span>
            )}
            {timing?.phase === 'postwait' && (
              <span className="rounded bg-go/20 px-1.5 py-px text-[9px] font-bold tracking-wider text-go">POST-WAIT</span>
            )}
            {timing?.phase === 'stopping' && (
              <span className="rounded bg-white/10 px-1.5 py-px text-[9px] font-bold tracking-wider text-white/60">FADING</span>
            )}
          </div>
          {cue.subtitle && <div className="truncate text-xs text-white/40 pointer-coarse:text-sm pointer-coarse:text-white/45">{cue.subtitle}</div>}
          {/* Touch: inline time line — elapsed, a progress track with a playhead dot, and time left */}
          <div className="mt-2 hidden items-center gap-2 pointer-coarse:flex" data-cue-progress>
            <span className="w-[4.4rem] shrink-0 font-mono text-sm text-white/75 tabular">{formatTime(timing?.elapsed ?? 0)}</span>
            <div className="relative mx-3 h-[3px] flex-1 rounded-full bg-white/15">
              <span className="absolute inset-y-0 left-0 rounded-full bg-go/70" style={{ width: `${(timing?.progress ?? 0) * 100}%` }} />
              <span
                className="absolute top-1/2 h-7 w-7 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-md"
                style={{ left: `${Math.min(1, Math.max(0, timing?.progress ?? 0)) * 100}%` }}
              />
            </div>
            <span className="w-[4.8rem] shrink-0 text-right font-mono text-sm text-white/75 tabular">
              {timing ? (timing.remaining != null ? `-${formatTime(timing.remaining)}` : '∞') : Number.isFinite(length) ? `-${formatTime(length)}` : '∞'}
            </span>
          </div>
        </div>

        <CueFlags cue={cue} />

        <div className="w-20 shrink-0 text-right font-mono text-sm tabular pointer-coarse:hidden">
          {timing ? (
            <span className={timing.phase === 'prewait' ? 'text-standby' : 'text-go'}>
              {timing.remaining != null ? `-${formatTime(timing.remaining)}` : formatTime(timing.elapsed)}
            </span>
          ) : (
            <span className="text-white/35">{Number.isFinite(length) ? formatTime(length) : '—'}</span>
          )}
        </div>

        {instance && instance.stopAt == null && !paused ? (
          <div className="flex shrink-0 gap-1">
            <button
              onClick={(e) => {
                e.stopPropagation()
                onPauseToggle(instance)
              }}
              className={`flex h-9 w-9 items-center justify-center rounded-md text-xs pointer-coarse:h-12 pointer-coarse:w-12 ${
                instance.pausedAt != null ? 'bg-go text-black' : 'bg-white/10 text-white/80 hover:bg-standby hover:text-black'
              }`}
              title={instance.pausedAt != null ? '繼續此 Cue' : '暫停此 Cue'}
            >
              {instance.pausedAt != null ? '▶' : '❚❚'}
            </button>
            {instance.pausedAt == null && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onStop(instance.instanceId)
                }}
                className="flex h-9 w-9 items-center justify-center rounded-md bg-white/10 text-xs text-white/80 hover:bg-panic hover:text-white pointer-coarse:h-12 pointer-coarse:w-12"
                title="停止（淡出）"
              >
                ■
              </button>
            )}
          </div>
        ) : (
          <span className="w-9 shrink-0 pointer-coarse:hidden" />
        )}
      </div>
    </Reorder.Item>
  )
}

function CueFlags({ cue }: { cue: Cue }) {
  const flags: { label: string; title: string; tone?: string }[] = []
  if (cue.studioId) flags.push({ label: '🎚 Studio', title: '播放 DAW Studio 專案的即時混音', tone: 'text-[#d7a6ff]' })
  if (cue.targetMode === 'selected')
    flags.push({ label: `🎯${cue.targetIds.length}`, title: `派發給 ${cue.targetIds.join(', ')}`, tone: 'text-accent' })
  if (cue.preWaitTime > 0) flags.push({ label: `⏱${cue.preWaitTime}`, title: `Pre-wait ${cue.preWaitTime}s` })
  if (cue.fadeInTime > 0 || cue.fadeOutTime > 0)
    flags.push({ label: '◢◣', title: `Fade in ${cue.fadeInTime}s / out ${cue.fadeOutTime}s` })
  if (cue.duckOthers > 0) flags.push({ label: `↧${cue.duckOthers}%`, title: `Duck others ${cue.duckOthers}%` })
  if (cue.stopOthers !== 'none') flags.push({ label: '■✕', title: `Stop others (${cue.stopOthers})` })
  if (cue.loop) flags.push({ label: cue.loopCount > 0 ? `⟳${cue.loopCount}` : '⟳∞', title: 'Loop' })
  if (cue.autoStopAfter > 0) flags.push({ label: `◢${cue.autoStopAfter}`, title: `自動淡出於 ${cue.autoStopAfter}s` })
  if (cue.fadeOnNextGo) flags.push({ label: 'GO→◢', title: `下一次 GO 時淡出 ${cue.fadeOutTime}s`, tone: 'text-standby' })
  if (cue.followMode === 'autoFollow') flags.push({ label: '↓', title: 'Auto-follow', tone: 'text-go' })
  if (cue.followMode === 'autoContinue') flags.push({ label: '⇉', title: 'Start next immediately', tone: 'text-go' })
  if (cue.preventGoDuration > 0) flags.push({ label: '🔒', title: `Prevent GO ${cue.preventGoDuration}s` })

  return (
    <div className="hidden shrink-0 gap-1 md:flex">
      {flags.map((f) => (
        <span
          key={f.title}
          title={f.title}
          className={`rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] ${f.tone ?? 'text-white/50'}`}
        >
          {f.label}
        </span>
      ))}
    </div>
  )
}
