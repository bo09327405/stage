import type { Cue } from './cue'

/**
 * "After this cue starts" templates (Go Button style). Each one is just a preset over the cue's
 * flow fields, so the advanced controls underneath stay the single source of truth.
 */
export type AfterStartTemplate =
  | 'autoStop'
  | 'autoFollowNext'
  | 'startNext'
  | 'loopFadeNext'
  | 'fadeAutoStop'
  | 'fadeFollowNext'

type FlowFields = Pick<Cue, 'followMode' | 'postWaitTime' | 'autoStopAfter' | 'fadeOnNextGo' | 'loop' | 'loopCount' | 'fadeOutTime'>

export interface TemplateInfo {
  id: AfterStartTemplate
  /** Two-dot glyph like the Go Button template buttons: this cue · next cue. */
  icon: string
  title: string
  description: string
}

export const AFTER_START_TEMPLATES: TemplateInfo[] = [
  { id: 'autoStop', icon: '🟢🔴', title: 'Auto Stop', description: '播完自動停止，停在這裡等下一次 GO' },
  { id: 'autoFollowNext', icon: '🟢🟢', title: 'Auto-Follow Next', description: 'Post Wait 到時自動 GO 下一個，音軌短暫交疊' },
  { id: 'startNext', icon: '♾️', title: 'Immediately Start Next', description: 'GO 的同時無延遲啟動下一個，雙軌同步' },
  { id: 'loopFadeNext', icon: '♾️', title: 'Loop ∞ / Fade + Next', description: '無限循環；下一次 GO 時淡出並開始下一個' },
  { id: 'fadeAutoStop', icon: '🟢', title: 'Fade Out + Auto Stop', description: '到達時間點自動淡出至靜音並停止' },
  { id: 'fadeFollowNext', icon: '🟢', title: 'Fade Out + Follow Next', description: '到達時間點淡出，同時接續下一個（Crossfade）' },
]

const DEFAULT_FADE = 5
const DEFAULT_POST_WAIT = 3

/** Fields a template sets. Fade time and post-wait keep the user's own value when it's already set. */
export function applyTemplate(template: AfterStartTemplate, current: FlowFields): FlowFields {
  const fade = current.fadeOutTime > 0 ? current.fadeOutTime : DEFAULT_FADE
  const base: FlowFields = {
    followMode: 'none',
    postWaitTime: 0,
    autoStopAfter: 0,
    fadeOnNextGo: false,
    loop: false,
    loopCount: 0,
    fadeOutTime: 0,
  }
  switch (template) {
    case 'autoStop':
      return base
    case 'autoFollowNext':
      return { ...base, followMode: 'autoContinue', postWaitTime: current.postWaitTime > 0 ? current.postWaitTime : DEFAULT_POST_WAIT }
    case 'startNext':
      return { ...base, followMode: 'autoContinue', postWaitTime: 0 }
    case 'loopFadeNext':
      return { ...base, loop: true, loopCount: 0, fadeOnNextGo: true, fadeOutTime: fade }
    case 'fadeAutoStop':
      return { ...base, fadeOutTime: fade, autoStopAfter: current.autoStopAfter }
    case 'fadeFollowNext':
      return { ...base, followMode: 'autoFollow', fadeOutTime: fade, autoStopAfter: current.autoStopAfter, postWaitTime: current.followMode === 'autoFollow' ? current.postWaitTime : 0 }
  }
}

/** Which template the current fields correspond to, or null for a custom combination. */
export function detectTemplate(c: FlowFields): AfterStartTemplate | null {
  const looping = c.loop && c.loopCount === 0
  if (looping && c.fadeOnNextGo && c.followMode === 'none') return 'loopFadeNext'
  if (c.loop || c.fadeOnNextGo) return null
  if (c.followMode === 'autoContinue') return c.postWaitTime > 0 ? 'autoFollowNext' : 'startNext'
  if (c.followMode === 'autoFollow') return c.fadeOutTime > 0 ? 'fadeFollowNext' : null
  return c.fadeOutTime > 0 ? 'fadeAutoStop' : 'autoStop'
}
