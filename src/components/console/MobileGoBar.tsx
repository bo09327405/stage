import type { Cue, PlaybackState } from '../../types/cue'
import { formatTime } from '../../hooks/useServerNow'

/**
 * Go Button-style top bar for phones / portrait iPads: the show title, a big GO (shows the cue it
 * will fire), and Pause on the left with the running time above it. While paused the two become
 * Resume and Stop. Both are large touch targets.
 */
export function MobileGoBar({
  title,
  playbackState,
  standbyCue,
  firstCue,
  elapsed,
  lockRemaining,
  onGo,
  onPause,
  onResume,
  onStop,
  onAdd,
}: {
  title: string
  playbackState: PlaybackState
  standbyCue: Cue | null
  firstCue: Cue | null
  /** Seconds the show has been running (longest-running cue); null while nothing plays. */
  elapsed: number | null
  lockRemaining: number
  onGo: () => void
  onPause: () => void
  onResume: () => void
  onStop: () => void
  onAdd: () => void
}) {
  const paused = playbackState === 'paused'
  const target = standbyCue ?? firstCue
  const locked = lockRemaining > 0 && !paused
  const goEnabled = paused || (!!target && !locked)
  const secondaryEnabled = playbackState !== 'idle'

  return (
    <div
      className="sticky top-0 z-30 border-b border-line bg-[#161618]/95 px-3 pt-1.5 pb-3 backdrop-blur-xl"
      data-mobile-gobar
    >
      <div className="relative flex items-center justify-center pb-1.5">
        <h2 className="max-w-[60%] truncate text-base font-bold">{title}</h2>
        <button
          type="button"
          onClick={onAdd}
          className="absolute top-0 right-0 flex h-8 items-center px-1 text-sm text-white/45 active:text-white"
        >
          ＋ 新增
        </button>
      </div>
      <div className="flex items-end gap-3">
        <div className="flex w-[27%] shrink-0 flex-col items-center gap-1">
          <span className={`font-mono text-sm font-bold tabular ${elapsed != null ? 'text-white' : 'text-white/25'}`}>
            {elapsed != null ? formatTime(elapsed).slice(0, 5) : '00:00'}
          </span>
          <button
            type="button"
            data-haptic="tap"
            data-mobile-pause
            onClick={paused ? onStop : onPause}
            disabled={!secondaryEnabled}
            className={`h-[76px] w-full rounded-xl border-2 text-xl font-extrabold transition active:scale-[0.97] ${
              !secondaryEnabled
                ? 'border-white/10 bg-white/[0.05] text-white/25'
                : paused
                  ? 'border-[#ff8a82] bg-panic text-white'
                  : 'border-[#ffcf66] bg-[#f5a623] text-white'
            }`}
          >
            {paused ? 'Stop' : 'Pause'}
          </button>
        </div>
        <button
          type="button"
          data-haptic="strong"
          data-mobile-go
          onClick={paused ? onResume : onGo}
          disabled={!goEnabled}
          className={`relative h-[100px] min-w-0 flex-1 overflow-hidden rounded-xl border-2 transition active:scale-[0.98] ${
            goEnabled ? 'border-[#6fdc8c] bg-[#14a32a] text-white shadow-[0_0_40px_-12px_rgba(48,209,88,0.8)]' : 'border-white/10 bg-white/[0.05] text-white/25'
          }`}
        >
          <span className="block truncate px-2 text-6xl leading-none font-extrabold tracking-tight">
            {paused ? 'Resume' : target ? `Go ${target.cueNumber}` : 'Go'}
          </span>
          {locked && (
            <span className="absolute inset-x-0 bottom-0 bg-black/55 py-0.5 font-mono text-xs text-standby">
              LOCKED {lockRemaining.toFixed(1)}s
            </span>
          )}
        </button>
      </div>
    </div>
  )
}
