import { useEffect, useRef, useState } from 'react'
import { activeStartAt, segmentLength, type ActiveCue } from '../../types/cue'
import { YT_HOST, YT_PLAYER_VARS, loadYouTubeApi, youtubeEnvelope, youtubeIdOf, type YTPlayer } from '../../utils/youtube'

/**
 * A YouTube link played with YouTube's official embedded player (IFrame Player API), kept in step with the show
 * clock: starts when the cue starts, follows pause / resume, loops and trims like a video cue, and rides the cue's
 * volume and fades (and Master / DIM / MUTE) through the player's volume. The player is always visible — it is the
 * picture. Autoplay with sound is up to the browser: when it refuses (typically iPhone), a tap button appears.
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
  const [blocked, setBlocked] = useState(false)
  const [needsSound, setNeedsSound] = useState(false)
  const [error, setError] = useState<string | null>(null)
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
    let wasPlaying = false
    const mount = document.createElement('div')
    host.current.appendChild(mount)

    loadYouTubeApi()
      .then((YT) => {
        if (!alive) return
        const player = new YT.Player(mount, {
          host: YT_HOST,
          videoId,
          width: '100%',
          height: '100%',
          playerVars: { ...YT_PLAYER_VARS, autoplay: 0, origin: location.origin },
          events: {
            onReady: (e) => {
              ready.current = true
              e.target.mute() // muted autoplay is what browsers allow; sound is switched on once it plays
            },
            onError: () => setError('這部影片無法嵌入播放（可能被作者限制、已移除或設為私人）'),
          },
        })
        playerRef.current = player
        timer = window.setInterval(() => {
          const p = playerRef.current
          if (!p || !ready.current) return
          const { inst: i, clock: c, paused: halted, level: lv, audible: sound } = latest.current
          const cue = i.cue
          const elapsed = Math.max(0, c - activeStartAt(i)) / 1000
          const segment = segmentLength(cue)
          const into = cue.loop && Number.isFinite(segment) && segment > 0 ? elapsed % segment : elapsed
          const position = cue.mediaStartTime + into
          const volume = Math.round(youtubeEnvelope(i, c) * lv * 100)
          if (volume !== lastVolume) {
            p.setVolume(volume)
            lastVolume = volume
          }
          if (halted) {
            if (p.getPlayerState() === YT.PlayerState.PLAYING) p.pauseVideo()
            wasPlaying = false
            return
          }
          const state = p.getPlayerState()
          if (state !== YT.PlayerState.PLAYING && state !== YT.PlayerState.BUFFERING) {
            if (Date.now() - lastAttempt > 800) {
              lastAttempt = Date.now()
              p.seekTo(position, true)
              p.playVideo()
            } else if (Date.now() - lastAttempt > 2500) setBlocked(true)
            wasPlaying = false
            return
          }
          setBlocked(false)
          if (Math.abs(p.getCurrentTime() - position) > 1.5) p.seekTo(position, true)
          if (!wasPlaying) {
            wasPlaying = true
            if (sound) {
              p.unMute()
              window.setTimeout(() => alive && playerRef.current?.isMuted() && setNeedsSound(true), 700)
            }
          }
          if (!sound && !p.isMuted()) p.mute()
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

  return (
    <div className="relative flex h-full w-full items-center justify-center bg-black" data-youtube-cue={videoId}>
      <div ref={host} className={`aspect-video max-h-full w-full [&_iframe]:h-full [&_iframe]:w-full ${blocked ? '' : '[&_iframe]:pointer-events-none'}`} />
      {error && <p className="absolute inset-x-4 top-1/2 -translate-y-1/2 rounded-xl bg-black/80 p-3 text-center text-sm text-white/70">{error}</p>}
      {!error && blocked && (
        <button type="button" onClick={() => playerRef.current?.playVideo()} className="absolute bottom-6 rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-black shadow-lg" data-youtube-play>
          ▶ 點一下播放
        </button>
      )}
      {!error && !blocked && needsSound && audible && (
        <button
          type="button"
          onClick={() => {
            playerRef.current?.unMute()
            setNeedsSound(false)
          }}
          className="absolute bottom-6 rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-black shadow-lg"
          data-youtube-sound
        >
          🔊 點一下開啟聲音
        </button>
      )}
    </div>
  )
}
