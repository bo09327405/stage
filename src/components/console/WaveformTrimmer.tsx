import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import WaveSurfer from 'wavesurfer.js'
import RegionsPlugin, { type Region } from 'wavesurfer.js/dist/plugins/regions.esm.js'
import { formatPrecise, formatTime } from '../../hooks/useServerNow'
import { FADE_SHAPES, fadeRamp, type FadeShape } from '../../types/studio'
import { NumberField } from '../ui/controls'

interface WaveformTrimmerProps {
  url: string
  /** Trim start in seconds. */
  start: number
  /** Trim end in seconds; 0 = end of file. */
  end: number
  onChange: (start: number, end: number) => void
  /** Reports the decoded file length so the cue's duration stays accurate. */
  onDuration: (seconds: number) => void
  fadeIn: number
  fadeOut: number
  /** Automatic fade-out point (seconds into playback); 0 = fade out just before the OUT point. */
  autoStopAfter: number
  loop: boolean
  /** 0–100, the level the fade ramps reach. */
  volume: number
  onFadesChange: (fadeIn: number, fadeOut: number) => void
  fadeInShape: FadeShape
  fadeOutShape: FadeShape
  onShapesChange: (fadeInShape: FadeShape, fadeOutShape: FadeShape) => void
  /** Drag the level line up / down (0 = mute). */
  onVolumeChange: (volume: number) => void
}

const round = (s: number) => Math.round(s * 100) / 100
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n))

const FADE_BLUE = '#0a84ff'
const WAVE_HEIGHT = 56 // per channel; stereo files draw two lanes

/**
 * Go Button-style media editor: split-channel waveform, yellow trim region, and (with "+ Fades")
 * blue dashed fade-in / fade-out ramps with draggable handles. Handles use Pointer Events, which
 * cover finger, stylus and mouse alike. Preview plays through a Web Audio gain node that follows
 * the same ramps.
 */
export function WaveformTrimmer({
  url,
  start,
  end,
  onChange,
  onDuration,
  fadeIn,
  fadeOut,
  autoStopAfter,
  loop,
  volume,
  onFadesChange,
  fadeInShape,
  fadeOutShape,
  onShapesChange,
  onVolumeChange,
}: WaveformTrimmerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const wsRef = useRef<WaveSurfer | null>(null)
  const regionRef = useRef<Region | null>(null)
  const mediaRef = useRef<HTMLAudioElement | null>(null)
  const audioRef = useRef<{ ctx: AudioContext; gain: GainNode } | null>(null)
  const [duration, setDuration] = useState(0)
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [showFades, setShowFades] = useState(true)
  const [loadError, setLoadError] = useState('')
  // A second try with a freshly fetched copy: a response cached earlier by a plain <audio> has no CORS headers.
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null)
  const triedFallback = useRef(false)
  const lastVolume = useRef(volume > 0 ? volume : 100)
  useEffect(() => {
    if (volume > 0) lastVolume.current = volume
  }, [volume])
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [dragging, setDragging] = useState<'in' | 'out' | 'vol' | null>(null)

  // Latest props for wavesurfer callbacks without re-creating the instance.
  const latest = useRef({ start, end, onChange, onDuration, fadeIn, fadeOut, autoStopAfter, loop, volume, fadeInShape, fadeOutShape })
  useEffect(() => {
    latest.current = { start, end, onChange, onDuration, fadeIn, fadeOut, autoStopAfter, loop, volume, fadeInShape, fadeOutShape }
  })

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!containerRef.current) return
    setStatus('loading')
    setLoadError('')
    // Our own element (with CORS) so preview can be routed through a Web Audio gain node.
    const media = new Audio()
    media.crossOrigin = 'anonymous'
    media.preload = 'auto'
    mediaRef.current = media

    const lane = { waveColor: 'rgba(48,209,88,0.45)', progressColor: '#30d158' }
    const ws = WaveSurfer.create({
      container: containerRef.current,
      url: fallbackUrl ?? url,
      media,
      height: WAVE_HEIGHT,
      splitChannels: [lane, lane],
      cursorColor: '#ffffff',
      cursorWidth: 1,
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      normalize: true,
      dragToSeek: true,
      fetchParams: { mode: 'cors' },
    })
    const regions = ws.registerPlugin(RegionsPlugin.create())
    wsRef.current = ws

    ws.on('ready', (d) => {
      setDuration(d)
      setStatus('ready')
      latest.current.onDuration(round(d))
      const { start: s, end: e } = latest.current
      regionRef.current = regions.addRegion({
        start: Math.min(s, d),
        end: e > 0 ? Math.min(e, d) : d,
        color: 'rgba(255,214,10,0.08)',
        drag: true,
        resize: true,
        minLength: 0.1,
      })
    })
    ws.on('error', (err) => {
      const reason = err instanceof Error ? err.message : String(err ?? '')
      if (triedFallback.current || fallbackUrl) {
        setLoadError(reason)
        return setStatus('error')
      }
      triedFallback.current = true
      // Retry once with a copy we fetch ourselves, bypassing the HTTP cache.
      fetch(url, { mode: 'cors', cache: 'reload' })
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          return res.blob()
        })
        .then((blob) => setFallbackUrl(URL.createObjectURL(blob)))
        .catch((e: Error) => {
          setLoadError(`${reason ? reason + ' · ' : ''}${e.message}`)
          setStatus('error')
        })
    })
    ws.on('timeupdate', (t) => {
      setTime(t)
      // Preview stops where the real cue would: the trim end, or the end of an automatic fade-out.
      const { start: s, autoStopAfter: asa, fadeOut: fo } = latest.current
      const region = regionRef.current
      const stopAt = Math.min(region?.end ?? Infinity, asa > 0 ? s + asa + fo : Infinity)
      if (ws.isPlaying() && t >= stopAt) ws.pause()
    })
    ws.on('play', () => setPlaying(true))
    ws.on('pause', () => {
      setPlaying(false)
      resetGain()
    })
    // Scrubbing while previewing restarts the ramps from the new position.
    ws.on('interaction', (t) => {
      if (ws.isPlaying()) scheduleGain(t)
    })
    regions.on('region-updated', (region) => {
      const d = ws.getDuration()
      const s = round(region.start)
      // An end at (or within 50 ms of) the file end is stored as 0 = "to the end".
      const e = region.end >= d - 0.05 ? 0 : round(region.end)
      latest.current.onChange(s, e)
    })

    return () => {
      regionRef.current = null
      wsRef.current = null
      ws.destroy()
      audioRef.current?.ctx.close().catch(() => {})
      audioRef.current = null
      mediaRef.current = null
    }
    // scheduleGain/resetGain read refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, fallbackUrl])
  useEffect(() => () => { if (fallbackUrl) URL.revokeObjectURL(fallbackUrl) }, [fallbackUrl])

  // Reflect numeric trim edits made outside the waveform.
  useEffect(() => {
    const region = regionRef.current
    if (!region || !duration) return
    const e = end > 0 ? Math.min(end, duration) : duration
    if (Math.abs(region.start - start) > 0.01 || Math.abs(region.end - e) > 0.01) {
      region.setOptions({ start: Math.min(start, e - 0.1), end: e })
    }
  }, [start, end, duration])

  /* ---------- geometry ---------- */

  const effectiveEnd = end > 0 && duration ? Math.min(end, duration) : duration
  const segment = Math.max(0, effectiveEnd - start)
  const fi = clamp(fadeIn, 0, segment)
  // Where the fade-out runs, in file time — mirrors the engine (cueRunLength / fadeOutStartsAt).
  const outEnd = autoStopAfter > 0 ? Math.min(effectiveEnd, start + autoStopAfter + fadeOut) : effectiveEnd
  const outStart = Math.max(start, outEnd - fadeOut)
  const fadeOutVisible = !loop && fadeOut > 0
  const x = (t: number) => (duration > 0 ? (t / duration) * size.width : 0)
  const H = size.height
  const top = 6 + (1 - volume / 100) * (H - 12)
  const STEPS = 28
  // Ramp outlines in the chosen shapes (fade-out mirrors the fade-in, as in the Studio).
  const inPts = Array.from({ length: STEPS + 1 }, (_, i) => {
    const p = i / STEPS
    return `${x(start + fi * p)},${H - (H - top) * fadeRamp(fadeInShape, p)}`
  })
  const outPts = Array.from({ length: STEPS + 1 }, (_, i) => {
    const p = i / STEPS
    return `${x(outStart + (outEnd - outStart) * p)},${top + (H - top) * (1 - fadeRamp(fadeOutShape, 1 - p, true))}`
  })

  /* ---------- fade handles ---------- */

  const timeAt = (e: ReactPointerEvent) => {
    const rect = containerRef.current!.getBoundingClientRect()
    return clamp(((e.clientX - rect.left) / rect.width) * duration, 0, duration)
  }

  const volumeAt = (e: ReactPointerEvent) => {
    const rect = containerRef.current!.getBoundingClientRect()
    return Math.round(clamp(1 - (e.clientY - rect.top - 6) / Math.max(1, rect.height - 12), 0, 1) * 100)
  }

  const dragHandle = (which: 'in' | 'out' | 'vol') => ({
    onPointerDown: (e: ReactPointerEvent<SVGElement>) => {
      e.stopPropagation()
      e.currentTarget.setPointerCapture(e.pointerId)
      setDragging(which)
    },
    onPointerMove: (e: ReactPointerEvent<SVGElement>) => {
      if (dragging !== which) return
      if (which === 'vol') return onVolumeChange(volumeAt(e))
      const t = timeAt(e)
      if (which === 'in') {
        onFadesChange(round(clamp(t - start, 0, segment - (fadeOutVisible ? fadeOut : 0))), fadeOut)
      } else if (autoStopAfter > 0) {
        // Automatic fade point: the start is fixed, dragging sets where it reaches silence.
        onFadesChange(fadeIn, round(clamp(t - (start + autoStopAfter), 0, effectiveEnd - start - autoStopAfter)))
      } else {
        onFadesChange(fadeIn, round(clamp(effectiveEnd - t, 0, segment - fadeIn)))
      }
    },
    onPointerUp: () => setDragging(null),
    onPointerCancel: () => setDragging(null),
  })

  /* ---------- preview gain ---------- */

  /** Lazily build media → gain → speakers (must happen inside the first preview tap). */
  function ensureAudio() {
    if (audioRef.current || !mediaRef.current) return audioRef.current
    try {
      const ctx = new AudioContext()
      const gain = ctx.createGain()
      ctx.createMediaElementSource(mediaRef.current).connect(gain).connect(ctx.destination)
      audioRef.current = { ctx, gain }
    } catch {
      audioRef.current = null
    }
    return audioRef.current
  }

  /** Follow the drawn ramps (shapes included) from file position `from` onward. */
  function scheduleGain(from: number) {
    const audio = audioRef.current
    if (!audio) return
    const { start: s, end: e, fadeIn: fIn, fadeOut: fOut, autoStopAfter: asa, loop: lp, volume: vol, fadeInShape: inShape, fadeOutShape: outShape } = latest.current
    const d = wsRef.current?.getDuration() ?? 0
    const segEnd = e > 0 ? Math.min(e, d) : d
    const level = vol / 100
    const inEnd = s + fIn
    const oEnd = asa > 0 ? Math.min(segEnd, s + asa + fOut) : segEnd
    const oStart = lp || fOut <= 0 ? Infinity : Math.max(s, oEnd - fOut)

    const valueAt = (t: number) => {
      let v = level
      if (fIn > 0 && t < inEnd) v = level * fadeRamp(inShape, clamp((t - s) / fIn, 0, 1))
      if (t >= oStart) v = Math.min(v, level * fadeRamp(outShape, clamp((oEnd - t) / (oEnd - oStart), 0, 1), true))
      return v
    }

    const g = audio.gain.gain
    const now = audio.ctx.currentTime
    g.cancelScheduledValues(now)
    g.setValueAtTime(valueAt(from), now)
    const stop = Number.isFinite(oStart) ? oEnd : fIn > 0 ? inEnd : from
    const span = stop - from
    if (span > 0.02) {
      // Sample the whole envelope (fade-in, level, fade-out) as one curve so every shape plays as drawn.
      const n = Math.min(4000, Math.max(2, Math.ceil(span / 0.02)))
      const values = new Float32Array(n)
      for (let i = 0; i < n; i++) values[i] = valueAt(from + (span * i) / (n - 1))
      g.setValueCurveAtTime(values, now + 0.001, span)
    }
  }

  function resetGain() {
    const audio = audioRef.current
    if (!audio) return
    audio.gain.gain.cancelScheduledValues(audio.ctx.currentTime)
    audio.gain.gain.setValueAtTime(latest.current.volume / 100, audio.ctx.currentTime)
  }

  // Dragging a fade or the volume while previewing is heard right away.
  useEffect(() => {
    const ws = wsRef.current
    if (ws?.isPlaying()) scheduleGain(ws.getCurrentTime())
    // scheduleGain reads latest props.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [volume, fadeIn, fadeOut, fadeInShape, fadeOutShape])

  const preview = () => {
    const ws = wsRef.current
    if (!ws) return
    if (ws.isPlaying()) return ws.pause()
    const audio = ensureAudio()
    audio?.ctx.resume().catch(() => {})
    const stopAt = Math.min(effectiveEnd, autoStopAfter > 0 ? outEnd : Infinity)
    const from = time >= start && time < stopAt - 0.05 ? time : start
    ws.setTime(from)
    scheduleGain(from)
    ws.play()
  }

  const setPoint = (which: 'start' | 'end') => {
    const t = round(time)
    if (which === 'start' && t < effectiveEnd - 0.1) onChange(t, end)
    if (which === 'end' && t > start + 0.1) onChange(start, t >= duration - 0.05 ? 0 : t)
  }

  const ready = status === 'ready' && size.width > 0

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-white/40">黃框 = 播放範圍 · 拖曳邊緣裁剪</span>
        <button
          type="button"
          onClick={() => setShowFades(!showFades)}
          className={`min-h-9 rounded-lg px-3 text-xs font-semibold transition pointer-coarse:min-h-11 ${
            showFades ? 'bg-accent text-white' : 'bg-white/[0.07] text-white/70 hover:bg-white/15'
          }`}
        >
          {showFades ? '− Fades / 音量' : '+ Fades / 音量'}
        </button>
      </div>

      <div className="wave-trim relative overflow-hidden rounded-xl border border-line bg-black px-1 py-2">
        <div className="relative">
          <div ref={containerRef} className="touch-none" />

          {showFades && ready && (
            <svg
              // Above wavesurfer's own layers (its trim handles use a positive z-index); only the fade
              // handles take pointer events, so trimming and seeking still work everywhere else.
              // touch-action must sit on the <svg> root: browsers ignore it on inner SVG elements, and
              // without it a finger drag gets taken over as a panel scroll (pointercancel).
              className="pointer-events-none absolute inset-0 z-20 h-full w-full touch-none overflow-visible"
              viewBox={`0 0 ${size.width} ${H}`}
              preserveAspectRatio="none"
            >
              {/* Fade in: shaded attenuated area + dashed ramp (drawn in the chosen shape) */}
              {fi > 0 && (
                <>
                  <polygon points={`${x(start)},0 ${x(start + fi)},0 ${inPts.slice().reverse().join(' ')}`} fill={FADE_BLUE} opacity={0.16} />
                  <polyline points={inPts.join(' ')} fill="none" stroke={FADE_BLUE} strokeWidth={2} strokeDasharray="6 4" />
                </>
              )}
              {/* Level line between the fades */}
              <line
                x1={x(start + fi)}
                y1={top}
                x2={fadeOutVisible ? x(outStart) : x(effectiveEnd)}
                y2={top}
                stroke={volume === 0 ? '#ff453a' : FADE_BLUE}
                strokeWidth={volume === 0 ? 2 : 1}
                strokeDasharray="2 4"
                opacity={0.75}
              />
              {/* Fade out: dashed ramp down to silence, shaded attenuated area */}
              {fadeOutVisible && (
                <>
                  <polygon points={`${x(outStart)},0 ${x(outEnd)},0 ${outPts.slice().reverse().join(' ')}`} fill={FADE_BLUE} opacity={0.16} />
                  <polyline points={outPts.join(' ')} fill="none" stroke={FADE_BLUE} strokeWidth={2} strokeDasharray="6 4" />
                  {outEnd < effectiveEnd && (
                    <rect x={x(outEnd)} y={0} width={x(effectiveEnd) - x(outEnd)} height={H} fill="#000" opacity={0.45} />
                  )}
                </>
              )}

              {/* Volume: drag the level handle up / down; all the way down = mute */}
              <FadeHandle
                cx={clamp((x(start + fi) + (fadeOutVisible ? x(outStart) : x(effectiveEnd))) / 2, 14, Math.max(14, size.width - 14))}
                cy={top}
                active={dragging === 'vol'}
                label={volume === 0 ? '靜音' : `音量 ${volume}%`}
                labelLeft={false}
                vertical
                color={volume === 0 ? '#ff453a' : '#fff'}
                {...dragHandle('vol')}
              />

              <FadeHandle
                cx={x(start + fi)}
                cy={top}
                active={dragging === 'in'}
                label={`Fade In ${formatPrecise(fi)}`}
                labelLeft={false}
                {...dragHandle('in')}
              />
              {!loop && (
                <FadeHandle
                  cx={autoStopAfter > 0 ? x(outEnd) : x(fadeOut > 0 ? outStart : effectiveEnd)}
                  cy={autoStopAfter > 0 ? H - 2 : top}
                  active={dragging === 'out'}
                  label={`Fade Out ${formatPrecise(fadeOut)}`}
                  labelLeft
                  {...dragHandle('out')}
                />
              )}
            </svg>
          )}
        </div>
        {status !== 'ready' && (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-white/40">
            {status === 'loading' ? '載入波形中…' : `無法讀取波形${loadError ? `：${loadError}` : '（檔案需允許 CORS）'}`}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between font-mono text-xs text-white/50 tabular">
        <span>
          IN <span className="text-standby">{formatTime(start)}</span>
        </span>
        <span className="text-white/80">▸ {formatTime(time)}</span>
        <span>
          OUT <span className="text-standby">{formatTime(effectiveEnd)}</span>
        </span>
      </div>

      {showFades && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <NumberField compact label="Fade In" hint={formatPrecise(fadeIn)} step={0.01} value={fadeIn} onChange={(v) => onFadesChange(round(v), fadeOut)} />
            <NumberField
              compact
              label="Fade Out"
              hint={loop ? '循環時於停止時套用' : formatPrecise(fadeOut)}
              step={0.01}
              value={fadeOut}
              onChange={(v) => onFadesChange(fadeIn, round(v))}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <ShapeSelect label="淡入曲線" value={fadeInShape} onChange={(sh) => onShapesChange(sh, fadeOutShape)} />
            <ShapeSelect label="淡出曲線" value={fadeOutShape} onChange={(sh) => onShapesChange(fadeInShape, sh)} />
          </div>
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => onVolumeChange(volume === 0 ? lastVolume.current : 0)}
          className={`min-h-11 shrink-0 rounded-lg px-3 text-xs font-semibold transition ${volume === 0 ? 'bg-panic text-white' : 'bg-white/[0.07] text-white/70 hover:bg-white/15'}`}
          aria-pressed={volume === 0}
          data-wave-mute
        >
          {volume === 0 ? '🔇 靜音中' : '🔈 靜音'}
        </button>
        <span className="text-[11px] leading-snug text-white/40">拖曳波形上的白點調整音量（拉到最底 = 靜音）· 藍點拉出淡入淡出</span>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <button
          type="button"
          onClick={() => setPoint('start')}
          disabled={status !== 'ready'}
          className="h-12 rounded-xl bg-white/[0.06] text-sm font-medium text-white/80 active:bg-white/15 disabled:opacity-30"
        >
          ⇤ 設為起點
        </button>
        <button
          type="button"
          onClick={preview}
          disabled={status !== 'ready'}
          className={`h-12 rounded-xl text-sm font-bold disabled:opacity-30 ${playing ? 'bg-standby text-black' : 'bg-go text-black'}`}
        >
          {playing ? '❚❚ 暫停' : '▶ 試聽'}
        </button>
        <button
          type="button"
          onClick={() => setPoint('end')}
          disabled={status !== 'ready'}
          className="h-12 rounded-xl bg-white/[0.06] text-sm font-medium text-white/80 active:bg-white/15 disabled:opacity-30"
        >
          設為終點 ⇥
        </button>
      </div>
    </div>
  )
}

/** A draggable fade point: a visible dot plus a finger-sized invisible hit area. */
function FadeHandle({
  cx,
  cy,
  active,
  label,
  labelLeft,
  vertical,
  color,
  ...handlers
}: {
  cx: number
  cy: number
  active: boolean
  label: string
  labelLeft: boolean
  vertical?: boolean
  color?: string
} & Pick<React.SVGProps<SVGGElement>, 'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onPointerCancel'>) {
  return (
    <g className={`pointer-events-auto touch-none ${vertical ? 'cursor-ns-resize' : 'cursor-ew-resize'}`} {...handlers}>
      <circle cx={cx} cy={cy} r={22} fill="transparent" />
      <circle cx={cx} cy={cy} r={active ? 9 : 7} fill={vertical ? (color ?? '#fff') : FADE_BLUE} stroke={vertical ? FADE_BLUE : '#fff'} strokeWidth={2} />
      {active && (
        <g>
          <rect x={labelLeft ? cx - 104 : cx + 12} y={vertical ? Math.max(0, cy - 26) : cy + 6} width={92} height={18} rx={4} fill="rgba(0,0,0,0.85)" />
          <text x={labelLeft ? cx - 58 : cx + 58} y={(vertical ? Math.max(0, cy - 26) : cy + 6) + 13} textAnchor="middle" fontSize={10} fill="#fff" fontFamily="monospace">
            {label}
          </text>
        </g>
      )}
    </g>
  )
}

function ShapeSelect({ label, value, onChange }: { label: string; value: FadeShape; onChange: (shape: FadeShape) => void }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium text-white/50">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as FadeShape)}
        className="min-h-11 w-full rounded-lg border border-line bg-white/[0.04] px-2 text-xs text-white"
        data-fade-shape={label}
      >
        {FADE_SHAPES.map((f) => (
          <option key={f.id} value={f.id}>
            {f.label}
          </option>
        ))}
      </select>
    </label>
  )
}
