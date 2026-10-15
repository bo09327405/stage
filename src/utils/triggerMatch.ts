import { midiAddress, midiCondition, type InputEvent, type TriggerMatch } from '../types/trigger'

/** A release-style OSC message (first argument 0 / false) shouldn't fire a trigger. */
function isOscRelease(event: Extract<InputEvent, { source: 'osc' }>) {
  const first = event.args[0]
  if (!first) return false
  return first.value === 0 || first.value === false || first.type === 'F'
}

/**
 * Whether `event` fires `match`. `previousCc` is the last value seen on the same channel/controller
 * (undefined if none), used to make CC conditions fire only on the way in.
 */
export function fires(match: TriggerMatch, event: InputEvent, previousCc: number | undefined): boolean {
  return explainMatch(match, event, previousCc) === null
}

/**
 * null when `event` fires `match`; otherwise a short reason why not (shown in the MIDI debug
 * log). Every MIDI field is compared as a number, so "1" from older data still matches 1.
 */
export function explainMatch(match: TriggerMatch, event: InputEvent, previousCc: number | undefined): string | null {
  if (match.source === 'osc') {
    if (event.source !== 'osc') return '來源不同（規則是 OSC）'
    if (event.address !== String(match.address).trim()) return `位址 ${event.address} ≠ ${match.address}`
    return isOscRelease(event) ? '參數為 0 / false（視為放開）' : null
  }
  if (event.source !== 'midi') return '來源不同（規則是 MIDI）'
  const { channel, number } = midiAddress(match)
  const evChannel = Number(event.channel)
  const evNumber = Number(event.number)
  const evValue = Number(event.value)
  const wantNote = match.message === 'noteOn'

  if (wantNote && event.message === 'cc') return '收到 CC，規則是 Note On'
  if (!wantNote && event.message !== 'cc') return `收到 ${event.message === 'noteOff' ? 'Note Off' : 'Note On'}，規則是 CC`
  if (event.message === 'noteOff') return 'Note Off（velocity 0）不觸發'
  if (channel !== 0 && evChannel !== channel) return `Channel ${evChannel} ≠ ${channel}`
  if (evNumber !== number) return `${wantNote ? 'Note' : 'CC #'} ${evNumber} ≠ ${number}`

  const c = midiCondition(match)
  if (wantNote) return evValue >= c.min ? null : `velocity ${evValue} < ${c.min}`
  const inside = (v: number) => v >= c.min && v <= c.max
  if (!inside(evValue)) return c.mode === 'rise' ? `CC 值 ${evValue} 未達 ${c.min}` : `CC 值 ${evValue} 不在 ${c.min}–${c.max}`
  // A controller we haven't heard from before counts as coming from outside the condition.
  if (previousCc != null && inside(Number(previousCc))) return `CC 已在條件內（上一個值 ${previousCc}），不重複觸發`
  return null
}
