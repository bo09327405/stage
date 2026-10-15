import type { ShowAction } from './actions'

/** An incoming external signal, from the OSC bridge or a Web MIDI input. */
export type InputEvent =
  | {
      source: 'osc'
      address: string
      args: { type: string; value: string | number | boolean }[]
      /** Sender "ip:port", as reported by the bridge. */
      from: string
      at: number
    }
  | {
      source: 'midi'
      message: 'noteOn' | 'noteOff' | 'cc'
      /** 1–16. */
      channel: number
      number: number
      value: number
      device: string
      at: number
    }

/**
 * What an external signal must look like to fire a trigger.
 * - OSC: exact address match. Messages whose first argument is 0/false are treated as a button
 *   release and ignored, so TouchOSC-style "/go 1 … /go 0" fires once.
 * - MIDI Note On: velocity ≥ minValue (default 1, i.e. any real Note On).
 * - MIDI CC, mode "rise": fires when the value rises to ≥ minValue (default 64) from below.
 * - MIDI CC, mode "range": fires when the value enters [minValue, maxValue] from outside it.
 * CC conditions are edge-triggered, so a fader sweep or a repeating controller fires once.
 */
export type CcMode = 'rise' | 'range'

export type TriggerMatch =
  | { source: 'osc'; address: string }
  | {
      source: 'midi'
      message: 'noteOn' | 'cc'
      /** 1–16; 0 = any channel. */
      channel: number
      /** Note number or controller number, 0–127. */
      number: number
      /** Note On: minimum velocity. CC: threshold ("rise") or range start ("range"). */
      minValue?: number
      /** CC "range" only: range end. */
      maxValue?: number
      ccMode?: CcMode
    }

type MidiMatch = Extract<TriggerMatch, { source: 'midi' }>

/** Settings may arrive as strings (imported JSON, older records); treat them as numbers. */
const num = (v: unknown, fallback: number) => {
  const n = Number(v)
  return v == null || v === '' || !Number.isFinite(n) ? fallback : n
}

/** The condition values with their defaults filled in, coerced to numbers. */
export function midiCondition(match: MidiMatch) {
  if (match.message === 'noteOn') return { mode: 'velocity' as const, min: Math.max(1, num(match.minValue, 1)), max: 127 }
  const mode: CcMode = match.ccMode === 'range' ? 'range' : 'rise'
  return mode === 'rise'
    ? { mode, min: num(match.minValue, 64), max: 127 }
    : { mode, min: num(match.minValue, 64), max: num(match.maxValue, 127) }
}

/** Channel (0 = any) and note/controller number of a MIDI match, coerced to numbers. */
export const midiAddress = (match: MidiMatch) => ({ channel: num(match.channel, 0), number: num(match.number, -1) })

export interface CueTrigger {
  enabled: boolean
  match: TriggerMatch
}

/** Project-wide mapping from an external signal to a show action (the "Global Profile"), at projects/{pid}/triggers/{id}. */
export interface GlobalTrigger {
  id: string
  enabled: boolean
  match: TriggerMatch
  action: ShowAction
}

export const defaultMatch = (source: TriggerMatch['source']): TriggerMatch =>
  source === 'osc' ? { source, address: '/sys/go' } : { source, message: 'noteOn', channel: 0, number: 60, minValue: 1 }

/**
 * Turn a received event into a match (the "Learn" button). Channel and note/CC number come from
 * the event; a condition the user already tuned for the same message type is kept.
 */
export function matchFromEvent(event: InputEvent, previous?: TriggerMatch): TriggerMatch {
  if (event.source === 'osc') return { source: 'osc', address: event.address }
  const message = event.message === 'cc' ? 'cc' : 'noteOn'
  const keep = previous?.source === 'midi' && previous.message === message ? previous : null
  if (message === 'noteOn') {
    return { source: 'midi', message, channel: event.channel, number: event.number, minValue: keep?.minValue ?? 1 }
  }
  return {
    source: 'midi',
    message,
    channel: event.channel,
    number: event.number,
    ccMode: keep?.ccMode ?? 'rise',
    minValue: keep?.minValue ?? 64,
    maxValue: keep?.maxValue ?? 127,
  }
}

export function describeMatch(match: TriggerMatch): string {
  if (match.source === 'osc') return `OSC ${match.address || '（未設定）'}`
  const ch = match.channel === 0 ? '任意 Ch' : `Ch ${match.channel}`
  const c = midiCondition(match)
  if (match.message === 'noteOn') return `MIDI Note ${match.number} · ${ch}${c.min > 1 ? ` · vel ≥ ${c.min}` : ''}`
  return c.mode === 'rise'
    ? `MIDI CC ${match.number} · ${ch} · 升到 ≥ ${c.min}`
    : `MIDI CC ${match.number} · ${ch} · 進入 ${c.min}–${c.max}`
}

export function describeEvent(event: InputEvent): string {
  if (event.source === 'osc') {
    const args = event.args.map((a) => String(a.value)).join(' ')
    return `OSC ${event.address}${args ? ` ${args}` : ''}`
  }
  const kind = { noteOn: 'Note On', noteOff: 'Note Off', cc: 'CC' }[event.message]
  return `MIDI ${kind} ${event.number} = ${event.value} · Ch ${event.channel}`
}
