import { useCallback, useEffect, useRef } from 'react'
import type { useTheatreEngine } from '../../../hooks/useTheatreEngine'
import type { Cue, Hit } from '../../../types/cue'
import { autoFireAt, cueAfter, cueBefore, executorShowCue, orderedCues, type SeqCue, type Sequence } from '../../../types/sequence'
import type { Surface } from '../../../types/surface'
import { executeShowAction } from '../../../utils/showActions'

type Engine = ReturnType<typeof useTheatreEngine>

/**
 * Executor playback for a control panel: GO / GO− / GOTO / PAUSE / OFF, and the automatic
 * Follow / Time triggers. Mounted while the panel is open (whether or not the Executor view is
 * showing), so sequences keep running. Every fire is a claim on the executor's current step (see
 * engine.execFire), so several open consoles never fire a step twice.
 */
export type ExecutorControls = ReturnType<typeof useExecutors>

/** The open control panel's executors, for MIDI / OSC-triggered surface buttons (useTriggerRouter). */
let current: ExecutorControls | null = null
export const activeExecutors = () => current

export function useExecutors({ engine, surface, cues, hits }: { engine: Engine; surface: Surface | null; cues: Cue[]; hits: Hit[] }) {
  const ctx = useRef({ engine, surface, cues, hits })
  useEffect(() => {
    ctx.current = { engine, surface, cues, hits }
  })

  const seqOf = useCallback((execNo: number): Sequence | null => {
    const s = ctx.current.surface
    const id = s?.executors[String(execNo)]?.sequenceId
    return (id && s?.sequences[id]) || null
  }, [])

  /** Fire `step` on `execNo` if the executor is still where we saw it. */
  const fire = useCallback(async (execNo: number, step: SeqCue) => {
    const { engine, cues, hits } = ctx.current
    const seq = seqOf(execNo)
    if (!seq) throw new Error(`Executor ${execNo} 沒有載入序列`)
    const run = engine.showState.executors[String(execNo)]
    const expect = { cueId: run?.cueId ?? null, instanceId: run?.instanceId ?? null }
    const ok = await engine.execFire(execNo, seq.id, step, executorShowCue(execNo, step, cues), expect)
    // A command step runs its show action (after its Delay) on the console that fired it.
    if (ok && step.source.kind === 'action') {
      const action = step.source.action
      const go = () => executeShowAction(action, { engine: ctx.current.engine, cues: ctx.current.cues, hits })
      if (step.delay > 0) window.setTimeout(go, step.delay * 1000)
      else go()
    }
    return ok
  }, [seqOf])

  const go = useCallback(
    (execNo: number) => {
      const { engine } = ctx.current
      const seq = seqOf(execNo)
      if (!seq) return Promise.reject(new Error(`Executor ${execNo} 沒有載入序列`))
      const run = engine.showState.executors[String(execNo)]
      // GO on a paused executor continues it.
      const inst = run?.instanceId ? engine.showState.active[run.instanceId] : null
      if (inst && inst.pausedAt != null && inst.stopAt == null) return engine.execPause(execNo)
      const next = cueAfter(seq, run?.sequenceId === seq.id ? run.cueId : null)
      if (!next) return Promise.reject(new Error(`「${seq.name}」還沒有 Cue`))
      return fire(execNo, next)
    },
    [fire, seqOf],
  )

  const back = useCallback(
    (execNo: number) => {
      const seq = seqOf(execNo)
      if (!seq) return Promise.reject(new Error(`Executor ${execNo} 沒有載入序列`))
      const run = ctx.current.engine.showState.executors[String(execNo)]
      const prev = cueBefore(seq, run?.sequenceId === seq.id ? run.cueId : null)
      return prev ? fire(execNo, prev) : Promise.resolve(false)
    },
    [fire, seqOf],
  )

  const gotoCue = useCallback((execNo: number, step: SeqCue) => fire(execNo, step), [fire])
  const pause = useCallback((execNo: number) => ctx.current.engine.execPause(execNo), [])
  const off = useCallback((execNo: number) => ctx.current.engine.execOff(execNo), [])

  // Follow / Time: schedule the next step of every running executor.
  const { showState, serverNow } = engine
  const sequences = surface?.sequences
  const slots = surface?.executors
  useEffect(() => {
    if (showState.pausedAt != null) return
    const timers: number[] = []
    for (const [no, run] of Object.entries(showState.executors)) {
      const seq = slots?.[no]?.sequenceId === run.sequenceId ? sequences?.[run.sequenceId] : null
      if (!seq || !run.cueId) continue
      const list = orderedCues(seq)
      const i = list.findIndex((c) => c.id === run.cueId)
      // Automatic triggers run to the end of the sequence; wrapping around takes a GO.
      const current = list[i]
      const next = list[i + 1]
      if (!current || !next) continue
      const inst = run.instanceId ? showState.active[run.instanceId] : null
      if (inst && (inst.pausedAt != null || inst.stopAt != null)) continue
      // The sound's own start time moves with pauses; command steps use the executor's.
      const at = autoFireAt(next, current, inst?.firedAt ?? run.firedAt)
      if (at == null) continue
      timers.push(window.setTimeout(() => void fire(Number(no), next).catch(() => {}), Math.max(0, at - serverNow())))
    }
    return () => timers.forEach(clearTimeout)
  }, [showState.executors, showState.active, showState.pausedAt, sequences, slots, serverNow, fire])

  const controls = { go, back, gotoCue, pause, off, fire }
  useEffect(() => {
    current = controls
    return () => {
      if (current === controls) current = null
    }
  })
  return controls
}
