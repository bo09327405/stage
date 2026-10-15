import { useEffect, useRef } from 'react'
import { useCueMonitorState } from '../../hooks/useCueMonitorState'
import { formatTime } from '../../hooks/useServerNow'
import type { useTheatreEngine } from '../../hooks/useTheatreEngine'
import { CUE_TYPE_GLYPHS, type Cue } from '../../types/cue'
import type { SurfaceWidget } from '../../types/surface'
import type { InstanceTiming } from '../../utils/cueTiming'

const ignore = () => {}

/**
 * A surface button set to "Cue Monitor" display: a small live monitor of the Active and Standby
 * cues, optionally with the cue list underneath (tap a cue to put it on standby, or GO it).
 * In edit mode (`preview`) it renders the same view but ignores taps, so the block can be dragged.
 */
export function MiniCueMonitor({
  widget,
  engine,
  cues,
  preview = false,
}: {
  widget: SurfaceWidget
  engine: ReturnType<typeof useTheatreEngine>
  cues: Cue[]
  preview?: boolean
}) {
  const { instances, newest, standby, tileState, timingOf, isPaused } = useCueMonitorState(engine)
  const live = instances.filter((i) => i.stopAt == null)
  const newestTiming = newest ? timingOf(newest) : null
  const listRef = useRef<HTMLUListElement>(null)

  // Keep the standby cue in view inside the list (without scrolling the page).
  const standbyId = standby?.id
  useEffect(() => {
    const list = listRef.current
    const row = standbyId ? list?.querySelector<HTMLElement>(`[data-mini-cue="${standbyId}"]`) : null
    if (!list || !row) return
    if (row.offsetTop < list.scrollTop || row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTo({ top: row.offsetTop - list.clientHeight / 3, behavior: 'smooth' })
    }
  }, [standbyId])

  const tap = (cue: Cue) => {
    if (preview) return
    if (widget.monitorTap === 'go') engine.go(cue).catch(ignore)
    else engine.standby(cue).catch(ignore)
  }

  return (
    <div
      className="flex h-full w-full flex-col gap-1.5 overflow-hidden rounded-2xl border bg-black/50 p-2 text-left select-none"
      style={{ borderColor: `${widget.color}80` }}
      data-mini-monitor={widget.id}
    >
      <div className="flex items-center justify-between gap-2 px-0.5">
        <span className="truncate text-[11px] font-bold tracking-wider uppercase" style={{ color: widget.color }}>
          {widget.label || 'Cue Monitor'}
        </span>
        {live.length > 1 && <span className="shrink-0 rounded bg-go/20 px-1.5 text-[10px] font-semibold text-go">{live.length} 個執行中</span>}
      </div>

      <StatusRow
        tone="go"
        tag={newest && isPaused(newest) ? 'PAUSED' : newestTiming?.phase === 'prewait' ? 'PRE-WAIT' : 'ACTIVE'}
        cue={newest?.cue ?? null}
        timing={newestTiming}
        empty="沒有執行中的 Cue"
      />
      <StatusRow tone="standby" tag="STANDBY" cue={standby} timing={null} empty="未選取" />

      {widget.monitorList && (
        <ul ref={listRef} className="relative min-h-0 flex-1 space-y-0.5 overflow-y-auto overscroll-contain border-t border-white/10 pt-1 touch-pan-y">
          {cues.map((cue) => {
            const { inst, timing, isStandby } = tileState(cue)
            return (
              <li key={cue.id} data-mini-cue={cue.id}>
                <button
                  type="button"
                  onClick={() => tap(cue)}
                  tabIndex={preview ? -1 : 0}
                  className={`relative flex min-h-8 w-full items-center gap-2 overflow-hidden rounded-md px-1.5 text-left text-xs transition pointer-coarse:min-h-11 ${
                    inst ? 'bg-go/15' : isStandby ? 'bg-standby/15' : 'hover:bg-white/[0.07]'
                  }`}
                  title={widget.monitorTap === 'go' ? '點擊直接 GO' : '點擊設為 Standby'}
                >
                  <span className={`absolute inset-y-0 left-0 w-0.5 ${inst ? 'bg-go' : isStandby ? 'bg-standby' : ''}`} />
                  <span className="w-8 shrink-0 font-mono font-semibold text-white/75 tabular">{cue.cueNumber}</span>
                  <span className="w-3 shrink-0 text-center text-white/40">{CUE_TYPE_GLYPHS[cue.type]}</span>
                  <span className="min-w-0 flex-1 truncate text-white/85">{cue.title || '（未命名）'}</span>
                  {timing && (
                    <span className={`shrink-0 font-mono tabular ${timing.phase === 'prewait' ? 'text-standby' : 'text-go'}`}>
                      {timing.remaining != null ? `-${formatTime(timing.remaining)}` : formatTime(timing.elapsed)}
                    </span>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function StatusRow({
  tone,
  tag,
  cue,
  timing,
  empty,
}: {
  tone: 'go' | 'standby'
  tag: string
  cue: Cue | null
  timing: InstanceTiming | null
  empty: string
}) {
  const color = tone === 'go' ? 'text-go' : 'text-standby'
  return (
    <div
      className={`relative shrink-0 overflow-hidden rounded-lg border px-2 py-1.5 ${
        cue ? (tone === 'go' ? 'border-go/50 bg-go/[0.08]' : 'border-standby/50 bg-standby/[0.08]') : 'border-white/10'
      }`}
      data-mini-status={tone}
    >
      {timing?.progress != null && (
        <span className={`absolute inset-y-0 left-0 ${timing.phase === 'prewait' ? 'bg-standby/20' : 'bg-go/20'}`} style={{ width: `${timing.progress * 100}%` }} />
      )}
      <span className="relative flex items-center gap-2 text-sm">
        <span className={`shrink-0 rounded px-1 text-[9px] font-bold tracking-wider ${cue ? (tone === 'go' ? 'bg-go text-black' : 'bg-standby text-black') : 'text-white/30'}`}>
          {tag}
        </span>
        {cue ? (
          <>
            <span className={`shrink-0 font-mono font-semibold tabular ${color}`}>Q{cue.cueNumber}</span>
            <span className="min-w-0 flex-1 truncate text-white">{cue.title || '（未命名）'}</span>
            {timing && (
              <span className={`shrink-0 font-mono text-xs tabular ${color}`}>
                {timing.remaining != null ? `-${formatTime(timing.remaining)}` : formatTime(timing.elapsed)}
              </span>
            )}
          </>
        ) : (
          <span className="truncate text-white/35">{empty}</span>
        )}
      </span>
    </div>
  )
}
