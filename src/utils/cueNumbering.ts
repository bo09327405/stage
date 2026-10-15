/**
 * Theatre-style cue numbering. Moving or inserting a cue between two others gives it a number
 * between them (3 and 4 → 3.5; 3 and 3.5 → 3.2), so existing cue numbers — which the crew calls
 * out loud — never change behind anyone's back.
 */

const round = (n: number) => Math.round(n * 1000) / 1000

/** The "simplest" number strictly between prev and next (either may be null at the list ends). */
export function numberBetween(prev: number | null, next: number | null): number {
  if (prev == null && next == null) return 1
  if (prev == null) return next! > 1 ? round(Math.floor(next! - 1) || next! / 2) : round(next! / 2)
  if (next == null) return round(Math.floor(prev) + 1)
  for (const step of [1, 0.5, 0.1, 0.05, 0.01, 0.005, 0.001]) {
    const candidate = round((Math.floor(prev / step + 1e-9) + 1) * step)
    if (candidate > prev && candidate < next) return candidate
  }
  return round((prev + next) / 2)
}

/** Sequential numbers for a set of cues, in their current order: start, start+step, … */
export function renumber(ids: string[], start = 1, step = 1): Record<string, number> {
  return Object.fromEntries(ids.map((id, i) => [id, round(start + i * step)]))
}
