import { useEffect, useRef, useState } from 'react'
import { useAudienceChannel } from '../../hooks/useAudienceChannel'
import { useVibrationCues } from '../../hooks/useVibrationCues'
import { useAudienceVoice } from '../../services/audienceVoice'
import { audiencePushStatus, disableAudiencePush, enableAudiencePush, syncAudiencePush, type AudiencePushStatus } from '../../services/audiencePush'
import { channelColor, channelLabel, reachesChannel, type Announcement } from '../../types/channels'
import { GroupPicker } from './GroupPicker'
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
  const { showState, connected, serverNow, loaded } = useTheatreEngine('audience', { basePath: versionPath(show) })
  // Audience group (Ch 1 … Ch N): chosen on this device, valid for the current grouping only.
  const grouping = useAudienceChannel(show.projectId, showState.channels, audienceId)
  const { channel } = grouping
  useAnnouncePresence(show, audienceId, channel)
  useEffect(() => stageAudio.setChannel(channel), [channel])
  const [entered, setEntered] = useState(stageAudio.isUnlocked)
  // Vibration cues and Pre-Wait reminders (motor on Android, Web Audio thumps on iPhone).
  useVibrationCues(showState, serverNow, audienceId, channel, entered)
  // Live voice from the operator to this group (receive-only; needs the page's tap to be allowed to play).
  const voice = useAudienceVoice(versionPath(show), audienceId, entered)
  const [banner, setBanner] = useState<Announcement | null>(null)
  const seenAnnounce = useRef<string | null | undefined>(undefined)
  const [pushState, setPushState] = useState<AudiencePushStatus>(() => audiencePushStatus())
  const [pushError, setPushError] = useState<string | null>(null)
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
  }, [showState.active, showState.pausedAt, entered, channel])

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

  // One-way announcements from the operator: chime, vibration, spoken text and an on-screen banner.
  // The first snapshot is only a baseline, so an old announcement doesn't replay on every load.
  useEffect(() => {
    if (!loaded) return
    const a = showState.announce
    if (seenAnnounce.current === undefined) {
      seenAnnounce.current = a?.id ?? null
      return
    }
    if (!a || a.id === seenAnnounce.current) return
    seenAnnounce.current = a.id
    if (serverNow() - a.at > 30_000 || !reachesChannel([a.channel], channel)) return
    setBanner(a)
    if (a.tone) stageAudio.chime()
    if (a.vibrate) navigator.vibrate?.([300, 120, 300, 120, 600])
    if (a.speak && a.text && 'speechSynthesis' in window) {
      const u = new SpeechSynthesisUtterance(a.text)
      u.lang = 'zh-TW'
      window.speechSynthesis.cancel()
      window.speechSynthesis.speak(u)
    }
    const timer = window.setTimeout(() => setBanner((b) => (b?.id === a.id ? null : b)), 9000)
    return () => window.clearTimeout(timer)
  }, [showState.announce, loaded, channel, serverNow])

  // Keep the stored push subscription pointing at this device's current group.
  useEffect(() => {
    syncAudiencePush(show, audienceId, channel ?? 'channel_all').catch(() => {})
  }, [show, audienceId, channel])

  // Tap = the gesture browsers need: ask for notification permission (background vibration / announcements).
  const askNotifications = (group: string | null) => {
    if (audiencePushStatus() !== 'off') return
    enableAudiencePush(show, audienceId, group ?? 'channel_all')
      .catch(() => {})
      .finally(() => setPushState(audiencePushStatus()))
  }

  const handleEnter = () => {
    askNotifications(channel)
    // unlock() must run synchronously inside this tap for iOS to allow audio.
    stageAudio.unlock(serverNow, audienceId)
    // Speech needs one utterance started inside a tap on iPhone before later announcements may speak.
    try {
      window.speechSynthesis?.speak(new SpeechSynthesisUtterance(''))
    } catch {
      // No speech support; announcements still chime and show.
    }
    setEntered(true)
    enterFullscreen()
    requestWakeLock()
  }

  if (!loaded) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-white/50">
        <span className="text-sm tracking-[0.4em]">THEATRE</span>
        <span className="text-sm">連線中…</span>
      </div>
    )
  }
  // Grouped show and no valid group yet: pick one first (a ?group=N link only needs a confirming tap).
  if (grouping.needsPick) {
    return (
      <GroupPicker
        count={showState.channels.count}
        linked={grouping.linked}
        current={grouping.switching ? channel : null}
        onPick={(group) => {
          askNotifications(group)
          grouping.choose(group)
        }}
        onCancel={grouping.switching ? grouping.cancelSwitch : undefined}
      />
    )
  }

  const groupBadge = channel && (
    <span
      className="pointer-events-auto flex items-center gap-2 rounded-full border-2 px-4 py-1.5 text-sm font-bold shadow-lg backdrop-blur"
      style={{ borderColor: channelColor(channel), background: `${channelColor(channel)}26`, color: '#fff' }}
      data-audience-group={channel}
    >
      📍 您已加入：{channelLabel(channel).replace('Ch ', '第 ')}{channel ? ' 組' : ''}
      {grouping.assigned && <span className="rounded-full bg-white/20 px-2 py-0.5 text-[11px] font-semibold">由工作人員指派</span>}
      {grouping.canSwitch && (
        <button type="button" onClick={(e) => {
            e.stopPropagation()
            grouping.startSwitch()
          }} className="ml-1 min-h-8 rounded-full bg-white/25 px-3 text-xs font-semibold" data-audience-switch>
          換組
        </button>
      )}
    </span>
  )

  return (
    <>
      {entered ? (
        <StageDisplay showState={showState} serverNow={serverNow} audienceId={audienceId} audienceChannel={channel} show={show} />
      ) : (
        <div role="button" tabIndex={0} onClick={handleEnter} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && handleEnter()} className="flex h-full w-full cursor-pointer flex-col items-center justify-center gap-6">
          <span className="text-sm tracking-[0.4em] text-white/50">THEATRE</span>
          <span className="rounded-full border border-white/60 px-10 py-4 text-xl tracking-widest">進入演出</span>
          <span className="text-xs text-white/40">請開啟手機聲音（關閉靜音模式）</span>
          {groupBadge}
          <AudienceCode code={audienceId} large />
        </div>
      )}

      {entered && (
        <div className="pointer-events-none absolute top-[max(0.75rem,env(safe-area-inset-top))] left-3">
          <AudienceCode code={audienceId} />
        </div>
      )}
      {entered && groupBadge && (
        <div className="pointer-events-none absolute inset-x-0 top-[max(2.75rem,calc(env(safe-area-inset-top)+2rem))] flex justify-center px-3">{groupBadge}</div>
      )}

      {/* Connection light: green = live; amber = reconnecting (Firebase retries on its own) */}
      {entered && (
        <span
          className={`pointer-events-none absolute top-[max(0.9rem,env(safe-area-inset-top))] right-12 flex items-center gap-1.5 text-[10px] ${connected ? 'text-go/80' : 'text-standby'}`}
          data-audience-connection={connected ? 'online' : 'offline'}
        >
          <span className={`h-2 w-2 rounded-full ${connected ? 'bg-go' : 'animate-pulse bg-standby'}`} />
          {connected ? '已連線' : '重新連線中…'}
        </span>
      )}

      {entered && voice.connected && (
        <span className="pointer-events-none absolute inset-x-0 bottom-[max(4.5rem,calc(env(safe-area-inset-bottom)+3.5rem))] mx-auto w-fit rounded-full bg-black/60 px-3 py-1 text-[11px] text-white/60 backdrop-blur" data-audience-voice="connected">
          🎙 現場語音已連線（只收聽）
        </span>
      )}

      {/* Background alerts (notification + vibration while the page is hidden / phone locked) */}
      {entered && (pushState === 'off' || pushState === 'on' || pushState === 'needs-install') && (
        <div className="absolute inset-x-0 bottom-[max(1rem,env(safe-area-inset-bottom))] flex flex-col items-center gap-1 px-4">
          {pushState === 'needs-install' ? (
            <p className="max-w-xs rounded-lg bg-black/60 px-3 py-2 text-center text-[11px] leading-relaxed text-white/50">🔔 想在鎖屏時也收到震動通知：Safari「分享 → 加入主畫面」後，從主畫面開啟（iOS 16.4+）</p>
          ) : (
            <button
              type="button"
              onClick={async () => {
                setPushError(null)
                try {
                  if (pushState === 'on') await disableAudiencePush(show, audienceId)
                  else await enableAudiencePush(show, audienceId, channel ?? 'channel_all')
                } catch (err) {
                  setPushError((err as Error).message)
                }
                setPushState(audiencePushStatus())
              }}
              className={`min-h-11 rounded-full px-5 text-xs font-semibold ${pushState === 'on' ? 'bg-white/10 text-white/50' : 'bg-white/90 text-black'}`}
              data-audience-push
            >
              {pushState === 'on' ? '🔔 背景通知已開啟' : '🔔 開啟背景通知與震動'}
            </button>
          )}
          {pushError && <span className="text-[11px] text-red-400">{pushError}</span>}
        </div>
      )}

      {/* Announcement from the operator */}
      {banner && (
        <button
          type="button"
          onClick={() => setBanner(null)}
          className="absolute inset-x-3 top-[max(5rem,calc(env(safe-area-inset-top)+4rem))] z-20 rounded-2xl border border-white/30 bg-black/80 p-4 text-left shadow-2xl backdrop-blur-xl"
          data-audience-announcement
        >
          <span className="text-[11px] font-bold tracking-widest text-standby">📢 現場通知</span>
          <span className="mt-1 block text-lg font-semibold text-white">{banner.text || '請看畫面'}</span>
        </button>
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
        <div className="absolute bottom-[max(0.75rem,env(safe-area-inset-bottom))] left-3 text-xs text-red-400/80">○ 連線中斷，重新連線中…</div>
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
