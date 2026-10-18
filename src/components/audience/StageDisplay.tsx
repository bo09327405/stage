import { AnimatePresence, motion } from 'motion/react'
import { useServerNow } from '../../hooks/useServerNow'
import { stageAudio } from '../../services/audioEngine'
import {
  activeEndAt,
  activeList,
  activeStartAt,
  cueTargets,
  instanceClock,
  isVisualCue,
  showClock,
  type ActiveCue,
  type ShowState,
} from '../../types/cue'
import type { ShowRef } from '../../types/project'
import { dimGain } from '../../utils/dim'
import { isYoutubeCue } from '../../utils/youtube'
import { InteractiveUpload } from './InteractiveUpload'
import { YouTubeCue } from './YouTubeCue'

/**
 * Which visual instance owns this device's screen at `now`: the newest visual cue addressed to this
 * audience code whose pre-wait has elapsed. A cue that was stopped because a newer visual fired
 * stays up until that newer one actually starts.
 */
function visibleVisual(instances: ActiveCue[], now: number): ActiveCue | null {
  const visuals = instances.filter((a) => isVisualCue(a.cue))
  // Each instance runs on its own clock, frozen while that cue is individually paused.
  const started = visuals.filter((a) => {
    const t = instanceClock(a, now)
    return t >= activeStartAt(a) && t < activeEndAt(a)
  })
  const shown = started[started.length - 1]
  if (!shown) return null
  const replacedByNewer = visuals.some((a) => a.firedAt > shown.firedAt)
  return shown.stopAt != null && !replacedByNewer ? null : shown
}

/** Full-viewport rendering of the live visual cue, crossfading with each cue's own fade times. */
export function StageDisplay({
  showState,
  serverNow,
  audienceId,
  audienceChannel = null,
  show,
  preview = false,
  previewSound = false,
}: {
  showState: ShowState
  serverNow: () => number
  audienceId: string
  /** This device's audience group (channel_n), or null when the show isn't grouped. */
  audienceChannel?: string | null
  show: ShowRef
  /**
   * Console simulation (Stage window): same picture, but videos play muted on their own element
   * (the audience engine's player stays untouched) and upload cues show a static mock-up.
   */
  preview?: boolean
  /** Preview with sound: video plays on the audio engine's element (in sync, audible). */
  previewSound?: boolean
}) {
  // Only cues broadcast to everyone or targeted at this device's code.
  const instances = activeList(showState).filter((a) => cueTargets(a.cue, audienceId, audienceChannel))
  // Coarse ticking is enough to reveal cues after pre-wait and hide them when they end.
  // While paused the clock is frozen, so nothing appears, disappears or advances.
  const liveNow = useServerNow(serverNow, instances.length > 0 && showState.pausedAt == null, 100)
  const now = showClock(showState, liveNow)
  const visual = visibleVisual(instances, now)
  const audioOnly = !visual && instances.some((a) => a.cue.type === 'AUDIO' && a.stopAt == null)

  return (
    <div className="relative h-full">
      <AnimatePresence>
        {visual ? (
          <motion.div
            key={visual.instanceId}
            className="absolute inset-0"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: { duration: visual.cue.fadeInTime } }}
            exit={{ opacity: 0, transition: { duration: visual.cue.fadeOutTime } }}
          >
            <VisualCue inst={visual} show={show} preview={preview && !previewSound} uploadMock={preview} now={now} frozen={showState.pausedAt != null} level={showState.muted ? 0 : (showState.masterVolume / 100) * dimGain(showState.dim, showState.dimDb)} audible={!preview || previewSound} />
          </motion.div>
        ) : audioOnly ? (
          <motion.div
            key="audio"
            className="absolute inset-0 flex items-center justify-center"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <div className="flex h-8 items-end gap-1">
              {[0, 150, 300, 450].map((delay) => (
                <span key={delay} className="w-1.5 animate-eq rounded-full bg-white/40" style={{ animationDelay: `${delay}ms` }} />
              ))}
            </div>
          </motion.div>
        ) : instances.length === 0 ? (
          <motion.div
            key="idle"
            className={`absolute inset-0 flex items-center justify-center tracking-[0.3em] text-white/25 ${preview ? 'text-[11px]' : 'text-sm'}`}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: { delay: 0.5 } }}
            exit={{ opacity: 0 }}
          >
            演出即將開始
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  )
}

function VisualCue({ inst, show, preview, uploadMock, now, frozen, level, audible }: { inst: ActiveCue; show: ShowRef; preview: boolean; uploadMock: boolean; now: number; frozen: boolean; level: number; audible: boolean }) {
  const { cue } = inst
  switch (cue.type) {
    case 'IMAGE':
      return (
        <figure className="relative flex h-full items-center justify-center">
          <img src={cue.targetUrl} alt={cue.text || cue.title} className="h-full w-full object-contain" />
          {cue.text && (
            <figcaption className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-6 pt-12 pb-[max(2rem,env(safe-area-inset-bottom))] text-center text-lg whitespace-pre-line">
              {cue.text}
            </figcaption>
          )}
        </figure>
      )
    case 'TEXT':
      return (
        <div className="flex h-full items-center justify-center px-8 text-center">
          <p className={`leading-snug font-semibold whitespace-pre-line ${preview ? 'text-[clamp(12px,6cqw,40px)]' : 'text-4xl md:text-6xl'}`}>{cue.text || cue.title}</p>
        </div>
      )
    case 'VIDEO':
      // A YouTube link plays in YouTube's embedded player (the audio engine can't carry it).
      if (isYoutubeCue(cue)) return <YouTubeCue inst={inst} clock={instanceClock(inst, now)} paused={frozen || inst.pausedAt != null} level={level} audible={audible} />
      if (preview) return <PreviewVideo inst={inst} now={now} paused={frozen || inst.pausedAt != null} />
      // The audio engine owns the <video> element (so it stays gesture-unlocked); mount it here.
      return (
        <div
          className="h-full w-full bg-black"
          ref={(node) => {
            if (node && stageAudio.videoElement.parentElement !== node) {
              node.appendChild(stageAudio.videoElement)
              // Browsers pause a media element taken out of the page (it may have moved here from
              // another Stage view); let the engine pick it up again if it should be playing.
              if (stageAudio.videoElement.paused) stageAudio.resume()
            }
          }}
        />
      )
    case 'INTERACTIVE_UPLOAD':
      if (uploadMock)
        return (
          <div className="flex h-full flex-col items-center justify-center gap-[4cqw] px-[6cqw] text-center">
            <p className="text-[clamp(11px,5cqw,28px)] font-medium whitespace-pre-line">{cue.text || cue.title}</p>
            <span className="rounded-[3cqw] bg-white px-[6cqw] py-[2.5cqw] text-[clamp(10px,4cqw,20px)] font-semibold text-black">
              {cue.uploadKind === 'audio' ? '🎙 錄音' : cue.uploadKind === 'video' ? '🎬 上傳影片' : '📷 拍照 / 上傳'}
            </span>
            <span className="text-[clamp(9px,3cqw,14px)] text-white/40">觀眾上傳畫面（模擬）</span>
          </div>
        )
      return <InteractiveUpload key={cue.id} cue={cue} show={show} />
    default:
      // BLACKOUT: pure black stage.
      return null
  }
}

/** Muted video for the Stage simulation, kept near the show clock's position in the clip. */
function PreviewVideo({ inst, now, paused }: { inst: ActiveCue; now: number; paused: boolean }) {
  const { cue } = inst
  // Show clock times are in milliseconds; media positions in seconds.
  const elapsed = Math.max(0, instanceClock(inst, now) - activeStartAt(inst)) / 1000
  const position = cue.mediaStartTime + elapsed
  return (
    <video
      src={cue.targetUrl}
      muted
      playsInline
      autoPlay={!paused}
      loop={cue.loop}
      className="h-full w-full bg-black object-contain"
      ref={(el) => {
        if (!el) return
        // Re-sync only on real drift, so playback stays smooth.
        if (el.readyState >= 1 && Math.abs(el.currentTime - position) > 1.5 && Number.isFinite(position)) el.currentTime = position
        if (paused) el.pause()
        else if (el.paused) el.play().catch(() => {})
      }}
      onLoadedMetadata={(e) => {
        e.currentTarget.currentTime = position
      }}
      data-stage-preview-video
    />
  )
}
