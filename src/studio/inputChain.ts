import { DEFAULT_INPUT, type TrackInput } from '../types/studio'
import { openMicrophone } from '../services/audioSession'
import { SAMPLE_RATE } from './audio'
import { TUNER_SOURCE, tunerParams } from './tuner'

/*
 * The live microphone channel strip:
 *
 *   mic → pre-gain → [noise removal: high-pass 80 Hz → low-pass 14 kHz → gate] → [vocal tuner]
 *       → meter, recorder (what's recorded is what you hear), and optional headphone monitoring
 *         → track volume → pan → speakers (+ reverb send)
 *
 * Raw PCM is captured by an AudioWorklet (no lossy codec). Browser voice processing (echo
 * cancellation, noise suppression, auto gain) is off: it would fold stereo to mono and pump the level.
 */

const WORKLETS = `
${TUNER_SOURCE}
class Capture extends AudioWorkletProcessor {
  constructor() { super(); this.on = false; this.port.onmessage = (e) => { this.on = e.data === 'start' } }
  process(inputs) {
    const input = inputs[0]
    if (this.on && input && input.length) this.port.postMessage(input.map((ch) => ch.slice(0)))
    return true
  }
}
registerProcessor('studio-capture', Capture)

class Gate extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [{ name: 'threshold', defaultValue: 0.003, minValue: 0, maxValue: 1 }] }
  constructor() { super(); this.env = 0; this.gain = 1 }
  process(inputs, outputs, params) {
    const input = inputs[0], output = outputs[0]
    if (!input || !input.length) return true
    const th = params.threshold[0]
    const att = Math.exp(-1 / (sampleRate * 0.002)), rel = Math.exp(-1 / (sampleRate * 0.08))
    for (let i = 0; i < input[0].length; i++) {
      let peak = 0
      for (const ch of input) peak = Math.max(peak, Math.abs(ch[i]))
      this.env = peak > this.env ? att * this.env + (1 - att) * peak : rel * this.env + (1 - rel) * peak
      // Below the threshold the level drops 24 dB (an expander: natural, never chopped).
      const target = this.env >= th ? 1 : 0.063
      this.gain += (target - this.gain) * (target > this.gain ? 0.02 : 0.0008)
      for (let c = 0; c < output.length; c++) output[c][i] = (input[c] || input[0])[i] * this.gain
    }
    return true
  }
}
registerProcessor('studio-gate', Gate)

class TunerNode extends AudioWorkletProcessor {
  constructor() { super(); this.tuners = []; this.params = {}; this.blocks = 0; this.port.onmessage = (e) => { this.params = e.data; for (const t of this.tuners) t.setParams(e.data) } }
  process(inputs, outputs) {
    const input = inputs[0], output = outputs[0]
    if (!input || !input.length) return true
    while (this.tuners.length < output.length) { const t = new Tuner(sampleRate); t.setParams(this.params); this.tuners.push(t) }
    for (let c = 0; c < output.length; c++) this.tuners[c].process(input[c] || input[0], output[c])
    // The detected pitch for the readout, ~20 times a second.
    if (++this.blocks % 18 === 0) this.port.postMessage(this.tuners[0].lastF0)
    return true
  }
}
registerProcessor('studio-tuner', TunerNode)
`

export interface InputDevice {
  id: string
  label: string
}

/** Microphones the browser can use. Labels appear once the page has had mic permission. */
export async function listInputs(): Promise<InputDevice[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return []
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices
    .filter((d) => d.kind === 'audioinput')
    .map((d, i) => ({ id: d.deviceId, label: d.label || (d.deviceId === 'default' ? '系統預設麥克風' : `麥克風 ${i + 1}`) }))
}

export interface MonitorMix {
  volume: number
  pan: number
  reverb: number
}

export interface CalibrationResult {
  noiseDb: number
  peakDb: number
  preGain: number
  gateDb: number
}

const db = (v: number) => (v > 1e-6 ? 20 * Math.log10(v) : -120)
const lin = (d: number) => 10 ** (d / 20)

export class InputChain {
  readonly ctx: AudioContext
  readonly channels: number
  readonly deviceLabel: string
  private stream: MediaStream
  private source: MediaStreamAudioSourceNode
  private raw: AnalyserNode
  private pre: GainNode
  private hp: BiquadFilterNode
  private lp: BiquadFilterNode
  private gate: AudioWorkletNode
  private tuner: AudioWorkletNode
  private post: GainNode
  private meter: AnalyserNode
  private capture: AudioWorkletNode
  private monitor: GainNode
  private monitorPan: StereoPannerNode
  private monitorReverb: GainNode
  private settings: TrackInput = DEFAULT_INPUT
  private chunks: Float32Array[][] = []
  private frames = 0
  private capturing = false
  /** Last detected pitch from the realtime tuner (Hz, 0 = none). */
  pitch = 0
  private constructor(ctx: AudioContext, stream: MediaStream, nodes: Record<string, AudioNode>, channels: number, label: string) {
    this.ctx = ctx
    this.stream = stream
    this.channels = channels
    this.deviceLabel = label
    this.source = nodes.source as MediaStreamAudioSourceNode
    this.raw = nodes.raw as AnalyserNode
    this.pre = nodes.pre as GainNode
    this.hp = nodes.hp as BiquadFilterNode
    this.lp = nodes.lp as BiquadFilterNode
    this.gate = nodes.gate as AudioWorkletNode
    this.tuner = nodes.tuner as AudioWorkletNode
    this.post = nodes.post as GainNode
    this.meter = nodes.meter as AnalyserNode
    this.capture = nodes.capture as AudioWorkletNode
    this.monitor = nodes.monitor as GainNode
    this.monitorPan = nodes.monitorPan as StereoPannerNode
    this.monitorReverb = nodes.monitorReverb as GainNode
    this.capture.port.onmessage = (e: MessageEvent<Float32Array[]>) => {
      if (!this.capturing) return
      this.chunks.push(e.data)
      this.frames += e.data[0]?.length ?? 0
    }
    this.tuner.port.onmessage = (e: MessageEvent<number>) => (this.pitch = e.data)
  }

  static async open({ deviceId, stereo = true }: { deviceId?: string; stereo?: boolean } = {}): Promise<InputChain> {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('此瀏覽器不支援麥克風（需要 HTTPS 或 localhost）')
    let stream: MediaStream
    try {
      stream = await openMicrophone(
        {
        audio: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          channelCount: { ideal: stereo ? 2 : 1 },
          sampleRate: { ideal: SAMPLE_RATE },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      },
        'crew',
      )
    } catch (err) {
      const name = (err as DOMException).name
      throw new Error(
        name === 'NotAllowedError' ? '麥克風權限被拒絕，請在瀏覽器網址列允許麥克風' : name === 'NotFoundError' || name === 'OverconstrainedError' ? '找不到這個麥克風' : `無法開啟麥克風：${(err as Error).message}`,
      )
    }
    const track = stream.getAudioTracks()[0]
    const deviceChannels = Math.max(1, Math.min(2, track.getSettings().channelCount ?? 1))
    const channels = stereo ? 2 : 1
    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' })
    const url = URL.createObjectURL(new Blob([WORKLETS], { type: 'text/javascript' }))
    await ctx.audioWorklet.addModule(url)
    URL.revokeObjectURL(url)
    const opts = { channelCount: channels, channelCountMode: 'explicit' as const, channelInterpretation: 'speakers' as const }
    const nodes = {
      source: new MediaStreamAudioSourceNode(ctx, { mediaStream: stream }),
      raw: new AnalyserNode(ctx, { fftSize: 2048 }),
      pre: new GainNode(ctx, opts),
      hp: new BiquadFilterNode(ctx, { type: 'highpass', frequency: 80, Q: 0.7, ...opts }),
      lp: new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 14000, Q: 0.7, ...opts }),
      gate: new AudioWorkletNode(ctx, 'studio-gate', { outputChannelCount: [channels], ...opts }),
      tuner: new AudioWorkletNode(ctx, 'studio-tuner', { outputChannelCount: [channels], ...opts }),
      post: new GainNode(ctx, opts),
      meter: new AnalyserNode(ctx, { fftSize: 2048 }),
      capture: new AudioWorkletNode(ctx, 'studio-capture', { numberOfOutputs: 0, ...opts }),
      monitor: new GainNode(ctx, { gain: 0 }),
      monitorPan: new StereoPannerNode(ctx),
      monitorReverb: new GainNode(ctx, { gain: 0 }),
    }
    // A mono mic "in stereo" is up-mixed to both sides by the explicit channel count.
    nodes.source.connect(nodes.raw)
    nodes.source.connect(nodes.pre)
    nodes.post.connect(nodes.meter)
    nodes.post.connect(nodes.capture)
    nodes.post.connect(nodes.monitor).connect(nodes.monitorPan).connect(ctx.destination)
    const ir = ctx.createBuffer(2, Math.round(ctx.sampleRate * 1.8), ctx.sampleRate)
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c)
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length) ** 3
    }
    nodes.monitor.connect(nodes.monitorReverb).connect(new ConvolverNode(ctx, { buffer: ir })).connect(nodes.monitorPan)
    await ctx.resume()
    const chain = new InputChain(ctx, stream, nodes, deviceChannels, track.label || '麥克風')
    chain.rewire()
    return chain
  }

  /** Route through the stages that are on (bypassed stages are disconnected, not just set to dry). */
  private rewire() {
    for (const n of [this.pre, this.hp, this.lp, this.gate, this.tuner]) n.disconnect()
    let at: AudioNode = this.pre
    if (this.settings.noiseRemoval) at = at.connect(this.hp).connect(this.lp).connect(this.gate)
    if (this.settings.tuner.enabled && this.settings.tuner.realtime) at = at.connect(this.tuner)
    at.connect(this.post)
  }

  /** Apply a track's input settings (pre-gain, noise removal, tuner). */
  apply(settings: TrackInput) {
    const prev = this.settings
    this.settings = settings
    const t = this.ctx.currentTime
    this.pre.gain.setTargetAtTime(lin(settings.preGain), t, 0.02)
    this.gate.parameters.get('threshold')!.setValueAtTime(lin(settings.gateDb), t)
    this.tuner.port.postMessage(tunerParams(settings.tuner))
    const routing = (s: TrackInput) => `${s.noiseRemoval}|${s.tuner.enabled && s.tuner.realtime}`
    if (routing(prev) !== routing(settings)) this.rewire()
  }

  /** Headphone monitoring through the track's volume, pan and reverb (0 volume = off). */
  setMonitoring(on: boolean, mix: MonitorMix) {
    const t = this.ctx.currentTime
    this.monitor.gain.setTargetAtTime(on ? mix.volume : 0, t, 0.02)
    this.monitorPan.pan.setTargetAtTime(mix.pan, t, 0.02)
    this.monitorReverb.gain.setTargetAtTime(mix.reverb, t, 0.02)
  }

  private readLevel(analyser: AnalyserNode) {
    const data = new Float32Array(analyser.fftSize)
    analyser.getFloatTimeDomainData(data)
    let peak = 0
    let sum = 0
    for (const v of data) {
      peak = Math.max(peak, Math.abs(v))
      sum += v * v
    }
    return { peak, rms: Math.sqrt(sum / data.length) }
  }

  /** What will be recorded right now (after pre-gain and processing). */
  level() {
    return this.readLevel(this.meter)
  }

  /**
   * Calibrate: listen to the room for 1.5 s (keep quiet), then to normal speech for 3 s.
   * Sets pre-gain so speech peaks land around −10 dBFS and the gate just above the room noise.
   */
  async calibrate(onPhase: (phase: 'quiet' | 'speak', progress: number) => void): Promise<CalibrationResult> {
    const sample = async (seconds: number, phase: 'quiet' | 'speak') => {
      let peak = 0
      let rmsSum = 0
      let n = 0
      const start = performance.now()
      while (performance.now() - start < seconds * 1000) {
        const l = this.readLevel(this.raw)
        peak = Math.max(peak, l.peak)
        rmsSum += l.rms
        n++
        onPhase(phase, (performance.now() - start) / (seconds * 1000))
        await new Promise((r) => setTimeout(r, 40))
      }
      return { peak, rms: rmsSum / Math.max(1, n) }
    }
    const quiet = await sample(1.5, 'quiet')
    const speech = await sample(3, 'speak')
    const peakDb = db(speech.peak)
    const preGain = Math.round(Math.min(24, Math.max(-12, -10 - peakDb)) * 2) / 2
    // Gate threshold in post-gain terms, a little above the noise floor.
    const gateDb = Math.round(Math.min(-20, Math.max(-80, db(quiet.rms) + preGain + 8)))
    return { noiseDb: Math.round(db(quiet.rms)), peakDb: Math.round(peakDb), preGain, gateDb }
  }

  startCapture() {
    this.chunks = []
    this.frames = 0
    this.capturing = true
    this.capture.port.postMessage('start')
  }
  /** Seconds captured so far. */
  elapsed() {
    return this.frames / this.ctx.sampleRate
  }
  get isCapturing() {
    return this.capturing
  }
  stopCapture(): AudioBuffer {
    this.capture.port.postMessage('stop')
    this.capturing = false
    const channels = this.chunks[0]?.length ?? 1
    const out = new AudioBuffer({ numberOfChannels: channels, length: Math.max(1, this.frames), sampleRate: this.ctx.sampleRate })
    for (let c = 0; c < channels; c++) {
      const dst = out.getChannelData(c)
      let at = 0
      for (const chunk of this.chunks) {
        const src = chunk[Math.min(c, chunk.length - 1)]
        dst.set(src.subarray(0, Math.max(0, Math.min(src.length, dst.length - at))), at)
        at += src.length
      }
    }
    this.chunks = []
    return out
  }

  close() {
    this.capturing = false
    this.source.disconnect()
    this.stream.getTracks().forEach((t) => t.stop())
    this.ctx.close().catch(() => {})
  }
}
