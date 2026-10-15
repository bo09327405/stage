import { dimGain } from '../utils/dim'
import { projectLength, type StudioProject } from '../types/studio'
import { SAMPLE_RATE } from './audio'
import { applyTrack, buildMix, loadRegionBuffers, type MixGraph } from './mixer'

/**
 * Live multitrack preview in the studio. Playing builds the mix graph from the current position;
 * edits to regions while playing rebuild it seamlessly from where the playhead is, and track
 * settings (volume, pan, EQ, sends, mute / solo) are applied to the running graph without a gap.
 */
export class StudioPlayer {
  private ctx: AudioContext | null = null
  private graph: MixGraph | null = null
  private project: StudioProject | null = null
  /** Timeline position at `anchorTime` (context clock) while playing; the paused position otherwise. */
  private anchorPos = 0
  private anchorTime = 0
  private playingFlag = false
  private token = 0
  private endTimer: ReturnType<typeof setTimeout> | undefined
  onEnded: (() => void) | null = null
  /** Called while buffers load (true) and when playback actually starts (false). */
  onLoading: ((loading: boolean) => void) | null = null

  get context() {
    return (this.ctx ??= new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' }))
  }
  get playing() {
    return this.playingFlag
  }

  /** Current timeline position, seconds. */
  position() {
    if (!this.playingFlag || !this.ctx) return this.anchorPos
    return this.anchorPos + (this.ctx.currentTime - this.anchorTime)
  }

  async play(project: StudioProject, from = this.position()) {
    const token = ++this.token
    this.project = project
    const ctx = this.context
    await ctx.resume()
    this.onLoading?.(true)
    let buffers: Map<string, AudioBuffer>
    try {
      buffers = await loadRegionBuffers(project)
    } finally {
      if (token === this.token) this.onLoading?.(false)
    }
    if (token !== this.token) return // stopped / restarted while loading
    this.teardown()
    const when = ctx.currentTime + 0.05
    this.graph = buildMix(ctx, project, buffers, { from, when })
    // Master → monitor (this listener's MUTE / DIM) → speakers; the meters read the master.
    this.graph.master.disconnect()
    this.graph.master.connect(this.monitorNode(ctx))
    this.graph.master.connect(this.meterTap(ctx))
    this.anchorPos = from - 0.05
    this.anchorTime = ctx.currentTime
    this.playingFlag = true
    this.scheduleEnd(project)
  }

  pause() {
    this.anchorPos = this.position()
    this.token++
    this.playingFlag = false
    this.teardown()
  }

  stop(to = 0) {
    this.pause()
    this.anchorPos = to
  }

  seek(to: number) {
    if (this.playingFlag && this.project) this.play(this.project, Math.max(0, to))
    else this.anchorPos = Math.max(0, to)
  }

  /**
   * The project changed. Track-only changes update the running graph; anything touching regions
   * (moved, trimmed, automation, processing) restarts playback from the current position.
   */
  update(project: StudioProject, regionsChanged: boolean) {
    const prev = this.project
    this.project = project
    if (!this.playingFlag || !this.graph || !this.ctx) return
    const trackSetChanged = !prev || Object.keys(prev.tracks).join() !== Object.keys(project.tracks).join()
    // The compressor is a node that exists or not, and automation curves are scheduled up front:
    // both need the graph rebuilt.
    const structureChanged = Object.values(project.tracks).some(
      (t) => prev?.tracks[t.id]?.fx.compressor !== t.fx.compressor || JSON.stringify(prev?.tracks[t.id]?.automation) !== JSON.stringify(t.automation),
    )
    if (regionsChanged || trackSetChanged || structureChanged) return void this.play(project, this.position())
    const anySolo = Object.values(project.tracks).some((t) => t.solo)
    for (const t of Object.values(project.tracks)) {
      const nodes = this.graph.tracks.get(t.id)
      if (nodes) applyTrack(this.ctx, nodes, t, anySolo, true)
    }
    this.graph.master.gain.setTargetAtTime(project.masterVolume, this.ctx.currentTime, 0.02)
    this.scheduleEnd(project)
  }

  /* ---------- monitoring: MUTE / DIM, master meters ---------- */

  /**
   * MUTE / DIM affect only what this listener hears — not the project, the mixdown or anyone
   * else's playback. DIM is 10^(dB/20) of the chosen amount (default −20 dB, see utils/dim.ts);
   * it never changes the master fader, so switching it off returns to exactly the same level.
   */
  private monitor: GainNode | null = null
  private monitorState: { mute: boolean; dim: boolean; dimDb?: number } = { mute: false, dim: false }
  private monitorNode(ctx: AudioContext) {
    if (!this.monitor) {
      this.monitor = new GainNode(ctx, { gain: this.monitorGain() })
      this.monitor.connect(ctx.destination)
    }
    return this.monitor
  }
  /** Where other studio sounds (previews) go, so MUTE / DIM apply to them too. */
  output() {
    return this.monitorNode(this.context)
  }
  /** Listening volume, 0–1 (the lobby player's volume control); 1 in the studio. */
  private listenVolume = 1
  private monitorGain = () => (this.monitorState.mute ? 0 : dimGain(this.monitorState.dim, this.monitorState.dimDb) * this.listenVolume)
  /** Current monitor gain (1, 10^(dB/20) for DIM, 0 for MUTE). */
  get monitorLevel() {
    return this.monitorGain()
  }
  setMonitor(state: { mute: boolean; dim: boolean; dimDb?: number }) {
    this.monitorState = state
    if (this.monitor && this.ctx) this.monitor.gain.setTargetAtTime(this.monitorGain(), this.ctx.currentTime, 0.015)
  }

  setVolume(volume: number) {
    this.listenVolume = Math.max(0, Math.min(1, volume))
    if (this.monitor && this.ctx) this.monitor.gain.setTargetAtTime(this.monitorGain(), this.ctx.currentTime, 0.015)
  }

  /** Left / right analysers on the master output (after the master fader, before MUTE / DIM). */
  private meters: { split: ChannelSplitterNode; l: AnalyserNode; r: AnalyserNode } | null = null
  private meterTap(ctx: AudioContext) {
    if (!this.meters) {
      const split = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 })
      const l = new AnalyserNode(ctx, { fftSize: 1024 })
      const r = new AnalyserNode(ctx, { fftSize: 1024 })
      split.connect(l, 0)
      split.connect(r, 1)
      this.meters = { split, l, r }
    }
    return this.meters.split
  }
  private peakOf(a: AnalyserNode, buf: Float32Array<ArrayBuffer>) {
    a.getFloatTimeDomainData(buf)
    let peak = 0
    for (const v of buf) peak = Math.max(peak, Math.abs(v))
    return peak
  }
  private meterBuf = new Float32Array(1024)
  /** Peak level of the master output per channel, 0–1+ (above 1 = clipping). */
  levels(): { l: number; r: number } {
    if (!this.graph || !this.meters) return { l: 0, r: 0 }
    return { l: this.peakOf(this.meters.l, this.meterBuf), r: this.peakOf(this.meters.r, this.meterBuf) }
  }
  /** Louder of the two channels (the transport's single meter). */
  level() {
    const { l, r } = this.levels()
    return Math.max(l, r)
  }

  private scheduleEnd(project: StudioProject) {
    clearTimeout(this.endTimer)
    const remaining = projectLength(project) + 0.3 - this.position()
    this.endTimer = setTimeout(() => {
      if (!this.playingFlag) return
      this.stop(projectLength(project))
      this.onEnded?.()
    }, Math.max(0, remaining) * 1000)
  }

  private teardown() {
    clearTimeout(this.endTimer)
    if (!this.graph) return
    for (const s of this.graph.sources) {
      try {
        s.stop()
      } catch {
        // never started
      }
    }
    // Disconnecting the master silences reverb / delay tails at once.
    this.graph.master.disconnect()
    this.graph = null
  }

  dispose() {
    this.pause()
    this.ctx?.close().catch(() => {})
    this.ctx = null
    this.monitor = null
    this.meters = null
  }
}
