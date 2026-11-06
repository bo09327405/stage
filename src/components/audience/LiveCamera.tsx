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

function LiveViewer({ node, cue, audienceId, operatorId, state }: { node: string; cue: Cue; audienceId: string; operatorId: string | null; state: string }) {
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
    el.muted = false
    el.play().then(
      () => setNeedsTap(false),
      () => {
        // Sound without a tap is refused: show the picture muted and ask for one tap.
        el.muted = true
        el.play().catch(() => {})
        setNeedsTap(true)
      },
    )
  }, [stream])

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
      {needsTap && (
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

/** The filming phone: permission prompt, viewfinder, front/back camera, mute and end. */
function LiveOperatorView({ node, audienceId }: { node: string; audienceId: string }) {
  const [phase, setPhase] = useState<OperatorPhase>('prompt')
  const [error, setError] = useState<string | null>(null)
  const [facing, setFacing] = useState<'user' | 'environment'>('environment')
  const [muted, setMuted] = useState(false)
  const [viewers, setViewers] = useState(0)
  const [link, setLink] = useState<RTCPeerConnectionState>('new')
  const preview = useRef<HTMLVideoElement>(null)
  const stream = useRef<MediaStream | null>(null)
  const broadcaster = useRef<LiveBroadcaster | null>(null)
  const unsubViewers = useRef<(() => void) | null>(null)

  const openCamera = (mode: 'user' | 'environment') =>
    navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: mode }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })

  const teardown = useCallback(() => {
    unsubViewers.current?.()
    unsubViewers.current = null
    broadcaster.current?.stop()
    broadcaster.current = null
    stream.current?.getTracks().forEach((t) => t.stop())
    stream.current = null
    releaseMicrophone()
  }, [])

  // Leaving (cue stopped, page closed) releases the camera; a dropped connection tells the console to replace this phone.
  useEffect(() => {
    onDisconnect(ref(db, `${node}/status`)).set({ state: 'failed', msg: '攝影機手機離線', at: Date.now() }).catch(() => {})
    return () => {
      onDisconnect(ref(db, `${node}/status`)).cancel().catch(() => {})
      teardown()
    }
  }, [node, teardown])

  const start = async () => {
    setPhase('starting')
    setError(null)
    try {
      // The audience page holds a playback-only audio session; capture needs the other category.
      setAudioSession('play-and-record')
      const media = await openCamera(facing).catch((err) => {
        if ((err as DOMException)?.name !== 'InvalidStateError') throw err
        setAudioSession('auto')
        return openCamera(facing)
      })
      stream.current = media
      if (preview.current) preview.current.srcObject = media
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
      const media = await openCamera(next)
      const track = media.getVideoTracks()[0]
      media.getAudioTracks().forEach((t) => t.stop())
      const old = stream.current
      if (old) {
        old.getVideoTracks().forEach((t) => {
          old.removeTrack(t)
          t.stop()
        })
        old.addTrack(track)
      }
      await broadcaster.current?.replaceVideoTrack(track)
      if (preview.current) preview.current.srcObject = old
      setFacing(next)
    } catch {
      setError('無法切換鏡頭')
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

  if (phase === 'ended') return null

  if (phase !== 'live') {
    return (
      <div className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-5 bg-black/95 px-8 text-center" data-live-operator-prompt>
        <span className="text-4xl">🔴</span>
        <h2 className="text-xl font-semibold">您被指派為現場直播攝影師</h2>
        <p className="max-w-xs text-sm leading-relaxed text-white/60">按下開始後，瀏覽器會詢問相機與麥克風權限。您的畫面與聲音會即時全螢幕播給同組的觀眾。</p>
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

  return (
    <div className="absolute inset-0 z-40 bg-black" data-live-operator>
      <video ref={preview} autoPlay playsInline muted className={`h-full w-full object-cover ${facing === 'user' ? '-scale-x-100' : ''}`} />
      <div className="absolute inset-x-0 top-0 flex items-center justify-between bg-gradient-to-b from-black/70 to-transparent px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-8">
        <span className="flex items-center gap-2 rounded-full bg-red-600 px-3 py-1 text-xs font-bold tracking-widest">
          <span className="h-2 w-2 animate-pulse rounded-full bg-white" />
          直播中
        </span>
        <span className="text-xs text-white/80">
          {link === 'connected' ? `觀眾 ${viewers}` : link === 'failed' || link === 'disconnected' ? '⚠ 連線不穩' : '連線伺服器中…'}
        </span>
      </div>
      {error && <p className="absolute inset-x-4 top-20 rounded-lg bg-black/70 px-3 py-2 text-center text-xs text-red-300">{error}</p>}
      <div className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-4 bg-gradient-to-t from-black/80 to-transparent px-4 pt-10 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        <button type="button" onClick={flip} className="flex h-14 w-14 items-center justify-center rounded-full bg-white/15 text-xl backdrop-blur" aria-label="切換前後鏡頭">
          🔄
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
  )
}
