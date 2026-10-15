/**
 * Standard show-control actions (Go Button style). Surface buttons, global trigger profiles and
 * anything else that "does a show thing" picks from this one list.
 */

export const HIT_SLOTS = [1, 2, 3, 4, 5, 6, 7, 8] as const
export type HitSlot = (typeof HIT_SLOTS)[number]
/** Hits are addressed by slot on the current page: slot n = hits[page * 8 + n - 1]. */
export const HITS_PER_PAGE = HIT_SLOTS.length

export type ShowAction =
  | 'none'
  // Core playback
  | 'go'
  | 'selectNext'
  | 'selectPrev'
  // Show state
  | 'pauseResumeShow'
  | 'pauseShow'
  | 'resumeShow'
  | 'panicShow'
  | 'panicCues'
  // Selected cue
  | 'playPauseSelected'
  | 'pauseSelected'
  | 'unpauseSelected'
  | 'oops'
  // Main volume
  | 'dimToggle'
  | 'dim'
  | 'undim'
  | 'muteToggle'
  | 'mute'
  | 'unmute'
  | 'volumeUp'
  | 'volumeDown'
  // Hits
  | `hitPlay${HitSlot}`
  | `hitStop${HitSlot}`
  | 'panicHits'
  | 'hitsPagePrev'
  | 'hitsPageNext'

export interface ActionGroup {
  label: string
  actions: { id: ShowAction; label: string; hint?: string }[]
}

export const ACTION_GROUPS: ActionGroup[] = [
  { label: '', actions: [{ id: 'none', label: '- no action / disabled -' }] },
  {
    label: '核心播放',
    actions: [
      { id: 'go', label: 'GO', hint: '執行 Standby Cue' },
      { id: 'selectNext', label: 'Select Next Cue', hint: 'Standby 往下一個' },
      { id: 'selectPrev', label: 'Select Prev Cue', hint: 'Standby 往上一個' },
    ],
  },
  {
    label: '演出狀態',
    actions: [
      { id: 'pauseResumeShow', label: 'Pause/Resume Show' },
      { id: 'pauseShow', label: 'Pause Show' },
      { id: 'resumeShow', label: 'Resume Show' },
      { id: 'panicShow', label: 'Panic Show', hint: '立即停止所有 Cue 與 Hits' },
      { id: 'panicCues', label: 'Panic All Cues', hint: '1 秒淡出所有 Cue' },
    ],
  },
  {
    label: '單一 Cue',
    actions: [
      { id: 'playPauseSelected', label: 'Play/Pause Selected Cue' },
      { id: 'pauseSelected', label: 'Pause Selected Cue' },
      { id: 'unpauseSelected', label: 'Unpause Selected Cue' },
      { id: 'oops', label: 'Oops (Reset to Last Cue)', hint: '停止剛觸發的 Cue 並退回 Standby' },
    ],
  },
  {
    label: '主音量',
    actions: [
      { id: 'dimToggle', label: 'Toggle Main Volume Dimmed' },
      { id: 'dim', label: 'Dim Main Volume' },
      { id: 'undim', label: 'Undim Main Volume' },
      { id: 'muteToggle', label: 'Toggle Main Volume Muted' },
      { id: 'mute', label: 'Mute Main Volume' },
      { id: 'unmute', label: 'Unmute Main Volume' },
      { id: 'volumeUp', label: 'Step Up Main Volume', hint: '+5%' },
      { id: 'volumeDown', label: 'Step Down Main Volume', hint: '−5%' },
    ],
  },
  {
    label: 'Hits',
    actions: [
      ...HIT_SLOTS.map((n) => ({ id: `hitPlay${n}` as ShowAction, label: `Play Hit ${n}` })),
      ...HIT_SLOTS.map((n) => ({ id: `hitStop${n}` as ShowAction, label: `Stop Hit ${n}` })),
      { id: 'panicHits', label: 'Panic All Hits' },
      { id: 'hitsPagePrev', label: 'Prev Hits Page' },
      { id: 'hitsPageNext', label: 'Next Hits Page' },
    ],
  },
]

const LABELS = new Map(ACTION_GROUPS.flatMap((g) => g.actions.map((a) => [a.id, a.label] as const)))
export const actionLabel = (action: ShowAction) => LABELS.get(action) ?? action
export const isShowAction = (value: unknown): value is ShowAction => typeof value === 'string' && LABELS.has(value as ShowAction)

/** "hitPlay3" → { op: 'play', slot: 3 } */
export function parseHitAction(action: ShowAction): { op: 'play' | 'stop'; slot: HitSlot } | null {
  const m = /^hit(Play|Stop)([1-8])$/.exec(action)
  return m ? { op: m[1] === 'Play' ? 'play' : 'stop', slot: Number(m[2]) as HitSlot } : null
}

/** Stage 6/7 surface command names, migrated on read. */
const LEGACY: Record<string, ShowAction> = {
  pauseToggle: 'pauseResumeShow',
  pause: 'pauseShow',
  resume: 'resumeShow',
  stop: 'panicShow',
  fadeAll: 'panicCues',
}

export const migrateAction = (value: unknown): ShowAction =>
  isShowAction(value) ? value : (LEGACY[String(value)] ?? 'none')

/** Main volume step for volumeUp / volumeDown, in percent. */
export const VOLUME_STEP = 5
/** Fade used by "Panic All Cues", in seconds. */
export const PANIC_FADE = 1
