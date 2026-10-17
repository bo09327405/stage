import {
  increment,
  limitToLast,
  onChildAdded,
  onDisconnect,
  onValue,
  push,
  query,
  ref,
  remove,
  serverTimestamp,
  set,
  update,
} from 'firebase/database'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { intercomAudio, playCallBuzzer, primeRingtone, unlockOnFirstGesture } from '../services/buzzer'
import { currentUser } from '../services/auth'
import { deviceId, disableCallPush, enableCallPush, pushStatus, ringCallPush, syncCallPush, testCallPush, type PushStatus } from '../services/callPush'
import { db } from '../services/firebase'
import { VoiceMesh } from '../services/voiceMesh'
import { AudienceVoiceSender, type AudienceTarget } from '../services/audienceVoice'
import {
  channelsMeet,
  intercomPath,
  type ChatMessage,
  isGroupChannel,
  isGroupLike,
  type IntercomChannel,
  type IntercomTarget,
  type IntercomCall,
  type IntercomMember,
  type IntercomRole,
  type MicMode,
  type Signal,
} from '../types/intercom'

const IDENTITY_KEY = 'theatre.intercomIdentity'
const MESSAGE_HISTORY = 150
/** A call older than this (on the shared server clock) is not rung: e.g. one that ended while the page was frozen. */
const CALL_MAX_AGE_MS = 20_000
const CHANNEL_KEY = 'theatre.intercomChannel'
const VOLUME_KEY = 'theatre.intercomVolume'
const TARGETS_KEY = 'theatre.intercomGroupTargets'
const SNOOZE_KEY = 'theatre.audienceTalkSnooze'
/** "Don't warn me again" for talking to the audience lasts this long. */
const SNOOZE_MS = 30 * 60 * 1000

function loadPref<T>(key: string, parse: (raw: string) => T | null, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw == null ? fallback : (parse(raw) ?? fallback)
  } catch {
    return fallback
  }
}
function savePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Not remembered across reloads; harmless.
  }
}

export interface IntercomIdentity {
  name: string
  role: IntercomRole
}

function loadIdentity(): IntercomIdentity | null {
  try {
    const raw = localStorage.getItem(IDENTITY_KEY)
    return raw ? (JSON.parse(raw) as IntercomIdentity) : null
  } catch {
    return null
  }
}

// One station per browser tab.
const MEMBER_ID = `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`

export interface ActiveCallAlert {
  call: IntercomCall
  /** Called me specifically (rather than everyone). */
  direct: boolean
}

/**
 * Production intercom for a project: presence, text chat, CALL buzzer and WebRTC voice.
 * Mount once per page (it keeps running while the panel is closed).
 */
export function useIntercom(projectId: string, groupCount = 0, versionBase = '') {
  const base = intercomPath(projectId)
  const [identity, setIdentity] = useState<IntercomIdentity | null>(loadIdentity)
  // Latest identity for callbacks that run right after join(), before a re-render.
  const identityRef = useRef(identity)
  const [joined, setJoined] = useState(false)
  const [members, setMembers] = useState<IntercomMember[]>([])
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [alert, setAlert] = useState<ActiveCallAlert | null>(null)
  const [readUpTo, setReadUpTo] = useState(0)
  const [channel, setChannelState] = useState<IntercomChannel>(() =>
    loadPref<IntercomChannel>(CHANNEL_KEY, (r) => (r === 'A' || r === 'B' || r === 'all' || isGroupLike(r) ? (r as IntercomChannel) : null), 'all'),
  )
  const [listenVolume, setListenVolumeState] = useState(() =>
    loadPref(VOLUME_KEY, (r) => (Number.isFinite(Number(r)) ? Math.max(0, Math.min(1, Number(r))) : null), 1),
  )
  // The show was regrouped to fewer groups than this station's channel: fall back to All Call.
  useEffect(() => {
    if ((isGroupChannel(channel) && Number(channel.replace('channel_', '')) > groupCount) || (channel === 'channel_all' && groupCount === 0)) {
      setChannelState('all')
      savePref(CHANNEL_KEY, 'all')
    }
  }, [channel, groupCount])
  const setChannel = useCallback((c: IntercomChannel) => {
    setChannelState(c)
    savePref(CHANNEL_KEY, c)
  }, [])
  const setListenVolume = useCallback((v: number) => {
    const clamped = Math.max(0, Math.min(1, v))
    setListenVolumeState(clamped)
    savePref(VOLUME_KEY, String(clamped))
  }, [])

  // Voice
  const [voiceOn, setVoiceOn] = useState(false)
  const [voiceError, setVoiceError] = useState<string | null>(null)
  const [hasMic, setHasMic] = useState(false)
  const [micMode, setMicMode] = useState<MicMode>('ptt')
  const [muted, setMuted] = useState(true)
  const [pttHeld, setPttHeld] = useState(false)
  const [speaking, setSpeaking] = useState<Set<string>>(new Set())
  const [peerStates, setPeerStates] = useState<Record<string, RTCPeerConnectionState>>({})
  const meshRef = useRef<VoiceMesh | null>(null)
  const remoteAudio = useRef(new Map<string, { el: HTMLAudioElement; analyser: AnalyserNode; source: MediaStreamAudioSourceNode }>())
  const localAnalyser = useRef<AnalyserNode | null>(null)

  const memberRef = ref(db, `${base}/members/${MEMBER_ID}`)

  /* ---------- group channels: crew or audience ---------- */

  // On a group channel (Ch 1 … Ch 10) this station talks either to other crew on it or to the audience of
  // that group. Crew channels (A / B / All) never reach the audience.
  const [groupTargets, setGroupTargets] = useState<Record<string, IntercomTarget>>(() =>
    loadPref<Record<string, IntercomTarget>>(TARGETS_KEY, (r) => (JSON.parse(r) as Record<string, IntercomTarget>) ?? null, {}),
  )
  const target: IntercomTarget = isGroupLike(channel) ? (groupTargets[channel] ?? 'crew') : 'crew'
  const setGroupTarget = useCallback((c: IntercomChannel, t: IntercomTarget) => {
    setGroupTargets((prev) => {
      const next = { ...prev, [c]: t }
      savePref(TARGETS_KEY, JSON.stringify(next))
      return next
    })
  }, [])
  const audienceTalk = target === 'audience' && !!versionBase

  // Warning before the first words to the audience: confirm once per channel, or "don't ask for 30 min".
  const [snoozeUntil, setSnoozeUntil] = useState(() => loadPref(SNOOZE_KEY, (r) => Number(r) || 0, 0))
  const [okChannel, setOkChannel] = useState<string | null>(null)
  const [askOpen, setAskOpen] = useState(false)
  const [, setTick] = useState(0)
  useEffect(() => {
    const left = snoozeUntil - Date.now()
    if (left <= 0) return
    const timer = window.setTimeout(() => setTick((t) => t + 1), left + 50)
    return () => window.clearTimeout(timer)
  }, [snoozeUntil])
  const audienceOk = audienceTalk && (okChannel === channel || snoozeUntil > Date.now())

  // Holding TALK (on screen or the T key) opens the mic in either mode; open mode also has a latch.
  // Talking to the audience additionally needs the confirmation above.
  const micLive = voiceOn && hasMic && (pttHeld || (micMode === 'open' && !muted)) && (!audienceTalk || audienceOk)
  useEffect(() => {
    // Keyed without confirmation: don't open the mic, ask first.
    if (audienceTalk && !audienceOk && (pttHeld || (voiceOn && micMode === 'open' && !muted))) {
      setPttHeld(false)
      setMuted(true)
      setAskOpen(true)
    }
  }, [audienceTalk, audienceOk, pttHeld, voiceOn, micMode, muted])
  const talkGate = {
    open: askOpen && audienceTalk && !audienceOk,
    channel,
    snoozeMinutes: SNOOZE_MS / 60000,
    confirm: (snooze: boolean) => {
      setOkChannel(channel)
      if (snooze) {
        const until = Date.now() + SNOOZE_MS
        setSnoozeUntil(until)
        savePref(SNOOZE_KEY, String(until))
      }
      setAskOpen(false)
    },
    /** "Fix the target": switch this channel back to crew. */
    fixTarget: () => {
      setGroupTarget(channel, 'crew')
      setAskOpen(false)
    },
    cancel: () => setAskOpen(false),
  }

  /* ---------- presence ---------- */

  const join = useCallback(
    async (who: IntercomIdentity) => {
      const name = who.name.trim().slice(0, 24)
      if (!name) throw new Error('請輸入名字')
      const clean = { name, role: who.role }
      try {
        localStorage.setItem(IDENTITY_KEY, JSON.stringify(clean))
      } catch {
        // Not remembered across reloads; harmless.
      }
      primeRingtone() // this click unlocks the call buzzer (context and ring element)
      intercomAudio()
      identityRef.current = clean
      setIdentity(clean)
      await remove(ref(db, `${base}/signals/${MEMBER_ID}`)).catch(() => {})
      await onDisconnect(memberRef).remove()
      await onDisconnect(ref(db, `${base}/signals/${MEMBER_ID}`)).remove()
      await set(memberRef, { ...clean, joinedAt: serverTimestamp(), voice: false, muted: true, micMode, channel })
      setJoined(true)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [base, micMode, channel],
  )

  // Returning crew rejoin chat/presence automatically; voice always needs an explicit tap.
  const autoJoined = useRef(false)
  useEffect(() => {
    if (autoJoined.current || !identity) return
    autoJoined.current = true
    unlockOnFirstGesture()
    join(identity).catch(() => {})
  }, [identity, join])

  // A network blip fires onDisconnect (removing us); put the station back once reconnected.
  const presence = useRef({ identity, voiceOn: false, muted: true, micMode: 'ptt' as MicMode, channel, target: 'crew' as IntercomTarget })
  useEffect(() => {
    if (!joined) return
    let wasConnected = true
    return onValue(ref(db, '.info/connected'), (snapshot) => {
      const connected = snapshot.val() === true
      if (connected && !wasConnected && presence.current.identity) {
        const { identity: who, voiceOn: v, muted: m, micMode: mode, channel: ch, target: tg } = presence.current
        onDisconnect(memberRef)
          .remove()
          .then(() => set(memberRef, { ...who, joinedAt: serverTimestamp(), voice: v, muted: m, micMode: mode, channel: ch, target: tg }))
          .catch(() => {})
      }
      wasConnected = connected
    })
    // memberRef is stable for this tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joined, base])

  useEffect(
    () =>
      onValue(ref(db, `${base}/members`), (snapshot) => {
        const raw = (snapshot.val() ?? {}) as Record<string, Omit<IntercomMember, 'id'>>
        setMembers(
          Object.entries(raw)
            .map(([id, m]) => ({ ...m, id }))
            .sort((a, b) => a.joinedAt - b.joinedAt),
        )
      }),
    [base],
  )

  /* ---------- chat ---------- */

  useEffect(
    () =>
      onValue(query(ref(db, `${base}/messages`), limitToLast(MESSAGE_HISTORY)), (snapshot) => {
        const raw = (snapshot.val() ?? {}) as Record<string, Omit<ChatMessage, 'id'>>
        setMessages(
          Object.entries(raw)
            .map(([id, m]) => ({ ...m, id }))
            .sort((a, b) => a.at - b.at),
        )
      }),
    [base],
  )

  const sendMessage = useCallback(
    async (text: string) => {
      const body = text.trim().slice(0, 500)
      const who = identityRef.current
      if (!body) return
      if (!who) throw new Error('請先加入 Intercom')
      const photo = currentUser()?.photo
      await set(push(ref(db, `${base}/messages`)), { memberId: MEMBER_ID, ...who, ...(photo ? { photo } : {}), channel, text: body, at: serverTimestamp() })
    },
    [base, channel],
  )

  // Chat follows the party line: you see the messages of the channels you can hear.
  const visibleMessages = useMemo(() => messages.filter((m) => channelsMeet(channel, m.channel)), [messages, channel])
  const unread = visibleMessages.filter((m) => m.at > readUpTo && m.memberId !== MEMBER_ID).length
  const markRead = useCallback(() => setReadUpTo(Date.now() + 60_000), [])

  /* ---------- CALL ---------- */

  // Phones' clocks drift: compare call times on the Firebase server clock, not the local one.
  const serverOffset = useRef(0)
  useEffect(() => onValue(ref(db, '.info/serverTimeOffset'), (s) => void (serverOffset.current = Number(s.val()) || 0)), [])
  const lastCallSeq = useRef<number | null>(null)
  const channelRef = useRef(channel)
  useEffect(() => {
    channelRef.current = channel
  }, [channel])
  useEffect(
    () =>
      onValue(ref(db, `${base}/call`), (snapshot) => {
        const call = snapshot.val() as IntercomCall | null
        // The first snapshot (even an empty one) is the baseline: whatever call was already
        // there when the page loaded must not ring.
        const first = lastCallSeq.current === null
        const seq = call?.seq ?? 0
        const isNew = seq !== lastCallSeq.current
        lastCallSeq.current = seq
        if (!call || first || !isNew || Date.now() + serverOffset.current - call.at > CALL_MAX_AGE_MS) return
        if (call.from === MEMBER_ID) return
        if (call.target !== '*' && call.target !== MEMBER_ID) return
        if (call.target === '*' && !channelsMeet(channelRef.current, call.channel)) return
        setAlert({ call, direct: call.target === MEMBER_ID })
        playCallBuzzer()
        navigator.vibrate?.([300, 120, 300, 120, 600])
      }),
    [base],
  )

  useEffect(() => {
    if (!alert) return
    const timer = setTimeout(() => setAlert(null), 4000)
    return () => clearTimeout(timer)
  }, [alert])

  const call = useCallback(
    async (target: string = '*') => {
      if (!identity) return
      await update(ref(db, `${base}/call`), {
        seq: increment(1),
        from: MEMBER_ID,
        ...identity,
        target,
        channel,
        // Server clock (client time + offset), so a phone with a wrong clock neither misses nor replays calls.
        at: Date.now() + serverOffset.current,
      })
      // Phones with the app in the background hear it through Web Push.
      ringCallPush(projectId, { target, channel, name: identity.name, role: identity.role })
    },
    [base, identity, channel, projectId],
  )

  /* ---------- background alerts (Web Push) ---------- */

  const [pushState, setPushState] = useState<PushStatus>(() => pushStatus())
  const pushInfo = identity ? { memberId: MEMBER_ID, name: identity.name, role: identity.role, channel } : null
  const enablePush = useCallback(async () => {
    if (!pushInfo) throw new Error('請先加入 Intercom')
    await enableCallPush(base, pushInfo)
    setPushState(pushStatus())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, identity, channel])
  const disablePush = useCallback(async () => {
    await disableCallPush(base)
    setPushState(pushStatus())
  }, [base])
  // Keep the stored subscription pointing at this tab and channel.
  useEffect(() => {
    if (joined && pushInfo) syncCallPush(base, pushInfo).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joined, base, identity, channel])

  /* ---------- voice ---------- */

  const attachRemote = useCallback((peerId: string, stream: MediaStream | null) => {
    const existing = remoteAudio.current.get(peerId)
    if (existing) {
      existing.el.srcObject = null
      existing.el.remove()
      existing.source.disconnect()
      remoteAudio.current.delete(peerId)
    }
    if (!stream) return
    // Chrome only plays remote WebRTC audio through a media element.
    const el = document.createElement('audio')
    el.autoplay = true
    el.srcObject = stream
    el.style.display = 'none'
    document.body.appendChild(el)
    el.play().catch(() => {})
    const audio = intercomAudio()
    const source = audio.createMediaStreamSource(stream)
    const analyser = audio.createAnalyser()
    analyser.fftSize = 512
    source.connect(analyser) // metering only, not routed to speakers
    remoteAudio.current.set(peerId, { el, analyser, source })
  }, [])

  const enableVoice = useCallback(async () => {
    if (meshRef.current || !joined) return
    intercomAudio()
    const mesh = new VoiceMesh({
      selfId: MEMBER_ID,
      send: (to, signal) => {
        set(push(ref(db, `${base}/signals/${to}`)), signal).catch(() => {})
      },
      onRemoteStream: attachRemote,
      onPeerState: (peerId, state) => setPeerStates((s) => ({ ...s, [peerId]: state })),
    })
    meshRef.current = mesh
    const error = await mesh.start()
    setVoiceError(error)
    setHasMic(mesh.hasMic)
    if (mesh.stream) {
      const source = intercomAudio().createMediaStreamSource(mesh.stream)
      const analyser = intercomAudio().createAnalyser()
      analyser.fftSize = 512
      source.connect(analyser)
      localAnalyser.current = analyser
    }
    setVoiceOn(true)
  }, [attachRemote, base, joined])

  /** Ask for the microphone again (call from a tap: the browser only prompts inside a gesture). */
  const retryMic = useCallback(() => {
    meshRef.current?.stop()
    meshRef.current = null
    localAnalyser.current = null
    setHasMic(false)
    // enableVoice() reaches getUserMedia synchronously, so the tap's permission to prompt still applies.
    return enableVoice()
  }, [enableVoice])

  const disableVoice = useCallback(() => {
    meshRef.current?.stop()
    meshRef.current = null
    localAnalyser.current = null
    for (const id of [...remoteAudio.current.keys()]) attachRemote(id, null)
    setVoiceOn(false)
    setHasMic(false)
    setPeerStates({})
  }, [attachRemote])

  // Incoming signals for this station.
  useEffect(() => {
    if (!joined) return
    const inbox = ref(db, `${base}/signals/${MEMBER_ID}`)
    return onChildAdded(inbox, (snapshot) => {
      const signal = snapshot.val() as Signal
      remove(snapshot.ref).catch(() => {})
      meshRef.current?.handleSignal(signal)
    })
  }, [base, joined])

  // Keep the mesh connected to everyone else who has voice on.
  const voicePeers = members
    .filter((m) => m.voice && m.id !== MEMBER_ID)
    .map((m) => m.id)
    .sort()
    .join(',')
  useEffect(() => {
    if (voiceOn) meshRef.current?.syncPeers(voicePeers ? voicePeers.split(',') : [])
  }, [voiceOn, voicePeers])

  // Mic state → tracks and the member record.
  useEffect(() => {
    presence.current = { identity, voiceOn, muted: !micLive, micMode, channel, target }
    meshRef.current?.setMicEnabled(micLive)
    if (joined) update(memberRef, { voice: voiceOn, muted: !micLive, micMode, channel, target }).catch(() => {})
    // memberRef is stable for this tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [micLive, voiceOn, micMode, joined, identity, channel, target])

  // Channel gating and listen level: each remote voice plays only if our channels meet.
  const memberChannels = members.map((m) => `${m.id}:${m.channel ?? ''}:${m.target ?? ''}`).join(',')
  const audible = useMemo(() => {
    const of = new Map(memberChannels.split(',').map((e) => e.split(':') as [string, string, string]).map(([id, ch, tg]) => [id, { ch, tg }] as const))
    // A station talking to the audience isn't talking to crew: its voice is muted for everyone else here.
    return (peerId: string) => {
      const peer = of.get(peerId)
      return channelsMeet(channel, (peer?.ch || undefined) as IntercomChannel | undefined) && peer?.tg !== 'audience'
    }
  }, [channel, memberChannels])
  const applyListen = useCallback(() => {
    for (const [id, { el }] of remoteAudio.current) {
      el.muted = !audible(id)
      el.volume = listenVolume
    }
  }, [audible, listenVolume])
  useEffect(applyListen, [applyListen, peerStates])

  // Push-to-talk: hold T anywhere on the page (outside text fields) while joined. Matched by the
  // physical key (e.code) so it also works with Zhuyin / other input methods and Caps Lock; those
  // report keyCode 229 / a different e.key, which the old check threw away. The first press turns
  // voice on if needed (a key press counts as the gesture the microphone permission needs).
  const pttKeyDown = useRef(false)
  const voiceOnRef = useRef(voiceOn)
  useEffect(() => {
    voiceOnRef.current = voiceOn
  }, [voiceOn])
  useEffect(() => {
    if (!joined) return
    const isT = (e: KeyboardEvent) => e.code === 'KeyT' || e.key?.toLowerCase() === 't'
    const inField = (el: EventTarget | Element | null) =>
      !!(el as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
    const release = () => {
      if (!pttKeyDown.current) return
      pttKeyDown.current = false
      setPttHeld(false)
    }
    const down = (e: KeyboardEvent) => {
      if (!isT(e) || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.repeat) return
      if (inField(e.target) || inField(document.activeElement)) return
      e.preventDefault()
      pttKeyDown.current = true
      setPttHeld(true)
      if (!voiceOnRef.current) enableVoice().catch(() => {})
    }
    const up = (e: KeyboardEvent) => {
      if (isT(e)) release()
    }
    const hidden = () => {
      if (document.hidden) release()
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', release)
    document.addEventListener('visibilitychange', hidden)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', release)
      document.removeEventListener('visibilitychange', hidden)
      release()
    }
  }, [joined, enableVoice])

  // Who is talking: RMS level of each stream, sampled ten times a second.
  useEffect(() => {
    if (!voiceOn) {
      setSpeaking(new Set())
      return
    }
    const buf = new Float32Array(512)
    const level = (a: AnalyserNode) => {
      a.getFloatTimeDomainData(buf)
      let sum = 0
      for (const v of buf) sum += v * v
      return Math.sqrt(sum / buf.length)
    }
    const timer = setInterval(() => {
      const next = new Set<string>()
      if (localAnalyser.current && micLive && level(localAnalyser.current) > 0.02) next.add(MEMBER_ID)
      for (const [id, { analyser }] of remoteAudio.current) if (level(analyser) > 0.02) next.add(id)
      setSpeaking((prev) => (prev.size === next.size && [...next].every((id) => prev.has(id)) ? prev : next))
    }, 100)
    return () => clearInterval(timer)
  }, [voiceOn, micLive])

  /* ---------- live voice to the audience of a group ---------- */

  const [audiencePresence, setAudiencePresence] = useState<AudienceTarget[]>([])
  const [audienceReach, setAudienceReach] = useState(0)
  const senderRef = useRef<AudienceVoiceSender | null>(null)
  // Who is in this group right now (audience devices announce themselves with their group).
  useEffect(() => {
    if (!audienceTalk || !isGroupLike(channel)) {
      setAudiencePresence([])
      return
    }
    return onValue(ref(db, `${versionBase}/presence`), (snapshot) => {
      const raw = (snapshot.val() ?? {}) as Record<string, { joinedAt?: number; channel?: string }>
      setAudiencePresence(
        Object.entries(raw)
          .filter(([, v]) => !!v && (channel === 'channel_all' ? !!v.channel : v.channel === channel))
          .map(([audienceId, v]) => ({ audienceId, joinedAt: Number(v.joinedAt) || 0 })),
      )
    })
  }, [audienceTalk, channel, versionBase])
  // Keep a connection to each of them while armed; the mic track only opens on TALK (micLive).
  useEffect(() => {
    if (!(audienceTalk && voiceOn && hasMic)) {
      setAudienceReach(0)
      return
    }
    const sender = new AudienceVoiceSender(versionBase, MEMBER_ID, () => meshRef.current?.stream ?? null, setAudienceReach)
    senderRef.current = sender
    return () => {
      sender.stop()
      if (senderRef.current === sender) senderRef.current = null
    }
  }, [audienceTalk, voiceOn, hasMic, versionBase, channel])
  useEffect(() => {
    senderRef.current?.sync(audiencePresence)
  }, [audiencePresence, audienceTalk, voiceOn, hasMic, channel])

  /* ---------- leave ---------- */

  const leave = useCallback(async () => {
    disableVoice()
    setJoined(false)
    await onDisconnect(memberRef).cancel().catch(() => {})
    await remove(memberRef).catch(() => {})
    // Left the channel: stop ringing this device (re-joining brings it back if alerts are on).
    await remove(ref(db, `${base}/push/${deviceId()}`)).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disableVoice])

  // Tear down on unmount (switching project, closing the console).
  useEffect(
    () => () => {
      meshRef.current?.stop()
      meshRef.current = null
      for (const { el, source } of remoteAudio.current.values()) {
        el.srcObject = null
        el.remove()
        source.disconnect()
      }
      remoteAudio.current.clear()
      remove(ref(db, `${intercomPath(projectId)}/members/${MEMBER_ID}`)).catch(() => {})
    },
    [projectId],
  )

  return {
    selfId: MEMBER_ID,
    identity,
    /** Number of audience groups of the show: Ch 1 … Ch N are offered as extra channels. */
    groupCount,
    channel,
    /** On a group channel: who this station talks to (crew or the audience of that group). */
    target,
    /** The target set for any group channel (crew by default). */
    targetOf: (c: IntercomChannel): IntercomTarget => groupTargets[c] ?? 'crew',
    setGroupTarget,
    /** Audience devices currently connected to this station's live voice. */
    audienceReach,
    /** Devices in the group that could be reached. */
    audienceInGroup: audiencePresence.length,
    /** Warning dialog state for talking to the audience (see AudienceTalkGate). */
    talkGate,
    setChannel,
    listenVolume,
    setListenVolume,
    /** Whether this station hears that member (their channel meets ours). */
    audible,
    joined,
    join,
    leave,
    members,
    messages,
    /** Messages on the channels this station hears (Ch A / Ch B / All Call). */
    visibleMessages,
    sendMessage,
    unread,
    markRead,
    call,
    /** Background CALL alerts (Web Push): works with the app in the background / phone locked. */
    push: { status: pushState, enable: enablePush, disable: disablePush, test: () => testCallPush(projectId) },
    alert,
    dismissAlert: () => setAlert(null),
    voice: {
      on: voiceOn,
      error: voiceError,
      hasMic,
      micMode,
      setMicMode,
      muted,
      setMuted,
      pttHeld,
      setPttHeld,
      micLive,
      speaking,
      peerStates,
      enable: enableVoice,
      retryMic,
      disable: disableVoice,
    },
  }
}
