import { motion, AnimatePresence } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { closePlayer, seekTo, setVolume, skipBy, stopPlayback, toggleMute, togglePlay, toggleStudio, useLobbyPlayer } from '../../services/lobbyPlayer'
import type { StudioProject } from '../../types/studio'

/*
 * Lobby: play a whole Studio project from its card (▶ / ❚❚), with a player bar along the bottom —
 * timeline overview with playhead, play / pause / stop, back / forward 10 s, volume.
 */

const SKIP = 10

/** m:ss (h:mm:ss past an hour) */
function clock(s: number) {
  const t = Math.max(0, Math.floor(s || 0))
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const sec = String(t % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

/** The round ▶ / ❚❚ on a Studio card. */
export function StudioPlayButton({ projectId, studioId, name, showName }: { projectId: string; studioId: string; name: string; showName: string | null }) {
  const p = useLobbyPlayer()
  const mine = p.key === `${projectId}/${studioId}`
  const playing = mine && p.playing
  const loading = mine && p.loading
  return (
    <button
      type="button"
      onClick={() => void toggleStudio(projectId, studioId, name, showName)}
      className={`relative flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-base font-bold transition ${
        playing ? 'bg-go text-black shadow-[0_0_16px_rgba(48,209,88,0.45)]' : mine ? 'bg-accent text-white' : 'bg-white/[0.08] text-white/80 hover:bg-white/15 hover:text-white'
      }`}
      aria-label={playing ? `暫停「${name}」` : `播放「${name}」`}
      aria-pressed={playing}
      title={playing ? '暫停' : '播放整個專案（不用開啟 Studio）'}
      data-play-studio={studioId}
      data-play-state={mine ? (loading ? 'loading' : playing ? 'playing' : 'paused') : 'idle'}
    >
      {loading ? <Spinner /> : playing ? <PauseIcon /> : <PlayIcon />}
    </button>
  )
}

/** Room for the bar at the end of a page, so it never covers the last cards. */
export function LobbyPlayerSpacer() {
  const p = useLobbyPlayer()
  return p.key ? <div className="h-36 sm:h-28" aria-hidden /> : null
}

/** The bottom player bar (shown while a project is loaded). */
export function LobbyPlayerBar() {
  const p = useLobbyPlayer()
  // Space: play / pause (unless typing or on a button).
  useEffect(() => {
    if (!p.key) return
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.closest('input, textarea, select, button, [contenteditable="true"]')) return
      if (e.key === ' ') {
        e.preventDefault()
        togglePlay()
      } else if (e.key === 'ArrowLeft' && t === document.body) skipBy(-SKIP)
      else if (e.key === 'ArrowRight' && t === document.body) skipBy(SKIP)
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [p.key])
  // Leaving the lobby never leaves sound behind.
  useEffect(() => () => closePlayer(), [])

  return createPortal(
    <AnimatePresence>
      {p.key && (
        <motion.section
          initial={{ y: 40, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 40, opacity: 0 }}
          transition={{ type: 'spring', stiffness: 420, damping: 36 }}
          className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-panel/95 px-3 pt-2 pb-[max(0.6rem,env(safe-area-inset-bottom))] shadow-[0_-12px_40px_rgba(0,0,0,0.5)] backdrop-blur-2xl sm:px-6"
          aria-label="專案播放器"
          data-lobby-player
        >
          <div className="mx-auto max-w-5xl space-y-2">
            <Timeline project={p.project} position={p.position} length={p.length} playing={p.playing} />
            <div className="flex items-center gap-2 sm:gap-4">
              <div className="min-w-0 flex-1 sm:w-56 sm:flex-none">
                <div className="truncate text-sm font-semibold" data-player-title>
                  🎚 {p.name}
                </div>
                <div className="truncate text-[11px] text-white/40">{p.error ? <span className="text-panic" data-player-error>{p.error}</span> : p.loading ? '載入音檔中…' : p.showName ? `屬於 Set Cue「${p.showName}」` : '獨立 Studio'}</div>
              </div>
              <div className="flex items-center gap-1 sm:flex-1 sm:justify-center">
                <TransportButton label={`倒退 ${SKIP} 秒`} onClick={() => skipBy(-SKIP)} data="back" disabled={!p.project}>
                  <SkipIcon back />
                </TransportButton>
                <button
                  type="button"
                  onClick={togglePlay}
                  disabled={!p.project}
                  className={`flex h-12 w-12 items-center justify-center rounded-full text-black transition disabled:opacity-40 ${p.playing ? 'bg-go' : 'bg-white hover:brightness-90'}`}
                  aria-label={p.playing ? '暫停' : '播放'}
                  data-player-toggle
                >
                  {p.loading ? <Spinner /> : p.playing ? <PauseIcon /> : <PlayIcon />}
                </button>
                <TransportButton label="停止（回到開頭）" onClick={stopPlayback} data="stop" disabled={!p.project}>
                  <span className="block h-3.5 w-3.5 rounded-[2px] bg-current" />
                </TransportButton>
                <TransportButton label={`快轉 ${SKIP} 秒`} onClick={() => skipBy(SKIP)} data="forward" disabled={!p.project}>
                  <SkipIcon />
                </TransportButton>
              </div>
              <div className="hidden font-mono text-xs text-white/60 tabular sm:block" data-player-time>
                {clock(p.position)} <span className="text-white/30">/ {clock(p.length)}</span>
              </div>
              <Volume volume={p.volume} muted={p.muted} />
              <button type="button" onClick={closePlayer} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white/40 hover:bg-white/10 hover:text-white" aria-label="關閉播放器" title="停止並關閉" data-player-close>
                ✕
              </button>
            </div>
          </div>
        </motion.section>
      )}
    </AnimatePresence>,
    document.body,
  )
}

function TransportButton({ label, onClick, disabled, data, children }: { label: string; onClick: () => void; disabled?: boolean; data: string; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className="flex h-10 w-10 items-center justify-center rounded-full text-white/75 hover:bg-white/10 hover:text-white disabled:opacity-30" aria-label={label} title={label} data-player-btn={data}>
      {children}
    </button>
  )
}

/** Overview of the project's tracks and clips, with the playhead; click or drag to seek. */
function Timeline({ project, position, length, playing }: { project: StudioProject | null; position: number; length: number; playing: boolean }) {
  const box = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<number | null>(null)
  const tracks = project ? Object.values(project.tracks).sort((a, b) => a.order - b.order) : []
  const rowOf = new Map(tracks.map((t, i) => [t.id, i]))
  const rows = Math.max(1, tracks.length)
  const span = Math.max(length, 0.001)
  const shown = drag ?? position
  const at = (clientX: number) => {
    const r = box.current!.getBoundingClientRect()
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * span
  }
  const sections = project ? Object.values(project.sections ?? {}) : []
  return (
    <div className="flex items-center gap-2">
      <span className="w-10 shrink-0 text-right font-mono text-[10px] text-white/45 tabular sm:hidden">{clock(shown)}</span>
      <div
        ref={box}
        className="relative h-11 flex-1 cursor-pointer touch-none overflow-hidden rounded-md bg-black/50 ring-1 ring-white/5 select-none"
        onPointerDown={(e) => {
          if (!length) return
          e.currentTarget.setPointerCapture(e.pointerId)
          setDrag(at(e.clientX))
        }}
        onPointerMove={(e) => drag !== null && setDrag(at(e.clientX))}
        onPointerUp={(e) => {
          if (drag === null) return
          seekTo(at(e.clientX))
          setDrag(null)
        }}
        onPointerCancel={() => setDrag(null)}
        role="slider"
        aria-label="時間軸（點擊或拖曳以跳到該位置）"
        aria-valuemin={0}
        aria-valuemax={Math.round(length)}
        aria-valuenow={Math.round(shown)}
        aria-valuetext={`${clock(shown)} / ${clock(length)}`}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') skipBy(-5)
          else if (e.key === 'ArrowRight') skipBy(5)
          else return
          e.preventDefault()
        }}
        data-player-timeline
      >
        {/* played part */}
        <div className="absolute inset-y-0 left-0 bg-go/10" style={{ width: `${(shown / span) * 100}%` }} />
        {sections.map((s) => (
          <div key={s.id} className="absolute inset-y-0 border-l border-white/15" style={{ left: `${(s.start / span) * 100}%` }} title={s.name} />
        ))}
        {project &&
          Object.values(project.regions).map((r) => {
            const row = rowOf.get(r.trackId) ?? 0
            const track = project.tracks[r.trackId]
            return (
              <div
                key={r.id}
                className="absolute rounded-[2px]"
                style={{
                  left: `${(r.start / span) * 100}%`,
                  width: `max(2px, ${(r.duration / span) * 100}%)`,
                  top: `calc(${(row / rows) * 100}% + 2px)`,
                  height: `calc(${100 / rows}% - 3px)`,
                  background: track?.color ?? '#0a84ff',
                  opacity: r.muted || track?.mute ? 0.25 : 0.85,
                }}
                title={r.name}
              />
            )
          })}
        {/* playhead */}
        <div className={`absolute inset-y-0 w-0.5 -translate-x-1/2 bg-white shadow-[0_0_6px_white] ${playing ? '' : 'opacity-80'}`} style={{ left: `${(shown / span) * 100}%` }} data-player-playhead />
      </div>
      <span className="w-10 shrink-0 font-mono text-[10px] text-white/45 tabular sm:hidden">{clock(length)}</span>
    </div>
  )
}

function Volume({ volume, muted }: { volume: number; muted: boolean }) {
  const level = muted ? 0 : volume
  return (
    <div className="flex items-center gap-1.5" data-player-volume>
      <button type="button" onClick={toggleMute} className="flex h-9 w-9 items-center justify-center rounded-lg text-white/70 hover:bg-white/10 hover:text-white" aria-label={muted ? '取消靜音' : '靜音'} aria-pressed={muted} title={muted ? '取消靜音' : '靜音'} data-player-mute>
        <SpeakerIcon level={level} />
      </button>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={level}
        onChange={(e) => setVolume(Number(e.target.value))}
        className="hidden w-24 accent-white sm:block"
        aria-label="音量"
        aria-valuetext={`${Math.round(level * 100)}%`}
        data-player-volume-slider
      />
      <span className="hidden w-8 font-mono text-[10px] text-white/45 tabular sm:block">{Math.round(level * 100)}</span>
    </div>
  )
}

const PlayIcon = () => (
  <svg viewBox="0 0 24 24" className="ml-0.5 h-5 w-5" fill="currentColor" aria-hidden>
    <path d="M7 4.5v15l13-7.5z" />
  </svg>
)
const PauseIcon = () => (
  <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden>
    <rect x="6" y="4.5" width="4" height="15" rx="1" />
    <rect x="14" y="4.5" width="4" height="15" rx="1" />
  </svg>
)
const SkipIcon = ({ back = false }: { back?: boolean }) => (
  <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <g transform={back ? 'matrix(-1 0 0 1 24 0)' : undefined}>
      <path d="M20 12a8 8 0 1 1-2.34-5.66" />
      <path d="M20 3.5V8h-4.5" />
    </g>
    <text x="12" y="15.2" fill="currentColor" stroke="none" fontSize="7" fontWeight="700" textAnchor="middle">
      {SKIP}
    </text>
  </svg>
)
const SpeakerIcon = ({ level }: { level: number }) => (
  <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor" />
    {level === 0 ? (
      <path d="M16 9.5l5 5m0-5l-5 5" />
    ) : (
      <>
        <path d="M15.5 9a4 4 0 0 1 0 6" />
        {level > 0.5 && <path d="M18.5 6.5a7.5 7.5 0 0 1 0 11" />}
      </>
    )}
  </svg>
)
const Spinner = () => <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
