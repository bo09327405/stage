import { useEffect, useState } from 'react'
import { useTheatreEngine } from '../../hooks/useTheatreEngine'
import { stageAudio } from '../../services/audioEngine'
import { useAnnouncePresence } from '../../services/presence'
import { useLivePointer } from '../../services/projects'
import { getAudienceId } from '../../services/uploads'
import { versionPath, type ShowRef } from '../../types/project'
import { StageDisplay } from './StageDisplay'

const canFullscreen = typeof document !== 'undefined' && !!document.documentElement.requestFullscreen

async function enterFullscreen() {
  if (!canFullscreen || document.fullscreenElement) return
  try {
    await document.documentElement.requestFullscreen({ navigationUI: 'hide' })
  } catch {
    // iPhone Safari and some embedded browsers refuse; the page is already full-viewport.
  }
}

// Keep phone screens awake during the show where supported (needs HTTPS).
async function requestWakeLock() {
  try {
    await navigator.wakeLock?.request('screen')
  } catch {
    // Not supported or denied; harmless.
  }
}

/**
 * Audience page. Follows whichever version the console put "on air" (/live), unless the URL
 * pins one with ?project=…&version=… (handy for rehearsing a non-live version on a test phone).
 */
export function AudienceView({ pinned }: { pinned: ShowRef | null }) {
  const live = useLivePointer()
  const show: ShowRef | null = pinned ?? (live ? { projectId: live.projectId, versionId: live.versionId } : null)
  const [audienceId] = useState(getAudienceId)
  useAnnouncePresence(show, audienceId)

  return (
    <div className="fixed inset-0 overflow-hidden bg-black text-white select-none">
      {show ? (
        // Re-mount per version so engine state never leaks between shows.
        <ShowStage key={versionPath(show)} show={show} audienceId={audienceId} />
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-6 px-6 text-center">
          <span className="text-sm tracking-[0.4em] text-white/50">THEATRE</span>
          <p className="text-white/50">{live === undefined ? '連線中…' : '目前沒有上線中的演出'}</p>
          <AudienceCode code={audienceId} large />
        </div>
      )}
    </div>
  )
}

function ShowStage({ show, audienceId }: { show: ShowRef; audienceId: string }) {
  const { showState, connected, serverNow } = useTheatreEngine('audience', { basePath: versionPath(show) })
  const [entered, setEntered] = useState(stageAudio.isUnlocked)
  const [blocked, setBlocked] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)

  useEffect(() => {
    stageAudio.onBlocked = setBlocked
  }, [])

  // Studio-bound cues load their mix from this project; render the standby one ahead of GO.
  useEffect(() => stageAudio.setProject(show.projectId), [show.projectId])
  useEffect(() => stageAudio.prepare(showState.standbyCue), [showState.standbyCue])

  // Feed every state change to the audio engine (it ignores everything until unlocked).
  useEffect(() => {
    stageAudio.sync(showState.active, showState.pausedAt)
  }, [showState.active, showState.pausedAt, entered])

  useEffect(() => {
    stageAudio.setMaster(showState.masterVolume, showState.dim, showState.muted, showState.dimDb)
  }, [showState.masterVolume, showState.dim, showState.muted, showState.dimDb, entered])

  useEffect(() => {
    stageAudio.stopHits(showState.hitStop)
  }, [showState.hitStop])

  // Live effects and fader levels from the console's control panel.
  useEffect(() => stageAudio.setFx(showState.fx), [showState.fx, entered])
  useEffect(() => stageAudio.setLive({ xfade: showState.xfade, hitLevels: showState.hitLevels, execLevels: showState.execLevels }), [showState.xfade, showState.hitLevels, showState.execLevels, entered])

  useEffect(() => {
    stageAudio.playHit(showState.hit)
  }, [showState.hit])

  // Leaving this version (live switched elsewhere) silences whatever it was playing.
  useEffect(() => () => stageAudio.sync({}), [])

  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  // Wake locks are released when the tab is hidden; re-acquire on return.
  useEffect(() => {
    if (!entered) return
    const onVisible = () => document.visibilityState === 'visible' && requestWakeLock()
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [entered])

  const handleEnter = () => {
    // unlock() must run synchronously inside this tap for iOS to allow audio.
    stageAudio.unlock(serverNow, audienceId)
    setEntered(true)
    enterFullscreen()
    requestWakeLock()
  }

  return (
    <>
      {entered ? (
        <StageDisplay showState={showState} serverNow={serverNow} audienceId={audienceId} show={show} />
      ) : (
        <button onClick={handleEnter} className="flex h-full w-full flex-col items-center justify-center gap-6">
          <span className="text-sm tracking-[0.4em] text-white/50">THEATRE</span>
          <span className="rounded-full border border-white/60 px-10 py-4 text-xl tracking-widest">進入演出</span>
          <span className="text-xs text-white/40">請開啟手機聲音（關閉靜音模式）</span>
          <AudienceCode code={audienceId} large />
        </button>
      )}

      {entered && (
        <div className="pointer-events-none absolute top-[max(0.75rem,env(safe-area-inset-top))] left-3">
          <AudienceCode code={audienceId} />
        </div>
      )}

      {entered && blocked && (
        <button
          onClick={() => stageAudio.resume()}
          className="absolute inset-x-0 bottom-8 mx-auto w-fit rounded-full bg-white px-6 py-3 text-sm font-semibold text-black"
        >
          🔊 點一下開啟聲音
        </button>
      )}

      {entered && canFullscreen && !isFullscreen && (
        <button
          onClick={enterFullscreen}
          className="absolute top-3 right-3 rounded px-2 py-1 text-xs text-white/30 hover:text-white/70"
          aria-label="全螢幕"
        >
          ⛶
        </button>
      )}

      {entered && !connected && (
        <div className="absolute bottom-3 left-3 text-xs text-red-400/80">○ 連線中斷，重新連線中…</div>
      )}
    </>
  )
}

/** The device's seat-style code, so audience members can tell the operator who they are. */
function AudienceCode({ code, large = false }: { code: string; large?: boolean }) {
  if (large) {
    return (
      <span className="mt-4 flex flex-col items-center gap-1">
        <span className="text-[10px] tracking-[0.3em] text-white/35">你的識別碼</span>
        <span className="rounded-xl border border-white/20 px-5 py-2 font-mono text-3xl font-bold tracking-[0.35em] text-white/90">
          {code}
        </span>
      </span>
    )
  }
  return (
    <span className="rounded-md bg-white/[0.08] px-2 py-1 font-mono text-[11px] font-semibold tracking-[0.25em] text-white/45">
      {code}
    </span>
  )
}
