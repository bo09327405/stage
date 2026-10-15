import { actionLabel, type ShowAction } from './actions'
import { DEFAULT_CUE, type Cue } from './cue'

/*
 * grandMA-style playback on the control panel: Sequences (ordered cue lists) loaded onto
 * Executors (numbered playback strips: fader, GO, PAUSE, GO−, OFF).
 *
 *   projects/{pid}/surfaces/{sid}/sequences/{seqId}   { name, cues/{cueId}: SeqCue }
 *   projects/{pid}/surfaces/{sid}/executors/{no}      { sequenceId }
 *
 * What an executor is doing right now (current cue, its running instance) is show state, shared
 * by every console: versions/{vid}/showState/executors/{no}; its fader is showState/execLevels/{no}.
 *
 * GO fires the next cue: its sound starts after Delay and fades in over Fade In, while the cue
 * before it fades out over this cue's Out Fade. Trig decides when a cue fires: on GO, or by itself —
 * Follow (when the previous cue has finished playing) or Time (n seconds after the previous cue
 * fired).
 */

export type SeqTrig = 'go' | 'follow' | 'time'
export const TRIG_LABELS: Record<SeqTrig, string> = { go: 'Go', follow: 'Follow', time: 'Time' }

/** What a sequence cue plays or does. */
export type SeqSource =
  | { kind: 'audio'; url: string; name: string; mediaKind: 'audio' | 'video' }
  /** A cue of the Set Cue list, played with this step's level and timing. */
  | { kind: 'cue'; cueId: string }
  /** A show command (GO, Pause, Play Hit 3, …). */
  | { kind: 'action'; action: ShowAction }
  | { kind: 'none' }

export interface SeqCue {
  id: string
  /** Cue number in the sequence (decimals allowed, e.g. 2.5); playback follows number order. */
  number: number
  name: string
  source: SeqSource
  /** 0–100. */
  volume: number
  /** −1 (left) … 1 (right). */
  pan: number
  /** Seconds. */
  fadeIn: number
  /** Seconds: how long the previous cue takes to fade out when this one fires. */
  fadeOut: number
  /** Seconds between the trigger and the start. */
  delay: number
  trig: SeqTrig
  /** Trig "time": seconds after the previous cue fired. */
  trigTime: number
  /** Loop the sound until the next cue (or OFF). */
  loop: boolean
  /** Length of the sound, seconds (0 = unknown), for Follow. */
  duration: number
}

export interface Sequence {
  id: string
  name: string
  cues: Record<string, SeqCue>
}

/** An executor's sequence assignment (saved with the panel). */
export interface ExecutorSlot {
  sequenceId: string
}

/** What an executor is running (show state). */
export interface ExecutorRun {
  sequenceId: string
  /** The current cue (null after OFF: the next GO starts from the top). */
  cueId: string | null
  /** Its running instance in showState.active (null for command-only cues). */
  instanceId: string | null
  firedAt: number
}

export const EXECUTOR_COUNT = 10
export const executorNumbers = Array.from({ length: EXECUTOR_COUNT }, (_, i) => i + 1)

export const DEFAULT_SEQ_CUE: Omit<SeqCue, 'id' | 'number'> = {
  name: '',
  source: { kind: 'none' },
  volume: 100,
  pan: 0,
  fadeIn: 0,
  fadeOut: 2,
  delay: 0,
  trig: 'go',
  trigTime: 0,
  loop: false,
  duration: 0,
}

const num = (v: unknown, fallback: number, min = -Infinity, max = Infinity) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

function normalizeSource(raw: unknown): SeqSource {
  const s = (raw ?? {}) as Record<string, unknown>
  if (s.kind === 'audio' && typeof s.url === 'string') return { kind: 'audio', url: s.url, name: typeof s.name === 'string' ? s.name : '', mediaKind: s.mediaKind === 'video' ? 'video' : 'audio' }
  if (s.kind === 'cue' && typeof s.cueId === 'string') return { kind: 'cue', cueId: s.cueId }
  if (s.kind === 'action' && typeof s.action === 'string') return { kind: 'action', action: s.action as ShowAction }
  return { kind: 'none' }
}

export function normalizeSeqCue(id: string, raw: Partial<SeqCue> = {}): SeqCue {
  return {
    id,
    number: num(raw.number, 1, 0),
    name: typeof raw.name === 'string' ? raw.name : '',
    source: normalizeSource(raw.source),
    volume: num(raw.volume, 100, 0, 100),
    pan: num(raw.pan, 0, -1, 1),
    fadeIn: num(raw.fadeIn, 0, 0, 600),
    fadeOut: num(raw.fadeOut, 2, 0, 600),
    delay: num(raw.delay, 0, 0, 3600),
    trig: raw.trig === 'follow' || raw.trig === 'time' ? raw.trig : 'go',
    trigTime: num(raw.trigTime, 0, 0, 3600),
    loop: raw.loop === true,
    duration: num(raw.duration, 0, 0),
  }
}

export function normalizeSequence(id: string, raw: Partial<Omit<Sequence, 'cues'>> & { cues?: Record<string, Partial<SeqCue>> } = {}): Sequence {
  const cues: Record<string, SeqCue> = {}
  for (const [cid, c] of Object.entries(raw.cues ?? {})) cues[cid] = normalizeSeqCue(cid, c)
  return { id, name: typeof raw.name === 'string' && raw.name ? raw.name : '未命名序列', cues }
}

/** A sequence's cues in playback order. */
export const orderedCues = (seq: Sequence | null | undefined): SeqCue[] => (seq ? Object.values(seq.cues).sort((a, b) => a.number - b.number || a.id.localeCompare(b.id)) : [])

/** The cue after `cueId` (wrapping to the first after the last; the first when nothing ran yet). */
export function cueAfter(seq: Sequence, cueId: string | null): SeqCue | null {
  const list = orderedCues(seq)
  if (!list.length) return null
  const i = cueId ? list.findIndex((c) => c.id === cueId) : -1
  return list[(i + 1) % list.length]
}

/** The cue before `cueId` (wrapping to the last). */
export function cueBefore(seq: Sequence, cueId: string | null): SeqCue | null {
  const list = orderedCues(seq)
  if (!list.length) return null
  const i = cueId ? list.findIndex((c) => c.id === cueId) : 0
  return list[(i - 1 + list.length) % list.length]
}

/** Next free whole number after the last cue. */
export const nextCueNumber = (seq: Sequence | null | undefined) => Math.floor(Math.max(0, ...orderedCues(seq).map((c) => c.number))) + 1

/** Format a cue number: 1, 2.5 */
export const formatCueNumber = (n: number) => String(Math.round(n * 100) / 100)

export function sourceLabel(source: SeqSource, cues: Cue[]): string {
  switch (source.kind) {
    case 'audio':
      return source.name || '音檔'
    case 'cue': {
      const c = cues.find((x) => x.id === source.cueId)
      return c ? `Q${c.cueNumber} ${c.title}` : '（Cue 已刪除）'
    }
    case 'action':
      return `指令：${actionLabel(source.action)}`
    case 'none':
      return '（空）'
  }
}

/**
 * The show cue an executor plays for a sequence cue: its sound with the step's level, pan and
 * timing, tagged with the executor (for its fader). Null for command-only / empty steps.
 */
export function executorShowCue(execNo: number, step: SeqCue, cues: Cue[]): Cue | null {
  const tag = { executor: String(execNo), pan: step.pan, followMode: 'none' as const, stopOthers: 'none' as const, duckOthers: 0, preventGoDuration: 0, fadeOnNextGo: false, triggers: [] }
  const timing = { volume: step.volume, preWaitTime: step.delay, fadeInTime: step.fadeIn, fadeOutTime: step.fadeOut, autoStopAfter: 0, loop: step.loop, loopCount: 0 }
  if (step.source.kind === 'audio') {
    return {
      ...DEFAULT_CUE,
      id: `exec${execNo}-${step.id}`,
      cueNumber: step.number,
      title: `Exec ${execNo} · ${step.name || step.source.name}`,
      type: step.source.mediaKind === 'video' ? 'VIDEO' : 'AUDIO',
      targetUrl: step.source.url,
      duration: step.duration,
      targetMode: 'all',
      targetIds: [],
      ...timing,
      ...tag,
    }
  }
  if (step.source.kind === 'cue') {
    const src = cues.find((c) => c.id === (step.source as { cueId: string }).cueId)
    if (!src) return null
    return { ...src, id: `exec${execNo}-${step.id}`, title: `Exec ${execNo} · ${step.name || src.title}`, ...timing, loop: step.loop || src.loop, ...tag }
  }
  return null
}

/** When the step after a running cue fires by itself (server ms), or null for Go. */
export function autoFireAt(next: SeqCue, current: SeqCue, firedAt: number): number | null {
  if (next.trig === 'time') return firedAt + next.trigTime * 1000
  if (next.trig !== 'follow') return null
  // Follow: once the current cue has played out (a looping or unknown-length sound: after its fade-in).
  const playLength = current.loop || !current.duration || current.source.kind === 'action' ? current.fadeIn : current.duration
  return firedAt + (current.delay + playLength) * 1000
}
