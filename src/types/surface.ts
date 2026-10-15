import type { ExecutorSlot, Sequence } from './sequence'
import { migrateAction, type ShowAction } from './actions'
import type { TriggerMatch } from './trigger'

export type MidiMessage = 'noteOn' | 'noteOff' | 'cc' | 'program'

export const MIDI_MESSAGE_LABELS: Record<MidiMessage, string> = {
  noteOn: 'Note On',
  noteOff: 'Note Off',
  cc: 'Control Change',
  program: 'Program Change',
}

export type OscArgType = 'f' | 'i' | 's' | 'T' | 'F'

export const OSC_ARG_LABELS: Record<OscArgType, string> = {
  f: 'float',
  i: 'int',
  s: 'string',
  T: 'true',
  F: 'false',
}

export interface OscArg {
  type: OscArgType
  /** Literal value; for faders the special value "$value" is replaced by the fader position. */
  value: string
}

/**
 * What a control does. A button runs its actions on press; a fader runs them on every move,
 * with its current value fed into MIDI CC / OSC "$value" / master volume.
 */
export type SurfaceAction =
  /** One of the standard show-control actions (GO, Pause Show, Play Hit 3, …). */
  | { kind: 'show'; action: ShowAction }
  | { kind: 'cue'; cueId: string; command: 'go' | 'stop' }
  | { kind: 'master' }
  | { kind: 'midi'; message: MidiMessage; channel: number; number: number; value: number }
  | {
      kind: 'osc'
      address: string
      args: OscArg[]
      /** Overrides the surface's default OSC target when set. */
      host: string
      port: number
    }
  /** Open / close / toggle one of the control panel's windows. */
  | { kind: 'panel'; panel: PanelTarget; mode: PanelMode }
  /** Knob / fader: a live parameter — show FX, show master, or a DAW Studio track / master. */
  | { kind: 'param'; target: ParamTarget }
  /** Fader: manual crossfade into the standby cue ("走 Cue"). */
  | { kind: 'xfade' }
  /** Knob / fader: ride a hit's level, or fire / stop it across the middle of the travel. */
  | { kind: 'hit'; hitId: string; mode: 'level' | 'trigger' }
  /** An executor (types/sequence.ts): button GO / PAUSE / GO− / OFF, or fader / knob: its level. */
  | { kind: 'executor'; exec: number; command: ExecCommand }

export type ExecCommand = 'go' | 'pause' | 'back' | 'off' | 'level'
export const EXEC_COMMAND_LABELS: Record<ExecCommand, string> = { go: 'GO', pause: 'PAUSE', back: 'GO−', off: 'OFF', level: '推桿' }

/** Show-wide live parameters (audience devices): master volume and the show FX bus. */
export type ShowParam = 'master' | 'eqLow' | 'eqMid' | 'eqHigh' | 'filter' | 'reverb' | 'delay' | 'pan'
/** DAW Studio parameters on a track (or the studio master: trackId "master", volume only). */
export type StudioParam = 'volume' | 'pan' | 'reverb' | 'delay' | 'eqLow' | 'eqMid' | 'eqHigh'
export type ParamTarget = { scope: 'show'; param: ShowParam } | { scope: 'studio'; studioId: string; trackId: string; param: StudioParam }

/** Windows a button can open or close on the control panel. */
export type PanelTarget = 'stage' | 'notes' | 'monitor'
export type PanelMode = 'toggle' | 'open' | 'close'
export const PANEL_LABELS: Record<PanelTarget, string> = { stage: '🎭 Stage 模擬畫面', notes: '📝 Note 筆記', monitor: '📺 Cue Monitor' }
export const PANEL_MODE_LABELS: Record<PanelMode, string> = { toggle: '切換', open: '開啟', close: '收合' }

export type WidgetType = 'button' | 'fader' | 'knob'

export interface SurfaceWidget {
  id: string
  type: WidgetType
  label: string
  color: string
  /** Grid position and size, in cells. */
  x: number
  y: number
  w: number
  h: number
  actions: SurfaceAction[]
  /** Fader only: output range and current value. */
  min: number
  max: number
  value: number
  /** Button only: also send Note Off / release actions when the finger lifts. */
  momentary: boolean
  /**
   * Incoming MIDI/OSC that operates this control remotely: presses a button, or (MIDI CC) moves
   * a fader across its range.
   */
  input: TriggerMatch | null
  /**
   * Button only: "action" fires its actions; "monitor" turns the block into a live mini Cue Monitor;
   * "note" into a small script / notes window.
   */
  display: ButtonDisplay
  /** Monitor display: also list the cues (tap to select) below the Active / Standby status. */
  monitorList: boolean
  /** Monitor display: what tapping a cue in its list does. */
  monitorTap: 'standby' | 'go'
  /** Note display: this block's own text, the version's shared script, or a public Notion page. */
  noteSource: 'script' | 'custom' | 'notion'
  noteText: string
  /** Note display with noteSource "notion": the page link. */
  noteNotionUrl: string
  /** Note display: text size multiplier. */
  noteFont: number
  /** Intercom display: voice station only, chat only, or both. */
  intercomMode: IntercomMode
}

export type IntercomMode = 'voice' | 'chat' | 'full'

export type ButtonDisplay = 'action' | 'monitor' | 'note' | 'stage' | 'intercom'

/** How the Cue Monitor on a surface is laid out (shared with the team via the surface record). */
/** A tile on the freeform canvas: x/w in 1/48ths of the width, y/h in 8 px units. */
export interface FreeRect {
  x: number
  y: number
  w: number
  h: number
}

export const FREE_COLUMNS = 48
export const FREE_ROW_PX = 8
/** Status modules that can sit on the freeform canvas next to cue tiles. */
export const MONITOR_MODULES = ['__now', '__next'] as const
export type MonitorModule = (typeof MONITOR_MODULES)[number]
export const MODULE_LABELS: Record<MonitorModule, string> = {
  __now: '執行中',
  __next: '下一個 (Standby)',
}

export interface MonitorLayout {
  mode: 'list' | 'grid' | 'free'
  /** Grid columns. */
  columns: number
  /** Height of one grid row, px. */
  tileHeight: number
  /** Text size multiplier for tiles. */
  fontScale: number
  /** What tapping a tile does. */
  tapAction: 'standby' | 'go'
  /** Custom tile order (cue ids); cues not listed follow in cue-list order. */
  order: string[]
  /** Per-cue tile size in grid cells. */
  spans: Record<string, { w: number; h: number }>
  /** Freeform canvas: position and size per cue id or module id. Unplaced cues are auto-placed. */
  free: Record<string, FreeRect>
  /** Status modules shown on the freeform canvas. */
  modules: MonitorModule[]
}

export const DEFAULT_MONITOR_LAYOUT: MonitorLayout = {
  mode: 'list',
  columns: 4,
  tileHeight: 92,
  fontScale: 1,
  tapAction: 'standby',
  order: [],
  spans: {},
  free: {},
  modules: [],
}

export function normalizeMonitorLayout(raw: Partial<MonitorLayout> | undefined): MonitorLayout {
  const m = { ...DEFAULT_MONITOR_LAYOUT, ...raw }
  return {
    ...m,
    columns: Math.min(10, Math.max(1, Math.round(Number(m.columns) || 4))),
    tileHeight: Math.min(240, Math.max(48, Number(m.tileHeight) || 92)),
    fontScale: Math.min(2.2, Math.max(0.7, Number(m.fontScale) || 1)),
    tapAction: m.tapAction === 'go' ? 'go' : 'standby',
    mode: m.mode === 'grid' || m.mode === 'free' ? m.mode : 'list',
    // RTDB drops empty arrays and may return arrays as objects.
    order: Object.values(m.order ?? {}),
    spans: m.spans ?? {},
    free: m.free ?? {},
    modules: Object.values(m.modules ?? {}).filter((x): x is MonitorModule => (MONITOR_MODULES as readonly string[]).includes(x)),
  }
}

/** A saved control surface layout, stored at projects/{pid}/surfaces/{surfaceId}. */
export interface Surface {
  id: string
  name: string
  /** Grid columns; rows grow with content. */
  columns: number
  /** Project-wide OSC target used by actions that don't override it (e.g. a Tailscale IP). */
  oscHost: string
  oscPort: number
  widgets: Record<string, SurfaceWidget>
  /** Cue Monitor arrangement for this surface. */
  monitor: MonitorLayout
  /** Executor playback (types/sequence.ts): the panel's sequences, and which executor runs which. */
  sequences: Record<string, Sequence>
  executors: Record<string, ExecutorSlot>
  updatedAt: number
}

export const SURFACE_COLUMNS = 12

export const WIDGET_COLORS = ['#30d158', '#0a84ff', '#ffd60a', '#ff9f0a', '#ff453a', '#bf5af2', '#64d2ff', '#8e8e93']

const MONITOR_DEFAULTS = {
  display: 'action',
  monitorList: true,
  monitorTap: 'standby',
  noteSource: 'custom',
  noteText: '',
  noteNotionUrl: '',
  noteFont: 1,
  intercomMode: 'full',
} as const

/** A button set up as a mini Cue Monitor (a good default size for it). */
export function newMonitorWidget(id: string, x: number, y: number): SurfaceWidget {
  return { ...newWidget('button', id, x, y), label: 'Cue Monitor', color: '#ffd60a', w: 4, h: 3, display: 'monitor' }
}

/** A button set up as a live Stage thumbnail (tap: open / close the Stage window). */
export function newStageWidget(id: string, x: number, y: number): SurfaceWidget {
  return { ...newWidget('button', id, x, y), label: 'Stage', color: '#64d2ff', w: 3, h: 3, display: 'stage' }
}

/** A button set up as an intercom station. */
export function newIntercomWidget(id: string, x: number, y: number): SurfaceWidget {
  return { ...newWidget('button', id, x, y), label: 'Intercom', color: '#30d158', w: 4, h: 7, display: 'intercom', intercomMode: 'full' }
}

/** A button set up as a note window. */
export function newNoteWidget(id: string, x: number, y: number): SurfaceWidget {
  return { ...newWidget('button', id, x, y), label: 'Note', color: '#bf5af2', w: 3, h: 3, display: 'note' }
}

export function newWidget(type: WidgetType, id: string, x: number, y: number): SurfaceWidget {
  if (type === 'knob') return { id, type, label: 'Knob', color: '#ff9f0a', x, y, w: 2, h: 2, actions: [], min: 0, max: 1, value: 0.5, momentary: false, input: null, ...MONITOR_DEFAULTS }
  return type === 'button'
    ? { id, type, label: 'Button', color: '#30d158', x, y, w: 2, h: 2, actions: [], min: 0, max: 1, value: 0, momentary: false, input: null, ...MONITOR_DEFAULTS }
    : { id, type, label: 'Fader', color: '#0a84ff', x, y, w: 1, h: 4, actions: [], min: 0, max: 1, value: 0, momentary: false, input: null, ...MONITOR_DEFAULTS }
}

/** Fill gaps in records saved by older builds; RTDB also drops empty arrays. */
export function normalizeWidget(raw: Partial<SurfaceWidget> & { id: string; type: WidgetType }): SurfaceWidget {
  const base = newWidget(raw.type, raw.id, 0, 0)
  const actions = Object.values(raw.actions ?? {}).map((a) => {
    if (a.kind === 'osc') return { ...a, args: Object.values(a.args ?? {}) }
    // Stage 6 stored { kind: 'show', command: 'pauseToggle' | … }.
    if (a.kind === 'show') return { kind: 'show', action: migrateAction((a as { action?: unknown; command?: unknown }).action ?? (a as { command?: unknown }).command) }
    return a
  }) as SurfaceAction[]
  const display: ButtonDisplay = raw.type === 'button' && (raw.display === 'monitor' || raw.display === 'note' || raw.display === 'stage' || raw.display === 'intercom') ? raw.display : 'action'
  return {
    ...base,
    ...raw,
    actions,
    input: raw.input ?? null,
    display,
    monitorList: raw.monitorList !== false,
    monitorTap: raw.monitorTap === 'go' ? 'go' : 'standby',
    noteSource: raw.noteSource === 'script' || raw.noteSource === 'notion' ? raw.noteSource : 'custom',
    noteNotionUrl: typeof raw.noteNotionUrl === 'string' ? raw.noteNotionUrl : '',
    noteText: typeof raw.noteText === 'string' ? raw.noteText : '',
    noteFont: Math.min(2.4, Math.max(0.6, Number(raw.noteFont) || 1)),
    intercomMode: raw.intercomMode === 'voice' || raw.intercomMode === 'chat' ? raw.intercomMode : 'full',
  }
}

export const defaultAction = (kind: SurfaceAction['kind'], widgetType: WidgetType): SurfaceAction => {
  switch (kind) {
    case 'show':
      return { kind, action: 'go' }
    case 'cue':
      return { kind, cueId: '', command: 'go' }
    case 'master':
      return { kind }
    case 'panel':
      return { kind, panel: 'stage', mode: 'toggle' }
    case 'param':
      return { kind, target: { scope: 'show', param: 'filter' } }
    case 'xfade':
      return { kind }
    case 'hit':
      return { kind, hitId: '', mode: 'level' }
    case 'executor':
      return { kind, exec: 1, command: widgetType === 'button' ? 'go' : 'level' }
    case 'midi':
      return widgetType !== 'button'
        ? { kind, message: 'cc', channel: 1, number: 7, value: 0 }
        : { kind, message: 'noteOn', channel: 1, number: 60, value: 127 }
    case 'osc':
      return {
        kind,
        address: widgetType !== 'button' ? `/${widgetType}/1` : '/qlab/go',
        args: widgetType !== 'button' ? [{ type: 'f', value: '$value' }] : [],
        host: '',
        port: 0,
      }
  }
}
