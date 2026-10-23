import type { VjMix } from '../types/vj'

/**
 * The mix the console's VJ controller is performing right now, so the cue editor can "capture" it into a VJ cue.
 * (A plain module variable: the controller is mounted for the whole console session; the editor only reads it on a click.)
 */
let latest: VjMix | null = null

export const publishLiveVjMix = (mix: VjMix) => {
  latest = mix
}
export const latestLiveVjMix = () => latest
