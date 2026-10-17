import { useCallback, useSyncExternalStore } from 'react'
import { CHANNEL_ALL, channelIds, reachesChannel } from '../types/channels'
import type { Cue } from '../types/cue'

/*
 * Which audience group the operator is looking at (ALL = every group). Shared by the Set Cue console and
 * the control panel — also across browser tabs — so filtering one filters the other.
 */
const KEY = 'theatre.channelView'
const listeners = new Set<() => void>()
const read = () => {
  try {
    return localStorage.getItem(KEY) ?? CHANNEL_ALL
  } catch {
    return CHANNEL_ALL
  }
}
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  window.addEventListener('storage', listener)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', listener)
  }
}

/** [view, setView]; the view falls back to ALL when it isn't one of the show's `count` groups. */
export function useChannelView(count: number): [string, (view: string) => void] {
  const raw = useSyncExternalStore(subscribe, read, () => CHANNEL_ALL)
  const view = count > 0 && channelIds(count).includes(raw) ? raw : CHANNEL_ALL
  const set = useCallback((next: string) => {
    try {
      localStorage.setItem(KEY, next)
    } catch {
      // Not remembered across tabs; this tab still updates below.
    }
    listeners.forEach((l) => l())
  }, [])
  return [view, set]
}

/** The cues a channel view shows: everything for ALL, otherwise the cues that reach that group. */
export const cuesForChannel = (cues: Cue[], view: string, count: number) =>
  count > 0 && view !== CHANNEL_ALL ? cues.filter((c) => reachesChannel(c.targetChannels, view)) : cues
