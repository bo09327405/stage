import { onDisconnect, onValue, ref, remove, serverTimestamp, set } from 'firebase/database'
import { useEffect, useState } from 'react'
import { db } from './firebase'

/*
 * Audience live camera: one phone films, the other phones of the channel watch full screen.
 *
 * Video goes through a Cloudflare Realtime SFU (the Worker's /api/live/* routes hold the app secret): the camera phone
 * uploads ONE copy, every viewer pulls it from Cloudflare, so the crowd size does not load the camera phone.
 * Firebase only carries the small coordination records under {versionBase}/live/{instanceId} (see the database rules):
 *   operator            {audienceId, at}          which phone films — named by the console (useLiveDirector)
 *   status              {state, msg?}             waiting | live | denied | failed | ended — reported by the filming phone
 *   sfu                 {sessionId, video, audio} where the camera phone published, for viewers to pull
 *   viewers/{aid}       {at}                      phones watching (a head count for the camera phone)
 */

const FALLBACK_ICE: RTCIceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }]
const VIDEO_TRACK = 'video'
const AUDIO_TRACK = 'audio'
/** One upstream copy, so it can afford more than a per-viewer mesh stream. */
const MAX_VIDEO_BITRATE = 1_500_000

export type LiveState = 'waiting' | 'live' | 'denied' | 'failed' | 'ended'
export interface LiveStatus {
  state: LiveState
  msg?: string
}
export interface LiveOperator {
  audienceId: string
  at: number
}

export const liveNode = (versionBase: string, instanceId: string) => `${versionBase}/live/${instanceId}`

export function setLiveStatus(node: string, status: LiveStatus) {
  return set(ref(db, `${node}/status`), { ...status, at: Date.now() }).catch(() => {})
}

/** Watch the operator and status of one live instance. `undefined` = not loaded yet, null = none. */
export function useLiveState(node: string) {
  const [operator, setOperator] = useState<LiveOperator | null | undefined>(undefined)
  const [status, setStatus] = useState<LiveStatus | null | undefined>(undefined)
  useEffect(() => {
    const unsubs = [
      onValue(ref(db, `${node}/operator`), (s) => setOperator((s.val() as LiveOperator | null) ?? null)),
      onValue(ref(db, `${node}/status`), (s) => setStatus((s.val() as LiveStatus | null) ?? null)),
    ]
    return () => unsubs.forEach((u) => u())
  }, [node])
  return { operator, status }
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/live/${path}`, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const data = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error(data.error ?? `直播伺服器錯誤（HTTP ${res.status}）`)
  return data
}

async function iceServers(): Promise<RTCIceServer[]> {
  try {
    return (await api<{ iceServers: RTCIceServer[] }>('ice')).iceServers
  } catch {
    return FALLBACK_ICE
  }
}

/** Camera phone: publishes the camera + microphone stream to the SFU and announces where, for viewers. */
export class LiveBroadcaster {
  private pc: RTCPeerConnection | null = null
  private closed = false
  private readonly node: string
  private readonly selfId: string
  private readonly stream: MediaStream
  private readonly onState: (state: RTCPeerConnectionState) => void

  constructor(node: string, selfId: string, stream: MediaStream, onState: (state: RTCPeerConnectionState) => void = () => {}) {
    this.node = node
    this.selfId = selfId
    this.stream = stream
    this.onState = onState
  }

  /** Connect to the SFU and announce the session. Rejects with a readable message when the server can't be reached. */
  async start() {
    const pc = new RTCPeerConnection({ iceServers: await iceServers(), bundlePolicy: 'max-bundle' })
    this.pc = pc
    pc.onconnectionstatechange = () => this.onState(pc.connectionState)
    const names: { mid: string; trackName: string }[] = []
    const pending: { transceiver: RTCRtpTransceiver; trackName: string }[] = []
    for (const track of this.stream.getTracks()) {
      const transceiver = pc.addTransceiver(track, { direction: 'sendonly', streams: [this.stream] })
      pending.push({ transceiver, trackName: track.kind === 'video' ? VIDEO_TRACK : AUDIO_TRACK })
      if (track.kind === 'video') {
        const params = transceiver.sender.getParameters()
        params.encodings = params.encodings?.length ? params.encodings : [{}]
        params.encodings[0].maxBitrate = MAX_VIDEO_BITRATE
        transceiver.sender.setParameters(params).catch(() => {})
      }
    }
    const { sessionId } = await api<{ sessionId: string }>('session', { node: this.node, audienceId: this.selfId })
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    for (const p of pending) if (p.transceiver.mid) names.push({ mid: p.transceiver.mid, trackName: p.trackName })
    const { sdp } = await api<{ sdp: string }>('publish', { node: this.node, audienceId: this.selfId, sessionId, sdp: offer.sdp, tracks: names })
    if (this.closed) return
    await pc.setRemoteDescription({ type: 'answer', sdp })
    await set(ref(db, `${this.node}/sfu`), { sessionId, video: VIDEO_TRACK, audio: AUDIO_TRACK, at: Date.now() })
  }

  /** Swap the camera (front/back) without renegotiating anything. */
  async replaceVideoTrack(track: MediaStreamTrack) {
    await Promise.all(this.pc?.getSenders().filter((s) => s.track?.kind === 'video').map((s) => s.replaceTrack(track).catch(() => {})) ?? [])
  }

  stop() {
    this.closed = true
    if (this.pc) {
      this.pc.onconnectionstatechange = null
      this.pc.close()
      this.pc = null
    }
    remove(ref(db, `${this.node}/sfu`)).catch(() => {})
  }
}

/** Camera phone: how many viewers are asking for the picture. */
export function watchViewers(node: string, cb: (count: number) => void) {
  return onValue(ref(db, `${node}/viewers`), (snap) => cb(Object.keys((snap.val() ?? {}) as object).length))
}

/**
 * Viewer: announce this phone, pull the camera's published tracks from the SFU and hand the stream to `onStream`.
 * Re-pulls when the camera phone publishes a new session (it reconnected or was replaced). Returns the cleanup.
 */
export function joinLive(node: string, selfId: string, onStream: (stream: MediaStream | null) => void): () => void {
  let pc: RTCPeerConnection | null = null
  let generation = 0
  const viewerRef = ref(db, `${node}/viewers/${selfId}`)

  const teardown = () => {
    generation++
    if (pc) {
      pc.ontrack = null
      pc.close()
      pc = null
    }
    onStream(null)
  }

  // Re-announce on every reconnect: onDisconnect handlers are consumed when they fire.
  const unsubConn = onValue(ref(db, '.info/connected'), (snap) => {
    if (snap.val() !== true) return
    onDisconnect(viewerRef)
      .remove()
      .then(() => set(viewerRef, { at: serverTimestamp() }))
      .catch(() => {})
  })

  const pull = async (sfu: { sessionId: string; video: string; audio: string }) => {
    teardown()
    const mine = generation
    try {
      const conn = new RTCPeerConnection({ iceServers: await iceServers(), bundlePolicy: 'max-bundle' })
      if (mine !== generation) return conn.close()
      pc = conn
      const incoming = new MediaStream()
      conn.ontrack = (e) => {
        incoming.addTrack(e.track)
        onStream(incoming)
      }
      conn.onconnectionstatechange = () => {
        // Dropped for good: pull again after a moment.
        if (conn.connectionState === 'failed' && mine === generation) window.setTimeout(() => mine === generation && void pull(sfu), 2000)
      }
      const { sessionId } = await api<{ sessionId: string }>('session', { node })
      const sub = await api<{ sdp: string }>('subscribe', { node, sessionId, trackNames: [sfu.video, sfu.audio] })
      if (mine !== generation) return
      await conn.setRemoteDescription({ type: 'offer', sdp: sub.sdp })
      const answer = await conn.createAnswer()
      await conn.setLocalDescription(answer)
      await api('renegotiate', { node, sessionId, sdp: answer.sdp })
    } catch (err) {
      console.warn('[live camera] pull failed', err)
      // The camera may not have published yet: try again shortly while this generation is still current.
      if (mine === generation) window.setTimeout(() => mine === generation && void pull(sfu), 3000)
    }
  }

  const unsubSfu = onValue(ref(db, `${node}/sfu`), (snap) => {
    const sfu = snap.val() as { sessionId?: string; video?: string; audio?: string } | null
    if (!sfu?.sessionId) return teardown()
    void pull({ sessionId: sfu.sessionId, video: sfu.video ?? VIDEO_TRACK, audio: sfu.audio ?? AUDIO_TRACK })
  })

  return () => {
    unsubConn()
    unsubSfu()
    teardown()
    onDisconnect(viewerRef).cancel().catch(() => {})
    remove(viewerRef).catch(() => {})
  }
}
