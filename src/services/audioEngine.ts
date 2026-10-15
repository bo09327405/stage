import { dimGain } from '../utils/dim'
import {
  DEFAULT_SHOW_FX,
  type ShowFx,
  type ShowXfade,
  activeEndAt,
  activeStartAt,
  cueTargets,
  isMediaCue,
  segmentLength,
  type ActiveCue,
  type HitTrigger,
  type Cue,
} from '../types/cue'
import { prepareStudioMix, studioMixUrl } from '../studio/cueMix'

/**
 * Audience-side playback for AUDIO/VIDEO cues and hits.
 *
 * Signal chain per voice: <audio>/<video> → envelope gain (volume, fades) → duck gain → master.
 * Everything goes through Web Audio because iOS ignores HTMLMediaElement.volume — gain nodes are
 * the only way to get volume, fades, ducking, Master and DIM on iPhones. iOS also only allows
 * playback on elements started inside a user gesture, so a fixed pool is primed in unlock().
 *
 * Media URLs must be served with CORS (Cloudinary is); otherwise Web Audio outputs silence.
 */

const CUE_POOL_SIZE = 8
const HIT_POOL_SIZE = 4
/** Hits older than this when they arrive (late joiners, reconnects) are not played. */
const HIT_MAX_AGE_MS = 3000
const CUT_FADE = 0.03
const TICK_MS = 50

/** Live levels from the console: the manual crossfade, hit levels, executor faders. */
export interface LiveLevels {
  xfade: ShowXfade | null
  hitLevels: Record<string, number>
  execLevels: Record<string, number>
}

interface Slot {
  el: HTMLMediaElement
  env: GainNode
  /** Live level from the control panel: manual crossfade position, a ridden hit's or an executor's fader. */
  live: GainNode
  /** The cue's own stereo position (executor cues). */
  pan: StereoPannerNode
  duck: GainNode
  /** instanceId, or "hit:<hitId>", currently using this slot. */
  owner: string | null
  lastUsed: number
  duckTarget: number
}

interface Voice {
  inst: ActiveCue
  slot: Slot
  timers: number[]
  stopping: boolean
  started: boolean
  /** Frozen by a show-wide pause or by pausing this one cue. */
  held: boolean
}

function silentWavUrl(): string {
  const sampleRate = 8000
  const samples = sampleRate / 10
  const buffer = new ArrayBuffer(44 + samples)
  const view = new DataView(buffer)
  const writeStr = (offset: number, s: string) => [...s].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)))
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + samples, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate, true)
  view.setUint16(32, 1, true)
  view.setUint16(34, 8, true)
  writeStr(36, 'data')
  view.setUint32(40, samples, true)
  new Uint8Array(buffer, 44).fill(128) // 8-bit silence midpoint
  return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }))
}

export class StageAudioEngine {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private cuePool: Slot[] = []
  private hitPool: Slot[] = []
  private videoSlot: Slot | null = null
  private voices = new Map<string, Voice>()
  private active: Record<string, ActiveCue> = {}
  private audienceId = ''
  private lastHitSeq: number | null = null
  private masterLevel = 1
  private paused = false
  private lastHitStopSeq: number | null = null
  private serverNow: () => number = Date.now

  /** The shared <video> element; the stage display mounts it when a VIDEO cue owns the screen. */
  readonly videoElement: HTMLVideoElement
  /** Called when the browser refuses to play (needs another tap). */
  onBlocked: (blocked: boolean) => void = () => {}

  constructor() {
    this.videoElement = document.createElement('video')
    this.videoElement.playsInline = true
    this.videoElement.className = 'h-full w-full object-contain'
  }

  get isUnlocked() {
    return this.ctx !== null
  }

  /** "running" once sound can actually come out; "suspended" until a tap allows it. */
  get contextState(): AudioContextState | 'none' {
    return this.ctx?.state ?? 'none'
  }

  /** Change which audience code this device plays for (the console's Stage window can switch). */
  setAudience(audienceId: string) {
    this.audienceId = audienceId
  }

  /** Must be called synchronously inside a user gesture. */
  unlock(serverNow: () => number, audienceId: string) {
    this.serverNow = serverNow
    this.audienceId = audienceId
    if (this.ctx) return this.resume()

    const ctx = new AudioContext()
    this.ctx = ctx
    this.master = ctx.createGain()
    this.master.gain.value = this.masterLevel
    this.master.connect(this.buildFx(ctx))

    const silent = silentWavUrl()
    const makeSlot = (el: HTMLMediaElement, duckable: boolean): Slot => {
      el.crossOrigin = 'anonymous'
      el.preload = 'auto'
      const env = ctx.createGain()
      const live = ctx.createGain()
      const duck = ctx.createGain()
      const pan = new StereoPannerNode(ctx)
      env.gain.value = 0
      ctx.createMediaElementSource(el).connect(env).connect(live).connect(pan).connect(duckable ? duck : this.master!)
      if (duckable) duck.connect(this.master!)
      // Priming play() inside the gesture is what unlocks the element on iOS.
      el.src = silent
      el.play().then(() => el.pause(), () => {})
      return { el, env, live, pan, duck, owner: null, lastUsed: 0, duckTarget: 1 }
    }
    this.cuePool = Array.from({ length: CUE_POOL_SIZE }, () => makeSlot(new Audio(), true))
    this.hitPool = Array.from({ length: HIT_POOL_SIZE }, () => makeSlot(new Audio(), false))
    this.videoSlot = makeSlot(this.videoElement, true)
    setTimeout(() => URL.revokeObjectURL(silent), 5000)

    ctx.resume().catch(() => {})
    window.setInterval(() => this.tick(), TICK_MS)
  }

  /** Retry after the browser blocked playback (call from a gesture). */
  resume() {
    this.ctx?.resume().catch(() => {})
    for (const voice of this.voices.values()) {
      if (!voice.held && voice.started && voice.slot.el.paused && !voice.stopping) this.play(voice.slot.el)
    }
  }

  /* ---------- show FX bus and live levels (control-panel knobs / faders) ---------- */

  private fx: {
    low: BiquadFilterNode
    mid: BiquadFilterNode
    high: BiquadFilterNode
    lp: BiquadFilterNode
    pan: StereoPannerNode
    reverb: GainNode
    delay: GainNode
  } | null = null
  private fxState: ShowFx = DEFAULT_SHOW_FX
  private liveState: LiveLevels = { xfade: null, hitLevels: {}, execLevels: {} }

  /** master → EQ low / mid / high → low-pass → pan → speakers, with reverb and delay sends. Returns its input. */
  private buildFx(ctx: AudioContext): AudioNode {
    const low = new BiquadFilterNode(ctx, { type: 'lowshelf', frequency: 250 })
    const mid = new BiquadFilterNode(ctx, { type: 'peaking', frequency: 1000, Q: 0.9 })
    const high = new BiquadFilterNode(ctx, { type: 'highshelf', frequency: 4000 })
    const lp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 20000, Q: 0.7 })
    const pan = new StereoPannerNode(ctx)
    low.connect(mid).connect(high).connect(lp).connect(pan).connect(ctx.destination)
    // Delay: a 350 ms echo with feedback.
    const delayLine = new DelayNode(ctx, { delayTime: 0.35, maxDelayTime: 2 })
    const feedback = new GainNode(ctx, { gain: 0.35 })
    const delay = new GainNode(ctx, { gain: 0 })
    pan.connect(delayLine).connect(feedback).connect(delayLine)
    delayLine.connect(delay).connect(ctx.destination)
    // Reverb: a generated 2.4 s hall.
    const length = Math.round(ctx.sampleRate * 2.4)
    const ir = ctx.createBuffer(2, length, ctx.sampleRate)
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c)
      for (let i = 0; i < length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 2.5
    }
    const reverb = new GainNode(ctx, { gain: 0 })
    pan.connect(new ConvolverNode(ctx, { buffer: ir })).connect(reverb).connect(ctx.destination)
    this.fx = { low, mid, high, lp, pan, reverb, delay }
    this.applyFx()
    return low
  }

  private applyFx() {
    if (!this.fx || !this.ctx) return
    const t = this.ctx.currentTime
    const f = this.fxState
    const to = (p: AudioParam, v: number) => p.setTargetAtTime(v, t, 0.03)
    to(this.fx.low.gain, f.eqLow)
    to(this.fx.mid.gain, f.eqMid)
    to(this.fx.high.gain, f.eqHigh)
    to(this.fx.lp.frequency, 20 * 1000 ** Math.max(0, Math.min(1, f.filter)))
    to(this.fx.pan.pan, Math.max(-1, Math.min(1, f.pan)))
    to(this.fx.reverb.gain, f.reverb * 0.8)
    to(this.fx.delay.gain, f.delay * 0.7)
  }

  /** Show-wide effects from the console (every audience device, and the console's Stage view). */
  setFx(fx: ShowFx) {
    this.fxState = { ...DEFAULT_SHOW_FX, ...fx }
    this.applyFx()
  }

  /** Manual crossfade, hit and executor levels from the console's faders. */
  setLive(live: Partial<LiveLevels>) {
    this.liveState = { xfade: live.xfade ?? null, hitLevels: live.hitLevels ?? {}, execLevels: live.execLevels ?? {} }
    this.applyLive()
  }

  private applyLive() {
    if (!this.ctx) return
    const t = this.ctx.currentTime
    const { xfade, hitLevels, execLevels } = this.liveState
    const level = (owner: string | null) => {
      if (!owner) return 1
      if (owner.startsWith('hit:')) return hitLevels[owner.slice(4)] ?? 1
      const exec = this.voices.get(owner)?.inst.cue.executor
      if (exec) return execLevels[exec] ?? 1
      if (!xfade) return 1
      if (owner === xfade.to) return xfade.pos
      return xfade.from.includes(owner) ? 1 - xfade.pos : 1
    }
    for (const slot of [...this.cuePool, ...this.hitPool, ...(this.videoSlot ? [this.videoSlot] : [])]) {
      slot.live.gain.setTargetAtTime(Math.max(0, Math.min(1, level(slot.owner))), t, 0.02)
      const cue = slot.owner ? this.voices.get(slot.owner)?.inst.cue : null
      slot.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, cue?.pan ?? 0)), t, 0.02)
    }
  }

  /**
   * Master gain: the show fader × the show DIM (10^(dB/20), see utils/dim.ts) × this page's own
   * monitor trim (the Set Cue headphone DIM; 1 on audience devices). DIM never changes the fader
   * value, so switching it off returns exactly to the previous level.
   */
  setMaster(volume: number, dim: boolean, muted = false, dimDb?: number) {
    this.masterInputs = { volume, dim, muted, dimDb }
    this.masterLevel = muted ? 0 : (volume / 100) * dimGain(dim, dimDb) * this.monitorTrim
    if (this.ctx && this.master) {
      this.master.gain.setTargetAtTime(this.masterLevel, this.ctx.currentTime, 0.05)
    }
  }
  private masterInputs: { volume: number; dim: boolean; muted: boolean; dimDb?: number } = { volume: 100, dim: false, muted: false }
  private monitorTrim = 1
  /** This page's monitoring only (Set Cue headphone DIM): a gain on top of the show master. */
  setMonitorTrim(gain: number) {
    this.monitorTrim = gain
    const { volume, dim, muted, dimDb } = this.masterInputs
    this.setMaster(volume, dim, muted, dimDb)
  }

  /**
   * Reconcile playing voices with the running cue instances addressed to this device.
   * `pausedAt` non-null freezes everything; on resume the console has shifted every instance's
   * timestamps by the pause length, so each voice simply re-seeks and reschedules from them.
   */
  sync(active: Record<string, ActiveCue>, pausedAt: number | null = null) {
    this.active = active
    if (!this.ctx) return
    this.paused = pausedAt != null

    for (const inst of Object.values(active)) {
      if (!isMediaCue(inst.cue) || !(inst.cue.targetUrl || inst.cue.studioId) || !cueTargets(inst.cue, this.audienceId)) continue
      const hold = this.paused || inst.pausedAt != null
      const voice = this.voices.get(inst.instanceId)
      if (!voice) {
        // Cues that appear while held (late joiners) start once they're running again.
        if (inst.stopAt == null && !hold) this.startVoice(inst)
        continue
      }
      const wasHeld = voice.held
      const shifted = voice.inst.firedAt !== inst.firedAt
      const restyled = voice.inst.cue.pan !== inst.cue.pan || voice.inst.cue.executor !== inst.cue.executor
      voice.inst = inst
      if (restyled) this.applyLive()
      if (hold) {
        if (!wasHeld) this.holdVoice(voice)
        continue
      }
      if (inst.stopAt != null && !voice.stopping) {
        voice.held = false
        this.stopVoice(inst.instanceId, Math.max(0, (activeEndAt(inst) - this.serverNow()) / 1000))
      } else if (wasHeld || shifted) {
        // Resumed: the console shifted firedAt by the pause length, so just reschedule from it.
        voice.held = false
        if (voice.stopping) this.continueStop(voice)
        else this.schedule(voice)
      }
    }
    for (const id of [...this.voices.keys()]) {
      if (!active[id]) this.stopVoice(id, CUT_FADE)
    }
  }

  /** Stop hits on this device: one hit id, or "*" for all ("Panic All Hits" / Panic Show). */
  stopHits(request: { target: string; seq: number; at: number } | null) {
    if (!request) return
    const isNew = request.seq !== this.lastHitStopSeq
    this.lastHitStopSeq = request.seq
    if (!this.ctx || !isNew || this.serverNow() - request.at > HIT_MAX_AGE_MS) return
    for (const slot of this.hitPool) {
      if (!slot.owner) continue
      if (request.target !== '*' && slot.owner !== `hit:${request.target}`) continue
      this.rampTo(slot.env, 0, 0.05)
      const el = slot.el
      window.setTimeout(() => el.pause(), 80)
      slot.owner = null
    }
  }

  /** Freeze one voice where it is: media paused, gains held, timers cleared. */
  private holdVoice(voice: Voice) {
    const t = this.ctx!.currentTime
    voice.held = true
    voice.timers.forEach(clearTimeout)
    voice.timers = []
    voice.slot.el.pause()
    for (const gain of [voice.slot.env, voice.slot.duck]) {
      const level = gain.gain.value
      gain.gain.cancelScheduledValues(t)
      gain.gain.setValueAtTime(level, t)
    }
  }

  /** Resume a voice that was mid fade-out when the show paused. */
  private continueStop(voice: Voice) {
    const remaining = Math.max(0, (activeEndAt(voice.inst) - this.serverNow()) / 1000)
    this.play(voice.slot.el)
    this.rampTo(voice.slot.env, 0, remaining)
    const id = voice.inst.instanceId
    voice.timers.push(window.setTimeout(() => this.releaseVoice(id), Math.max(CUT_FADE, remaining) * 1000 + 50))
  }

  playHit(hit: HitTrigger | null) {
    if (!hit) return
    // Old hits seen on first load are filtered by age, so any seq change counts as new.
    const isNew = hit.seq !== this.lastHitSeq
    this.lastHitSeq = hit.seq
    if (!this.ctx || !isNew || !hit.url || this.serverNow() - hit.firedAt > HIT_MAX_AGE_MS) return

    const slot = this.acquire(this.hitPool, `hit:${hit.hitId}`)
    this.applyLive()
    const t = this.ctx.currentTime
    slot.env.gain.cancelScheduledValues(t)
    slot.env.gain.setValueAtTime(hit.volume / 100, t)
    slot.el.loop = false
    slot.el.src = hit.url
    slot.el.currentTime = 0
    this.play(slot.el)
  }

  private play(el: HTMLMediaElement) {
    el.play().then(
      () => this.onBlocked(false),
      (err: DOMException) => {
        if (err.name === 'NotAllowedError') this.onBlocked(true)
      },
    )
  }

  /** Take a free slot, or steal the least recently used one. */
  private acquire(pool: Slot[], owner: string): Slot {
    const slot = pool.find((s) => s.owner === null) ?? pool.reduce((a, b) => (a.lastUsed <= b.lastUsed ? a : b))
    if (slot.owner && !slot.owner.startsWith('hit:')) this.releaseVoice(slot.owner)
    slot.owner = owner
    slot.lastUsed = performance.now()
    return slot
  }

  private startVoice(inst: ActiveCue) {
    const ctx = this.ctx!
    const { cue } = inst
    if (this.serverNow() >= activeEndAt(inst)) return

    let slot: Slot
    if (cue.type === 'VIDEO') {
      slot = this.videoSlot!
      if (slot.owner) this.releaseVoice(slot.owner)
      slot.owner = inst.instanceId
    } else {
      slot = this.acquire(this.cuePool, inst.instanceId)
    }
    const voice: Voice = { inst, slot, timers: [], stopping: false, started: false, held: false }
    this.voices.set(inst.instanceId, voice)
    this.applyLive()

    const { el, env } = slot
    env.gain.cancelScheduledValues(ctx.currentTime)
    env.gain.setValueAtTime(0, ctx.currentTime)
    const trimmed = cue.mediaStartTime > 0 || cue.mediaEndTime > 0
    // Untrimmed loops can use the element's own gapless loop; trimmed ones are wrapped in tick().
    el.loop = cue.loop && !trimmed
    if (cue.studioId && this.projectId) {
      // A DAW Studio cue: play its live mix (rendered on this device; usually ready from standby).
      studioMixUrl(this.projectId, cue.studioId).then(
        (url) => {
          if (slot.owner !== inst.instanceId || !this.voices.has(inst.instanceId)) return
          el.src = url
          el.load()
          this.schedule(voice) // starts at the right point even if rendering took a moment
        },
        () => this.releaseVoice(inst.instanceId),
      )
      return
    }
    el.src = cue.targetUrl
    el.load()
    this.schedule(voice)
  }

  /** The show project this device follows (studio cues load their mix from it). */
  private projectId: string | null = null
  setProject(projectId: string | null) {
    this.projectId = projectId
  }

  /** Get a cue ready before it is GOed: studio cues render their mix in the background. */
  prepare(cue: Cue | null | undefined) {
    if (cue?.studioId && this.projectId && isMediaCue(cue)) prepareStudioMix(this.projectId, cue.studioId)
  }

  /**
   * (Re)compute a voice's playback from its instance timestamps: wait out pre-wait, seek to where
   * the cue should be "now", apply fade-in from that point, and schedule fade-out and release.
   * Used both when a cue starts and when the show resumes from pause.
   */
  private schedule(voice: Voice) {
    const ctx = this.ctx!
    const { inst, slot } = voice
    const { cue } = inst
    const { el, env } = slot
    voice.timers.forEach(clearTimeout)
    voice.timers = []

    const startAt = activeStartAt(inst)
    const endAt = activeEndAt(inst)
    if (this.serverNow() >= endAt) return this.releaseVoice(inst.instanceId)

    const segment = segmentLength(cue)
    const positionAt = (serverMs: number) => {
      const offset = Math.max(0, (serverMs - startAt) / 1000)
      const intoSegment = cue.loop && Number.isFinite(segment) && segment > 0 ? offset % segment : offset
      return cue.mediaStartTime + intoSegment
    }

    const target = cue.volume / 100
    const begin = () => {
      voice.started = true
      // Late joiners, pre-wait and resume all resolve to "how far into the cue are we right now".
      const seek = () => {
        if (slot.owner === inst.instanceId) el.currentTime = positionAt(this.serverNow())
      }
      if (el.readyState >= HTMLMediaElement.HAVE_METADATA) seek()
      else el.addEventListener('loadedmetadata', seek, { once: true })
      this.play(el)

      const offset = Math.max(0, (this.serverNow() - startAt) / 1000)
      const t = ctx.currentTime
      env.gain.cancelScheduledValues(t)
      if (cue.fadeInTime > 0 && offset < cue.fadeInTime) {
        env.gain.setValueAtTime(target * (offset / cue.fadeInTime), t)
        env.gain.linearRampToValueAtTime(target, t + (cue.fadeInTime - offset))
      } else {
        env.gain.setValueAtTime(target, t)
      }

      if (Number.isFinite(endAt)) {
        const msToEnd = endAt - this.serverNow()
        if (cue.fadeOutTime > 0) {
          const msToFade = msToEnd - cue.fadeOutTime * 1000
          voice.timers.push(
            window.setTimeout(() => this.rampTo(env, 0, Math.min(cue.fadeOutTime, msToEnd / 1000)), Math.max(0, msToFade)),
          )
        }
        voice.timers.push(window.setTimeout(() => this.releaseVoice(inst.instanceId), msToEnd))
      }
    }

    const delay = startAt - this.serverNow()
    if (delay > 0) voice.timers.push(window.setTimeout(begin, delay))
    else begin()
  }

  /**
   * Runs every 50 ms: wraps trimmed loops back to their start point, and recomputes ducking —
   * every voice is lowered by each *other* running cue's duckOthers percentage.
   */
  private tick() {
    const ctx = this.ctx
    if (!ctx || this.voices.size === 0) return
    const now = this.serverNow()

    const duckers = Object.values(this.active).filter(
      (d) =>
        d.cue.duckOthers > 0 &&
        d.stopAt == null &&
        cueTargets(d.cue, this.audienceId) &&
        now >= activeStartAt(d) &&
        now < activeEndAt(d),
    )

    for (const voice of this.voices.values()) {
      if (voice.held) continue
      const { cue } = voice.inst
      const { el } = voice.slot
      const slot = voice.slot

      if (voice.started && cue.loop && !el.loop) {
        const end = cue.mediaEndTime > 0 ? cue.mediaEndTime : el.duration
        if (Number.isFinite(end) && el.currentTime >= end - 0.03) el.currentTime = cue.mediaStartTime
      }

      const relevant = duckers.filter((d) => d.instanceId !== voice.inst.instanceId)
      const target = relevant.reduce((level, d) => level * (1 - d.cue.duckOthers / 100), 1)
      if (target !== slot.duckTarget) {
        const ducking = target < slot.duckTarget
        // Duck in over the ducking cue's fade-in, release over its fade-out (time constant ≈ fade/3).
        const fade = ducking
          ? Math.max(0, ...relevant.map((d) => d.cue.fadeInTime))
          : Math.max(0.3, ...Object.values(this.active).map((d) => (d.cue.duckOthers > 0 ? d.cue.fadeOutTime : 0)))
        slot.duck.gain.setTargetAtTime(target, ctx.currentTime, Math.max(0.03, fade / 3))
        slot.duckTarget = target
      }
    }
  }

  private rampTo(gain: GainNode, value: number, seconds: number) {
    const t = this.ctx!.currentTime
    gain.gain.cancelScheduledValues(t)
    gain.gain.setValueAtTime(gain.gain.value, t)
    gain.gain.linearRampToValueAtTime(value, t + Math.max(CUT_FADE, seconds))
  }

  private stopVoice(instanceId: string, fadeSeconds: number) {
    const voice = this.voices.get(instanceId)
    if (!voice || voice.stopping) return
    voice.stopping = true
    voice.timers.forEach(clearTimeout)
    voice.timers = []
    this.rampTo(voice.slot.env, 0, fadeSeconds)
    voice.timers.push(window.setTimeout(() => this.releaseVoice(instanceId), Math.max(CUT_FADE, fadeSeconds) * 1000 + 50))
  }

  private releaseVoice(instanceId: string) {
    const voice = this.voices.get(instanceId)
    if (!voice) return
    voice.timers.forEach(clearTimeout)
    this.voices.delete(instanceId)
    const { slot } = voice
    if (slot.owner === instanceId) {
      const t = this.ctx!.currentTime
      slot.el.pause()
      slot.el.loop = false
      slot.env.gain.cancelScheduledValues(t)
      slot.env.gain.setValueAtTime(0, t)
      slot.duck.gain.cancelScheduledValues(t)
      slot.duck.gain.setValueAtTime(1, t)
      slot.duckTarget = 1
      slot.owner = null
      slot.live.gain.setValueAtTime(1, t)
    }
  }
}

/** One engine per page: the pool of gesture-unlocked elements must outlive React re-renders. */
export const stageAudio = new StageAudioEngine()
