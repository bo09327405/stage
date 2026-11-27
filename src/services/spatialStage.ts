import { createAmbiRenderer, type AmbiRenderer } from '../studio/ambisonics'
import { SpatialRunner } from '../studio/spatial'
import { activeEndAt, activeStartAt, segmentLength, type ActiveCue } from '../types/cue'
import { headFieldMatrix, type AmbisonicsConfig } from '../types/spatialAudio'
import type { TrajectoryConfig } from '../types/trajectory'
import { fadeCurve } from '../utils/fadeCurve'
import type { FadeShape } from '../types/studio'

/*
 * Audience-side playback of 3D (binaural) sounds. The stage engine plays ordinary cues through <audio> elements;
 * a cue with a sound trajectory plays here instead, from decoded AudioBuffers, because the sound has to be moved
 * every few milliseconds and started on the audio clock to stay in step with the path.
 *
 *   part (AudioBufferSource) → [air low-pass → HRTF panner (SpatialRunner)] → envelope (volume, fades)
 *     → live level (console faders) → duck → master            (a part without a trajectory skips the bracket)
 *
 * No 3D drawing happens on a phone: the runner only evaluates the spline for the next few seconds and writes the
 * numbers into the panner. The position on the path comes from the cue's server-time position, so all phones
 * (and the studio) put the sound in the same place. Everything is torn down when the cue ends or stops.
 */

const CUT_FADE = 0.03
const lengthOf = (p: SpatialPart) => p.buffer?.duration ?? p.live?.duration ?? 0
/** Audio-clock lead so a start that is due now is not already late when the nodes are built. */
const LEAD = 0.03
/** Decoded files kept for the next GO (older ones are dropped; voices hold what they play). */
const CACHE_MAX = 4
/** …and never more than this many bytes of decoded audio (a few minutes of 4-channel sound is already a lot for a phone). */
const CACHE_BYTES = 160 * 1024 * 1024

/** A sound rendered while it plays (an Eclipsa file whose binaural render follows the listener's head) instead of decoded ahead into a buffer. */
export interface LiveSource {
  output: AudioNode
  /** Length, seconds. */
  duration: number
  /** Play from `pos` seconds so that this moment is `when` on the audio clock; loop inside `loop` when given. */
  play(when: number, pos: number, loop: { start: number; end: number } | null): void
  stop(): void
  /** The listener's head (column-major 3×3, local → scene), or null. */
  setHead(m: ArrayLike<number> | null): void
  /** Lead time the source needs between asking it to play and its first sound, seconds. */
  readonly lead: number
}

/** One sound of a spatial cue: a file, a studio's bed (no trajectory) or a studio track with its own path. */
export interface SpatialPart {
  /** The decoded sound (absent for a `live` part). */
  buffer?: AudioBuffer
  /** A sound rendered live; `head` says it follows the listener's head. */
  live?: LiveSource
  head?: boolean
  /** null = plain stereo (a studio's non-spatial tracks mixed together). */
  traj: TrajectoryConfig | null
  /** Seconds into the buffer where the path clock starts (a studio track's first region). */
  origin: number
  /** An Ambisonics soundfield (4 / 9 / 16 channels): decoded to binaural with Omnitone, rotated with the head. */
  ambi?: AmbisonicsConfig
  /** Names this part's renderer for pre-warming at STANDBY (the cue id, plus the part's index). */
  key?: string
  /** Called when the voice is released: frees a big decoded buffer that would otherwise stay cached. */
  release?: () => void
}

/** What the stage engine lends this module. */
export interface SpatialHost {
  ctx: () => AudioContext
  master: () => AudioNode
  serverNow: () => number
  /** 0–1 from the console's crossfade / executor faders. */
  liveLevel: (inst: ActiveCue) => number
  /** The sound a cue plays (decoded), for cues that are not already handed in. */
  load: (inst: ActiveCue) => Promise<SpatialPart[]>
}

interface SVoice {
  inst: ActiveCue
  parts: SpatialPart[]
  env: GainNode
  live: GainNode
  duck: GainNode
  runners: (SpatialRunner | null)[]
  /** The soundfield decoders of Ambisonics parts (null for the other parts). */
  renderers: (AmbiRenderer | null)[]
  inputs: GainNode[]
  sources: AudioBufferSourceNode[]
  timers: number[]
  stopping: boolean
  held: boolean
  duckTarget: number
}

/* ---------- decoding ---------- */

let decoder: OfflineAudioContext | null = null
const cache = new Map<string, Promise<AudioBuffer>>()
const sizes = new Map<string, number>()

/** Forget a decoded file (a finished Ambisonics cue gives its big multichannel buffer back at once). */
export function dropSpatialBuffer(url: string) {
  cache.delete(url)
  sizes.delete(url)
}

/**
 * Fetch and decode a sound ahead of its GO (STANDBY). Decoding goes through an offline context, so it works before
 * the page has been tapped (no autoplay lock) and the buffer can be played by any context later.
 */
export function loadSpatialBuffer(url: string): Promise<AudioBuffer> {
  const hit = cache.get(url)
  if (hit) {
    cache.delete(url) // most recently used last
    cache.set(url, hit)
    return hit
  }
  decoder ??= new OfflineAudioContext(2, 1, 48000)
  const job = fetch(url)
    .then((res) => {
      if (!res.ok) throw new Error(`聲音檔載入失敗 (${res.status})`)
      return res.arrayBuffer()
    })
    .then((data) => decoder!.decodeAudioData(data))
  job.then((b) => {
    if (cache.has(url)) sizes.set(url, b.length * b.numberOfChannels * 4)
  }, () => dropSpatialBuffer(url))
  cache.set(url, job)
  const total = () => [...sizes.values()].reduce((a, b) => a + b, 0)
  // Oldest first, but the one just asked for stays.
  while ((cache.size > CACHE_MAX || total() > CACHE_BYTES) && cache.size > 1) dropSpatialBuffer(cache.keys().next().value as string)
  return job
}

/* ---------- Ambisonics renderers, built ahead of GO ---------- */

/**
 * Omnitone has to decode its HRIRs before it can render. At STANDBY the renderer of the next cue is built and kept
 * here under the part's key; GO takes it (so the first sound comes out at once), and anything unclaimed is disposed
 * when another cue goes on standby.
 */
const prewarmed = new Map<string, Promise<AmbiRenderer>>()

/** How many pre-warmed renderers are waiting (diagnostics / tests). */
export const prewarmedCount = () => prewarmed.size

/** Bytes of decoded audio the file cache holds (diagnostics / tests). */
export const spatialCacheBytes = () => [...sizes.values()].reduce((a, b) => a + b, 0)

export function prewarmAmbi(ctx: BaseAudioContext, key: string, config: AmbisonicsConfig) {
  if (prewarmed.has(key)) return
  const job = createAmbiRenderer(ctx, config)
  job.catch(() => prewarmed.delete(key))
  prewarmed.set(key, job)
}

/** Dispose every pre-warmed renderer except those whose keys start with `keep`. */
export function dropPrewarmed(keep = '') {
  for (const [key, job] of [...prewarmed]) {
    if (keep && key.startsWith(keep)) continue
    prewarmed.delete(key)
    job.then((r) => r.dispose(), () => {})
  }
}

async function takeAmbi(ctx: BaseAudioContext, part: SpatialPart): Promise<AmbiRenderer> {
  const warm = part.key ? prewarmed.get(part.key) : undefined
  if (warm && part.key) {
    prewarmed.delete(part.key)
    return warm
  }
  return createAmbiRenderer(ctx, part.ambi!)
}

export class SpatialStage {
  private host: SpatialHost
  private voices = new Map<string, SVoice>()
  private pending = new Set<string>()
  /** The cue instances the engine currently wants here (a decode that finishes late checks it). */
  private wanted = new Map<string, ActiveCue>()
  private reverbBus: ConvolverNode | null = null
  private listenerDir: { x: number; y: number; z: number } | null = null
  private listenerApplied = ''
  /** The head's orientation (column-major 3×3, local → scene) while a view or the gyroscope reports it. */
  private head: ArrayLike<number> | null = null
  private headWasWanted = false
  /** Told when a playing sound starts or stops wanting the head's orientation (the page then offers the gyroscope). */
  onHeadWanted: (wanted: boolean) => void = () => {}

  constructor(host: SpatialHost) {
    this.host = host
  }

  /** True while this module handles the instance (playing, or waiting for its sound to decode). */
  owns(id: string) {
    return this.voices.has(id) || this.pending.has(id)
  }

  get size() {
    return this.voices.size
  }

  private get ctx() {
    return this.host.ctx()
  }

  /** The shared "room" reverb every spatial voice sends to (built when first needed). */
  private reverb() {
    if (!this.reverbBus) {
      const ctx = this.ctx
      const len = Math.round(ctx.sampleRate * 1.8)
      const ir = ctx.createBuffer(2, len, ctx.sampleRate)
      for (let c = 0; c < 2; c++) {
        const d = ir.getChannelData(c)
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3
      }
      this.reverbBus = new ConvolverNode(ctx, { buffer: ir })
      this.reverbBus.connect(this.host.master())
    }
    return this.reverbBus
  }

  /**
   * Reconcile with the running instances addressed to this device (the engine already dropped the ones that do not
   * reach it). Mirrors the element voices: late joiners start mid-cue, pause freezes, resume re-seeks from the shifted
   * timestamps, a stop fades out.
   */
  sync(insts: ActiveCue[], paused: boolean) {
    this.wanted = new Map(insts.map((i) => [i.instanceId, i]))
    for (const inst of insts) {
      const hold = paused || inst.pausedAt != null
      const voice = this.voices.get(inst.instanceId)
      if (!voice) {
        if (inst.stopAt == null && !hold && !this.pending.has(inst.instanceId)) this.start(inst, this.host.load(inst))
        continue
      }
      const wasHeld = voice.held
      const shifted = voice.inst.firedAt !== inst.firedAt
      voice.inst = inst
      if (hold) {
        if (!wasHeld) this.holdVoice(voice)
        continue
      }
      if (inst.stopAt != null && !voice.stopping) {
        voice.held = false
        this.stop(inst.instanceId, Math.max(0, (activeEndAt(inst) - this.host.serverNow()) / 1000))
      } else if (wasHeld || shifted) {
        voice.held = false
        if (voice.stopping) this.continueStop(voice)
        else this.schedule(voice)
      }
    }
    for (const id of [...this.voices.keys()]) if (!this.wanted.has(id)) this.stop(id, CUT_FADE)
  }

  /** Begin a cue whose sound is (being) decoded. */
  start(inst: ActiveCue, parts: Promise<SpatialPart[]> | SpatialPart[]) {
    const id = inst.instanceId
    if (this.host.serverNow() >= activeEndAt(inst)) return
    this.pending.add(id)
    this.wanted.set(id, this.wanted.get(id) ?? inst)
    Promise.resolve(parts)
      .then(async (list) => ({ list, decoders: await Promise.all(list.map((p) => (p.ambi ? takeAmbi(this.ctx, p) : null))) }))
      .then(
      ({ list, decoders }) => {
        this.pending.delete(id)
        const now = this.wanted.get(id)
        // Gone, retargeted or paused while it decoded: the next sync decides again.
        if (!now || this.voices.has(id) || now.stopAt != null || now.pausedAt != null) {
          decoders.forEach((d) => d?.dispose())
          return
        }
        const voice = this.build(now, list, decoders)
        this.voices.set(id, voice)
        this.applyLive()
        this.applyListener()
        this.applyHead()
        this.schedule(voice)
      },
      (err) => {
        this.pending.delete(id)
        console.warn('spatial cue failed to load', err)
      },
    )
  }

  private build(inst: ActiveCue, parts: SpatialPart[], decoders: (AmbiRenderer | null)[]): SVoice {
    const ctx = this.ctx
    const env = new GainNode(ctx, { gain: 0 })
    const live = new GainNode(ctx)
    const duck = new GainNode(ctx)
    env.connect(live).connect(duck).connect(this.host.master())
    // One input gain per part: a plain part goes straight to the envelope, a spatial one through its runner.
    const inputs = parts.map(() => new GainNode(ctx))
    const runners = parts.map((p, i) => {
      const field = decoders[i]
      if (field) {
        // A soundfield: decoded to binaural stereo by its renderer.
        inputs[i].connect(field.input)
        field.output.connect(env)
        return null
      }
      if (!p.traj) {
        inputs[i].connect(env)
        p.live?.output.connect(inputs[i])
        return null
      }
      const runner = new SpatialRunner(ctx, p.traj)
      runner.connect(inputs[i], env, this.reverb())
      return runner
    })
    return { inst, parts, env, live, duck, runners, renderers: decoders, inputs, sources: [], timers: [], stopping: false, held: false, duckTarget: 1 }
  }

  /**
   * (Re)compute playback from the instance's server timestamps: wait out pre-wait, start every part at the position
   * the cue should be at "now" on the audio clock, aim each path from there, apply the fade-in from that point and
   * schedule the fade-out and release. Used for a new cue and for resume / re-sync.
   */
  private schedule(voice: SVoice) {
    const ctx = this.ctx
    const { inst } = voice
    const { cue } = inst
    voice.timers.forEach(clearTimeout)
    voice.timers = []
    this.stopSources(voice)

    const startAt = activeStartAt(inst)
    const endAt = activeEndAt(inst)
    const now = this.host.serverNow()
    if (now >= endAt) return this.release(inst.instanceId)

    const segment = segmentLength(cue)
    const loop = cue.loop
    const wrap = loop && Number.isFinite(segment) && segment > 0
    const wait = Math.max(0, (startAt - now) / 1000)
    // A live part needs a moment to have its first audio ready; the whole cue then starts that much later (the position follows).
    const lead = Math.max(LEAD, ...voice.parts.map((p) => p.live?.lead ?? 0))
    const elapsed = Math.max(0, (now - startAt) / 1000) + (wait > 0 ? 0 : lead)
    const pos0 = cue.mediaStartTime + (wrap ? elapsed % segment : elapsed)
    const t = ctx.currentTime
    const when = t + (wait > 0 ? wait : lead)
    // Every part wraps at the same moment, and the path wraps with it (a studio's buffers carry a reverb tail past its length).
    const loopEnd = cue.mediaEndTime > 0 ? cue.mediaEndTime : cue.duration > 0 ? cue.duration : Math.max(...voice.parts.map(lengthOf))

    voice.parts.forEach((part, i) => {
      const length = lengthOf(part)
      if (!loop && pos0 >= length) return
      if (part.live) {
        part.live.play(when, Math.min(pos0, Math.max(0, length - 0.001)), loop ? { start: cue.mediaStartTime, end: Math.min(loopEnd, length) } : null)
      } else if (part.buffer) {
        const src = new AudioBufferSourceNode(ctx, { buffer: part.buffer, loop })
        if (loop) {
          src.loopStart = cue.mediaStartTime
          src.loopEnd = Math.min(loopEnd, length)
        }
        src.connect(voice.inputs[i])
        src.start(when, Math.min(pos0, Math.max(0, length - 0.001)))
        voice.sources.push(src)
      }
      voice.runners[i]?.start((ct) => {
        let pos = pos0 + (ct - when)
        if (wrap) pos = cue.mediaStartTime + ((pos - cue.mediaStartTime) % segment)
        return pos - part.origin
      })
    })

    // Volume envelope: fade-in measured from the cue's start, wherever in it this device joins.
    const target = cue.volume / 100
    const offset = wait > 0 ? 0 : elapsed
    const startCtx = wait > 0 ? when : t
    voice.env.gain.cancelScheduledValues(t)
    voice.env.gain.setValueAtTime(0, t)
    if (cue.fadeInTime > 0 && offset < cue.fadeInTime) {
      const done = offset / cue.fadeInTime
      const left = cue.fadeInTime - offset
      if (cue.fadeInShape && cue.fadeInShape !== 'linear' && left > CUT_FADE) {
        voice.env.gain.setValueCurveAtTime(fadeCurve(cue.fadeInShape, target, false, done), startCtx, left)
      } else {
        voice.env.gain.setValueAtTime(target * done, startCtx)
        voice.env.gain.linearRampToValueAtTime(target, startCtx + left)
      }
    } else {
      voice.env.gain.setValueAtTime(target, startCtx)
    }

    if (Number.isFinite(endAt)) {
      const msToEnd = endAt - now
      if (cue.fadeOutTime > 0) {
        voice.timers.push(
          window.setTimeout(() => this.rampTo(voice.env, 0, Math.min(cue.fadeOutTime, msToEnd / 1000), cue.fadeOutShape), Math.max(0, msToEnd - cue.fadeOutTime * 1000)),
        )
      }
      voice.timers.push(window.setTimeout(() => this.release(inst.instanceId), msToEnd))
    }
  }

  /** Keep the paths scheduled ahead and apply ducking; called from the engine's 50 ms ticker. */
  tick(duck: (inst: ActiveCue, current: number) => { target: number; fade: number }) {
    const ctx = this.ctx
    for (const voice of this.voices.values()) {
      if (voice.held) continue
      for (const r of voice.runners) r?.top()
      const { target, fade } = duck(voice.inst, voice.duckTarget)
      if (target !== voice.duckTarget) {
        voice.duck.gain.setTargetAtTime(target, ctx.currentTime, Math.max(0.03, fade / 3))
        voice.duckTarget = target
      }
    }
  }

  /** Console faders (manual crossfade, executors). */
  applyLive() {
    const t = this.ctx.currentTime
    for (const v of this.voices.values()) v.live.gain.setTargetAtTime(Math.max(0, Math.min(1, this.host.liveLevel(v.inst))), t, 0.02)
  }

  private holdVoice(voice: SVoice) {
    const t = this.ctx.currentTime
    voice.held = true
    voice.timers.forEach(clearTimeout)
    voice.timers = []
    this.stopSources(voice)
    for (const r of voice.runners) r?.hold()
    for (const gain of [voice.env, voice.duck]) {
      const level = gain.gain.value
      gain.gain.cancelScheduledValues(t)
      gain.gain.setValueAtTime(level, t)
    }
  }

  /** The show was paused while this voice was fading out: carry on from the shifted timestamps. */
  private continueStop(voice: SVoice) {
    const remaining = Math.max(0, (activeEndAt(voice.inst) - this.host.serverNow()) / 1000)
    this.schedule(voice)
    this.rampTo(voice.env, 0, remaining)
    const id = voice.inst.instanceId
    voice.timers.push(window.setTimeout(() => this.release(id), Math.max(CUT_FADE, remaining) * 1000 + 50))
  }

  stop(id: string, fadeSeconds: number) {
    const voice = this.voices.get(id)
    if (!voice || voice.stopping) return
    voice.stopping = true
    voice.timers.forEach(clearTimeout)
    voice.timers = []
    this.rampTo(voice.env, 0, fadeSeconds, voice.inst.cue.fadeOutShape)
    voice.timers.push(window.setTimeout(() => this.release(id), Math.max(CUT_FADE, fadeSeconds) * 1000 + 50))
  }

  /** Stop everything at once (a STOP for the whole show, or leaving the page). */
  stopAll(fadeSeconds = CUT_FADE) {
    this.wanted.clear()
    for (const id of [...this.voices.keys()]) this.stop(id, fadeSeconds)
  }

  /**
   * The audio context was suspended (locked screen, a call, the autoplay lock) and is running again: sources
   * scheduled on the stalled clock are behind the show, so start every voice again from the server position.
   */
  resync() {
    for (const voice of this.voices.values()) if (!voice.held && !voice.stopping) this.schedule(voice)
  }

  private stopSources(voice: SVoice) {
    for (const p of voice.parts) p.live?.stop()
    for (const s of voice.sources) {
      try {
        s.stop()
      } catch {
        // never started
      }
      s.disconnect()
    }
    voice.sources = []
  }

  /** Free every node of a finished or stopped cue (decoded files stay cached for the next GO). */
  private release(id: string) {
    const voice = this.voices.get(id)
    if (!voice) return
    voice.timers.forEach(clearTimeout)
    this.voices.delete(id)
    this.stopSources(voice)
    for (const r of voice.runners) r?.dispose()
    for (const r of voice.renderers) r?.dispose()
    for (const n of [...voice.inputs, voice.env, voice.live, voice.duck]) n.disconnect()
    for (const p of voice.parts) p.release?.()
    this.applyListener()
    this.applyHead()
    if (this.voices.size === 0 && this.reverbBus) {
      this.reverbBus.disconnect()
      this.reverbBus = null
    }
  }

  private rampTo(gain: GainNode, value: number, seconds: number, shape?: FadeShape) {
    const t = this.ctx.currentTime
    const from = gain.gain.value
    gain.gain.cancelScheduledValues(t)
    gain.gain.setValueAtTime(from, t)
    if (value === 0 && shape && shape !== 'linear' && seconds > CUT_FADE && from > 0) {
      gain.gain.setValueCurveAtTime(fadeCurve(shape, from, true), t, seconds)
      return
    }
    gain.gain.linearRampToValueAtTime(value, t + Math.max(CUT_FADE, seconds))
  }

  /* ---------- head tracking ---------- */

  /**
   * The audience's head orientation (a column-major 3×3, local → scene) from the XR view or the gyroscope; null when no
   * view is running. It turns the sound field only while a playing sound asks for it (`headTrack` / `bindHeadTracking`).
   */
  setListenerOrientation(m: ArrayLike<number> | null) {
    this.head = m
    this.listenerDir = m ? { x: -m[6], y: -m[7], z: -m[8] } : null
    this.applyListener()
    this.applyHead()
  }

  /** Whether any playing sound wants the head's orientation. */
  headWanted() {
    return [...this.voices.values()].some((v) => v.parts.some((p) => p.traj?.headTrack || p.ambi?.bindHeadTracking || (p.live && p.head)))
  }

  /** Turn each soundfield: its own offset, plus the opposite of the head's turn when it is bound to the head. */
  private applyHead() {
    for (const v of this.voices.values()) {
      v.parts.forEach((p, i) => {
        const r = v.renderers[i]
        if (r && p.ambi) r.setMatrix(headFieldMatrix(p.ambi.bindHeadTracking ? this.head : null, p.ambi.rotationOffset))
        if (p.live && p.head) p.live.setHead(this.head)
      })
    }
    const wanted = this.headWanted()
    if (wanted !== this.headWasWanted) {
      this.headWasWanted = wanted
      this.onHeadWanted(wanted)
    }
  }

  private applyListener() {
    const ctx = this.ctx
    const want = [...this.voices.values()].some((v) => v.parts.some((p) => p.traj?.headTrack))
    const d = want && this.listenerDir ? this.listenerDir : { x: 0, y: 0, z: -1 }
    const key = `${d.x.toFixed(3)},${d.y.toFixed(3)},${d.z.toFixed(3)}`
    if (key === this.listenerApplied) return
    this.listenerApplied = key
    const l = ctx.listener
    // Looking (almost) straight up or down: pick another "up" so the basis stays valid.
    const flat = Math.abs(d.y) > 0.98
    const t = ctx.currentTime
    const set = (p: AudioParam | undefined, v: number) => p?.setTargetAtTime(v, t, 0.04)
    set(l.forwardX, d.x)
    set(l.forwardY, d.y)
    set(l.forwardZ, d.z)
    set(l.upX, 0)
    set(l.upY, flat ? 0 : 1)
    set(l.upZ, flat ? -Math.sign(d.y) : 0)
  }
}
