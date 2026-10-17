import { useEffect, useId, useSyncExternalStore } from 'react'
import { readDimDb, writeDimDb } from '../utils/dim'

/*
 * Shared state of every Stage viewer on this page (the Stage window and Stage buttons on the
 * control panel). There is one audio engine and one engine-owned <video> per page, so:
 *  - sound on/off and the simulated audience code are shared by all viewers;
 *  - only one viewer at a time mounts the engine's live (audible) video — the Stage window if it
 *    is open, otherwise the first Stage button. The others show a muted copy;
 *  - the headphone DIM (this operator's monitoring only, never the audience) and its amount.
 */

interface Viewer {
  id: string
  priority: number
  order: number
}
interface State {
  sound: boolean
  /** Headphone DIM on this page, and its amount in dB (remembered on this device). */
  dim: boolean
  dimDb: number
  audience: string
  /** Simulated audience group (channel_n); '' = not grouped (hears every cue). */
  channel: string
  viewers: Viewer[]
}

const SOUND_KEY = 'theatre.stageSound'
const readSound = () => {
  try {
    return localStorage.getItem(SOUND_KEY) !== '0'
  } catch {
    return true
  }
}

const DIM_KEY = 'theatre.stageDim'
const readDim = () => {
  try {
    return localStorage.getItem(DIM_KEY) === '1'
  } catch {
    return false
  }
}

let state: State = { sound: readSound(), dim: readDim(), dimDb: readDimDb('monitor'), audience: '', channel: '', viewers: [] }
let order = 0
const listeners = new Set<() => void>()
const set = (next: Partial<State>) => {
  state = { ...state, ...next }
  listeners.forEach((l) => l())
}

export const stageMonitor = {
  get: () => state,
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  setSound(sound: boolean) {
    try {
      localStorage.setItem(SOUND_KEY, sound ? '1' : '0')
    } catch {
      // Not remembered; harmless.
    }
    set({ sound })
  },
  setAudience(audience: string) {
    set({ audience })
  },
  setChannel(channel: string) {
    set({ channel })
  },
  setDim(dim: boolean) {
    try {
      localStorage.setItem(DIM_KEY, dim ? '1' : '0')
    } catch {
      // Not remembered; harmless.
    }
    set({ dim })
  },
  setDimDb(dimDb: number) {
    writeDimDb('monitor', dimDb)
    set({ dimDb: readDimDb('monitor') })
  },
}

export function useStageMonitor() {
  return useSyncExternalStore(stageMonitor.subscribe, stageMonitor.get)
}

/** Register a viewer; true while it is the one that shows the engine's live video. */
export function useVideoOwner(priority: number): boolean {
  const id = useId()
  useEffect(() => {
    set({ viewers: [...state.viewers.filter((v) => v.id !== id), { id, priority, order: order++ }] })
    return () => set({ viewers: state.viewers.filter((v) => v.id !== id) })
  }, [id, priority])
  const { viewers } = useStageMonitor()
  const owner = [...viewers].sort((a, b) => b.priority - a.priority || a.order - b.order)[0]
  return owner?.id === id
}
