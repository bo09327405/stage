import { useEffect, useRef, useState } from 'react'
import { inputBus } from '../services/inputBus'
import { midi } from '../services/midi'
import { oscBridge } from '../services/oscBridge'
import { saveFaderValue, useSurfaces } from '../services/surfaces'
import { useGlobalTriggers, useLocalLeader, useTriggerHost } from '../services/triggers'
import { actionLabel } from '../types/actions'
import type { Cue, Hit } from '../types/cue'
import type { ShowRef } from '../types/project'
import { describeEvent, describeMatch, midiAddress, type InputEvent } from '../types/trigger'
import { explainShowAction, executeShowAction } from '../utils/showActions'
import { runWidgetActions } from '../utils/surfaceActions'
import { explainMatch } from '../utils/triggerMatch'
import type { useTheatreEngine } from './useTheatreEngine'

type Engine = ReturnType<typeof useTheatreEngine>

const ccKey = (channel: number, number: number) => `${Number(channel)}:${Number(number)}`
const DISPATCH_HISTORY = 12

/** What happened to one incoming signal — shown in the Triggers panel and logged to the console. */
export interface DispatchRecord {
  at: number
  source: InputEvent['source']
  event: string
  /** False when another tab/computer is responsible for acting on it. */
  executed: boolean
  /** Why it wasn't executed here. */
  skipped?: string
  /** Actions that ran, each with an optional caveat ("only selected Q1", "paused"…). */
  fired: { text: string; note?: string }[]
  /** Rules of the same kind that didn't match, with the reason. */
  misses: string[]
}

/** One collapsible console group per incoming signal (DevTools → Console). */
function logDispatch(record: DispatchRecord) {
  const head = `[Trigger] ${record.event} → ${
    !record.executed ? '略過' : record.fired.length > 0 ? `觸發 ${record.fired.length} 個動作` : '沒有符合的規則'
  }`
  console.groupCollapsed(head)
  if (record.skipped) console.log('略過原因：', record.skipped)
  for (const f of record.fired) console.log('✓', f.text, f.note ? `（${f.note}）` : '')
  for (const m of record.misses) console.log('✕', m)
  console.groupEnd()
}

/**
 * Listens to incoming OSC/MIDI and runs, on the tab responsible for it:
 *   1. the project's Global Profile (signal → standard show action),
 *   2. cue-level triggers (signal → GO that cue),
 *   3. control-surface inputs (signal → press a button / move a fader).
 *
 * Who acts: OSC reaches every page through the bridge, so only the trigger host acts on it. MIDI
 * only reaches the computer the controller is plugged into, so it is handled by the host if the
 * host is on this computer, otherwise by the leading tab on this computer.
 */
export function useTriggerRouter({
  show,
  basePath,
  label,
  engine,
  cues,
  hits,
}: {
  show: ShowRef
  basePath: string
  /** How this tab is named in the host indicator, e.g. "控台" or "控制面板 · 音效組". */
  label: string
  engine: Engine
  cues: Cue[]
  hits: Hit[]
}) {
  const globalTriggers = useGlobalTriggers(show.projectId)
  const { surfaces } = useSurfaces(show.projectId)
  const hostState = useTriggerHost(basePath, label)
  const localLeader = useLocalLeader(`theatre-midi:${basePath}`)
  const [dispatches, setDispatches] = useState<DispatchRecord[]>([])

  // Bring up whichever inputs the configured triggers need.
  const cueTriggerSources = cues.flatMap((c) => c.triggers.filter((t) => t.enabled).map((t) => t.match.source))
  const widgetSources = (surfaces ?? []).flatMap((s) => Object.values(s.widgets).flatMap((w) => (w.input ? [w.input.source] : [])))
  const sources = new Set([...globalTriggers.filter((t) => t.enabled).map((t) => t.match.source), ...cueTriggerSources, ...widgetSources])
  const needsOsc = sources.has('osc')
  const needsMidi = sources.has('midi')
  useEffect(() => {
    if (needsOsc) oscBridge.connect()
  }, [needsOsc])
  useEffect(() => {
    if (needsMidi) midi.connect()
  }, [needsMidi])

  // Latest values for the long-lived bus subscription.
  const latest = useRef({ engine, cues, hits, globalTriggers, surfaces, hostState, localLeader })
  useEffect(() => {
    latest.current = { engine, cues, hits, globalTriggers, surfaces, hostState, localLeader }
  })
  const ccState = useRef(new Map<string, number>())
  const faderSaveTimers = useRef(new Map<string, number>())

  useEffect(() => {
    const finish = (record: DispatchRecord) => {
      logDispatch(record)
      setDispatches((list) => [record, ...list].slice(0, DISPATCH_HISTORY))
    }
    return inputBus.subscribe((event) => {
        const { engine, cues, hits, globalTriggers, surfaces, hostState, localLeader } = latest.current
        const key = event.source === 'midi' ? ccKey(event.channel, event.number) : ''
        const previousCc = event.source === 'midi' && event.message === 'cc' ? ccState.current.get(key) : undefined
        if (event.source === 'midi' && event.message === 'cc') ccState.current.set(key, Number(event.value))

        const record: DispatchRecord = { at: Date.now(), source: event.source, event: describeEvent(event), executed: false, fired: [], misses: [] }
        const responsible =
          hostState.isHost || (event.source === 'midi' && !hostState.hostOnThisMachine && localLeader)

        if (!responsible) {
          record.skipped =
            event.source === 'midi'
              ? `觸發主機「${hostState.host?.label ?? '—'}」在這台電腦的另一個分頁，由它執行`
              : `由觸發主機「${hostState.host?.label ?? '—'}」執行（OSC 只由主機處理，避免重複）`
          finish(record)
          return
        }
        record.executed = true
        const ctx = { engine, cues, hits }

        // 1. Global Profile
        for (const t of globalTriggers) {
          if (!t.enabled || t.match.source !== event.source) continue
          const why = explainMatch(t.match, event, previousCc)
          if (why) {
            record.misses.push(`${describeMatch(t.match)} → ${actionLabel(t.action)}：${why}`)
            continue
          }
          if (t.action === 'none') continue
          const note = explainShowAction(t.action, ctx) ?? undefined
          executeShowAction(t.action, ctx)
          record.fired.push({ text: `${describeMatch(t.match)} → ${actionLabel(t.action)}`, note })
        }

        // 2. Cue-level triggers
        for (const cue of cues) {
          const enabled = cue.triggers.filter((t) => t.enabled && t.match.source === event.source)
          if (enabled.length === 0) continue
          const reasons = enabled.map((t) => explainMatch(t.match, event, previousCc))
          if (reasons.some((r) => r === null)) {
            const note =
              engine.playbackState === 'paused'
                ? '演出暫停中，GO 被忽略'
                : engine.serverNow() < engine.showState.goLockedUntil
                  ? 'GO 鎖定中（Prevent GO）'
                  : undefined
            engine.go(cue).catch(() => {})
            record.fired.push({ text: `Cue 觸發 → GO Q${cue.cueNumber} ${cue.title}`, note })
          } else {
            record.misses.push(`Q${cue.cueNumber} ${cue.title}：${reasons[0]}`)
          }
        }

        // 3. Control-surface inputs
        for (const surface of surfaces ?? []) {
          for (const widget of Object.values(surface.widgets)) {
            const input = widget.input
            // A button shown as a Cue Monitor or note has no actions of its own.
            if (!input || input.source !== event.source || widget.display !== 'action') continue
            const actionCtx = { ...ctx, surface, projectId: show.projectId }
            if (widget.type !== 'button') {
              // Faders and knobs follow the controller continuously instead of edge-triggering.
              let position: number | null = null
              if (input.source === 'midi' && event.source === 'midi' && event.message === 'cc') {
                const { channel, number } = midiAddress(input)
                if (Number(event.number) === number && (channel === 0 || Number(event.channel) === channel)) position = Number(event.value) / 127
              } else if (input.source === 'osc' && event.source === 'osc' && event.address === input.address) {
                const n = Number(event.args[0]?.value)
                if (Number.isFinite(n)) position = Math.min(1, Math.max(0, n))
              }
              if (position == null) continue
              const value = widget.min + position * (widget.max - widget.min)
              runWidgetActions(widget, 'change', value, actionCtx)
              record.fired.push({ text: `${widget.type === 'knob' ? '旋鈕' : '推桿'}「${widget.label}」→ ${value.toFixed(2)}` })
              // Persist the position once the controller settles.
              clearTimeout(faderSaveTimers.current.get(widget.id))
              faderSaveTimers.current.set(
                widget.id,
                window.setTimeout(() => saveFaderValue(show.projectId, surface.id, widget.id, value).catch(() => {}), 300),
              )
            } else {
              const why = explainMatch(input, event, previousCc)
              if (why) record.misses.push(`按鈕「${widget.label}」：${why}`)
              else {
                runWidgetActions(widget, 'press', 1, actionCtx)
                record.fired.push({ text: `按下「${widget.label}」` })
              }
            }
          }
        }

        finish(record)
    })
  }, [show.projectId])

  const lastFired = dispatches.find((d) => d.fired.length > 0)
  return {
    ...hostState,
    localLeader,
    globalTriggers,
    dispatches,
    lastFired: lastFired ? { text: lastFired.fired.map((f) => f.text).join('、'), at: lastFired.at } : null,
  }
}
