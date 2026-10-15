import { activeEndAt, activeFollowAt, activeStartAt, cueRunLength, type ActiveCue } from '../types/cue'

export interface InstanceTiming {
  phase: 'prewait' | 'running' | 'stopping' | 'postwait'
  /** 0–1 through the current phase; null when the cue holds indefinitely. */
  progress: number | null
  /** Seconds left in the current phase; null when the cue holds indefinitely. */
  remaining: number | null
  /** Seconds since playback began (after pre-wait). */
  elapsed: number
}

/** Where a running instance is at server time `now`, for progress bars and countdowns. */
export function instanceTiming(inst: ActiveCue, now: number): InstanceTiming {
  const { cue } = inst
  const startAt = activeStartAt(inst)
  const endAt = activeEndAt(inst)
  const elapsed = Math.max(0, (now - startAt) / 1000)

  if (inst.stopAt != null) {
    const fade = (inst.stopFade ?? cue.fadeOutTime) * 1000
    return {
      phase: 'stopping',
      progress: fade > 0 ? Math.min(1, (now - inst.stopAt) / fade) : 1,
      remaining: Math.max(0, (endAt - now) / 1000),
      elapsed,
    }
  }
  if (now < startAt) {
    return {
      phase: 'prewait',
      progress: (now - inst.firedAt) / (cue.preWaitTime * 1000),
      remaining: (startAt - now) / 1000,
      elapsed: 0,
    }
  }
  // Finished playing, waiting out post-wait before auto-follow fires.
  const followAt = activeFollowAt(inst)
  if (now >= endAt && followAt != null && !inst.followed) {
    const wait = cue.postWaitTime * 1000
    return {
      phase: 'postwait',
      progress: wait > 0 ? Math.min(1, (now - endAt) / wait) : 1,
      remaining: Math.max(0, (followAt - now) / 1000),
      elapsed,
    }
  }
  const length = cueRunLength(cue)
  if (!Number.isFinite(length)) return { phase: 'running', progress: null, remaining: null, elapsed }
  return {
    phase: 'running',
    progress: length > 0 ? Math.min(1, elapsed / length) : 1,
    remaining: Math.max(0, (endAt - now) / 1000),
    elapsed,
  }
}
