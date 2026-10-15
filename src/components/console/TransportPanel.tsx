import { AnimatePresence, motion } from 'motion/react'
import { CUE_TYPE_LABELS, type Cue, type PlaybackState } from '../../types/cue'
import { LiveFader } from '../ui/controls'
import { DimButton } from '../ui/DimButton'
import { dimGain, formatDimDb } from '../../utils/dim'

interface TransportPanelProps {
  playbackState: PlaybackState
  standbyCue: Cue | null
  /** First cue in the list: what GO fires when nothing is on standby. */
  firstCue: Cue | null
  /** Seconds until GO unlocks (preventGoDuration); 0 when unlocked. */
  lockRemaining: number
  lockTotal: number
  masterVolume: number
  dim: boolean
  /** DIM amount shown on the button (the show's while DIM is on, this operator's choice otherwise). */
  dimDb: number
  muted: boolean
  onGo: () => void
  onPause: () => void
  onResume: () => void
  onStop: () => void
  onStopAll: () => void
  /** `undim`: moved while DIM was on — DIM switches off at this new volume. */
  onMasterVolume: (volume: number, undim?: boolean) => void
  onDim: (dim: boolean) => void
  onDimDb: (db: number) => void
  onMute: (muted: boolean) => void
}

const swap = {
  initial: { opacity: 0, y: 10, filter: 'blur(4px)' },
  animate: { opacity: 1, y: 0, filter: 'blur(0px)' },
  exit: { opacity: 0, y: -10, filter: 'blur(4px)' },
  transition: { duration: 0.16 },
}

/**
 * Go Button-style transport. The two big buttons change role with the playback state:
 *   idle     → GO            · Pause (disabled)
 *   playing  → GO            · Pause (yellow)
 *   paused   → Resume (green) · Stop (red)
 */
export function TransportPanel({
  playbackState,
  standbyCue,
  firstCue,
  lockRemaining,
  lockTotal,
  masterVolume,
  dim,
  dimDb,
  muted,
  onGo,
  onPause,
  onResume,
  onStop,
  onStopAll,
  onMasterVolume,
  onDim,
  onDimDb,
  onMute,
}: TransportPanelProps) {
  // What the Master fader shows: the level actually sent out (the fader value itself never changes).
  const effective = masterVolume * dimGain(dim, dimDb)
  const paused = playbackState === 'paused'
  const locked = lockRemaining > 0 && !paused
  const goTarget = standbyCue ?? firstCue
  const primaryEnabled = paused || (!!goTarget && !locked)

  const secondary =
    playbackState === 'paused'
      ? { key: 'stop', label: '■ STOP', hint: '終止所有 Cue 並清空畫面', bg: '#ff453a', fg: '#ffffff', glow: 'rgba(255,69,58,0.55)' }
      : { key: 'pause', label: '❚❚ PAUSE', hint: '暫停音訊、影片與計時 · P', bg: '#ffd60a', fg: '#000000', glow: 'rgba(255,214,10,0.45)' }
  const secondaryEnabled = playbackState !== 'idle'

  return (
    <div className="flex flex-col gap-3 p-4">
      {/* GO / RESUME */}
      <motion.button data-haptic="strong"
        onClick={paused ? onResume : onGo}
        disabled={!primaryEnabled}
        whileTap={primaryEnabled ? { scale: 0.97 } : undefined}
        className={`group relative flex h-44 flex-col items-center justify-center overflow-hidden rounded-3xl transition-colors pointer-coarse:h-52 ${
          primaryEnabled
            ? 'bg-gradient-to-b from-[#3ee26a] to-[#1fae45] text-black shadow-[0_0_60px_-10px_rgba(48,209,88,0.7)]'
            : 'bg-raised text-white/25'
        }`}
      >
        <span className="absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b from-white/25 to-transparent opacity-60" />
        {paused && (
          // Breathing ring so a paused show is impossible to miss.
          <motion.span
            className="absolute inset-0 rounded-3xl ring-4 ring-white/60"
            animate={{ opacity: [0.2, 0.9, 0.2] }}
            transition={{ duration: 1.6, repeat: Infinity }}
          />
        )}
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span key={paused ? 'resume' : 'go'} {...swap} className="relative flex flex-col items-center">
            <span className={`font-extrabold tracking-tight ${paused ? 'text-5xl' : 'text-7xl'}`}>
              {paused ? '▶ RESUME' : 'GO'}
            </span>
            <span className="mt-1 max-w-[85%] truncate text-sm font-semibold opacity-75">
              {paused
                ? '從暫停處繼續 · Space'
                : standbyCue
                  ? `Q${standbyCue.cueNumber} · ${standbyCue.title}`
                  : firstCue
                    ? `未選取 · 按 GO 選取 Q${firstCue.cueNumber}`
                    : 'Cue 清單是空的'}
            </span>
          </motion.span>
        </AnimatePresence>
        {/* preventGoDuration lock: a draining bar along the bottom */}
        <AnimatePresence>
          {locked && (
            <motion.span
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-x-0 bottom-0 flex h-8 items-center justify-center bg-black/60 font-mono text-xs text-standby"
            >
              <span
                className="absolute inset-y-0 left-0 bg-standby/25"
                style={{ width: `${(lockRemaining / Math.max(lockTotal, 0.001)) * 100}%` }}
              />
              <span className="relative tabular">LOCKED {lockRemaining.toFixed(1)}s</span>
            </motion.span>
          )}
        </AnimatePresence>
      </motion.button>

      {/* PAUSE / STOP */}
      <motion.button data-haptic="tap"
        onClick={paused ? onStop : onPause}
        disabled={!secondaryEnabled}
        whileTap={secondaryEnabled ? { scale: 0.97 } : undefined}
        animate={{
          backgroundColor: secondaryEnabled ? secondary.bg : '#232323',
          color: secondaryEnabled ? secondary.fg : 'rgba(255,255,255,0.25)',
          boxShadow: secondaryEnabled ? `0 0 36px -10px ${secondary.glow}` : '0 0 0 0 rgba(0,0,0,0)',
        }}
        transition={{ duration: 0.25 }}
        className="relative flex h-20 flex-col items-center justify-center overflow-hidden rounded-2xl pointer-coarse:h-24"
      >
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span key={secondary.key} {...swap} className="flex flex-col items-center">
            <span className="text-2xl font-extrabold tracking-wider">{secondary.label}</span>
            <span className="text-[11px] font-medium opacity-70">
              {secondaryEnabled ? secondary.hint : '沒有播放中的 Cue'}
            </span>
          </motion.span>
        </AnimatePresence>
      </motion.button>

      {/* Standby detail */}
      <div className="rounded-2xl border border-line bg-panel/80 p-4 backdrop-blur-xl">
        <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold tracking-widest text-standby uppercase">
          <span className="h-1.5 w-1.5 rounded-full bg-standby" /> Standby
        </div>
        {standbyCue ? (
          <>
            <div className="truncate text-lg font-semibold">
              <span className="mr-2 font-mono text-white/50">{standbyCue.cueNumber}</span>
              {standbyCue.title}
            </div>
            <div className="truncate text-xs text-white/40">
              {CUE_TYPE_LABELS[standbyCue.type]}
              {standbyCue.subtitle && ` · ${standbyCue.subtitle}`}
            </div>
          </>
        ) : (
          <div className="text-sm text-white/30">未選取 · 按 GO 選取第一個 Cue，或雙擊清單 / 按 ↑↓</div>
        )}
      </div>

      {/* Master */}
      <div className="rounded-2xl border border-line bg-panel/80 p-4 backdrop-blur-xl">
        <div className="mb-3 flex items-baseline justify-between">
          <span className="text-[11px] font-semibold tracking-widest text-white/50 uppercase">Master</span>
          <span className={`font-mono text-sm tabular ${dim ? 'text-standby' : 'text-white/80'}`} data-master-readout>
            {dim ? (effective < 10 ? effective.toFixed(1) : Math.round(effective)) : masterVolume}
            <span className="text-white/30">%</span>
            {muted && <span className="ml-1.5 text-panic">MUTE</span>}
          </span>
        </div>
        {dim && (
          <div className="-mt-2 mb-2 text-right font-mono text-[11px] text-standby/90" data-dim-readout>
            DIM {formatDimDb(dimDb)}
            <span className="ml-1 text-white/35">· 原 {masterVolume}%</span>
          </div>
        )}
        {/* While DIM is on the fader shows the dimmed level; moving it switches DIM off there. */}
        <LiveFader
          label="Master volume"
          value={effective}
          write={(v) => onMasterVolume(v, dim)}
          fill={muted ? '#ff453a' : dim ? '#ffd60a' : '#f5f5f7'}
        />
        <div className="mt-3 grid grid-cols-2 gap-2">
          <DimButton
            area="console"
            active={dim}
            db={dimDb}
            onToggle={() => onDim(!dim)}
            onDbChange={onDimDb}
            scope="Show Master：所有觀眾裝置與監聽"
            className="min-h-11 rounded-xl text-sm font-bold tracking-widest transition"
            activeClassName="bg-standby text-black shadow-[0_0_24px_-6px_rgba(255,214,10,0.7)]"
            inactiveClassName="bg-white/[0.06] text-white/70 hover:bg-white/10"
          />
          <button
            data-haptic="tap"
            onClick={() => onMute(!muted)}
            className={`min-h-11 rounded-xl text-sm font-bold tracking-widest transition ${
              muted ? 'bg-panic text-white shadow-[0_0_24px_-6px_rgba(255,69,58,0.7)]' : 'bg-white/[0.06] text-white/70 hover:bg-white/10'
            }`}
          >
            MUTE
          </button>
        </div>
      </div>

      {/* Fade everything out (unavailable while paused: time is frozen) */}
      <button
        data-haptic="tap"
        onClick={onStopAll}
        disabled={playbackState !== 'playing'}
        className="min-h-12 rounded-xl bg-white/[0.06] text-sm font-semibold text-white/80 transition hover:bg-white/10 disabled:opacity-30"
      >
        ◢ Fade Out All <span className="ml-1 text-[10px] font-normal text-white/40">Esc</span>
      </button>
    </div>
  )
}
