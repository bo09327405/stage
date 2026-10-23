import { useEffect, useRef } from 'react'
import { VjEngine, type VjRenderLayer } from '../../services/vjEngine'
import { clipPosition, layerGain, type VjMix } from '../../types/vj'

type Source = { el: HTMLImageElement | HTMLVideoElement; video: boolean; retried?: boolean }

/** The same address with a throw-away query, so a copy cached WITHOUT CORS headers (by a plain <img>) isn't reused. */
const bust = (url: string) => (/^(blob|data):/.test(url) ? url : `${url}${url.includes('?') ? '&' : '?'}cors=${Date.now().toString(36)}`)

/** Sync tolerance: seeking a playing video is visible, so only correct real drift. */
const DRIFT = 0.5

/**
 * Renders a VJ mix with the WebGL 2 engine, filling its container.
 *  · mode 'audience': the real output (projection / phones). Clips marked "audio" play their sound.
 *  · mode 'preview': console monitor and Stage simulation (always silent).
 * Clip timing follows `clock` (server ms) from each layer's trigger time, so every device shows the same frame.
 * `origin` is the start time for layers without one (a cue's clips start when the cue does).
 */
export function VjStage({
  mix,
  clock,
  origin = 0,
  mode,
  paused = false,
  level = 1,
  onError,
  className = '',
}: {
  mix: VjMix
  clock: () => number
  origin?: number
  mode: 'audience' | 'preview'
  paused?: boolean
  /** 0 … 1, applied to clip sound (master volume, DIM). */
  level?: number
  onError?: (message: string) => void
  className?: string
}) {
  const wrap = useRef<HTMLDivElement>(null)
  const latest = useRef({ mix, clock, origin, mode, paused, level })
  useEffect(() => {
    latest.current = { mix, clock, origin, mode, paused, level }
  })

  useEffect(() => {
    const box = wrap.current
    if (!box) return
    // A canvas of its own per run: a disposed WebGL context can't be reused (React may run effects twice).
    const canvas = document.createElement('canvas')
    canvas.className = 'absolute inset-0 h-full w-full'
    box.prepend(canvas)
    let engine: VjEngine
    try {
      engine = new VjEngine(canvas)
    } catch (err) {
      canvas.remove()
      onError?.((err as Error).message)
      return
    }
    let frame = 0
    let alive = true
    const started = performance.now()
    const sources = new Map<string, Source>()
    /** Smoothed fader values: remote updates arrive a few times a second, the picture moves every frame. */
    const smooth = { gains: [0, 0, 0], master: 1 }

    const fit = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      let w = box.clientWidth * dpr
      let h = box.clientHeight * dpr
      // Four full-screen targets and several passes per layer: keep the pixel count in check on big screens.
      const area = w * h
      if (area > 2_100_000) {
        const k = Math.sqrt(2_100_000 / area)
        w *= k
        h *= k
      }
      engine.setSize(w, h)
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(box)

    const source = (layer: number, url: string, isVideo: boolean): Source => {
      const key = `${layer}:${isVideo ? 'v' : 'i'}:${url}`
      let s = sources.get(key)
      if (!s) {
        if (isVideo) {
          const v = document.createElement('video')
          v.crossOrigin = 'anonymous'
          v.muted = true
          v.playsInline = true
          v.preload = 'auto'
          v.src = url
          const entry: Source = { el: v, video: true }
          v.addEventListener('error', () => {
            if (!entry.retried) {
              entry.retried = true
              v.src = bust(url)
            } else onError?.('無法讀取這支影片（網址失效，或不允許跨網站讀取）')
          })
          s = entry
        } else {
          const img = new Image()
          img.crossOrigin = 'anonymous'
          const entry: Source = { el: img, video: false }
          img.onerror = () => {
            if (!entry.retried) {
              entry.retried = true
              img.src = bust(url)
            } else onError?.('無法讀取這張圖片（網址失效，或不允許跨網站讀取）')
          }
          img.src = url
          s = entry
        }
        sources.set(key, s)
      }
      return s
    }

    const tick = () => {
      if (!alive) return
      frame = requestAnimationFrame(tick)
      const { mix: m, clock: now, origin: o, mode: md, paused: halted, level: lvl } = latest.current
      const t = (performance.now() - started) / 1000
      const layers: VjRenderLayer[] = []
      const keep = new Set<string>()
      const nowMs = now()

      m.layers.forEach((layer, i) => {
        const clip = layer.clip
        const target = clip ? layerGain(layer, m.crossfader) : 0
        smooth.gains[i] += (target - smooth.gains[i]) * 0.4
        if (Math.abs(target - smooth.gains[i]) < 0.002) smooth.gains[i] = target
        if (!clip) return
        const isVideo = clip.mediaKind === 'video'
        const s = source(i, clip.src, isVideo)
        keep.add(`${i}:${isVideo ? 'v' : 'i'}:${clip.src}`)
        let ended = false
        let ready = false
        let w = 0
        let h = 0
        if (s.video) {
          const v = s.el as HTMLVideoElement
          w = v.videoWidth
          h = v.videoHeight
          ready = v.readyState >= 2 && w > 0
          const elapsed = (nowMs - (layer.startedAt || o)) / 1000
          const { position, ended: done } = clipPosition(clip, elapsed, Number.isFinite(v.duration) ? v.duration : 0)
          ended = done
          // Sound: only the real output, only clips that ask for it; a browser that refuses falls back to silent.
          const wantSound = md === 'audience' && clip.audio && lvl > 0
          v.volume = Math.min(1, Math.max(0, target * lvl))
          if (v.muted === wantSound) v.muted = !wantSound
          v.loop = clip.playMode === 'loop'
          v.playbackRate = clip.speed
          if (halted || ended || (clip.playMode === 'hold' && v.duration > 0 && position >= v.duration - 0.05)) {
            if (!v.paused) v.pause()
            if (v.readyState >= 1 && Math.abs(v.currentTime - position) > 0.05) v.currentTime = position
          } else if (v.readyState >= 1) {
            let drift = Math.abs(v.currentTime - position)
            // A looping clip is the same frame just before and after its wrap point.
            if (clip.playMode === 'loop' && v.duration > 0) drift = Math.min(drift, v.duration - drift)
            if (drift > DRIFT) v.currentTime = position
            if (v.paused)
              v.play().catch(() => {
                if (!v.muted) v.muted = true
                v.play().catch(() => {})
              })
          }
        } else {
          const img = s.el as HTMLImageElement
          w = img.naturalWidth
          h = img.naturalHeight
          ready = img.complete && w > 0
        }
        layers.push({
          key: `${i}:${isVideo ? 'v' : 'i'}:${clip.src}`,
          source: ready && !ended ? s.el : null,
          width: w,
          height: h,
          dynamic: s.video,
          opacity: smooth.gains[i],
          blend: layer.blend,
          fx: layer.fx,
        })
      })

      // Retire media no layer plays any more.
      for (const [key, s] of sources) {
        if (keep.has(key)) continue
        if (s.video) {
          const v = s.el as HTMLVideoElement
          v.pause()
          v.removeAttribute('src')
          v.load()
        }
        sources.delete(key)
      }

      smooth.master += (m.master - smooth.master) * 0.4
      try {
        engine.render({ layers, masterFx: m.masterFx, master: smooth.master, time: t })
      } catch (err) {
        alive = false
        cancelAnimationFrame(frame)
        onError?.((err as Error).message)
      }
    }
    frame = requestAnimationFrame(tick)

    return () => {
      alive = false
      cancelAnimationFrame(frame)
      observer.disconnect()
      for (const s of sources.values()) {
        if (s.video) {
          const v = s.el as HTMLVideoElement
          v.pause()
          v.removeAttribute('src')
          v.load()
        }
      }
      sources.clear()
      engine.dispose()
      canvas.remove()
    }
    // The engine lives as long as the component; everything else is read from `latest`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return <div ref={wrap} className={`relative h-full w-full bg-black ${className}`} data-vj-stage={mode} />
}
