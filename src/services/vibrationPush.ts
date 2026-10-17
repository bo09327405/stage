import { activeStartAt, type ActiveCue, type Cue } from '../types/cue'
import { vibrationPattern } from './vibration'

/*
 * Console side: when a vibration cue (or a cue with a Pre-Wait reminder) is fired, schedule the Web Push that
 * reaches audience phones with the app in the background (the foreground ones vibrate by themselves, see
 * hooks/useVibrationCues). Pushed at the same moments the devices would vibrate: the Pre-Wait reminder and,
 * for a VIBRATION cue, the start. A tab that stays open on the console is needed to send them on time.
 */

/** When this cue's vibration moments fall, in show-clock ms. */
export function vibrationMoments(cue: Cue, firedAt: number): number[] {
  const start = activeStartAt({ cue, firedAt } as ActiveCue)
  const out: number[] = []
  if (cue.preWaitVibrate && cue.preWaitTime > 0) out.push(start - Math.min(Math.max(0, cue.preWaitVibrateLead), cue.preWaitTime) * 1000)
  if (cue.type === 'VIBRATION') out.push(start)
  return out
}

export function planVibrationPush(projectId: string, cue: Cue, firedAt: number, serverNow: () => number, stillActive: () => boolean) {
  for (const at of vibrationMoments(cue, firedAt)) {
    window.setTimeout(
      () => {
        if (!stillActive()) return
        fetch('/api/push/vibrate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            projectId,
            channels: cue.targetChannels,
            ...(cue.targetMode === 'selected' ? { codes: cue.targetIds } : {}),
            pattern: vibrationPattern(cue),
            text: cue.type === 'VIBRATION' ? cue.title : '',
          }),
        }).catch(() => {})
      },
      Math.max(0, at - serverNow()),
    )
  }
}
