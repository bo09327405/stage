import { useMemo } from 'react'
import { activeList, instanceClock, showClock, type ActiveCue, type Cue } from '../types/cue'
import { instanceTiming, type InstanceTiming } from '../utils/cueTiming'
import { useServerNow } from './useServerNow'
import type { useTheatreEngine } from './useTheatreEngine'

export interface TileState {
  inst: ActiveCue | null
  timing: InstanceTiming | null
  isStandby: boolean
  paused: boolean
}

/**
 * Live view of the show for monitors: what is running (newest last), what is on standby, and a
 * per-cue status. Shared by the Cue Monitor panel and Cue Monitor buttons on a surface.
 */
export function useCueMonitorState(engine: ReturnType<typeof useTheatreEngine>) {
  const { showState, playbackState, serverNow } = engine
  const instances = useMemo(() => activeList(showState), [showState])
  const liveNow = useServerNow(serverNow, playbackState === 'playing')
  const now = showClock(showState, liveNow)

  // Latest running instance per cue.
  const running = useMemo(() => {
    const map = new Map<string, ActiveCue>()
    for (const inst of instances) if (inst.stopAt == null || !map.has(inst.cue.id)) map.set(inst.cue.id, inst)
    return map
  }, [instances])
  const newest = instances.filter((i) => i.stopAt == null).at(-1) ?? null
  const standby = showState.standbyCue ?? null
  const isPaused = (inst: ActiveCue) => playbackState === 'paused' || inst.pausedAt != null
  const timingOf = (inst: ActiveCue) => instanceTiming(inst, instanceClock(inst, now))

  const tileState = (cue: Cue): TileState => {
    const inst = running.get(cue.id) ?? null
    return {
      inst,
      timing: inst ? timingOf(inst) : null,
      isStandby: cue.id === standby?.id,
      paused: !!inst && isPaused(inst),
    }
  }

  return { instances, running, newest, standby, now, playbackState, tileState, timingOf, isPaused }
}
