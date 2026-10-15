import type { Signal } from '../types/intercom'

/**
 * Full-mesh WebRTC voice for a small crew: one RTCPeerConnection per pair of stations.
 * Signaling travels through Firebase (see useIntercom). To avoid both sides offering at once
 * ("glare"), the station with the lexicographically smaller id always makes the offer.
 *
 * Without a microphone (denied or absent) the station still joins listen-only, so it hears
 * everyone else.
 */

const ICE_SERVERS: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }]

interface Peer {
  pc: RTCPeerConnection
  /** ICE candidates that arrived before the remote description was set. */
  pending: RTCIceCandidateInit[]
  remoteSet: boolean
  retryTimer?: number
}

export interface VoiceMeshOptions {
  selfId: string
  send: (to: string, signal: Signal) => void
  onRemoteStream: (peerId: string, stream: MediaStream | null) => void
  onPeerState: (peerId: string, state: RTCPeerConnectionState) => void
}

/** Friendly explanations for getUserMedia failures. */
const isHomeScreenApp = () => window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true

export function describeMicError(err: unknown): string {
  const name = (err as DOMException)?.name
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    return '此網址不支援麥克風：語音需要 https 或 localhost（區網 http 無法使用）。目前為僅收聽模式。'
  }
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    // iOS asks for the microphone again in every launch of a home-screen app, and a "Don't Allow"
    // sticks until the app is closed: say exactly what to do.
    if (isHomeScreenApp()) {
      return `麥克風權限被拒絕（${name}）。主畫面 App 每次開啟都會詢問一次麥克風：請完全關閉此 App（從 App 切換器上滑移除）後重新開啟，出現提示時按「允許」，再按「重新開啟麥克風」。若仍然不行，請改用 Safari 開啟網頁版。目前為僅收聽模式。`
    }
    return `麥克風權限被拒絕（${name}）。請在瀏覽器網址列的權限設定允許麥克風，再按「重新開啟麥克風」。目前為僅收聽模式。`
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return '找不到麥克風裝置，目前為僅收聽模式。'
  if (name === 'NotReadableError') return '麥克風正被其他程式使用中，目前為僅收聽模式。'
  return `無法開啟麥克風（${name ?? 'Error'}：${(err as Error)?.message ?? ''}），目前為僅收聽模式。`
}

export class VoiceMesh {
  private peers = new Map<string, Peer>()
  private localStream: MediaStream | null = null
  private micEnabled = false
  private closed = false
  private readonly opts: VoiceMeshOptions

  constructor(opts: VoiceMeshOptions) {
    this.opts = opts
  }

  get hasMic() {
    return this.localStream !== null
  }

  /**
   * Open the microphone. Resolves with an error message (listen-only) instead of throwing, so the
   * caller can still join the channel.
   */
  async start(): Promise<string | null> {
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      this.setMicEnabled(this.micEnabled)
      return null
    } catch (err) {
      this.localStream = null
      return describeMicError(err)
    }
  }

  get stream() {
    return this.localStream
  }

  setMicEnabled(on: boolean) {
    this.micEnabled = on
    this.localStream?.getAudioTracks().forEach((t) => (t.enabled = on))
  }

  /** Connect to exactly these stations (everyone else on the voice channel). */
  syncPeers(ids: string[]) {
    if (this.closed) return
    const wanted = new Set(ids.filter((id) => id !== this.opts.selfId))
    for (const id of [...this.peers.keys()]) if (!wanted.has(id)) this.closePeer(id)
    for (const id of wanted) {
      if (!this.peers.has(id) && this.opts.selfId < id) this.call(id)
    }
  }

  async handleSignal(signal: Signal) {
    if (this.closed) return
    const { from } = signal
    try {
      if (signal.type === 'bye') {
        this.closePeer(from)
      } else if (signal.type === 'offer') {
        // A fresh offer replaces any half-built connection (e.g. after a reload on their side).
        this.closePeer(from)
        const peer = this.createPeer(from)
        await peer.pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp })
        await this.flushCandidates(peer)
        const answer = await peer.pc.createAnswer()
        await peer.pc.setLocalDescription(answer)
        this.opts.send(from, { from: this.opts.selfId, type: 'answer', sdp: answer.sdp ?? '' })
      } else if (signal.type === 'answer') {
        const peer = this.peers.get(from)
        if (!peer || peer.pc.signalingState !== 'have-local-offer') return
        await peer.pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp })
        await this.flushCandidates(peer)
      } else if (signal.type === 'candidate') {
        const peer = this.peers.get(from)
        if (!peer) return
        if (peer.remoteSet) await peer.pc.addIceCandidate(signal.candidate).catch(() => {})
        else peer.pending.push(signal.candidate)
      }
    } catch (err) {
      console.warn('[intercom] signaling error with', from, err)
    }
  }

  stop() {
    this.closed = true
    for (const id of [...this.peers.keys()]) {
      this.opts.send(id, { from: this.opts.selfId, type: 'bye' })
      this.closePeer(id)
    }
    this.localStream?.getTracks().forEach((t) => t.stop())
    this.localStream = null
  }

  private async call(id: string) {
    const peer = this.createPeer(id)
    try {
      const offer = await peer.pc.createOffer()
      await peer.pc.setLocalDescription(offer)
      this.opts.send(id, { from: this.opts.selfId, type: 'offer', sdp: offer.sdp ?? '' })
    } catch (err) {
      console.warn('[intercom] offer failed', err)
    }
  }

  private createPeer(id: string): Peer {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    const peer: Peer = { pc, pending: [], remoteSet: false }
    this.peers.set(id, peer)

    if (this.localStream) {
      for (const track of this.localStream.getAudioTracks()) pc.addTrack(track, this.localStream)
    } else {
      // Listen-only: still negotiate an audio line so the other side can send to us.
      pc.addTransceiver('audio', { direction: 'recvonly' })
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) this.opts.send(id, { from: this.opts.selfId, type: 'candidate', candidate: e.candidate.toJSON() })
    }
    pc.ontrack = (e) => this.opts.onRemoteStream(id, e.streams[0] ?? new MediaStream([e.track]))
    pc.onconnectionstatechange = () => {
      this.opts.onPeerState(id, pc.connectionState)
      // The offering side re-dials after a failure (network change, Wi-Fi drop).
      if (pc.connectionState === 'failed' && this.opts.selfId < id && !this.closed) {
        clearTimeout(peer.retryTimer)
        peer.retryTimer = window.setTimeout(() => {
          if (this.peers.get(id) === peer) {
            this.closePeer(id)
            this.call(id)
          }
        }, 2000)
      }
    }
    return peer
  }

  private async flushCandidates(peer: Peer) {
    peer.remoteSet = true
    for (const c of peer.pending.splice(0)) await peer.pc.addIceCandidate(c).catch(() => {})
  }

  private closePeer(id: string) {
    const peer = this.peers.get(id)
    if (!peer) return
    clearTimeout(peer.retryTimer)
    peer.pc.onicecandidate = null
    peer.pc.ontrack = null
    peer.pc.onconnectionstatechange = null
    peer.pc.close()
    this.peers.delete(id)
    this.opts.onRemoteStream(id, null)
    this.opts.onPeerState(id, 'closed')
  }
}
