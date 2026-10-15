import type { ShowAction, HitSlot } from '../types/actions'
import { newIntercomWidget, newMonitorWidget, newStageWidget, newWidget, type SurfaceAction, type SurfaceWidget } from '../types/surface'

/**
 * Built-in control-panel modules, listed first in the 📦 module library (12-column grid). They are
 * generated here rather than stored, so every project has them and they can't be deleted.
 */

export interface BuiltinModule {
  id: 'theatre' | 'live-music'
  name: string
  description: string
  icon: string
  /** What the module contains, for the library card. */
  contents: string[]
  build: (newId: () => string) => SurfaceWidget[]
}

const show = (action: ShowAction): SurfaceAction => ({ kind: 'show', action })

function button(newId: () => string, label: string, color: string, x: number, y: number, w: number, h: number, actions: SurfaceAction[], extra: Partial<SurfaceWidget> = {}): SurfaceWidget {
  return { ...newWidget('button', newId(), x, y), label, color, w, h, actions, ...extra }
}

function fader(newId: () => string, label: string, color: string, x: number, y: number, w: number, h: number, actions: SurfaceAction[], value: number): SurfaceWidget {
  return { ...newWidget('fader', newId(), x, y), label, color, w, h, actions, value }
}

function knob(newId: () => string, label: string, color: string, x: number, y: number, actions: SurfaceAction[], value: number): SurfaceWidget {
  return { ...newWidget('knob', newId(), x, y), label, color, actions, value }
}

/**
 * Theatre: cue-by-cue show running with safety controls.
 *
 *   [ Cue Monitor   ][    GO     ][P/R ][M]
 *   [               ][Prev][Next][PANIC][a]
 *   [Hit1][Hit2][Hit3][Hit4][Page ›    ][i]
 *   [Hit5][Hit6][Hit7][Hit8][Stop Hits ][n]
 *   [ Stage           ][ Intercom         ]
 */
function theatre(newId: () => string): SurfaceWidget[] {
  const hit = (n: HitSlot, i: number, y: number, color: string) => button(newId, `Hit ${n}`, color, i * 2, y, 2, 2, [show(`hitPlay${n}`)])
  return [
    { ...newMonitorWidget(newId(), 0, 0), w: 5, h: 6, monitorList: true },
    button(newId, 'GO', '#30d158', 5, 0, 4, 3, [show('go')]),
    button(newId, 'Pause / Resume', '#ffd60a', 9, 0, 2, 3, [show('pauseResumeShow')]),
    button(newId, '‹ Prev Cue', '#8e8e93', 5, 3, 2, 3, [show('selectPrev')]),
    button(newId, 'Next Cue ›', '#8e8e93', 7, 3, 2, 3, [show('selectNext')]),
    button(newId, 'PANIC', '#ff453a', 9, 3, 2, 3, [show('panicShow')]),
    fader(newId, 'Master', '#30d158', 11, 0, 1, 10, [{ kind: 'master' }], 1),
    ...([1, 2, 3, 4] as const).map((n, i) => hit(n, i, 6, '#0a84ff')),
    ...([5, 6, 7, 8] as const).map((n, i) => hit(n, i, 8, '#bf5af2')),
    button(newId, 'Hits Page ›', '#64d2ff', 8, 6, 3, 2, [show('hitsPageNext')]),
    button(newId, 'Stop Hits', '#8e8e93', 8, 8, 3, 2, [show('panicHits')]),
    { ...newStageWidget(newId(), 0, 10), w: 6, h: 6 },
    { ...newIntercomWidget(newId(), 6, 10), w: 6, h: 6 },
  ]
}

/**
 * Live Music (Ableton Live style):
 *
 *   [Pad1][Pad2][Pad3][Pad4] [Ch1][Ch2][Ch3][Ch4]
 *   [Pad5][Pad6][Pad7][Pad8] [   channel faders ]
 *   [Clp1][Clp2][Clp3][Clp4] [Filter ][Reverb   ]
 *   [Clp5][Clp6][Clp7][Clp8] [Delay  ][Master   ]
 *   [====== Crossfader ====]
 *   [Scene▶][Next][Stop][Fade][Page‹][Page›]
 *
 * Pads 1–8 play the project's Hits; clips 1–8 send MIDI notes 36–43 (Drum Rack / clip launch
 * mapping) on channel 1; channel faders send CC 20–23; FX knobs ride the show FX bus.
 */
const PAD_COLORS = ['#ff453a', '#ff9f0a', '#ffd60a', '#30d158', '#64d2ff', '#0a84ff', '#bf5af2', '#ff375f']

function liveMusic(newId: () => string): SurfaceWidget[] {
  const pads = PAD_COLORS.map((color, i) =>
    button(newId, `Pad ${i + 1}`, color, (i % 4) * 2, Math.floor(i / 4) * 2, 2, 2, [show(`hitPlay${(i + 1) as HitSlot}`)]),
  )
  const clips = PAD_COLORS.map((color, i) =>
    button(newId, `Clip ${i + 1}`, color, (i % 4) * 2, 4 + Math.floor(i / 4) * 2, 2, 2, [{ kind: 'midi', message: 'noteOn', channel: 1, number: 36 + i, value: 127 }], { momentary: true }),
  )
  const channels = [1, 2, 3, 4].map((n, i) => fader(newId, `Ch ${n}`, '#0a84ff', 8 + i, 0, 1, 4, [{ kind: 'midi', message: 'cc', channel: 1, number: 19 + n, value: 0 }], 0.8))
  const triggers: [string, string, ShowAction][] = [
    ['Scene ▶ GO', '#30d158', 'go'],
    ['Next Scene', '#8e8e93', 'selectNext'],
    ['Stop Clips', '#ff453a', 'panicHits'],
    ['Fade Out', '#ff9f0a', 'panicCues'],
    ['‹ Pad Bank', '#64d2ff', 'hitsPagePrev'],
    ['Pad Bank ›', '#64d2ff', 'hitsPageNext'],
  ]
  return [
    ...pads,
    ...clips,
    ...channels,
    knob(newId, 'Filter', '#ff9f0a', 8, 4, [{ kind: 'param', target: { scope: 'show', param: 'filter' } }], 0.5),
    knob(newId, 'Reverb', '#bf5af2', 10, 4, [{ kind: 'param', target: { scope: 'show', param: 'reverb' } }], 0),
    knob(newId, 'Delay', '#64d2ff', 8, 6, [{ kind: 'param', target: { scope: 'show', param: 'delay' } }], 0),
    knob(newId, 'Master', '#30d158', 10, 6, [{ kind: 'param', target: { scope: 'show', param: 'master' } }], 1),
    fader(newId, 'Crossfader', '#ffd60a', 0, 8, 8, 2, [{ kind: 'xfade' }], 0),
    ...triggers.map(([label, color, action], i) => button(newId, label, color, i * 2, 10, 2, 2, [show(action)])),
  ]
}

export const BUILTIN_MODULES: BuiltinModule[] = [
  {
    id: 'theatre',
    name: 'Theatre',
    icon: '🎭',
    description: '劇場演出：Cue 點推進與安全控制',
    contents: ['Cue Monitor', '大型 GO', 'Pause / Resume', 'Prev / Next Cue', 'Master 推桿', 'PANIC', 'Hits 1–8', 'Stage 預覽', 'Intercom'],
    build: theatre,
  },
  {
    id: 'live-music',
    name: 'Live Music',
    icon: '🎛️',
    description: '現場音樂 / Live Set / 即興（Ableton Live 風格）',
    contents: ['Pad 4×2（Hits）', 'Clip 4×2（MIDI Note 36–43）', 'Channel Faders ×4（CC 20–23）', 'Crossfader', 'Filter / Reverb / Delay', '即興 Trigger 區'],
    build: liveMusic,
  },
]

/** The layout a new control panel starts with. */
export const defaultSurfaceWidgets = (newId: () => string) => BUILTIN_MODULES[0].build(newId)
