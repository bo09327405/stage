import { useEffect, useRef } from 'react'
import { stageAudio } from '../services/audioEngine'
import { playVibration } from '../services/vibration'
import { activeStartAt, cueTargets, type ShowState } from '../types/cue'

/** A vibration that is already this late when we notice it (page just opened / resumed) is not replayed. */
const STALE_MS = 1500

/**
 * Audience side: plays the show's vibration moments on this device while the page is open —
 *  · a VIBRATION cue, when its Pre-Wait ends;
 *  · the optional "get ready" reminder shortly before any cue's Pre-Wait ends (preWaitVibrate).
 * Android uses the vibration motor; iPhone / iPad fall back to Web Audio thumps (see services/vibration.ts).
 * With the page in the background the same moments reach the phone as Web Push notifications.
 */
export function useVibrationCues(showState: ShowState, serverNow: () => number, audienceId: string, channel: string | null, enabled: boolean) {
  const fired = useRef(new Set<string>())
  const latest = useRef(showState)
  useEffect(() => {
    latest.current = showState
  })

  useEffect(() => {
    if (!enabled || showState.pausedAt != null) return
    const timers: number[] = []
    for (const inst of Object.values(showState.active)) {
      const { cue } = inst
      if (inst.stopAt != null || !cueTargets(cue, audienceId, channel)) continue
      const start = activeStartAt(inst)
      const moments: { id: string; at: number }[] = []
      if (cue.preWaitVibrate && cue.preWaitTime > 0) {
        const lead = Math.min(Math.max(0, cue.preWaitVibrateLead), cue.preWaitTime)
        moments.push({ id: `${inst.instanceId}:pre`, at: start - lead * 1000 })
      }
      if (cue.type === 'VIBRATION') moments.push({ id: `${inst.instanceId}:main`, at: start })

      for (const m of moments) {
        if (fired.current.has(m.id)) continue
        const wait = m.at - serverNow()
        if (wait < -STALE_MS) {
          fired.current.add(m.id) // too old to matter
          continue
        }
        timers.push(
          window.setTimeout(() => {
            // Still running (not stopped, not paused meanwhile)?
            const now = latest.current.active[inst.instanceId]
            if (!now || now.stopAt != null || latest.current.pausedAt != null || fired.current.has(m.id)) return
            fired.current.add(m.id)
            playVibration(cue, stageAudio.context)
          }, Math.max(0, wait)),
        )
      }
    }
    return () => timers.forEach(window.clearTimeout)
  }, [showState.active, showState.pausedAt, enabled, audienceId, channel, serverNow])
}
