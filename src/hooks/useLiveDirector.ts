import { get, onValue, ref, remove, runTransaction } from 'firebase/database'
import { useEffect, useRef } from 'react'
import { db } from '../services/firebase'
import { liveNode, setLiveStatus, type LiveOperator, type LiveStatus } from '../services/liveCamera'
import type { PresenceEntry } from '../services/presence'
import { activeStartAt, cueTargets, type ActiveCue } from '../types/cue'

/**
 * Console side of the audience live camera: for every running AUDIENCE_LIVE cue, name the phone that films
 * (by the cue's operator mode) and replace it when it refuses the camera or drops. Only the trigger host runs this,
 * so two console tabs never elect two cameras. Cleans a cue's signaling up once it stops.
 */
export function useLiveDirector({
  basePath,
  instances,
  presence,
  now,
  enabled,
}: {
  basePath: string
  instances: ActiveCue[]
  presence: PresenceEntry[]
  /** Show clock, ms. */
  now: number
  enabled: boolean
}) {
  // Phones already tried (and failed) per cue instance, so a replacement is always a new one.
  const tried = useRef(new Map<string, Set<string>>())
  const known = useRef(new Set<string>())
  const state = useRef(new Map<string, { operator: LiveOperator | null; status: LiveStatus | null }>())
  const latest = useRef({ instances, presence, now })
  latest.current = { instances, presence, now }

  const running = instances.filter((i) => i.cue.type === 'AUDIENCE_LIVE' && i.stopAt == null)
  const runningKey = running.map((i) => i.instanceId).join(',')
  // Which running cues are past their Pre-Wait.
  const startedKey = running.map((i) => (now >= activeStartAt(i) ? 1 : 0)).join('')

  const elect = (inst: ActiveCue) => {
    const { presence: here } = latest.current
    const node = liveNode(basePath, inst.instanceId)
    const done = tried.current.get(inst.instanceId) ?? new Set<string>()
    tried.current.set(inst.instanceId, done)
    const cue = inst.cue
    const pool = here.filter((p) => cueTargets(cue, p.audienceId, p.channel ?? null) && !done.has(p.audienceId))
    let pick: PresenceEntry | undefined
    if (cue.liveOperatorMode === 'specific') {
      const want = cue.liveOperatorId.trim().toUpperCase()
      pick = pool.find((p) => p.audienceId.toUpperCase() === want)
    } else if (cue.liveOperatorMode === 'random') {
      pick = pool[Math.floor(Math.random() * pool.length)]
    } else {
      pick = [...pool].sort((a, b) => a.joinedAt - b.joinedAt)[0]
    }
    if (!pick) {
      void setLiveStatus(node, { state: 'failed', msg: '找不到可用的直播攝影機' })
      return
    }
    done.add(pick.audienceId)
    // Transaction so a late second election can't override one that already landed.
    const current = state.current.get(inst.instanceId)
    void runTransaction(ref(db, `${node}/operator`), (cur) => {
      const op = cur as LiveOperator | null
      if (op && op.audienceId !== current?.operator?.audienceId) return op
      return { audienceId: pick.audienceId, at: Date.now() } satisfies LiveOperator
    }).then(() => setLiveStatus(node, { state: 'waiting' }))
  }

  // Follow the operator / status of each running cue; elect when there is none, replace when it fails.
  useEffect(() => {
    if (!enabled) return
    const unsubs: (() => void)[] = []
    for (const inst of latest.current.instances.filter((i) => runningKey.split(',').includes(i.instanceId))) {
      const node = liveNode(basePath, inst.instanceId)
      state.current.set(inst.instanceId, { operator: null, status: null })
      known.current.add(inst.instanceId)
      const update = (patch: Partial<{ operator: LiveOperator | null; status: LiveStatus | null }>) => {
        const next = { ...state.current.get(inst.instanceId)!, ...patch }
        state.current.set(inst.instanceId, next)
        return next
      }
      unsubs.push(
        onValue(ref(db, `${node}/operator`), (s) => {
          const next = update({ operator: (s.val() as LiveOperator | null) ?? null })
          if (!next.operator && latest.current.now >= activeStartAt(inst)) elect(inst)
        }),
        onValue(ref(db, `${node}/status`), (s) => {
          const next = update({ status: (s.val() as LiveStatus | null) ?? null })
          // The camera phone refused or dropped: hand over to the next one (a fixed phone has no stand-in).
          if (next.operator && (next.status?.state === 'denied' || next.status?.state === 'failed') && inst.cue.liveOperatorMode !== 'specific') {
            remove(ref(db, `${node}/operator`)).catch(() => {})
          }
        }),
      )
    }
    return () => unsubs.forEach((u) => u())
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-subscribe only when the set of running cues changes
  }, [basePath, enabled, runningKey])

  // A cue whose Pre-Wait just ended with no camera named yet gets one.
  useEffect(() => {
    if (!enabled) return
    for (const inst of running) {
      if (now < activeStartAt(inst)) continue
      const s = state.current.get(inst.instanceId)
      if (s && !s.operator && s.status?.state !== 'failed') get(ref(db, `${liveNode(basePath, inst.instanceId)}/operator`)).then((snap) => !snap.exists() && elect(inst)).catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, startedKey, presence.length])

  // The camera phone vanished from the presence list for good: replace it.
  useEffect(() => {
    if (!enabled) return
    for (const inst of running) {
      const op = state.current.get(inst.instanceId)?.operator
      if (!op || presence.some((p) => p.audienceId === op.audienceId)) continue
      const timer = window.setTimeout(() => {
        const still = state.current.get(inst.instanceId)?.operator
        if (still?.audienceId !== op.audienceId || latest.current.presence.some((p) => p.audienceId === op.audienceId)) return
        void setLiveStatus(liveNode(basePath, inst.instanceId), { state: 'failed', msg: '攝影機手機離線' })
      }, 6000)
      return () => window.clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, presence, runningKey])

  // Clear a cue's signaling once it has been stopped or removed.
  useEffect(() => {
    if (!enabled) return
    const alive = new Set(running.map((i) => i.instanceId))
    for (const id of [...known.current]) {
      if (alive.has(id)) continue
      known.current.delete(id)
      state.current.delete(id)
      tried.current.delete(id)
      remove(ref(db, liveNode(basePath, id))).catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, basePath, runningKey])
}
