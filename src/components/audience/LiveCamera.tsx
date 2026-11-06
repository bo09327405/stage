import { onDisconnect, ref } from 'firebase/database'
import { useCallback, useEffect, useRef, useState } from 'react'
import { releaseMicrophone, setAudioSession } from '../../services/audioSession'
import { db } from '../../services/firebase'
import { joinLive, LiveBroadcaster, setLiveStatus, useLiveState, watchViewers } from '../../services/liveCamera'
import type { Cue } from '../../types/cue'

/** How long a viewer waits for the first picture before treating the camera as lost. */
const CONNECT_TIMEOUT_MS = 20_000

/**
 * The live layer of one AUDIENCE_LIVE cue, over the whole audience screen: the phone the console named films
 * (LiveOperatorView), every other phone of the channel watches (LiveViewer).
 */
export function LiveLayer({ node, cue, audienceId }: { node: string; cue: Cue; audienceId: string }) {
  const { operator, status } = useLiveState(node)
  if (operator?.audienceId === audienceId && status?.state !== 'ended') return <LiveOperatorView node={node} audienceId={audienceId} />
  return <LiveViewer node={node} cue={cue} audienceId={audienceId} operatorId={operator?.audienceId ?? null} state={status?.state ?? 'waiting'} />
}

function LiveViewer({ node, cue, audienceId, operatorId, state, silent = false }: { node: string; cue: Cue; audienceId: string; operatorId: string | null; state: string; silent?: boolean }) {
  const video = useRef<HTMLVideoElement>(null)
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [needsTap, setNeedsTap] = useState(false)
  // Which operator we gave up waiting for.
  const [gaveUpOn, setGaveUpOn] = useState<string | null>(null)
  const timedOut = gaveUpOn === (operatorId ?? '')

  // Ask for the picture while an operator is named; a new operator (or a reload of theirs) renegotiates by itself.
  useEffect(() => {
    if (!operatorId) return
    return joinLive(node, audienceId, setStream)
  }, [node, audienceId, operatorId])

  useEffect(() => {
    const el = video.current
    if (!el) return
    el.srcObject = stream
    if (!stream) return
    el.muted = silent
    el.play().then(
      () => setNeedsTap(false),
      () => {
        // Sound without a tap is refused: show the picture muted and ask for one tap.
        el.muted = true
        el.play().catch(() => {})
        setNeedsTap(true)
      },
    )
  }, [stream, silent])

  // No picture soon enough = the camera is lost (the console's own re-election resets this when a new one is named).
  useEffect(() => {
    if (stream || state === 'ended') return
    const timer = window.setTimeout(() => setGaveUpOn(operatorId ?? ''), CONNECT_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [stream, state, operatorId])

  if (state === 'ended') return null
  const lost = !stream && (state === 'failed' || state === 'denied' || timedOut)
  // 'standby' fallback: step aside so the stage underneath shows again.
  if (lost && cue.liveFallback === 'standby') return null

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-black" data-audience-live={stream ? 'playing' : lost ? 'lost' : 'connecting'}>
      <video ref={video} autoPlay playsInline className={`h-full w-full object-contain ${stream ? '' : 'hidden'}`} />
      {!stream && (
        <div className="flex flex-col items-center gap-3 px-8 text-center">
          <span className={`text-sm tracking-[0.3em] ${lost ? 'text-white/60' : 'animate-pulse text-white/40'}`}>{lost ? '直播中斷' : '🔴 直播連線中…'}</span>
        </div>
      )}
      {stream && (
        <span className="pointer-events-none absolute top-[max(0.75rem,env(safe-area-inset-top))] left-3 flex items-center gap-1.5 rounded-full bg-black/50 px-2.5 py-1 text-[11px] font-bold tracking-widest text-white">
          <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
          LIVE
        </span>
      )}
      {needsTap && !silent && (
        <button
          type="button"
          onClick={() => {
            const el = video.current
            if (!el) return
            el.muted = false
            el.play().catch(() => {})
            setNeedsTap(false)
          }}
          className="absolute inset-x-0 bottom-[max(2rem,env(safe-area-inset-bottom))] mx-auto w-fit rounded-full bg-white px-6 py-3 text-sm font-semibold text-black"
        >
          🔊 點一下開啟直播聲音
        </button>
      )}
    </div>
  )
}

type OperatorPhase = 'prompt' | 'starting' | 'live' | 'denied' | 'ended'

function describeCameraError(err: unknown) {
  const name = (err as DOMException)?.name
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) return '此網址不支援相機：直播需要 https。'
  if (name === 'NotAllowedError' || name === 'SecurityError') return '相機或麥克風權限被拒絕。請在瀏覽器的網站設定允許後再試一次。'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return '找不到相機或麥克風。'
  if (name === 'NotReadableError') return '相機正被其他程式使用中。'
  if (name === 'InvalidStateError') return '這台裝置的音訊模式與錄音衝突，請完全關閉分頁後重新開啟。'
  return `無法開啟相機（${name ?? 'Error'}）。`
}

/** Digital zoom ceiling when the camera has no hardware zoom (iPhone Safari), and the hardware ceiling we allow. */
const DIGITAL_MAX_ZOOM = 4
const HARDWARE_MAX_ZOOM = 8

interface ZoomRange {
  min: number
  max: number
  /** true = the camera zooms optically / in hardware (viewers get it for free); false = we crop in a canvas. */
  hardware: boolean
}

/** Keep the camera focusing by itself where the browser exposes focus control (iPhone focuses on its own). */
function enableAutofocus(track: MediaStreamTrack | undefined) {
  const modes = (track?.getCapabilities?.() as { focusMode?: string[] } | undefined)?.focusMode
  if (modes?.includes('continuous')) track?.applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] }).catch(() => {})
  return !!modes?.includes('continuous')
}

function zoomRangeOf(track: MediaStreamTrack | undefined): ZoomRange {
  const zoom = (track?.getCapabilities?.() as { zoom?: { min: number; max: number } } | undefined)?.zoom
  return zoom && zoom.max > zoom.min ? { min: zoom.min, max: Math.min(zoom.max, HARDWARE_MAX_ZOOM), hardware: true } : { min: 1, max: DIGITAL_MAX_ZOOM, hardware: false }
}

const previewViewerId = `STAGE-${Math.random().toString(36).slice(2, 7).toUpperCase()}`

/**
 * The console's Stage window: watches the same live camera as the audience (as one more viewer), so the operator
 * sees what the phones see. Silent unless the Stage window is listening (`audible`).
 */
export function LivePreview({ node, cue, audible }: { node: string; cue: Cue; audible: boolean }) {
  const { operator, status } = useLiveState(node)
  return <LiveViewer node={node} cue={cue} audienceId={previewViewerId} operatorId={operator?.audienceId ?? null} state={status?.state ?? 'waiting'} silent={!audible} />
}

/** The filming phone: permission prompt, viewfinder, front/back camera, pinch / slider zoom, mute and end. */
function LiveOperatorView({ node, audienceId }: { node: string; audienceId: string }) {
  const [phase, setPhase] = useState<OperatorPhase>('prompt')
  const [error, setError] = useState<string | null>(null)
  const [facing, setFacing] = useState<'user' | 'environment'>('environment')
  const [muted, setMuted] = useState(false)
  const [viewers, setViewers] = useState(0)
  const [link, setLink] = useState<RTCPeerConnectionState>('new')
  const [zoom, setZoomState] = useState(1)
  const [range, setRange] = useState<ZoomRange>({ min: 1, max: DIGITAL_MAX_ZOOM, hardware: false })
  // Where the viewfinder was last tapped to focus (shows a ring), and whether the browser lets us drive focus.
  const [focusRing, setFocusRing] = useState<{ x: number; y: number; at: number } | null>(null)
  const [afSupported, setAfSupported] = useState(false)
  const preview = useRef<HTMLVideoElement>(null)
  const stream = useRef<MediaStream | null>(null)
  const broadcaster = useRef<LiveBroadcaster | null>(null)
  const unsubViewers = useRef<(() => void) | null>(null)
  // Digital zoom: the preview is drawn cropped into a canvas, whose track replaces the camera's while zoomed in.
  const zoomRef = useRef(1)
  const canvasPipe = useRef<{ canvas: HTMLCanvasElement; track: MediaStreamTrack; raf: number } | null>(null)
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const pinch = useRef<{ dist: number; zoom: number } | null>(null)
  const tap = useRef<{ x: number; y: number; moved: boolean } | null>(null)

  const openCamera = (mode: 'user' | 'environment', withAudio: boolean) =>
    navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: mode }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      audio: withAudio ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true } : false,
    })

  const stopCanvasPipe = useCallback(() => {
    const pipe = canvasPipe.current
    if (!pipe) return
    cancelAnimationFrame(pipe.raf)
    pipe.track.stop()
    canvasPipe.current = null
  }, [])

  const teardown = useCallback(() => {
    stopCanvasPipe()
    unsubViewers.current?.()
    unsubViewers.current = null
    broadcaster.current?.stop()
    broadcaster.current = null
    stream.current?.getTracks().forEach((t) => t.stop())
    stream.current = null
    releaseMicrophone()
  }, [stopCanvasPipe])

  // Leaving (cue stopped, page closed) releases the camera; a dropped connection tells the console to replace this phone.
  useEffect(() => {
    onDisconnect(ref(db, `${node}/status`)).set({ state: 'failed', msg: '攝影機手機離線', at: Date.now() }).catch(() => {})
    return () => {
      onDisconnect(ref(db, `${node}/status`)).cancel().catch(() => {})
      teardown()
    }
  }, [node, teardown])

  // The viewfinder <video> only exists once live, so attach the camera stream when it appears.
  useEffect(() => {
    if (phase === 'live' && preview.current && stream.current) preview.current.srcObject = stream.current
  }, [phase])

  /** Feed the broadcast from a canvas that crops the preview to the zoomed area (cameras without hardware zoom). */
  const startCanvasPipe = () => {
    const video = preview.current
    const cam = stream.current?.getVideoTracks()[0]
    if (!video || !cam || canvasPipe.current) return
    const { width = 1280, height = 720 } = cam.getSettings()
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const out = canvas.captureStream(30).getVideoTracks()[0]
    const pipe = { canvas, track: out, raf: 0 }
    const draw = () => {
      const z = zoomRef.current
      const sw = video.videoWidth / z
      const sh = video.videoHeight / z
      if (sw > 0) ctx.drawImage(video, (video.videoWidth - sw) / 2, (video.videoHeight - sh) / 2, sw, sh, 0, 0, canvas.width, canvas.height)
      pipe.raf = requestAnimationFrame(draw)
    }
    canvasPipe.current = pipe
    draw()
    void broadcaster.current?.replaceVideoTrack(out)
  }

  const setZoom = (value: number) => {
    const z = Math.min(range.max, Math.max(range.min, value))
    zoomRef.current = z
    setZoomState(z)
    const cam = stream.current?.getVideoTracks()[0]
    if (range.hardware) {
      cam?.applyConstraints({ advanced: [{ zoom: z } as MediaTrackConstraintSet] }).catch(() => {})
    } else if (z > 1.001) {
      startCanvasPipe()
    } else if (canvasPipe.current) {
      // Back to the plain camera picture.
      stopCanvasPipe()
      if (cam) void broadcaster.current?.replaceVideoTrack(cam)
    }
  }

  const resetZoomFor = (track: MediaStreamTrack | undefined) => {
    setAfSupported(enableAutofocus(track))
    stopCanvasPipe()
    const r = zoomRangeOf(track)
    setRange(r)
    zoomRef.current = Math.max(1, r.min)
    setZoomState(zoomRef.current)
  }

  const start = async () => {
    setPhase('starting')
    setError(null)
    try {
      // The audience page holds a playback-only audio session; capture needs the other category.
      setAudioSession('play-and-record')
      const media = await openCamera(facing, true).catch((err) => {
        if ((err as DOMException)?.name !== 'InvalidStateError') throw err
        setAudioSession('auto')
        return openCamera(facing, true)
      })
      stream.current = media
      if (preview.current) preview.current.srcObject = media
      resetZoomFor(media.getVideoTracks()[0])
      const live = new LiveBroadcaster(node, audienceId, media, setLink)
      broadcaster.current = live
      await live.start()
      // The operator is a viewer of nothing: don't count this phone.
      unsubViewers.current = watchViewers(node, (n) => setViewers(n))
      await setLiveStatus(node, { state: 'live' })
      setPhase('live')
    } catch (err) {
      teardown()
      const msg = err instanceof Error && !(err instanceof DOMException) ? `直播伺服器連線失敗：${err.message}` : describeCameraError(err)
      setError(msg)
      setPhase('denied')
      void setLiveStatus(node, { state: 'denied', msg })
    }
  }

  const flip = async () => {
    const next = facing === 'user' ? 'environment' : 'user'
    try {
      const media = await openCamera(next, false)
      const track = media.getVideoTracks()[0]
      const old = stream.current
      if (!old) return
      stopCanvasPipe()
      old.getVideoTracks().forEach((t) => {
        old.removeTrack(t)
        t.stop()
      })
      old.addTrack(track)
      await broadcaster.current?.replaceVideoTrack(track)
      if (preview.current) preview.current.srcObject = old
      resetZoomFor(track)
      setFacing(next)
      setError(null)
    } catch {
      setError('無法切換鏡頭（這支手機可能只有一顆鏡頭）')
    }
  }

  const toggleMute = () => {
    const next = !muted
    stream.current?.getAudioTracks().forEach((t) => (t.enabled = !next))
    setMuted(next)
  }

  const end = () => {
    teardown()
    setPhase('ended')
    void setLiveStatus(node, { state: 'ended' })
  }

  // Two-finger pinch on the viewfinder.
  const focusAt = (e: React.PointerEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const x = (e.clientX - rect.left) / rect.width
    const y = (e.clientY - rect.top) / rect.height
    const at = Date.now()
    setFocusRing({ x: e.clientX - rect.left, y: e.clientY - rect.top, at })
    window.setTimeout(() => setFocusRing((r) => (r?.at === at ? null : r)), 1200)
    const cam = stream.current?.getVideoTracks()[0]
    if (!cam) return
    // Focus on the tapped point where supported, then go back to continuous autofocus.
    cam
      .applyConstraints({ advanced: [{ focusMode: 'single-shot', pointsOfInterest: [{ x: facing === 'user' ? 1 - x : x, y }] } as MediaTrackConstraintSet] })
      .catch(() => {})
      .finally(() => window.setTimeout(() => enableAutofocus(stream.current?.getVideoTracks()[0]), 1500))
  }
  const onPointerDown = (e: React.PointerEvent) => {
    if (pointers.current.size === 0) tap.current = { x: e.clientX, y: e.clientY, moved: false }
    else if (tap.current) tap.current.moved = true
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()]
      pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: zoomRef.current }
    }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (tap.current && Math.hypot(e.clientX - tap.current.x, e.clientY - tap.current.y) > 10) tap.current.moved = true
    if (pointers.current.size === 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()]
      const dist = Math.hypot(a.x - b.x, a.y - b.y)
      if (pinch.current.dist > 0) setZoom(pinch.current.zoom * (dist / pinch.current.dist))
    }
  }
  const onPointerUp = (e: React.PointerEvent) => {
    // A short, still, single-finger touch on the picture (not a control) = tap to focus.
    if (e.type === 'pointerup' && tap.current && !tap.current.moved && pointers.current.size === 1 && e.target === e.currentTarget.querySelector('video')) focusAt(e)
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) pinch.current = null
  }

  if (phase === 'ended') return null

  if (phase !== 'live') {
    return (
      <div className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-5 bg-black/95 px-8 text-center" data-live-operator-prompt>
        <span className="text-4xl">🔴</span>
        <h2 className="text-xl font-semibold">您被指派為現場直播攝影師</h2>
        <p className="max-w-xs text-sm leading-relaxed text-white/60">按下開始後，瀏覽器會詢問相機與麥克風權限。您的畫面與聲音會即時全螢幕播給同組的觀眾。</p>
        <div className="flex gap-2" role="radiogroup" aria-label="使用鏡頭">
          {([['environment', '後鏡頭'], ['user', '前鏡頭（自拍）']] as const).map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={facing === mode}
              onClick={() => setFacing(mode)}
              className={`min-h-11 rounded-full px-4 text-sm ${facing === mode ? 'bg-white text-black' : 'bg-white/10 text-white/70'}`}
            >
              {label}
            </button>
          ))}
        </div>
        {error && <p className="max-w-xs text-sm text-red-400">{error}</p>}
        <button
          type="button"
          onClick={start}
          disabled={phase === 'starting'}
          className="min-h-12 rounded-full bg-red-600 px-8 text-base font-semibold text-white disabled:opacity-50"
        >
          {phase === 'starting' ? '開啟中…' : phase === 'denied' ? '重新嘗試' : '開始直播'}
        </button>
        <button type="button" onClick={end} className="min-h-10 text-xs text-white/40">
          我不方便，放棄
        </button>
      </div>
    )
  }

  // Digital zoom is shown by scaling the preview (the same crop the canvas sends); hardware zoom shows natively.
  const previewScale = range.hardware ? 1 : zoom
  const presets = [1, 2, 3].filter((z) => z >= range.min && z <= range.max)

  return (
    <div className="absolute inset-0 z-40 touch-none overflow-hidden bg-black" data-live-operator onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
      <video
        ref={preview}
        autoPlay
        playsInline
        muted
        className="h-full w-full object-cover"
        style={{ transform: `scale(${facing === 'user' ? -previewScale : previewScale}, ${previewScale})` }}
      />
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between bg-gradient-to-b from-black/70 to-transparent px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-8">
        <span className="flex items-center gap-2 rounded-full bg-red-600 px-3 py-1 text-xs font-bold tracking-widest">
          <span className="h-2 w-2 animate-pulse rounded-full bg-white" />
          直播中
        </span>
        <span className="text-xs text-white/80">
          {link === 'connected' ? `觀眾 ${viewers}` : link === 'failed' || link === 'disconnected' ? '⚠ 連線不穩' : '連線伺服器中…'}
        </span>
      </div>
      {focusRing && (
        <span
          key={focusRing.at}
          className="pointer-events-none absolute h-16 w-16 -translate-x-1/2 -translate-y-1/2 animate-ping rounded-full border-2 border-yellow-400"
          style={{ left: focusRing.x, top: focusRing.y, animationIterationCount: 1 }}
        />
      )}
      <span className="pointer-events-none absolute top-[max(3.25rem,calc(env(safe-area-inset-top)+2.5rem))] left-4 rounded-full bg-black/40 px-2 py-0.5 text-[10px] text-white/70">
        {afSupported ? '自動對焦 · 點畫面可對焦' : '自動對焦（由手機控制）'}
      </span>
      {error && <p className="absolute inset-x-4 top-20 rounded-lg bg-black/70 px-3 py-2 text-center text-xs text-red-300">{error}</p>}
      <div className="absolute inset-x-0 bottom-0 flex flex-col items-center gap-3 bg-gradient-to-t from-black/80 to-transparent px-4 pt-10 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        <div className="flex w-full max-w-sm items-center gap-2" data-live-zoom>
          {presets.map((z) => (
            <button
              key={z}
              type="button"
              onClick={() => setZoom(z)}
              className={`h-9 min-w-9 rounded-full px-2 text-xs font-semibold backdrop-blur ${Math.abs(zoom - z) < 0.05 ? 'bg-yellow-400 text-black' : 'bg-white/15 text-white'}`}
            >
              {z}×
            </button>
          ))}
          <input
            type="range"
            min={range.min}
            max={range.max}
            step={0.1}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            className="min-w-0 flex-1 accent-yellow-400"
            aria-label="縮放"
          />
          <span className="w-12 text-right font-mono text-xs text-white/80">{zoom.toFixed(1)}×</span>
        </div>
        <div className="flex items-center justify-center gap-4">
          <button type="button" onClick={flip} className="flex h-14 w-14 flex-col items-center justify-center rounded-full bg-white/15 backdrop-blur" aria-label="切換前後鏡頭">
            <span className="text-xl">🔄</span>
            <span className="text-[9px] leading-none text-white/70">{facing === 'user' ? '前' : '後'}</span>
          </button>
          <button
            type="button"
            onClick={toggleMute}
            className={`flex h-14 w-14 items-center justify-center rounded-full text-xl backdrop-blur ${muted ? 'bg-white text-black' : 'bg-white/15'}`}
            aria-label={muted ? '取消靜音' : '靜音'}
            aria-pressed={muted}
          >
            {muted ? '🔇' : '🎙'}
          </button>
          <button type="button" onClick={end} className="min-h-14 rounded-full bg-red-600 px-6 text-sm font-semibold">
            結束直播
          </button>
        </div>
      </div>
    </div>
  )
}
