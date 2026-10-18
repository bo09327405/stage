import type { Cue } from '../types/cue'

/*
 * Vibration cues, for both platforms.
 *  · Android (and anything with navigator.vibrate): the real motor, with the pattern [pulse, pause, pulse …].
 *  · iPhone / iPad Safari and home-screen apps have no vibration API at all. In the foreground they fall back to
 *    short low-frequency "thumps" through Web Audio (felt in the hand and heard as a soft knock); in the
 *    background the Web Push notification (public/sw.js) gives the system's own alert.
 */

export type VibrationParams = Pick<Cue, 'vibrationCount' | 'vibrationDuration' | 'vibrationInterval'>

/** Browser-limited, show-safe bounds. */
export const VIBRATION_LIMITS = { count: [1, 20], duration: [20, 3000], interval: [0, 3000] } as const

export function clampVibration(p: VibrationParams): VibrationParams {
  const c = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, Math.round(Number(v) || 0)))
  return {
    vibrationCount: c(p.vibrationCount, VIBRATION_LIMITS.count),
    vibrationDuration: c(p.vibrationDuration, VIBRATION_LIMITS.duration),
    vibrationInterval: c(p.vibrationInterval, VIBRATION_LIMITS.interval),
  }
}

/** [pulse, pause, pulse, pause, …, pulse] in ms, as navigator.vibrate and the notification `vibrate` option take it. */
export function vibrationPattern(p: VibrationParams): number[] {
  const { vibrationCount: n, vibrationDuration: d, vibrationInterval: gap } = clampVibration(p)
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    if (i > 0 && gap > 0) out.push(gap)
    else if (i > 0) out[out.length - 1] += d
    // With no pause, consecutive pulses merge into one long one.
    if (i === 0 || gap > 0) out.push(d)
  }
  return out
}

export type HapticMode = 'vibrate' | 'audio'

/** How this device will play a vibration cue in the foreground. */
export const hapticMode = (): HapticMode => (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function' ? 'vibrate' : 'audio')

/** The Web Audio stand-in: one low "thump" per pulse (low enough to feel, with upper partials a phone speaker can play). */
function playThumps(ctx: AudioContext, p: VibrationParams) {
  const { vibrationCount: n, vibrationDuration: d, vibrationInterval: gap } = clampVibration(p)
  const t0 = ctx.currentTime + 0.02
  for (let i = 0; i < n; i++) {
    const start = t0 + (i * (d + gap)) / 1000
    const end = start + d / 1000
    const env = ctx.createGain()
    env.gain.setValueAtTime(0, start)
    env.gain.linearRampToValueAtTime(1, start + 0.006)
    env.gain.setValueAtTime(1, Math.max(start + 0.006, end - 0.02))
    env.gain.linearRampToValueAtTime(0, end)
    env.connect(ctx.destination)
    // A low tone with its octave: small phone speakers reproduce the upper part, the hand feels the lower.
    for (const hz of [110, 220, 440]) {
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.value = hz
      osc.connect(env)
      osc.start(start)
      osc.stop(end + 0.02)
    }
  }
}

/**
 * Play a vibration pattern now. `ctx` is the page's unlocked AudioContext (used only when the device has no
 * vibration motor API). Returns how it was played, or 'none' when nothing could be (no motor, no audio yet).
 */
export function playVibration(p: VibrationParams, ctx?: AudioContext | null): HapticMode | 'none' {
  if (hapticMode() === 'vibrate') {
    return navigator.vibrate(vibrationPattern(p)) ? 'vibrate' : 'none'
  }
  if (ctx && ctx.state === 'running') {
    playThumps(ctx, p)
    return 'audio'
  }
  return 'none'
}
