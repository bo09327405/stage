/**
 * Intercom call tone, synthesised with Web Audio (no sound file to load or fail).
 * A two-pulse buzzer in the style of a wired party-line call light.
 */

let ctx: AudioContext | null = null

/** The shared context; call from a user gesture once so later calls are allowed to sound. */
export function intercomAudio(): AudioContext {
  ctx ??= new AudioContext()
  if (ctx.state === 'suspended') ctx.resume().catch(() => {})
  return ctx
}

/** Unlock audio on the first user interaction anywhere on the page. */
export function unlockOnFirstGesture() {
  const unlock = () => {
    intercomAudio()
    window.removeEventListener('pointerdown', unlock, true)
    window.removeEventListener('keydown', unlock, true)
  }
  window.addEventListener('pointerdown', unlock, true)
  window.addEventListener('keydown', unlock, true)
}

export function playCallBuzzer() {
  const audio = intercomAudio()
  const t0 = audio.currentTime + 0.02
  const out = audio.createGain()
  out.gain.value = 0.22
  out.connect(audio.destination)

  // Two buzzes, each a slightly detuned square pair for that classic rasp.
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
