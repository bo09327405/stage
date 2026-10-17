/**
 * Intercom call tone, synthesised (no sound file to load or fail): a two-pulse buzzer in the style of a
 * wired party-line call light.
 *
 * It is played through an HTML <audio> element rather than only Web Audio: on iPhone the ring / silent
 * switch mutes Web Audio but not media playback, and an element that was started once inside a tap may be
 * started again later, when a call arrives. Web Audio stays as the fallback if the element is refused.
 */

let ctx: AudioContext | null = null

/** The shared context; call from a user gesture once so later calls are allowed to sound. */
export function intercomAudio(): AudioContext {
  ctx ??= new AudioContext()
  if (ctx.state === 'suspended') ctx.resume().catch(() => {})
  return ctx
}

/** The buzzer as a 16-bit mono WAV (two squarish pulses, slightly detuned pair of tones for the rasp). */
export function buildBuzzerWav(): Uint8Array<ArrayBuffer> {
  const rate = 22050
  const pulses = [
    [0, 0.32],
    [0.42, 0.5],
  ] as const
  const total = Math.ceil((0.42 + 0.5 + 0.05) * rate)
  const samples = new Int16Array(total)
  for (const [start, length] of pulses) {
    const from = Math.floor(start * rate)
    const to = Math.min(total, Math.floor((start + length) * rate))
    for (let i = from; i < to; i++) {
      const t = (i - from) / rate
      const env = Math.min(1, t / 0.01, (length - t) / 0.03)
      const square = (hz: number) => (Math.sin(2 * Math.PI * hz * (i / rate)) >= 0 ? 1 : -1)
      samples[i] = Math.round(((square(440) + square(446)) / 2) * Math.max(0, env) * 0.5 * 32767)
    }
  }
  const bytes = new Uint8Array(44 + samples.length * 2)
  const v = new DataView(bytes.buffer)
  const ascii = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)))
  ascii(0, 'RIFF')
  v.setUint32(4, 36 + samples.length * 2, true)
  ascii(8, 'WAVEfmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, rate, true)
  v.setUint32(28, rate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  ascii(36, 'data')
  v.setUint32(40, samples.length * 2, true)
  samples.forEach((s, i) => v.setInt16(44 + i * 2, s, true))
  return bytes
}

let element: HTMLAudioElement | null = null
let buzzerUrl: string | null = null
let silentUrl: string | null = null
let primed = false

function ensureElement() {
  if (!element) {
    element = new Audio()
    element.preload = 'auto'
    buzzerUrl = URL.createObjectURL(new Blob([buildBuzzerWav()], { type: 'audio/wav' }))
    // A tiny silent clip to start inside the tap.
    const silent = new Uint8Array(buildBuzzerWav())
    silent.fill(0, 44)
    silentUrl = URL.createObjectURL(new Blob([silent], { type: 'audio/wav' }))
  }
  return element
}

/** Call inside a tap / key press: unlocks both the audio context and the ring element for later calls. */
export function primeRingtone() {
  intercomAudio()
  // iOS 17+: treat call tones as media playback, so they sound with the ring / silent switch off.
  try {
    const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession
    if (session) session.type = 'playback'
  } catch {
    // Not supported; the <audio> element path still works.
  }
  // Once unlocked, don't touch the element again (a later tap must not cut a ringing call).
  if (primed) return
  const el = ensureElement()
  el.src = silentUrl!
  el.play().then(
    () => {
      el.pause()
      primed = true
    },
    () => {},
  )
}

/**
 * Unlock the call tone on the first real tap anywhere on the page. iOS only counts click / touchend (not
 * pointerdown) as a gesture, so those are used, and listening continues until the tone is really unlocked.
 */
let armed = false
export function unlockOnFirstGesture() {
  if (armed) return
  armed = true
  const events = ['touchend', 'click', 'keydown'] as const
  const unlock = () => {
    if (primed) return done()
    primeRingtone()
  }
  const done = () => events.forEach((e) => window.removeEventListener(e, unlock, true))
  events.forEach((e) => window.addEventListener(e, unlock, { capture: true, passive: true }))
}

function playWithWebAudio() {
  const audio = intercomAudio()
  const t0 = audio.currentTime + 0.02
  const out = audio.createGain()
  out.gain.value = 0.22
  out.connect(audio.destination)
  for (const [start, length] of [
    [0, 0.32],
    [0.42, 0.5],
  ]) {
    const env = audio.createGain()
    env.gain.setValueAtTime(0, t0 + start)
    env.gain.linearRampToValueAtTime(1, t0 + start + 0.01)
    env.gain.setValueAtTime(1, t0 + start + length - 0.04)
    env.gain.linearRampToValueAtTime(0, t0 + start + length)
    env.connect(out)
    for (const freq of [440, 446]) {
      const osc = audio.createOscillator()
      osc.type = 'square'
      osc.frequency.value = freq
      osc.connect(env)
      osc.start(t0 + start)
      osc.stop(t0 + start + length + 0.02)
    }
  }
  setTimeout(() => out.disconnect(), 1200)
}

export function playCallBuzzer() {
  const el = ensureElement()
  el.src = buzzerUrl!
  el.currentTime = 0
  el.volume = 1
  el.play().catch(() => playWithWebAudio())
}
