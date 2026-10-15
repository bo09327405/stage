import { TRACK_PARAMS, filterHz, laneValueAt, projectLength, regionGainAt, sortedTracks, type StudioProject, type StudioRegion, type StudioTrack } from '../types/studio'
import { SAMPLE_RATE, bufferOffset, regionBuffer } from './audio'

/*
 * The studio's mix graph, built the same way for live preview (AudioContext) and for rendering
 * (OfflineAudioContext), so what you hear in the studio is exactly what export and cues play.
 *
 *   region source → region gain (gain × automation × fades)
 *     → track: high-pass → 3-band EQ → [compressor] → low-pass (Filter automation)
 *              → volume (fader, mute/solo) → automation gain (Volume automation) → pan → master
 *                                         ↘ reverb send ↗   ↘ delay send (with feedback) ↗
 */

export interface TrackNodes {
  highpass: BiquadFilterNode
  low: BiquadFilterNode
  mid: BiquadFilterNode
  high: BiquadFilterNode
  lowpass: BiquadFilterNode
  volume: GainNode
  autoGain: GainNode
  pan: StereoPannerNode
  reverbSend: GainNode
  delaySend: GainNode
  delay: DelayNode
  feedback: GainNode
}

export interface MixGraph {
  master: GainNode
  tracks: Map<string, TrackNodes>
  sources: AudioBufferSourceNode[]
}

/** Seconds of tail to render after the last region when reverb / delay are in use. */
export const TAIL = 2

/** Load (and process) every region's buffer the mix needs. */
export async function loadRegionBuffers(project: StudioProject, regionIds?: string[]) {
  const regions = Object.values(project.regions).filter((r) => !regionIds || regionIds.includes(r.id))
  const entries = await Promise.all(regions.map(async (r) => [r.id, await regionBuffer(r)] as const))
  return new Map<string, AudioBuffer>(entries)
}

const impulses = new WeakMap<BaseAudioContext, AudioBuffer>()
/** A plate-like decaying-noise impulse response, made once per context. */
function reverbImpulse(ctx: BaseAudioContext) {
  let ir = impulses.get(ctx)
  if (!ir) {
    const seconds = 2.2
    ir = ctx.createBuffer(2, Math.round(ctx.sampleRate * seconds), ctx.sampleRate)
    for (let c = 0; c < 2; c++) {
      const data = ir.getChannelData(c)
      for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length) ** 3
    }
    impulses.set(ctx, ir)
  }
  return ir
}

/** Whether a track is heard, given mute and solo across the project. */
export const trackAudible = (track: StudioTrack, anySolo: boolean) => !track.mute && (!anySolo || track.solo)

/** Push a track's settings onto its nodes (immediately, or smoothed while playing). */
export function applyTrack(ctx: BaseAudioContext, nodes: TrackNodes, track: StudioTrack, anySolo: boolean, smooth = false) {
  const t = ctx.currentTime
  const setP = (p: AudioParam, v: number) => (smooth ? p.setTargetAtTime(v, t, 0.02) : p.setValueAtTime(v, t))
  setP(nodes.highpass.frequency, track.fx.highpass > 0 ? track.fx.highpass : 10)
  setP(nodes.low.gain, track.eq.low)
  setP(nodes.mid.gain, track.eq.mid)
  setP(nodes.mid.frequency, track.eq.midFreq)
  setP(nodes.high.gain, track.eq.high)
  setP(nodes.volume.gain, trackAudible(track, anySolo) ? track.volume : 0)
  // Automated parameters are driven by their curves (scheduled in buildMix), not the knobs.
  if (!track.automation.pan?.points.length) setP(nodes.pan.pan, track.pan)
  setP(nodes.reverbSend.gain, track.fx.reverb)
  setP(nodes.delaySend.gain, track.fx.delay)
  setP(nodes.delay.delayTime, track.fx.delayTime)
  setP(nodes.feedback.gain, track.fx.feedback)
}

/**
 * Build the graph and schedule every region that overlaps [from, …).
 * `when` is the context time that corresponds to timeline position `from`.
 */
export function buildMix(
  ctx: BaseAudioContext,
  project: StudioProject,
  buffers: Map<string, AudioBuffer>,
  { from = 0, when = ctx.currentTime, trackIds }: { from?: number; when?: number; trackIds?: string[] } = {},
): MixGraph {
  const end = projectLength(project) + TAIL
  const master = new GainNode(ctx, { gain: project.masterVolume })
  master.connect(ctx.destination)
  const tracks = new Map<string, TrackNodes>()
  const ordered = sortedTracks(project).filter((t) => !trackIds || trackIds.includes(t.id))
  const anySolo = ordered.some((t) => t.solo)
  const ir = reverbImpulse(ctx)

  for (const track of ordered) {
    const highpass = new BiquadFilterNode(ctx, { type: 'highpass', Q: 0.7 })
    const low = new BiquadFilterNode(ctx, { type: 'lowshelf', frequency: 200 })
    const mid = new BiquadFilterNode(ctx, { type: 'peaking', Q: 1 })
    const high = new BiquadFilterNode(ctx, { type: 'highshelf', frequency: 4500 })
    const lowpass = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 20000, Q: 0.7 })
    const volume = new GainNode(ctx)
    const autoGain = new GainNode(ctx)
    const pan = new StereoPannerNode(ctx)
    highpass.connect(low).connect(mid).connect(high)
    let chainEnd: AudioNode = high
    if (track.fx.compressor) {
      const comp = new DynamicsCompressorNode(ctx, { threshold: -20, knee: 12, ratio: 4, attack: 0.004, release: 0.2 })
      const makeup = new GainNode(ctx, { gain: 1.3 })
      chainEnd = chainEnd.connect(comp).connect(makeup)
    }
    chainEnd.connect(lowpass).connect(volume).connect(autoGain).connect(pan).connect(master)
    // Sends are post-fader (and post-automation), so muting or riding a track also affects its echoes.
    const reverbSend = new GainNode(ctx)
    const convolver = new ConvolverNode(ctx, { buffer: ir })
    autoGain.connect(reverbSend).connect(convolver).connect(pan)
    const delaySend = new GainNode(ctx)
    const delay = new DelayNode(ctx, { maxDelayTime: 2 })
    const feedback = new GainNode(ctx)
    autoGain.connect(delaySend).connect(delay).connect(pan)
    delay.connect(feedback).connect(delay)

    const nodes = { highpass, low, mid, high, lowpass, volume, autoGain, pan, reverbSend, delaySend, delay, feedback }
    applyTrack(ctx, nodes, track, anySolo)
    scheduleTrackAutomation(track, nodes, from, when, end)
    tracks.set(track.id, nodes)
  }

  const sources: AudioBufferSourceNode[] = []
  for (const r of Object.values(project.regions)) {
    const nodes = tracks.get(r.trackId)
    const buffer = buffers.get(r.id)
    if (!nodes || !buffer || r.muted) continue
    const end = r.start + r.duration
    if (end <= from) continue
    sources.push(scheduleRegion(ctx, r, buffer, nodes.highpass, from, when))
  }
  return { master, tracks, sources }
}

/** Drive a track's automated parameters along their curves from `from` (timeline) at `when` (context). */
function scheduleTrackAutomation(track: StudioTrack, nodes: TrackNodes, from: number, when: number, end: number) {
  const length = end - from
  if (length <= 0) return
  for (const param of TRACK_PARAMS) {
    const points = track.automation[param]?.points ?? []
    if (points.length === 0) continue
    const target = param === 'volume' ? nodes.autoGain.gain : param === 'pan' ? nodes.pan.pan : nodes.lowpass.frequency
    const map = param === 'filter' ? filterHz : (v: number) => v
    const steps = Math.max(2, Math.min(20000, Math.ceil(length * 50)))
    const curve = new Float32Array(steps)
    for (let i = 0; i < steps; i++) curve[i] = map(laneValueAt(points, from + (length * i) / (steps - 1), param))
    target.cancelScheduledValues(when)
    target.setValueAtTime(curve[0], when)
    target.setValueCurveAtTime(curve, when, length)
  }
}

/** Play one region into a track input, starting `from` timeline seconds at context time `when`. */
function scheduleRegion(ctx: BaseAudioContext, r: StudioRegion, buffer: AudioBuffer, input: AudioNode, from: number, when: number) {
  const skip = Math.max(0, from - r.start) // already past part of the region
  const startTime = when + Math.max(0, r.start - from)
  const length = r.duration - skip
  const src = new AudioBufferSourceNode(ctx, { buffer })
  const gain = new GainNode(ctx, { gain: regionGainAt(r, skip) })
  // The envelope (automation × fades × gain) as a curve, ~100 points per second.
  const points = Math.max(2, Math.min(20000, Math.ceil(length * 100)))
  const curve = new Float32Array(points)
  for (let i = 0; i < points; i++) curve[i] = regionGainAt(r, skip + (length * i) / (points - 1))
  gain.gain.setValueCurveAtTime(curve, startTime, Math.max(0.01, length))
  src.connect(gain).connect(input)
  src.start(startTime, bufferOffset(r, buffer) + skip, Math.max(0.001, length))
  return src
}

const usesTail = (p: StudioProject, trackIds?: string[]) =>
  Object.values(p.tracks).some((t) => (!trackIds || trackIds.includes(t.id)) && (t.fx.reverb > 0 || t.fx.delay > 0))

/**
 * Render the project (or some tracks) to a stereo buffer — export, cue playback and "render to
 * clip" all go through here.
 */
export async function renderMix(project: StudioProject, { trackIds, sampleRate = SAMPLE_RATE }: { trackIds?: string[]; sampleRate?: number } = {}) {
  const regions = Object.values(project.regions).filter((r) => !trackIds || trackIds.includes(r.trackId))
  const end = regions.reduce((e, r) => Math.max(e, r.start + r.duration), 0) || projectLength(project)
  const seconds = Math.max(0.1, end + (usesTail(project, trackIds) ? TAIL : 0))
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * sampleRate), sampleRate)
  const buffers = await loadRegionBuffers(project, regions.map((r) => r.id))
  buildMix(ctx, project, buffers, { from: 0, when: 0, trackIds })
  return ctx.startRendering()
}
