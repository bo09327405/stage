import { useEffect, useRef, useState } from 'react'
import { formatTime } from '../../hooks/useServerNow'
import { YT_HOST, loadYouTubeApi, youtubeIdOf, type YTPlayer } from '../../utils/youtube'

/**
 * Cue editor for a YouTube link: the official player with its own controls (to find the moment), the length it
 * reports back, and set-start / set-end buttons. Waveform and fade handles belong to files; a YouTube cue follows
 * the cue's volume, fade times, trim and loop through the embedded player.
 */
export function YouTubePreview({
  url,
  start,
  end,
  onTrim,
  onDuration,
}: {
  url: string
  start: number
  end: number
  onTrim: (start: number, end: number) => void
  onDuration: (seconds: number) => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const player = useRef<YTPlayer | null>(null)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const latest = useRef({ onDuration })
  useEffect(() => {
    latest.current = { onDuration }
  })
  const id = youtubeIdOf(url)

  useEffect(() => {
    if (!id || !host.current) return
    let alive = true
    let timer = 0
    const mount = document.createElement('div')
    host.current.appendChild(mount)
    loadYouTubeApi()
      .then((YT) => {
        if (!alive) return
        player.current = new YT.Player(mount, {
          host: YT_HOST,
          videoId: id,
          width: '100%',
          height: '100%',
          playerVars: { rel: 0, modestbranding: 1, playsinline: 1, controls: 1, enablejsapi: 1, origin: location.origin },
          events: {
            onReady: (e) => {
              const d = e.target.getDuration()
              if (d > 0) {
                setDuration(d)
                latest.current.onDuration(Math.round(d * 100) / 100)
              }
            },
            onError: () => setError('這部影片無法嵌入播放（可能被作者限制、已移除或設為私人）'),
          },
        })
        timer = window.setInterval(() => {
          try {
            setTime(player.current?.getCurrentTime() ?? 0)
            const d = player.current?.getDuration() ?? 0
            if (d > 0) setDuration((prev) => (prev === d ? prev : d))
          } catch {
            // Player not ready yet.
          }
        }, 300)
      })
      .catch((err: Error) => alive && setError(err.message))
    return () => {
      alive = false
      window.clearInterval(timer)
      try {
        player.current?.destroy()
      } catch {
        // Already gone.
      }
      player.current = null
      mount.remove()
    }
  }, [id])

  const round = (s: number) => Math.round(s * 100) / 100
  return (
    <div className="space-y-3" data-youtube-preview>
      <div ref={host} className="aspect-video w-full overflow-hidden rounded-xl bg-black [&_iframe]:h-full [&_iframe]:w-full" />
      {error && <p className="text-xs text-panic">{error}</p>}
      <div className="flex items-center justify-between font-mono text-xs text-white/50 tabular">
        <span>
          IN <span className="text-standby">{formatTime(start)}</span>
        </span>
        <span className="text-white/80">▸ {formatTime(time)}</span>
        <span>
          OUT <span className="text-standby">{end > 0 ? formatTime(end) : duration ? formatTime(duration) : '—'}</span>
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <button type="button" onClick={() => time < (end || Infinity) - 0.1 && onTrim(round(time), end)} className="min-h-12 rounded-xl bg-white/[0.06] text-sm font-medium text-white/80 active:bg-white/15">
          ⇤ 設為起點
        </button>
        <button type="button" onClick={() => time > start + 0.1 && onTrim(start, duration && time >= duration - 0.05 ? 0 : round(time))} className="min-h-12 rounded-xl bg-white/[0.06] text-sm font-medium text-white/80 active:bg-white/15">
          設為終點 ⇥
        </button>
      </div>
      <p className="text-[11px] leading-relaxed text-white/40">
        YouTube 以官方嵌入播放器播放：畫面一定會顯示，是否出現廣告由 YouTube 決定；演出時需要網路。音量與淡入淡出會跟著 Cue 設定（透過播放器音量調整，不如音檔精準）。
      </p>
    </div>
  )
}
