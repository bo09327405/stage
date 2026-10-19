import { useEffect, useRef, useState } from 'react'
import type { ActiveCue } from '../../types/cue'
import { YT_HOST, YT_PLAYER_VARS, YT_STATE, isAutoplayBlocked, loadYouTubeApi, youtubeEnvelope, youtubeErrorMessage, youtubeIdOf, youtubePosition, type YTPlayer } from '../../utils/youtube'

/**
 * A YouTube link played with YouTube's official embedded player (IFrame Player API), kept in step with the show
 * clock: starts when the cue starts, follows pause / resume, loops and trims like a video cue, and rides the cue's
 * volume and fades (and Master / DIM / MUTE) through the player's volume.
 *
 *  · Command queue — GO can arrive while the player is still loading. The request is remembered (`wantPlay`) and the
 *    moment the player reports ready it is carried out at the position the show clock says by then, so GO is never lost
 *    to loading time.
 *  · Tap to start — phones refuse autoplay. After a few start attempts with no playback, a centred button appears;
 *    tapping it runs unMute + seek + play inside the user's gesture, which unlocks media playback for good.
 *  · No covers — nothing of ours sits over the video once it is buffering / playing: overlays are removed (and while
 *    waiting they never block the player's own controls underneath).
 */
export function YouTubeCue({
  inst,
  clock,
  paused,
  level,
  audible,
}: {
  inst: ActiveCue
  /** This instance's clock, ms (frozen while paused). */
  clock: number
  paused: boolean
  /** Show-wide level 0–1: Master × DIM, 0 when muted. */
  level: number
  /** False for a silent preview (the Stage simulation without sound). */
  audible: boolean
}) {
  const host = useRef<HTMLDivElement>(null)
  const playerRef = useRef<YTPlayer | null>(null)
  const ready = useRef(false)
  const latest = useRef({ inst, clock, paused, level, audible })
  // 'loading' until the player is ready, 'waiting' = ready but not playing yet, 'playing' = buffering / playing.
  const [phase, setPhase] = useState<'loading' | 'waiting' | 'playing'>('loading')
  const [blocked, setBlocked] = useState(false)
  const [needsSound, setNeedsSound] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Shown only while stuck: what the player reports, so a phone that won't start can be diagnosed.
  const [debug, setDebug] = useState('')
  useEffect(() => {
    latest.current = { inst, clock, paused, level, audible }
  })

  const videoId = youtubeIdOf(inst.cue.targetUrl)

  useEffect(() => {
    if (!videoId || !host.current) return
    let alive = true
    let timer = 0
    let lastVolume = -1
    let lastAttempt = 0
    let firstAttempt = 0
    let attempts = 0
    let announcedSound = false
    // The command queue: a play request made before the player is ready, carried out on onReady.
    let wantPlay = true
    const mount = document.createElement('div')
    host.current.appendChild(mount)

    const stopWaiting = () => {
      attempts = 0
      firstAttempt = 0
      setBlocked(false)
    }

    /** One step of keeping the player in line with the show clock (also run right away on ready). */
    const sync = (YT: { PlayerState: typeof YT_STATE }) => {
      const p = playerRef.current
      if (!p || !ready.current) return
      const { inst: i, clock: c, paused: halted, level: lv, audible: sound } = latest.current
      const position = youtubePosition(i, c)
      const volume = Math.round(youtubeEnvelope(i, c) * lv * 100)
      if (volume !== lastVolume) {
        p.setVolume(volume)
        lastVolume = volume
      }
      if (halted) {
        if (p.getPlayerState() === YT.PlayerState.PLAYING) p.pauseVideo()
        wantPlay = false
        return
      }
      wantPlay = true
      const state = p.getPlayerState()
      if (state !== YT.PlayerState.PLAYING && state !== YT.PlayerState.BUFFERING) {
        const now = Date.now()
        if (now - lastAttempt >= 700) {
          lastAttempt = now
          if (!firstAttempt) firstAttempt = now
          attempts++
          p.seekTo(position, true)
          p.playVideo()
        }
        if (isAutoplayBlocked(attempts, now - firstAttempt)) setBlocked(true)
        return
      }
      if (Math.abs(p.getCurrentTime() - position) > 1.5) p.seekTo(position, true)
      if (sound && !announcedSound) {
        announcedSound = true
        p.unMute()
        window.setTimeout(() => alive && playerRef.current?.isMuted() && setNeedsSound(true), 700)
      }
      if (!sound && !p.isMuted()) p.mute()
    }

    loadYouTubeApi()
      .then((YTApi) => {
        if (!alive) return
        const YT = YTApi as unknown as { PlayerState: typeof YT_STATE }
        const player = new YTApi.Player(mount, {
          host: YT_HOST,
          videoId,
          width: '100%',
          height: '100%',
          playerVars: { ...YT_PLAYER_VARS, autoplay: 0, origin: location.origin },
          events: {
            onReady: (e) => {
              if (!alive) return
              ready.current = true
              e.target.mute() // muted autoplay is what browsers allow; sound is switched on once it plays
              setPhase((ph) => (ph === 'loading' ? 'waiting' : ph))
              // Queue flush: a GO that arrived while loading plays now, at the position the clock says by now.
              if (wantPlay) sync(YT)
            },
            onStateChange: (e) => {
              if (!alive) return
              if (e.data === YT_STATE.PLAYING || e.data === YT_STATE.BUFFERING) {
                // Playback has started: every overlay of ours goes away.
                stopWaiting()
                setPhase('playing')
              } else if (e.data === YT_STATE.ENDED || e.data === YT_STATE.UNSTARTED || e.data === YT_STATE.CUED) {
                setPhase((ph) => (ph === 'playing' && e.data === YT_STATE.ENDED ? 'playing' : 'waiting'))
              }
            },
            onError: (e) => setError(youtubeErrorMessage(e.data)),
          },
        })
        playerRef.current = player
        timer = window.setInterval(() => {
          sync(YT)
          const p = playerRef.current
          setDebug(p && ready.current ? `ready · state ${p.getPlayerState()} · 嘗試 ${attempts} 次` : '播放器載入中')
        }, 250)
      })
      .catch((err: Error) => alive && setError(err.message))

    return () => {
      alive = false
      window.clearInterval(timer)
      ready.current = false
      try {
        playerRef.current?.destroy()
      } catch {
        // Already gone.
      }
      playerRef.current = null
      mount.remove()
    }
  }, [videoId])

  /** The tap: unlocks playback with the user's gesture — unMute + seek + play, all in this handler. */
  const startByTap = () => {
    const p = playerRef.current
    if (!p) return
    const { inst: i, clock: c, level: lv } = latest.current
    p.unMute()
    p.setVolume(Math.round(youtubeEnvelope(i, c) * lv * 100))
    p.seekTo(youtubePosition(i, c), true)
    p.playVideo()
    setNeedsSound(false)
    setBlocked(false)
  }

  const tapUnblock = blocked && phase !== 'playing'
  return (
    <div className="relative flex h-full w-full items-center justify-center bg-black" data-youtube-cue={videoId} data-youtube-phase={phase}>
      {/* While waiting on a phone the player itself takes taps (its own big play button); otherwise it is just the picture. */}
      <div ref={host} className={`aspect-video max-h-full w-full [&_iframe]:h-full [&_iframe]:w-full ${tapUnblock ? '' : '[&_iframe]:pointer-events-none'}`} />
      {error && <p className="absolute inset-x-4 top-1/2 -translate-y-1/2 rounded-xl bg-black/80 p-3 text-center text-sm text-white/70">{error}</p>}
      {!error && phase === 'loading' && <span className="pointer-events-none absolute bottom-3 text-[11px] text-white/35">載入播放器…</span>}
      {!error && phase !== 'playing' && <span className="pointer-events-none absolute bottom-1 left-2 font-mono text-[9px] text-white/25" data-youtube-debug>YT {debug}</span>}
      {!error && tapUnblock && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/30" data-youtube-overlay>
          <button
            type="button"
            onClick={startByTap}
            className="pointer-events-auto rounded-full bg-white/85 px-7 py-4 text-base font-bold text-black shadow-2xl backdrop-blur active:scale-95"
            data-youtube-play
          >
            ▶ 點擊以啟動演出畫面
          </button>
        </div>
      )}
      {!error && phase === 'playing' && needsSound && audible && (
        <button type="button" onClick={startByTap} className="absolute bottom-6 rounded-full bg-white/85 px-5 py-2.5 text-sm font-semibold text-black shadow-lg backdrop-blur" data-youtube-sound>
          🔊 點一下開啟聲音
        </button>
      )}
    </div>
  )
}
