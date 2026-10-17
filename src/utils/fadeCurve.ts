import { fadeRamp, type FadeShape } from '../types/studio'

/** Samples per ramp handed to Web Audio's setValueCurveAtTime (smooth enough for any fade shape). */
const POINTS = 64

/**
 * Gain values for a fade, for `gain.setValueCurveAtTime(values, startTime, seconds)`.
 * Fade-in: rises from `level × ramp(from)` to `level` (`from` = progress already elapsed, 0–1).
 * Fade-out: falls from `level` to silence — the mirror image in time, same shapes as Studio's fades.
 */
export function fadeCurve(shape: FadeShape | undefined, level: number, out: boolean, from = 0): Float32Array<ArrayBuffer> {
  const values = new Float32Array(POINTS)
  for (let i = 0; i < POINTS; i++) {
    const p = from + (1 - from) * (i / (POINTS - 1))
    values[i] = out ? level * fadeRamp(shape, 1 - p, true) : level * fadeRamp(shape, p)
  }
  return values
}
