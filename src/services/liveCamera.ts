import { onChildAdded, onDisconnect, onValue, push, ref, remove, serverTimestamp, set } from 'firebase/database'
import { useEffect, useState } from 'react'
import { db } from './firebase'

/*
 * Audience live camera: one phone films, the other phones of the channel watch full screen.
 *
 * Everything lives under {versionBase}/live/{instanceId} (see the database rules):
 *   operator            {audienceId, at}   which phone films — named by the console (useLiveDirector)
 *   status              {state, msg?}      waiting | live | denied | failed | ended — reported by the filming phone
 *   viewers/{aid}       {at}               a phone that wants the picture
 *   peers/{aid}/offer|answer|ice           WebRTC signaling between the filming phone and one viewer
 *
 * Transport is a star of direct WebRTC connections (camera phone → each viewer), signaled through Firebase like the
 * operator voice line. That is fine for a few dozen phones on good networks; a bigger crowd, or networks that block
 * peer-to-peer, needs an SFU (LiveKit / Cloudflare Realtime) behind the same `LiveBroadcaster` / `joinLive` seam.
 */

const ICE_SERVERS: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }]
/** Per-viewer video cap: the camera phone uploads one copy per viewer. */
const MAX_VIDEO_BITRATE = 700_000

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

interface OutPeer {
  key: string
  pc: RTCPeerConnection
  unsubs: (() => void)[]
  retry?: number
}

/** Camera phone: one outgoing connection per viewer, all fed from the same camera + microphone stream. */
export class LiveBroadcaster {
  private peers = new Map<string, OutPeer>()
  private closed = false

  private readonly node: string
  private readonly selfId: string
  private readonly stream: MediaStream
  private readonly onCount: (connected: number) => void

  constructor(node: string, selfId: string, stream: MediaStream, onCount: (connected: number) => void = () => {}) {
    this.node = node
    this.selfId = selfId
    this.stream = stream
    this.onCount = onCount
  }

  /** Connect to exactly these viewers (key changes when a viewer reloads, which makes a fresh offer). */
  sync(viewers: { audienceId: string; at: number }[]) {
    if (this.closed) return
    const wanted = new Map(viewers.filter((v) => v.audienceId !== this.selfId).map((v) => [v.audienceId, `${v.audienceId}:${v.at}`]))
    for (const [id, peer] of [...this.peers]) if (wanted.get(id) !== peer.key) this.close(id)
    for (const [id, key] of wanted) if (!this.peers.has(id)) void this.open(id, key)
  }

  /** Swap the camera (front/back) without renegotiating any connection. */
  async replaceVideoTrack(track: MediaStreamTrack) {
    await Promise.all(
      [...this.peers.values()].flatMap((p) => p.pc.getSenders().filter((s) => s.track?.kind === 'video').map((s) => s.replaceTrack(track).catch(() => {}))),
    )
  }

  stop() {
    this.closed = true
    for (const id of [...this.peers.keys()]) this.close(id)
  }

  private report() {
    this.onCount([...this.peers.values()].filter((p) => p.pc.connectionState === 'connected').length)
  }

  private async open(id: string, key: string) {
    const peerNode = `${this.node}/peers/${id}`
    await remove(ref(db, peerNode)).catch(() => {})
    if (this.closed) return
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    const peer: OutPeer = { key, pc, unsubs: [] }
    this.peers.set(id, peer)
    for (const track of this.stream.getTracks()) pc.addTrack(track, this.stream)
    for (const sender of pc.getSenders()) {
      if (sender.track?.kind !== 'video') continue
      const params = sender.getParameters()
      params.encodings = params.encodings?.length ? params.encodings : [{}]
      params.encodings[0].maxBitrate = MAX_VIDEO_BITRATE
      sender.setParameters(params).catch(() => {})
    }

    let remoteSet = false
    const pending: RTCIceCandidateInit[] = []
    pc.onicecandidate = (e) => {
      if (e.candidate) set(push(ref(db, `${peerNode}/ice`)), { from: 'op', candidate: JSON.stringify(e.candidate.toJSON()) }).catch(() => {})
    }
    pc.onconnectionstatechange = () => {
      this.report()
      if (pc.connectionState === 'failed' && !this.closed) {
        window.clearTimeout(peer.retry)
        peer.retry = window.setTimeout(() => {
          if (this.peers.get(id) === peer) {
            this.close(id)
            void this.open(id, key)
          }
        }, 2500)
      }
    }
    peer.unsubs.push(
      onValue(ref(db, `${peerNode}/answer`), async (snap) => {
        const answer = snap.val() as { sdp?: string } | null
        if (!answer?.sdp || remoteSet || pc.signalingState !== 'have-local-offer') return
        remoteSet = true
        await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp }).catch(() => {})
        for (const c of pending.splice(0)) await pc.addIceCandidate(c).catch(() => {})
      }),
      onChildAdded(ref(db, `${peerNode}/ice`), (snap) => {
        const v = snap.val() as { from?: string; candidate?: string } | null
        if (v?.from !== 'aud' || !v.candidate) return
        const cand = JSON.parse(v.candidate) as RTCIceCandidateInit
        if (remoteSet) pc.addIceCandidate(cand).catch(() => {})
        else pending.push(cand)
      }),
    )
    try {
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      await set(ref(db, `${peerNode}/offer`), { sdp: offer.sdp ?? '', at: Date.now() })
    } catch (err) {
      console.warn('[live camera] offer failed', err)
    }
  }

  private close(id: string) {
    const peer = this.peers.get(id)
    if (!peer) return
    window.clearTimeout(peer.retry)
    peer.unsubs.forEach((u) => u())
    peer.pc.onicecandidate = null
    peer.pc.onconnectionstatechange = null
    peer.pc.close()
    this.peers.delete(id)
    remove(ref(db, `${this.node}/peers/${id}`)).catch(() => {})
    this.report()
  }
}

/** Camera phone: the viewers currently asking for the picture. */
export function watchViewers(node: string, cb: (viewers: { audienceId: string; at: number }[]) => void) {
  return onValue(ref(db, `${node}/viewers`), (snap) => {
    const raw = (snap.val() ?? {}) as Record<string, { at?: number }>
    cb(Object.entries(raw).map(([audienceId, v]) => ({ audienceId, at: Number(v?.at) || 0 })))
  })
}

/**
 * Viewer: announce this phone, answer the camera phone's offer and hand every incoming stream to `onStream`.
 * Returns the cleanup.
 */
export function joinLive(node: string, selfId: string, onStream: (stream: MediaStream | null) => void): () => void {
  let pc: RTCPeerConnection | null = null
  let lastSdp = ''
  let unsubIce: (() => void) | null = null
  const peerNode = `${node}/peers/${selfId}`
  const viewerRef = ref(db, `${node}/viewers/${selfId}`)

  const teardown = () => {
    unsubIce?.()
    unsubIce = null
    if (pc) {
      pc.onicecandidate = null
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

  const unsubOffer = onValue(ref(db, `${peerNode}/offer`), async (snap) => {
    const offer = snap.val() as { sdp?: string } | null
    if (!offer?.sdp) {
      lastSdp = ''
      return teardown()
    }
    if (offer.sdp === lastSdp) return
    lastSdp = offer.sdp
    teardown()
    const conn = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    pc = conn
    conn.addTransceiver('video', { direction: 'recvonly' })
    conn.addTransceiver('audio', { direction: 'recvonly' })
    const incoming = new MediaStream()
    conn.ontrack = (e) => {
      incoming.addTrack(e.track)
      onStream(incoming)
    }
    conn.onicecandidate = (e) => {
      if (e.candidate) set(push(ref(db, `${peerNode}/ice`)), { from: 'aud', candidate: JSON.stringify(e.candidate.toJSON()) }).catch(() => {})
    }
    const pending: RTCIceCandidateInit[] = []
    let remoteSet = false
    unsubIce = onChildAdded(ref(db, `${peerNode}/ice`), (s) => {
      const v = s.val() as { from?: string; candidate?: string } | null
      if (v?.from !== 'op' || !v.candidate) return
      const cand = JSON.parse(v.candidate) as RTCIceCandidateInit
      if (remoteSet) conn.addIceCandidate(cand).catch(() => {})
      else pending.push(cand)
    })
    try {
      await conn.setRemoteDescription({ type: 'offer', sdp: offer.sdp })
      remoteSet = true
      for (const c of pending.splice(0)) await conn.addIceCandidate(c).catch(() => {})
      const answer = await conn.createAnswer()
      await conn.setLocalDescription(answer)
      await set(ref(db, `${peerNode}/answer`), { sdp: answer.sdp ?? '' })
    } catch (err) {
      console.warn('[live camera] answer failed', err)
    }
  })

  return () => {
    unsubConn()
    unsubOffer()
    teardown()
    onDisconnect(viewerRef).cancel().catch(() => {})
    remove(viewerRef).catch(() => {})
    remove(ref(db, `${peerNode}/answer`)).catch(() => {})
  }
}
