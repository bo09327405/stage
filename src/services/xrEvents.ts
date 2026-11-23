/*
 * "Execute the next cue" from inside an XR scene: an audience device (not signed in) may not touch the show,
 * so it leaves a request at {version}/xrEvents/{cue instance}/{interaction id}; an open console checks that the
 * running cue really has that interaction and presses GO once (the first request wins, later ones are ignored).
 */
import { onValue, ref, remove, runTransaction, serverTimestamp, set } from 'firebase/database'
import { useEffect, useRef } from 'react'
import type { ShowState } from '../types/cue'
import { db } from './firebase'

const eventsPath = (basePath: string) => `${basePath}/xrEvents`

/** Audience side: ask for the next cue. Only the first request for an interaction is stored (database rule). */
export function requestNextCue(basePath: string, instanceId: string, interactionId: string, audienceId: string) {
  return set(ref(db, `${eventsPath(basePath)}/${instanceId}/${interactionId}`), { aid: audienceId, at: serverTimestamp() }).catch(() => {
    // Somebody else was first (or the cue is over): nothing to do.
  })
}

/**
 * Console side. Any open console may run this: the claim is a first-writer-wins transaction, so two tabs never
 * fire twice. A request only counts while its cue is the latest GO and still running — a stale tap can't
 * advance a show that has already moved on.
 */
export function useXrDirector({ basePath, showState, go, enabled }: { basePath: string; showState: ShowState; go: () => void; enabled: boolean }) {
  const latest = useRef({ showState, go })
  useEffect(() => {
    latest.current = { showState, go }
  })
  useEffect(() => {
    if (!enabled) return
    const handled = new Set<string>()
    return onValue(
      ref(db, eventsPath(basePath)),
      (snapshot) => {
        const all = (snapshot.val() ?? {}) as Record<string, Record<string, { claimed?: boolean }>>
        const { showState: state } = latest.current
        for (const [instanceId, events] of Object.entries(all)) {
          const inst = state.active[instanceId]
          if (!inst) {
            // The cue is gone: its requests are of no use any more.
            void remove(ref(db, `${eventsPath(basePath)}/${instanceId}`)).catch(() => {})
            continue
          }
          if (inst.stopAt != null || state.lastGo?.instanceId !== instanceId || state.pausedAt != null) continue
          const allowed = new Set((inst.cue.xr?.objects ?? []).flatMap((o) => o.interactions.filter((i) => i.action === 'next_cue').map((i) => i.id)))
          for (const [interactionId, event] of Object.entries(events ?? {})) {
            const key = `${instanceId}:${interactionId}`
            if (!allowed.has(interactionId) || event?.claimed || handled.has(key)) continue
            handled.add(key)
            void runTransaction(ref(db, `${eventsPath(basePath)}/${instanceId}/${interactionId}/claimed`), (current) => (current ? undefined : true)).then(
              (result) => result.committed && latest.current.go(),
              () => {},
            )
          }
        }
      },
      () => {},
    )
  }, [basePath, enabled])
}
