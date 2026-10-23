import { increment, onValue, push, ref, runTransaction, serverTimestamp, set, update } from 'firebase/database'
import { useCallback, useEffect, useRef, useState } from 'react'
import { db } from '../services/firebase'
import { clampDimDb } from '../utils/dim'
import { planVibrationPush } from '../services/vibrationPush'
import { normalizeChannels, type Announcement, type ChannelConfig } from '../types/channels'
import type { ExecutorRun, SeqCue } from '../types/sequence'
import { normalizeMix, type VjMix } from '../types/vj'
import {
  DEFAULT_SHOW_FX,
  INITIAL_SHOW_STATE,
  playbackState as derivePlaybackState,
  activeEndAt,
  activeFollowAt,
  isVisualCue,
  normalizeCue,
  type ActiveCue,
  type Cue,
  type Hit,
  type ShowFx,
  type ShowState,
} from '../types/cue'

export type EngineRole = 'console' | 'audience'

type RawActive = Omit<ActiveCue, 'cue'> & { cue: Parameters<typeof normalizeCue>[0] }

// RTDB drops null fields and empty objects, so snapshots can be partial; fill gaps from the defaults.
function normalizeShowState(raw: Record<string, unknown> | null): ShowState {
  const state = { ...INITIAL_SHOW_STATE, ...raw } as Omit<ShowState, 'xfade'> & { active?: Record<string, RawActive>; xfade?: { from?: Record<string, string>; to?: string; pos?: number } | null }
  const active: Record<string, ActiveCue> = {}
  for (const [id, inst] of Object.entries(state.active ?? {})) {
    if (!inst?.cue) continue
    active[id] = {
      instanceId: id,
      firedAt: inst.firedAt,
      stopAt: inst.stopAt ?? null,
      stopFade: inst.stopFade ?? null,
      followed: inst.followed ?? false,
      pausedAt: inst.pausedAt ?? null,
      cue: normalizeCue(inst.cue),
    }
  }
  return {
    active,
    pausedAt: state.pausedAt ?? null,
    standbyCue: state.standbyCue ? normalizeCue(state.standbyCue) : null,
    masterVolume: state.masterVolume,
    dim: state.dim,
    ...(state.dimDb != null ? { dimDb: state.dimDb } : {}),
    goLockedUntil: state.goLockedUntil,
    hit: state.hit,
    hitStop: state.hitStop ?? null,
    hitsPage: state.hitsPage ?? 0,
    muted: state.muted ?? false,
    lastGo: state.lastGo ?? null,
    sequence: state.sequence,
    fx: { ...DEFAULT_SHOW_FX, ...(state.fx ?? {}) },
    xfade: state.xfade?.to ? { from: Object.values(state.xfade.from ?? {}), to: state.xfade.to, pos: Number(state.xfade.pos) || 0 } : null,
    hitLevels: state.hitLevels ?? {},
    executors: Object.fromEntries(
      Object.entries((state.executors ?? {}) as Record<string, Partial<ExecutorRun>>)
        .filter(([, e]) => e && typeof e.sequenceId === 'string')
        .map(([no, e]) => [no, { sequenceId: e.sequenceId!, cueId: e.cueId ?? null, instanceId: e.instanceId ?? null, firedAt: Number(e.firedAt) || 0 }]),
    ),
    execLevels: state.execLevels ?? {},
    channels: normalizeChannels(state.channels),
    announce: state.announce?.id ? state.announce : null,
    vj: normalizeMix(state.vj),
  }
}

/** Whether firing `next` should retire the older visual cue `prev` (same audience, or a superset). */
function visualCovers(next: Cue, prev: Cue): boolean {
  if (next.targetMode === 'all') return true
  return prev.targetMode === 'selected' && prev.targetIds.every((id) => next.targetIds.includes(id))
}

/** A follow action is cancelled when the instance was stopped before it was due. */
function followDue(inst: ActiveCue): number | null {
  const at = activeFollowAt(inst)
  if (at == null || inst.followed) return null
  if (inst.stopAt != null && inst.stopAt < at) return null
  return at
}

interface EngineOptions {
  /** Version root, e.g. projects/{pid}/versions/{vid}; showState lives underneath. */
  basePath: string
  /** Console only: the cue list, used to find the next cue for follows and standby advance. */
  cues?: Cue[]
}

export function useTheatreEngine(role: EngineRole, { basePath, cues = [] }: EngineOptions) {
  const statePath = `${basePath}/showState`
  const [showState, setShowState] = useState<ShowState>(INITIAL_SHOW_STATE)
  const [loaded, setLoaded] = useState(false)
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const serverOffsetRef = useRef(0)
  // Latest values for callbacks fired from timers and transactions.
  const stateRef = useRef(showState)
  const cuesRef = useRef(cues)
  useEffect(() => {
    stateRef.current = showState
    cuesRef.current = cues
  })

  useEffect(() => {
    const unsubState = onValue(
      ref(db, statePath),
      (snapshot) => {
        const next = normalizeShowState(snapshot.val())
        stateRef.current = next
        setShowState(next)
        setLoaded(true)
        setError(null)
      },
      (err) => setError(err),
    )
    const unsubConnected = onValue(ref(db, '.info/connected'), (snapshot) => {
      setConnected(snapshot.val() === true)
    })
    const unsubOffset = onValue(ref(db, '.info/serverTimeOffset'), (snapshot) => {
      serverOffsetRef.current = snapshot.val() ?? 0
    })
    return () => {
      unsubState()
      unsubConnected()
      unsubOffset()
    }
  }, [statePath])

  /** Current time on the Firebase server clock, shared by every device. */
  const serverNow = useCallback(() => Date.now() + serverOffsetRef.current, [])

  const assertConsole = useCallback(
    (action: string) => {
      if (role !== 'console') {
        throw new Error(`useTheatreEngine: "${action}" is only available to the console role`)
      }
    },
    [role],
  )

  const run = useCallback(async <T,>(write: Promise<T>) => {
    try {
      return await write
    } catch (err) {
      setError(err as Error)
      throw err
    }
  }, [])

  const cueAfter = useCallback((cueId: string): Cue | null => {
    const list = cuesRef.current
    const index = list.findIndex((c) => c.id === cueId)
    return index >= 0 ? (list[index + 1] ?? null) : null
  }, [])

  /** Arm a cue for the next GO (null clears standby). */
  const standby = useCallback(
    (cue: Cue | null) => {
      assertConsole('standby')
      return run(update(ref(db, statePath), { standbyCue: cue }))
    },
    [assertConsole, run, statePath],
  )

  /**
   * `at` (server ms) pins the start time for scheduled follows: the instance keeps its exact
   * timeline even though the write lands after a transaction round trip, and every device
   * computes playback from firedAt.
   */
  const fire = useCallback(
    (cue: Cue, next: Cue | null, at?: number) => {
      const instanceId = push(ref(db, `${statePath}/active`)).key!
      // Phones with the app in the background get vibration cues / Pre-Wait reminders as Web Push.
      const projectId = /^projects\/([^/]+)\//.exec(statePath)?.[1]
      if (role === 'console' && projectId && (cue.type === 'VIBRATION' || (cue.preWaitVibrate && cue.preWaitTime > 0))) {
        planVibrationPush(projectId, cue, at ?? serverNow(), serverNow, () => {
          const now = stateRef.current.active[instanceId]
          return !!now && now.stopAt == null && stateRef.current.pausedAt == null
        })
      }
      const updates: Record<string, unknown> = {
        [`active/${instanceId}`]: { instanceId, cue, firedAt: at ?? serverTimestamp() },
        standbyCue: next,
        lastGo: { cueId: cue.id, instanceId },
        goLockedUntil: cue.preventGoDuration > 0 ? serverNow() + cue.preventGoDuration * 1000 : 0,
        sequence: increment(1),
      }
      for (const other of Object.values(stateRef.current.active)) {
        if (other.stopAt != null) continue
        const path = `active/${other.instanceId}`
        if (cue.stopOthers !== 'none') {
          updates[`${path}/stopAt`] = serverTimestamp()
          if (cue.stopOthers === 'cut') updates[`${path}/stopFade`] = 0
        } else if (other.cue.fadeOnNextGo && other.pausedAt == null) {
          // "Loop ∞ / Fade Out + Start Next": a vamp fades out (over its own fade time) as the
          // next cue starts.
          updates[`${path}/stopAt`] = at ?? serverTimestamp()
        } else if (isVisualCue(cue) && isVisualCue(other.cue) && visualCovers(cue, other.cue)) {
          // A new picture replaces the old one for the same audience, crossfading with its fade-out.
          updates[`${path}/stopAt`] = serverTimestamp()
        }
      }
      return run(update(ref(db, statePath), updates))
    },
    [role, run, serverNow, statePath],
  )

  /**
   * Fire `cue` (default: the standby cue) and arm `next` (default: the cue after it in the list).
   * Rejected while a preventGoDuration lock is active.
   */
  const go = useCallback(
    (cue?: Cue, next?: Cue | null) => {
      assertConsole('go')
      const target = cue ?? stateRef.current.standbyCue
      if (!target) {
        // Nothing selected (fresh show, or just after a Panic): the first GO only selects the
        // first cue; the next GO fires it.
        const first = cuesRef.current[0]
        if (!first) return Promise.reject(new Error('Cue 清單是空的'))
        return run(update(ref(db, statePath), { standbyCue: first }))
      }
      if (stateRef.current.pausedAt != null) return Promise.reject(new Error('暫停中：請先 Resume 或 Stop'))
      if (serverNow() < stateRef.current.goLockedUntil) return Promise.reject(new Error('GO 鎖定中'))
      return fire(target, next === undefined ? cueAfter(target.id) : next)
    },
    [assertConsole, fire, cueAfter, serverNow, run, statePath],
  )

  /** Stop one running instance, fading over its own fadeOutTime unless `fade` is given. */
  const stopInstance = useCallback(
    (instanceId: string, fade?: number) => {
      assertConsole('stopInstance')
      if (stateRef.current.pausedAt != null) return Promise.reject(new Error('暫停中無法淡出：請 Resume 或 Stop'))
      return run(
        update(ref(db, `${statePath}/active/${instanceId}`), {
          stopAt: serverTimestamp(),
          ...(fade != null ? { stopFade: fade } : {}),
        }),
      )
    },
    [assertConsole, run, statePath],
  )

  /**
   * Fade out everything that is running (each with its own fade-out, or `fade` seconds if given).
   * `clearSelection` also empties standby, as Panic All Cues does.
   */
  const stopAll = useCallback((fade?: number, { clearSelection = false } = {}) => {
    assertConsole('stopAll')
    if (stateRef.current.pausedAt != null) return Promise.reject(new Error('暫停中無法淡出：請 Resume 或 Stop'))
    const updates: Record<string, unknown> = clearSelection ? { standbyCue: null, lastGo: null } : {}
    for (const inst of Object.values(stateRef.current.active)) {
      if (inst.stopAt != null) continue
      updates[`active/${inst.instanceId}/stopAt`] = serverTimestamp()
      if (fade != null) updates[`active/${inst.instanceId}/stopFade`] = fade
    }
    return run(update(ref(db, statePath), updates))
  }, [assertConsole, run, statePath])

  /**
   * Panic / Stop: cut every running cue and hit instantly, clear the stage and the selection
   * (standby becomes empty, so the next GO selects the first cue instead of firing). Ends a pause;
   * master, DIM, MUTE and the hits page are kept.
   */
  const panic = useCallback(() => {
    assertConsole('panic')
    const { masterVolume, dim, muted, hitsPage, sequence, hitStop, execLevels, channels } = stateRef.current
    return run(
      set(ref(db, statePath), {
        ...INITIAL_SHOW_STATE,
        // Executor faders stay where they are; what the executors were running is cleared.
        execLevels,
        // The audience's grouping survives a Stop: devices keep their group.
        channels,
        masterVolume,
        dim,
        muted,
        hitsPage,
        sequence,
        // Panic silences hits too.
        hitStop: { target: '*', seq: (hitStop?.seq ?? 0) + 1, at: serverNow() },
      }),
    )
  }, [assertConsole, run, serverNow, statePath])

  /** Freeze the show: every device holds its clock at pausedAt and pauses its media. */
  const pause = useCallback(() => {
    assertConsole('pause')
    const state = stateRef.current
    if (state.pausedAt != null || Object.keys(state.active).length === 0) return Promise.resolve()
    return run(update(ref(db, statePath), { pausedAt: serverNow() }))
  }, [assertConsole, run, serverNow, statePath])

  /**
   * Continue from where the show was paused. Shifting every instance's timestamps forward by
   * the pause length means countdowns, fades, follows and late-joiner sync all carry on unchanged.
   */
  const resume = useCallback(() => {
    assertConsole('resume')
    const { pausedAt, active, goLockedUntil } = stateRef.current
    if (pausedAt == null) return Promise.resolve()
    const shift = Math.max(0, serverNow() - pausedAt)
    const updates: Record<string, unknown> = { pausedAt: null }
    for (const inst of Object.values(active)) {
      updates[`active/${inst.instanceId}/firedAt`] = inst.firedAt + shift
      if (inst.stopAt != null) updates[`active/${inst.instanceId}/stopAt`] = inst.stopAt + shift
      // A cue paused on its own stays paused, frozen at the same point of its timeline.
      if (inst.pausedAt != null) updates[`active/${inst.instanceId}/pausedAt`] = inst.pausedAt + shift
    }
    if (goLockedUntil > pausedAt) updates.goLockedUntil = goLockedUntil + shift
    return run(update(ref(db, statePath), updates))
  }, [assertConsole, run, serverNow, statePath])

  /** Pause one running instance on its own (the rest of the show keeps going). */
  const pauseInstance = useCallback(
    (instanceId: string) => {
      assertConsole('pauseInstance')
      const inst = stateRef.current.active[instanceId]
      if (!inst || inst.pausedAt != null) return Promise.resolve()
      const at = stateRef.current.pausedAt ?? serverNow()
      return run(update(ref(db, `${statePath}/active/${instanceId}`), { pausedAt: at }))
    },
    [assertConsole, run, serverNow, statePath],
  )

  /** Continue an individually paused instance, shifting its timeline by how long it was held. */
  const unpauseInstance = useCallback(
    (instanceId: string) => {
      assertConsole('unpauseInstance')
      const inst = stateRef.current.active[instanceId]
      if (!inst || inst.pausedAt == null) return Promise.resolve()
      const shift = Math.max(0, (stateRef.current.pausedAt ?? serverNow()) - inst.pausedAt)
      return run(
        update(ref(db, `${statePath}/active/${instanceId}`), {
          pausedAt: null,
          firedAt: inst.firedAt + shift,
          ...(inst.stopAt != null ? { stopAt: inst.stopAt + shift } : {}),
        }),
      )
    },
    [assertConsole, run, serverNow, statePath],
  )

  /* ---------- live controls (control-panel knobs and faders) ---------- */

  // Knob / fader moves arrive every frame; they are merged and written at most ~25 times a second.
  const pendingLive = useRef<Record<string, unknown>>({})
  const liveTimer = useRef(0)
  const liveWrite = useCallback(
    (updates: Record<string, unknown>) => {
      Object.assign(pendingLive.current, updates)
      if (liveTimer.current) return
      liveTimer.current = window.setTimeout(() => {
        const batch = pendingLive.current
        pendingLive.current = {}
        liveTimer.current = 0
        update(ref(db, statePath), batch).catch((err) => setError(err as Error))
      }, 40)
    },
    [statePath],
  )
  /** Forget batched live writes under a key (a later, final write replaces them). */
  const dropLive = (prefix: string) => {
    for (const k of Object.keys(pendingLive.current)) if (k.startsWith(prefix)) delete pendingLive.current[k]
  }

  /** Show-wide effects on every audience device (EQ, filter, reverb / delay sends, pan). */
  const setFx = useCallback(
    (patch: Partial<ShowFx>) => {
      assertConsole('setFx')
      liveWrite(Object.fromEntries(Object.entries(patch).map(([k, v]) => [`fx/${k}`, v])))
    },
    [assertConsole, liveWrite],
  )

  /** Live VJ mix (clips, layer faders, effects) shown on every audience device; written in throttled batches. */
  const setVj = useCallback(
    (mix: VjMix) => {
      assertConsole('setVj')
      liveWrite({ vj: mix })
    },
    [assertConsole, liveWrite],
  )

  /* ---------- control-panel executors (types/sequence.ts) ---------- */

  /**
   * Fire a sequence step on an executor. The executor is claimed in a transaction — only if it is
   * still on `expect` (the step it was on when the GO / Follow was decided), so two consoles, or a
   * GO racing a Follow, never fire twice. Then the step's sound starts (after its Delay, fading in)
   * and the previous step's sound fades out over this step's Out Fade.
   * Resolves false when another console got there first.
   */
  const execFire = useCallback(
    async (execNo: number, sequenceId: string, step: SeqCue, showCue: Cue | null, expect?: { cueId: string | null; instanceId: string | null }) => {
      assertConsole('execFire')
      if (stateRef.current.pausedAt != null) throw new Error('暫停中：請先 Resume')
      const firedAt = serverNow()
      const instanceId = showCue ? push(ref(db, `${statePath}/active`)).key! : null
      let previous: ExecutorRun | null = null
      const result = await run(
        runTransaction(ref(db, `${statePath}/executors/${execNo}`), (cur: ExecutorRun | null) => {
          if (expect && ((cur?.cueId ?? null) !== expect.cueId || (cur?.instanceId ?? null) !== expect.instanceId)) return undefined
          previous = cur
          return { sequenceId, cueId: step.id, instanceId, firedAt }
        }),
      )
      if (!result.committed) return false
      const updates: Record<string, unknown> = {}
      if (showCue && instanceId) updates[`active/${instanceId}`] = { instanceId, cue: showCue, firedAt }
      const prevId = (previous as ExecutorRun | null)?.instanceId
      const prev = prevId ? stateRef.current.active[prevId] : null
      if (prev && prev.stopAt == null) {
        updates[`active/${prev.instanceId}/stopAt`] = firedAt
        // A paused sound can't fade (its clock is frozen): cut it.
        updates[`active/${prev.instanceId}/stopFade`] = prev.pausedAt != null ? 0 : step.fadeOut
        if (prev.pausedAt != null) updates[`active/${prev.instanceId}/pausedAt`] = null
      }
      if (Object.keys(updates).length) await run(update(ref(db, statePath), updates))
      return true
    },
    [assertConsole, run, serverNow, statePath],
  )

  /** PAUSE on an executor: hold its running sound where it is; again to continue. */
  const execPause = useCallback(
    (execNo: number) => {
      assertConsole('execPause')
      const id = stateRef.current.executors[String(execNo)]?.instanceId
      const inst = id ? stateRef.current.active[id] : null
      if (!inst || inst.stopAt != null) return Promise.resolve()
      return inst.pausedAt == null ? pauseInstance(inst.instanceId) : unpauseInstance(inst.instanceId)
    },
    [assertConsole, pauseInstance, unpauseInstance],
  )

  /** OFF: fade the executor's sound out (its own fade-out, or `fade` seconds) and reset it to the top. */
  const execOff = useCallback(
    (execNo: number, fade?: number) => {
      assertConsole('execOff')
      const run_ = stateRef.current.executors[String(execNo)]
      const inst = run_?.instanceId ? stateRef.current.active[run_.instanceId] : null
      const updates: Record<string, unknown> = { [`executors/${execNo}`]: null }
      if (inst && inst.stopAt == null) {
        updates[`active/${inst.instanceId}/stopAt`] = serverNow()
        updates[`active/${inst.instanceId}/stopFade`] = inst.pausedAt != null ? 0 : (fade ?? inst.cue.fadeOutTime)
        if (inst.pausedAt != null) updates[`active/${inst.instanceId}/pausedAt`] = null
      }
      return run(update(ref(db, statePath), updates))
    },
    [assertConsole, run, serverNow, statePath],
  )

  /** An executor's fader (0–1), live on every device. */
  const setExecLevel = useCallback(
    (execNo: number, level: number) => {
      assertConsole('setExecLevel')
      liveWrite({ [`execLevels/${execNo}`]: Math.max(0, Math.min(1, level)) })
    },
    [assertConsole, liveWrite],
  )

  /** Ride one hit's level (0–1) live. */
  const setHitLevel = useCallback(
    (hitId: string, level: number) => {
      assertConsole('setHitLevel')
      liveWrite({ [`hitLevels/${hitId}`]: Math.max(0, Math.min(1, level)) })
    },
    [assertConsole, liveWrite],
  )

  /**
   * Manual crossfade ("走 Cue" fader), position 0–1. Leaving 0 fires the standby cue silently and
   * crossfades it in against everything that was running; reaching the top completes it (the old
   * cues stop); dropping back to 0 first cancels it. After a completed fade the fader has to come
   * back down before it can start the next one.
   */
  const xfadeRef = useRef<{ from: string[]; to: string; cueId: string; standbyBefore: Cue | null } | null>(null)
  const xfadeArmed = useRef(true)
  const manualXfade = useCallback(
    (pos: number) => {
      assertConsole('manualXfade')
      const xf = xfadeRef.current
      const state = stateRef.current
      if (!xf) {
        if (pos <= 0.02) {
          xfadeArmed.current = true
          return Promise.resolve()
        }
        if (!xfadeArmed.current) return Promise.resolve()
        const target = state.standbyCue
        if (!target) return Promise.reject(new Error('沒有 Standby Cue：先選一個 Cue'))
        if (state.pausedAt != null) return Promise.reject(new Error('暫停中'))
        const from = Object.values(state.active)
          .filter((i) => i.stopAt == null)
          .map((i) => i.instanceId)
        const instanceId = push(ref(db, `${statePath}/active`)).key!
        // The fader is the fade: no automatic fade-in, and nothing else is stopped by the GO.
        const cue: Cue = { ...target, fadeInTime: 0, stopOthers: 'none' }
        xfadeRef.current = { from, to: instanceId, cueId: target.id, standbyBefore: target }
        xfadeArmed.current = false
        return run(
          update(ref(db, statePath), {
            [`active/${instanceId}`]: { instanceId, cue, firedAt: serverTimestamp() },
            standbyCue: cueAfter(target.id),
            lastGo: { cueId: target.id, instanceId },
            sequence: increment(1),
            xfade: { from: Object.fromEntries(from.map((id, i) => [String(i), id])), to: instanceId, pos },
          }),
        )
      }
      if (pos >= 0.98) {
        // Done: the old cues stop where they are (already faded out by the fader).
        xfadeRef.current = null
        dropLive('xfade')
        const updates: Record<string, unknown> = { xfade: null }
        for (const id of xf.from) if (state.active[id]?.stopAt == null) Object.assign(updates, { [`active/${id}/stopAt`]: serverTimestamp(), [`active/${id}/stopFade`]: 0 })
        return run(update(ref(db, statePath), updates))
      }
      if (pos <= 0.02) {
        // Pulled back down before the end: cancel, and put the cue back on standby.
        xfadeRef.current = null
        dropLive('xfade')
        xfadeArmed.current = true
        return run(
          update(ref(db, statePath), {
            xfade: null,
            [`active/${xf.to}/stopAt`]: serverTimestamp(),
            [`active/${xf.to}/stopFade`]: 0,
            standbyCue: xf.standbyBefore,
          }),
        )
      }
      liveWrite({ 'xfade/pos': pos })
      return Promise.resolve()
    },
    [assertConsole, cueAfter, liveWrite, run, statePath],
  )

  /** Move standby by `delta` cues in the list ("Select Next/Prev Cue"). */
  const selectRelative = useCallback(
    (delta: number) => {
      assertConsole('selectRelative')
      const list = cuesRef.current
      if (list.length === 0) return Promise.resolve()
      const index = list.findIndex((c) => c.id === stateRef.current.standbyCue?.id)
      const next = index < 0 ? (delta > 0 ? 0 : list.length - 1) : Math.min(list.length - 1, Math.max(0, index + delta))
      return run(update(ref(db, statePath), { standbyCue: list[next] }))
    },
    [assertConsole, run, statePath],
  )

  /** Oops: stop the cue that was just fired (cut) and put it back on standby. */
  const oops = useCallback(() => {
    assertConsole('oops')
    const { lastGo, active } = stateRef.current
    if (!lastGo) return Promise.resolve()
    const cue = cuesRef.current.find((c) => c.id === lastGo.cueId) ?? active[lastGo.instanceId]?.cue
    const updates: Record<string, unknown> = { lastGo: null, standbyCue: cue ?? null }
    if (active[lastGo.instanceId]) updates[`active/${lastGo.instanceId}`] = null
    return run(update(ref(db, statePath), updates))
  }, [assertConsole, run, statePath])

  const setMuted = useCallback(
    (muted: boolean) => {
      assertConsole('setMuted')
      return run(set(ref(db, `${statePath}/muted`), muted))
    },
    [assertConsole, run, statePath],
  )

  /** Audience grouping settings (group count, self-service switching, epoch for "reset"). */
  const setChannels = useCallback(
    (changes: Partial<Omit<ChannelConfig, 'assign'>> & { assign?: null }) => {
      assertConsole('setChannels')
      return run(update(ref(db, `${statePath}/channels`), { ...changes }))
    },
    [assertConsole, run, statePath],
  )

  /** Place audience devices in groups by hand (code → channel_n); null removes the assignment. */
  const assignAudience = useCallback(
    (changes: Record<string, string | null>) => {
      assertConsole('assignAudience')
      return run(update(ref(db, `${statePath}/channels/assign`), changes))
    },
    [assertConsole, run, statePath],
  )

  /** One-way announcement to the audience (all groups, or one): chime / vibration / spoken text on their devices. */
  const announce = useCallback(
    (message: Omit<Announcement, 'id' | 'at'>) => {
      assertConsole('announce')
      const id = push(ref(db, `${statePath}/announce`)).key!
      // Server clock, so audience phones with a wrong clock still ring (and don't replay old ones).
      return run(set(ref(db, `${statePath}/announce`), { ...message, id, at: serverNow() }))
    },
    [assertConsole, run, serverNow, statePath],
  )

  const setHitsPage = useCallback(
    (page: number) => {
      assertConsole('setHitsPage')
      return run(set(ref(db, `${statePath}/hitsPage`), Math.max(0, page)))
    },
    [assertConsole, run, statePath],
  )

  /** Stop one hit (by id) or every hit ("*") on all audience devices. */
  const stopHits = useCallback(
    (target: string) => {
      assertConsole('stopHits')
      return run(
        update(ref(db, statePath), {
          'hitStop/target': target,
          'hitStop/seq': increment(1),
          'hitStop/at': serverNow(),
        }),
      )
    },
    [assertConsole, run, serverNow, statePath],
  )

  /**
   * Master volume. `undim`: the fader was moved while DIM was on — DIM switches off and the volume
   * becomes exactly where the fader was let go, in one write (no jump, nothing left to restore).
   */
  const setMasterVolume = useCallback(
    (volume: number, opts: { undim?: boolean } = {}) => {
      assertConsole('setMasterVolume')
      const v = Math.round(volume)
      return run(opts.undim ? update(ref(db, statePath), { masterVolume: v, dim: false }) : set(ref(db, `${statePath}/masterVolume`), v))
    },
    [assertConsole, run, statePath],
  )

  /** DIM on / off; `amount` (dB, when given) also sets its depth in the same write. */
  const setDim = useCallback(
    (dim: boolean, amount?: number) => {
      assertConsole('setDim')
      return run(amount == null ? set(ref(db, `${statePath}/dim`), dim) : update(ref(db, statePath), { dim, dimDb: clampDimDb(amount) }))
    },
    [assertConsole, run, statePath],
  )
  /** The show DIM amount (dB), applied at once if DIM is on. */
  const setDimDb = useCallback(
    (amount: number) => {
      assertConsole('setDimDb')
      return run(set(ref(db, `${statePath}/dimDb`), clampDimDb(amount)))
    },
    [assertConsole, run, statePath],
  )

  /** Play a hit on every audience device, independent of the cue list. */
  const fireHit = useCallback(
    (hit: Hit) => {
      assertConsole('fireHit')
      return run(
        update(ref(db, statePath), {
          'hit/hitId': hit.id,
          'hit/url': hit.targetUrl,
          'hit/volume': hit.volume,
          'hit/firedAt': serverTimestamp(),
          'hit/seq': increment(1),
        }),
      )
    },
    [assertConsole, run, statePath],
  )

  // Console scheduler (every 50 ms):
  //  1. fire follow actions that are due (auto-follow / auto-continue, after post-wait);
  //  2. remove instances that have finished and have no follow still pending.
  // Both steps are transactions, so with two consoles open each action happens exactly once.
  const busyRef = useRef(new Set<string>())
  useEffect(() => {
    if (role !== 'console') return
    const timer = setInterval(() => {
      // Time is frozen while paused: nothing ends and nothing follows.
      if (stateRef.current.pausedAt != null) return
      const now = serverNow()
      for (const inst of Object.values(stateRef.current.active)) {
        const id = inst.instanceId
        // An individually paused cue neither ends nor follows until it is unpaused.
        if (busyRef.current.has(id) || inst.pausedAt != null) continue
        const followAt = followDue(inst)
        const instRef = ref(db, `${statePath}/active/${id}`)

        if (followAt != null && now >= followAt) {
          busyRef.current.add(id)
          runTransaction(instRef, (current) => (current && !current.followed ? { ...current, followed: true } : undefined))
            .then(({ committed }) => {
              if (!committed) return
              const next = cueAfter(inst.cue.id)
              if (next) return fire(next, cueAfter(next.id), followAt)
            })
            .catch((err) => setError(err as Error))
            .finally(() => busyRef.current.delete(id))
        } else if (followAt == null && now >= activeEndAt(inst)) {
          busyRef.current.add(id)
          runTransaction(instRef, (current) => (current ? null : undefined))
            .catch((err) => setError(err as Error))
            .finally(() => busyRef.current.delete(id))
        }
      }
    }, 50)
    return () => clearInterval(timer)
  }, [role, serverNow, cueAfter, fire, statePath])

  return {
    showState,
    playbackState: derivePlaybackState(showState),
    loaded,
    connected,
    error,
    serverNow,
    go,
    standby,
    stopInstance,
    stopAll,
    panic,
    pause,
    resume,
    pauseInstance,
    unpauseInstance,
    selectRelative,
    oops,
    setMuted,
    setHitsPage,
    setChannels,
    assignAudience,
    announce,
    stopHits,
    setMasterVolume,
    setDim,
    setDimDb,
    fireHit,
    setFx,
    setVj,
    setHitLevel,
    manualXfade,
    execFire,
    execPause,
    execOff,
    setExecLevel,
  }
}
