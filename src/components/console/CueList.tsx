import { AnimatePresence, Reorder, useDragControls } from 'motion/react'
import { useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent } from 'react'
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
  onStandby: (cue: Cue) => void
  onStop: (instanceId: string) => void
  /** Pause / unpause one running cue on its own. */
  onPauseToggle: (instance: ActiveCue) => void
  /** A drag-reorder dropped `id` between two cues; give it this number. */
  onRenumber: (numbers: Record<string, number>) => void
}

/**
 * The cue list. Click = edit, double-click = standby. Drag a row (mouse) or its ☰ handle (touch)
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
  onStandby,
  onStop,
  onPauseToggle,
  onRenumber,
}: CueListProps) {
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
    <Reorder.Group axis="y" values={order} onReorder={setDraft} className="space-y-1.5 p-3">
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
              paused={paused}
              onBeginDrag={() => beginDrag(id)}
              onRowClick={(e) => {
                if (suppressClick.current) {
                  suppressClick.current = false
                  return
                }
                if (e.metaKey || e.ctrlKey) toggle(id, false)
                else if (e.shiftKey) toggle(id, true)
                else onSelect(cue)
              }}
              onCheck={(range) => toggle(id, range)}
              onStandby={() => onStandby(cue)}
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
  paused,
  onBeginDrag,
  onRowClick,
  onCheck,
  onStandby,
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
  paused: boolean
  onBeginDrag: () => void
  onRowClick: (e: ReactMouseEvent) => void
  onCheck: (range: boolean) => void
  onStandby: () => void
  onStop: (instanceId: string) => void
  onPauseToggle: (instance: ActiveCue) => void
}) {
  const controls = useDragControls()
  const press = useRef<{ x: number; y: number; started: boolean } | null>(null)

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
      onPointerDown={onRowPointerDown}
      onPointerMove={onRowPointerMove}
      onPointerUp={onRowPointerUp}
      onClick={onRowClick}
      onDoubleClick={onStandby}
      data-cue-row={cue.id}
      className={`group relative cursor-default overflow-hidden rounded-xl border transition-colors select-none ${
        dragging
          ? 'border-accent bg-[#1b2433]'
          : instance
            ? 'border-go/50 bg-go/[0.06]'
            : isStandby
              ? 'border-standby/50 bg-standby/[0.05]'
              : isChecked
                ? 'border-accent/40 bg-accent/[0.08]'
                : 'border-transparent bg-white/[0.025] hover:bg-white/[0.05]'
      } ${isSelected ? 'ring-1 ring-accent/70' : ''}`}
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

      <div className="relative flex min-h-14 items-center gap-3 py-2.5 pr-3 pl-3 pointer-coarse:min-h-16">
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
          className="h-4 w-4 shrink-0 cursor-pointer accent-[#0a84ff] pointer-coarse:h-5 pointer-coarse:w-5"
          aria-label={`選取 Q${cue.cueNumber}`}
        />
        <span className="w-12 shrink-0 font-mono text-lg font-semibold text-white/80 tabular">{cue.cueNumber}</span>
        <span
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-sm ${
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
          {cue.subtitle && <div className="truncate text-xs text-white/40">{cue.subtitle}</div>}
        </div>

        <CueFlags cue={cue} />

        <div className="w-20 shrink-0 text-right font-mono text-sm tabular">
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
              className={`flex h-9 w-9 items-center justify-center rounded-md text-xs pointer-coarse:h-11 pointer-coarse:w-11 ${
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
                className="flex h-9 w-9 items-center justify-center rounded-md bg-white/10 text-xs text-white/80 hover:bg-panic hover:text-white pointer-coarse:h-11 pointer-coarse:w-11"
                title="停止（淡出）"
              >
                ■
              </button>
            )}
          </div>
        ) : (
          <span className="w-9 shrink-0 pointer-coarse:w-11" />
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
