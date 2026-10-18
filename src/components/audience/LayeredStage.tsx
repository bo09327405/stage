import { useEffect, useRef, useState } from 'react'
import { stageAudio } from '../../services/audioEngine'
import { Compositor, type RenderLayer } from '../../services/visualCompositor'
import type { Cue } from '../../types/cue'
import { type CueVisual, NO_ADJUST } from '../../types/visual'

type Source = { el: HTMLImageElement | HTMLVideoElement; video: boolean }

const hexToRgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.slice(1), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

/**
 * Renders a cue's layers, masks, grading and effects with the WebGL compositor, filling its container.
 *  · mode 'audience': the real thing (the audience device / projection); a VIDEO base is the audio engine's own
 *    element, so its sound and timing are untouched.
 *  · mode 'preview': the Stage simulation (silent, kept near the show clock).
 *  · mode 'editor': the cue editor's live preview (silent, looping).
 * Falls back (onError) to the plain display when WebGL isn't available.
 */
export function LayeredStage({
  cue,
  visual,
  mode,
  position = 0,
  paused = false,
  onError,
  className = '',
}: {
  cue: Cue
  visual: CueVisual
  mode: 'audience' | 'preview' | 'editor'
  /** Preview: where the base video should be (seconds into the file). */
  position?: number
  paused?: boolean
  onError?: (message: string) => void
  className?: string
}) {
  const wrap = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sources = useRef(new Map<string, Source>())
  const [, bump] = useState(0)
  const latest = useRef({ cue, visual, mode, position, paused })
  const dirty = useRef(true)
  useEffect(() => {
    latest.current = { cue, visual, mode, position, paused }
    dirty.current = true
  })

  useEffect(() => {
    const canvas = canvasRef.current
    const box = wrap.current
    if (!canvas || !box) return
    let comp: Compositor
    try {
      comp = new Compositor(canvas)
    } catch (err) {
      onError?.((err as Error).message)
      return
    }
    let frame = 0
    let alive = true
    const started = performance.now()
    const map = sources.current

    const fit = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      let w = box.clientWidth * dpr
      let h = box.clientHeight * dpr
      // Keep the pixel count in check on big screens (the shaders are per-pixel).
      const area = w * h
      if (area > 2_400_000) {
        const k = Math.sqrt(2_400_000 / area)
        w *= k
        h *= k
      }
      comp.setSize(w, h)
      dirty.current = true
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(box)

    const source = (url: string, isVideo: boolean): Source | null => {
      if (!url) return null
      const key = `${isVideo ? 'v' : 'i'}:${url}`
      let s = map.get(key)
      if (!s) {
        if (isVideo) {
          const v = document.createElement('video')
          v.crossOrigin = 'anonymous'
          v.muted = true
          v.loop = true
          v.playsInline = true
          v.preload = 'auto'
          v.src = url
          v.addEventListener('loadeddata', () => (dirty.current = true))
          s = { el: v, video: true }
        } else {
          const img = new Image()
          img.crossOrigin = 'anonymous'
          img.onload = () => {
            dirty.current = true
            bump((n) => n + 1)
          }
          img.src = url
          s = { el: img, video: false }
        }
        map.set(key, s)
      }
      return s
    }

    const tick = () => {
      if (!alive) return
      frame = requestAnimationFrame(tick)
      const { cue: c, visual: v, mode: m, position: pos, paused: halted } = latest.current
      const layers: RenderLayer[] = []
      let animated = false

      // The cue's own media is the bottom layer (or its edited copy).
      const baseUrl = v.base.src || c.targetUrl
      const baseIsVideo = c.type === 'VIDEO' && !v.base.src
      let baseEl: HTMLImageElement | HTMLVideoElement | null = null
      if (baseIsVideo && m === 'audience') baseEl = stageAudio.videoElement
      else baseEl = source(baseUrl, baseIsVideo)?.el ?? null
      if (baseEl && baseEl instanceof HTMLVideoElement) {
        animated = true
        if (m !== 'audience' && baseEl.readyState >= 1) {
          if (m === 'preview' && Number.isFinite(pos) && Math.abs(baseEl.currentTime - pos) > 1.5) baseEl.currentTime = pos
          if (halted) baseEl.pause()
          else if (baseEl.paused) baseEl.play().catch(() => {})
        }
      }
      const dims = (el: HTMLImageElement | HTMLVideoElement | null) =>
        el instanceof HTMLVideoElement ? [el.videoWidth, el.videoHeight] : el instanceof HTMLImageElement && el.complete ? [el.naturalWidth, el.naturalHeight] : [0, 0]
      if (v.base.visible && baseEl) {
        const [w, h] = dims(baseEl)
        const ready = baseEl instanceof HTMLVideoElement ? baseEl.readyState >= 2 : w > 0
        layers.push({
          key: `base:${baseUrl}`,
          solid: false,
          color: [0, 0, 0],
          source: ready ? baseEl : null,
          width: w,
          height: h,
          dynamic: baseEl instanceof HTMLVideoElement,
          opacity: v.base.opacity,
          blend: v.base.blend,
          x: v.base.x,
          y: v.base.y,
          scale: v.base.scale,
          rotation: v.base.rotation,
          mask: v.base.mask,
          adjust: v.base.adjust,
        })
      }
      for (const l of v.layers) {
        if (!l.visible) continue
        if (l.kind === 'color') {
          layers.push({ key: `c:${l.id}`, solid: true, color: hexToRgb(l.color), source: null, width: 1, height: 1, dynamic: false, opacity: l.opacity, blend: l.blend, x: l.x, y: l.y, scale: l.scale, rotation: l.rotation, mask: l.mask, adjust: l.adjust })
          continue
        }
        const s = source(l.src, l.mediaKind === 'video')
        if (!s) continue
        const [w, h] = dims(s.el)
        if (s.video) {
          animated = true
          const vid = s.el as HTMLVideoElement
          if (vid.paused && !halted) vid.play().catch(() => {})
        }
        const ready = s.video ? (s.el as HTMLVideoElement).readyState >= 2 : w > 0
        layers.push({ key: `m:${l.src}`, solid: false, color: [0, 0, 0], source: ready ? s.el : null, width: w, height: h, dynamic: s.video, opacity: l.opacity, blend: l.blend, x: l.x, y: l.y, scale: l.scale, rotation: l.rotation, mask: l.mask, adjust: l.adjust })
      }
      const fxAnimated = v.fx.grain > 0 || v.fx.film > 0 || v.fx.glitch > 0
      if (!animated && !fxAnimated && !dirty.current) return
      dirty.current = false
      try {
        comp.render({ layers, adjust: v.adjust ?? NO_ADJUST, fx: v.fx, time: (performance.now() - started) / 1000 })
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
      for (const s of map.values()) {
        if (s.video) {
          const vid = s.el as HTMLVideoElement
          vid.pause()
          vid.removeAttribute('src')
          vid.load()
        }
      }
      map.clear()
      comp.dispose()
    }
    // The compositor lives as long as the component; everything else is read from `latest`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div ref={wrap} className={`relative h-full w-full bg-black ${className}`} data-layered-stage={mode}>
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      {/* The audio engine's <video> keeps playing (and keeps its sound) even though the picture is the canvas. */}
      {mode === 'audience' && cue.type === 'VIDEO' && !visual.base.src && (
        <div
          className="pointer-events-none absolute right-0 bottom-0 h-px w-px overflow-hidden opacity-0"
          ref={(node) => {
            if (node && stageAudio.videoElement.parentElement !== node) {
              node.appendChild(stageAudio.videoElement)
              if (stageAudio.videoElement.paused) stageAudio.resume()
            }
          }}
        />
      )}
    </div>
  )
}
