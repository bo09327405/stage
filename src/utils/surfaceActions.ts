import { refuseIfReadOnly } from '../services/projectLock'
import { midi } from '../services/midi'
import { emitPanel } from '../services/panelBus'
import { oscBridge } from '../services/oscBridge'
import { actionLabel } from '../types/actions'
import type { Cue } from '../types/cue'
import { EXEC_COMMAND_LABELS, PANEL_LABELS, PANEL_MODE_LABELS, type Surface, type SurfaceAction, type SurfaceWidget } from '../types/surface'
import { activeExecutors, type ExecutorControls } from '../components/surface/executors/useExecutors'
import { executeShowAction, type ShowActionContext } from './showActions'
import { SHOW_PARAMS, STUDIO_PARAMS, fromNorm, studioParamPath } from './liveParams'
import { ref, update } from 'firebase/database'
import { db } from '../services/firebase'
import type { Hit } from '../types/cue'

export interface ActionContext extends ShowActionContext {
  surface: Surface
  /** The show project (needed to drive its DAW Studio parameters). */
  projectId?: string
  /** The panel's executors (falls back to the open panel's, for MIDI / OSC input). */
  executors?: ExecutorControls
}

/* Studio parameter writes from knobs / faders: live, merged, ~25 per second, not in the undo history. */
const pendingStudio: Record<string, unknown> = {}
let studioTimer = 0
function writeStudio(path: string, value: number) {
  // A knob riding a Studio parameter edits the studio: not in a read-only project.
  const pid = /^projects\/([^/]+)\//.exec(path)?.[1]
  if (pid && refuseIfReadOnly(pid)) return
  pendingStudio[path] = Math.round(value * 1000) / 1000
  if (studioTimer) return
  studioTimer = window.setTimeout(() => {
    const batch = { ...pendingStudio }
    for (const k of Object.keys(pendingStudio)) delete pendingStudio[k]
    studioTimer = 0
    update(ref(db), batch).catch(ignore)
  }, 40)
}

/** Hit fired by a "trigger" fader, per widget (so it re-arms after dropping back down). */
const hitTriggered = new Map<string, boolean>()

/**
 * When an action fires:
 *   press   — button pressed, or fader grabbed
 *   release — button released (momentary buttons only)
 *   change  — fader moved; `value` is the fader's position in [min, max]
 */
export type ActionPhase = 'press' | 'release' | 'change'

const ignore = () => {}

/** Fader position as 0–1. */
const normalized = (widget: SurfaceWidget, value: number) =>
  widget.max === widget.min ? 0 : (value - widget.min) / (widget.max - widget.min)

function runOne(action: SurfaceAction, widget: SurfaceWidget, phase: ActionPhase, value: number, ctx: ActionContext) {
  const { engine } = ctx
  // Knobs behave like faders: continuous, acting on every move.
  const isFader = widget.type !== 'button'
  // Show and cue commands are one-shot: buttons fire them on press; faders never do.
  const oneShot = !isFader && phase === 'press'

  switch (action.kind) {
    case 'show':
      // Buttons fire show actions on press; faders don't send them.
      if (oneShot) executeShowAction(action.action, ctx)
      return
    case 'cue': {
      if (!oneShot) return
      const cue = ctx.cues.find((c) => c.id === action.cueId)
      if (!cue) return
      if (action.command === 'go') {
        engine.go(cue).catch(ignore)
      } else {
        for (const inst of Object.values(engine.showState.active)) {
          if (inst.cue.id === cue.id && inst.stopAt == null) engine.stopInstance(inst.instanceId).catch(ignore)
        }
      }
      return
    }
    case 'panel':
      // Whichever view owns that window on this page opens / closes it.
      if (oneShot) emitPanel(action.panel, action.mode)
      return
    case 'master': {
      // Moving a Master fader while DIM is on switches DIM off at that level.
      if (isFader && phase === 'change') engine.setMasterVolume(normalized(widget, value) * 100, { undim: engine.showState.dim }).catch(ignore)
      return
    }
    case 'param': {
      if (!isFader || phase !== 'change') return
      const v = fromNorm(action.target, normalized(widget, value))
      const t = action.target
      if (t.scope === 'show') {
        if (t.param === 'master') engine.setMasterVolume(v, { undim: engine.showState.dim }).catch(ignore)
        else engine.setFx({ [t.param]: Math.round(v * 1000) / 1000 })
      } else if (ctx.projectId && t.studioId && t.trackId) {
        writeStudio(`projects/${ctx.projectId}/studio/${t.studioId}/${studioParamPath(t)}`, v)
      }
      return
    }
    case 'xfade': {
      if (!isFader || phase !== 'change') return
      engine.manualXfade(normalized(widget, value)).catch(ignore)
      return
    }
    case 'hit': {
      const hit = ctx.hits.find((h) => h.id === action.hitId)
      if (!hit || !isFader || phase !== 'change') return
      const n = normalized(widget, value)
      if (action.mode === 'level') {
        engine.setHitLevel(hit.id, n)
      } else {
        // Trigger: crossing the middle upward fires the hit, crossing back down stops it.
        const key = `${widget.id}:${hit.id}`
        const on = hitTriggered.get(key) ?? false
        if (!on && n >= 0.5) {
          hitTriggered.set(key, true)
          engine.fireHit(hit).catch(ignore)
        } else if (on && n < 0.45) {
          hitTriggered.set(key, false)
          engine.stopHits(hit.id).catch(ignore)
        }
      }
      return
    }
    case 'executor': {
      const no = action.exec
      if (isFader) {
        if (phase === 'change' && action.command === 'level') engine.setExecLevel(no, normalized(widget, value))
        return
      }
      if (!oneShot) return
      const x = ctx.executors ?? activeExecutors()
      if (!x) return
      const run = { go: x.go, pause: x.pause, back: x.back, off: x.off, level: null }[action.command]
      run?.(no).catch(ignore)
      return
    }
    case 'midi': {
      if (isFader) {
        if (phase !== 'change') return
        const scaled = Math.round(normalized(widget, value) * 127)
        midi.send(action.message, action.channel, action.message === 'program' ? scaled : action.number, scaled)
      } else if (phase === 'press') {
        midi.send(action.message, action.channel, action.number, action.value)
      } else if (phase === 'release') {
        // Momentary release: close the note, or drop the controller back to 0.
        if (action.message === 'noteOn') midi.send('noteOff', action.channel, action.number, 0)
        else if (action.message === 'cc') midi.send('cc', action.channel, action.number, 0)
      }
      return
    }
    case 'osc': {
      if (isFader ? phase !== 'change' : phase === 'change') return
      const host = action.host.trim() || ctx.surface.oscHost.trim()
      const port = action.port || ctx.surface.oscPort
      if (!host || !port) {
        oscBridge.send(host || '（未設定）', port || 0, action.address, [])
        return
      }
      // "$value" → fader position, or 1/0 for a button press/release.
      const live = isFader ? value : phase === 'press' ? 1 : 0
      const args = action.args.map((a) => ({ type: a.type, value: a.value === '$value' ? live : a.value }))
      oscBridge.send(host, port, action.address, args)
      return
    }
  }
}

export function runWidgetActions(widget: SurfaceWidget, phase: ActionPhase, value: number, ctx: ActionContext) {
  // Non-momentary buttons only act on press.
  if (widget.type === 'button' && phase === 'release' && !widget.momentary) return
  for (const action of widget.actions) runOne(action, widget, phase, value, ctx)
}

/** One-line description of an action, for widget faces and the properties list. */
export function describeAction(action: SurfaceAction, cues: Cue[], hits?: Hit[]): string {
  switch (action.kind) {
    case 'show':
      return actionLabel(action.action)
    case 'cue': {
      const cue = cues.find((c) => c.id === action.cueId)
      return `${action.command === 'go' ? 'GO' : 'Stop'} ${cue ? `Q${cue.cueNumber}` : '（未選 Cue）'}`
    }
    case 'master':
      return 'Master'
    case 'param':
      return action.target.scope === 'show' ? SHOW_PARAMS[action.target.param].label : `Studio ${STUDIO_PARAMS[action.target.param].label}`
    case 'xfade':
      return '走 Cue（手動 Crossfade）'
    case 'hit':
      return `Hit「${hits?.find((h) => h.id === action.hitId)?.title ?? '未選'}」${action.mode === 'level' ? '音量' : '觸發'}`
    case 'executor':
      return `Exec ${action.exec} ${EXEC_COMMAND_LABELS[action.command]}`
    case 'panel':
      return `${PANEL_MODE_LABELS[action.mode]} ${PANEL_LABELS[action.panel].replace(/^\S+\s/, '')}`
    case 'midi':
      return `MIDI ${{ noteOn: 'Note', noteOff: 'NoteOff', cc: 'CC', program: 'PC' }[action.message]} ch${action.channel}/${action.number}`
    case 'osc':
      return `OSC ${action.address}`
  }
}
