import { useSyncExternalStore } from 'react'
import type { InputEvent } from '../types/trigger'

/**
 * Hub for incoming external signals. The OSC bridge client and the MIDI service publish here;
 * the trigger router and the "Learn" buttons listen.
 */

type Listener = (event: InputEvent) => void

const listeners = new Set<Listener>()
const storeListeners = new Set<() => void>()
let recent: InputEvent[] = []
let learner: ((event: InputEvent) => void) | null = null
let learning = false

function notifyStore() {
  storeListeners.forEach((l) => l())
}

export const inputBus = {
  emit(event: InputEvent) {
    recent = [event, ...recent].slice(0, 20)
    notifyStore()
    // While learning, the next signal is captured for the editor instead of firing triggers.
    if (learner) {
      const capture = learner
      learner = null
      learning = false
      notifyStore()
      capture(event)
      return
    }
    listeners.forEach((l) => l(event))
  },

  subscribe(listener: Listener) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },

  /** Capture the next incoming signal (for a "Learn" button). Returns a cancel function. */
  learn(onEvent: (event: InputEvent) => void) {
    learner = onEvent
    learning = true
    notifyStore()
    return () => {
      if (learner === onEvent) {
        learner = null
        learning = false
        notifyStore()
      }
    }
  },
}

const subscribeStore = (l: () => void) => {
  storeListeners.add(l)
  return () => {
    storeListeners.delete(l)
  }
}

/** Recent incoming signals (newest first) and whether a Learn is waiting, for monitors. */
export function useInputMonitor() {
  const events = useSyncExternalStore(subscribeStore, () => recent)
  const isLearning = useSyncExternalStore(subscribeStore, () => learning)
  return { events, isLearning }
}
