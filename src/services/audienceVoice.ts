import { onChildAdded, onValue, push, ref, remove, set } from 'firebase/database'
import { useEffect, useRef, useState } from 'react'
import { db } from './firebase'

/*
 * Live voice from an operator to the audience devices of one group (one-way). Each audience device gets its
 * own WebRTC connection: the operator offers, the device answers, signaling goes through
 * {versionBase}/voice/{audienceId}/{offer|answer|ice} (see database rules). The operator keeps the
 * connections up while "talk to audience" is armed and only keys the microphone track on push-to-talk,
 * so pressing TALK is instant. Audience devices only receive — they send no audio.
 */

const ICE_SERVERS: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }]

export interface AudienceTarget {
  audienceId: string
  /** Changes when the device reconnects, so it gets a fresh offer. */
  joinedAt: number
}

interface OutPeer {
  key: string
  pc: RTCPeerConnection
  unsubs: (() => void)[]
  retry?: number
}

/** Operator side: one outgoing connection per audience device of the group. */
export class AudienceVoiceSender {
  private peers = new Map<string, OutPeer>()
  private closed = false

  private readonly base: string
  private readonly selfId: string
  private readonly stream: () => MediaStream | null
  private readonly onCount: (connected: number) => void

  constructor(base: string, selfId: string, stream: () => MediaStream | null, onCount: (connected: number) => void = () => {}) {
    this.base = base
    this.selfId = selfId
    this.stream = stream
    this.onCount = onCount
  }

  /** Connect to exactly these devices. */
  sync(targets: AudienceTarget[]) {
    if (this.closed) return
    const wanted = new Map(targets.map((t) => [t.audienceId, `${t.audienceId}:${t.joinedAt}`]))
    for (const [id, peer] of [...this.peers]) if (wanted.get(id) !== peer.key) this.close(id)
    for (const [id, key] of wanted) if (!this.peers.has(id)) void this.open(id, key)
  }

  stop() {
    this.closed = true
    for (const id of [...this.peers.keys()]) this.close(id)
  }

  private report() {
    this.onCount([...this.peers.values()].filter((p) => p.pc.connectionState === 'connected').length)
  }

  private async open(id: string, key: string) {
    const stream = this.stream()
    if (!stream) return
    const node = ref(db, `${this.base}/voice/${id}`)
    await remove(node).catch(() => {})
    if (this.closed) return
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    const peer: OutPeer = { key, pc, unsubs: [] }
    this.peers.set(id, peer)
    for (const track of stream.getAudioTracks()) pc.addTrack(track, stream)

    let remoteSet = false
    const pending: RTCIceCandidateInit[] = []
    pc.onicecandidate = (e) => {
      if (e.candidate) set(push(ref(db, `${this.base}/voice/${id}/ice`)), { from: 'op', candidate: JSON.stringify(e.candidate.toJSON()) }).catch(() => {})
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
      onValue(ref(db, `${this.base}/voice/${id}/answer`), async (snap) => {
        const answer = snap.val() as { sdp?: string } | null
        if (!answer?.sdp || remoteSet || pc.signalingState !== 'have-local-offer') return
        remoteSet = true
        await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp }).catch(() => {})
        for (const c of pending.splice(0)) await pc.addIceCandidate(c).catch(() => {})
      }),
      onChildAdded(ref(db, `${this.base}/voice/${id}/ice`), (snap) => {
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
      await set(ref(db, `${this.base}/voice/${id}/offer`), { sdp: offer.sdp ?? '', at: Date.now(), from: this.selfId })
    } catch (err) {
      console.warn('[audience voice] offer failed', err)
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
    remove(ref(db, `${this.base}/voice/${id}`)).catch(() => {})
    this.report()
  }
}

/**
 * Audience side: answer the operator's offer for this device and play the incoming voice. `unlocked` =
 * the page has had its tap (audio may play). Returns whether a live voice line is connected.
 */
export function useAudienceVoice(base: string, audienceId: string, unlocked: boolean) {
  const [connected, setConnected] = useState(false)
  const audio = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    if (!unlocked) return
    let pc: RTCPeerConnection | null = null
    let lastSdp = ''
    let unsubIce: (() => void) | null = null
    const node = `${base}/voice/${audienceId}`
    const el = new Audio()
    el.autoplay = true
    audio.current = el

    const teardown = () => {
      unsubIce?.()
      unsubIce = null
      if (pc) {
        pc.onicecandidate = null
        pc.ontrack = null
        pc.onconnectionstatechange = null
        pc.close()
        pc = null
      }
      el.srcObject = null
      setConnected(false)
    }

    const unsubOffer = onValue(ref(db, `${node}/offer`), async (snap) => {
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
      conn.addTransceiver('audio', { direction: 'recvonly' })
      conn.ontrack = (e) => {
        el.srcObject = e.streams[0] ?? new MediaStream([e.track])
        el.play().catch(() => {})
      }
      conn.onconnectionstatechange = () => setConnected(conn.connectionState === 'connected')
      conn.onicecandidate = (e) => {
        if (e.candidate) set(push(ref(db, `${node}/ice`)), { from: 'aud', candidate: JSON.stringify(e.candidate.toJSON()) }).catch(() => {})
      }
      const pending: RTCIceCandidateInit[] = []
      let remoteSet = false
      unsubIce = onChildAdded(ref(db, `${node}/ice`), (s) => {
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
        await set(ref(db, `${node}/answer`), { sdp: answer.sdp ?? '' })
      } catch (err) {
        console.warn('[audience voice] answer failed', err)
      }
    })

    return () => {
      unsubOffer()
      teardown()
      remove(ref(db, `${node}/answer`)).catch(() => {})
      audio.current = null
    }
  }, [base, audienceId, unlocked])

  return { connected }
}
