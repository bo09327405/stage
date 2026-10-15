import { dimGain } from '../utils/dim'
import { useEffect, useState } from 'react'
import { stageAudio } from '../services/audioEngine'
import { useStageMonitor } from '../services/stageMonitor'
import type { useTheatreEngine } from './useTheatreEngine'

export type MonitorAudio = {
  /** Sound switched on (shared by every Stage viewer on the page). */
  sound: boolean
  /** Sound is on and the browser lets it play. */
  playing: boolean
  /** Sound is on but the browser is still holding it back: needs a click (autoplay policy). */
  needsTap: boolean
  /** Call from a click / tap: creates or resumes the AudioContext inside the gesture. */
  unlock: () => void
}

/** Stage viewers currently mounted; the last one to go silences the engine. */
let consumers = 0

/**
 * Plays the show through this page's speakers for the Stage viewers, with the same engine the
 * audience devices use (cue audio and video with fades, ducking, studio mixes, hits, master / DIM /
 * MUTE) — so sound stays in step with the simulated picture. Several viewers can use it at once;
 * they drive the one engine with the same state.
 *
 * The AudioContext can only start after a user gesture; when the page already had one (Chrome's
 * sticky activation) it starts on its own, otherwise `needsTap` asks for a click.
 */
export function useStageMonitorAudio(engine: ReturnType<typeof useTheatreEngine>, projectId: string): MonitorAudio {
  const { showState, serverNow } = engine
  const { sound: enabled, audience, dim: monitorDim, dimDb: monitorDimDb } = useStageMonitor()
  const [state, setState] = useState(() => stageAudio.contextState)
  const [blocked, setBlocked] = useState(false)

  const unlock = () => {
    stageAudio.unlock(serverNow, audience)
    stageAudio.resume()
    setState(stageAudio.contextState)
    setBlocked(false)
  }

  useEffect(() => {
    consumers++
    return () => {
      consumers--
      // Last Stage viewer closed: stop and mute everything it was playing. Checked a moment
      // later, so a viewer that is only re-mounting (or handing over to another) doesn't cut sound.
      window.setTimeout(() => {
        if (consumers > 0) return
        stageAudio.sync({})
        stageAudio.setMaster(0, false, true)
      }, 0)
    }
  }, [])

  // Start (or resume) on enable, when the browser allows it without a fresh tap.
  useEffect(() => {
    if (!enabled) return
    const onBlocked = (b: boolean) => setBlocked(b)
    stageAudio.onBlocked = onBlocked
    const activated = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive ?? false
    if (stageAudio.isUnlocked || activated) {
      stageAudio.unlock(serverNow, audience)
      stageAudio.resume()
    }
    // The context's state changes asynchronously after resume(); poll it.
    const timer = window.setInterval(() => setState(stageAudio.contextState), 500)
    return () => {
      window.clearInterval(timer)
      if (stageAudio.onBlocked === onBlocked) stageAudio.onBlocked = () => {}
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled])

  useEffect(() => stageAudio.setAudience(audience), [audience])
  useEffect(() => stageAudio.setProject(projectId), [projectId])
  useEffect(() => {
    if (enabled) stageAudio.prepare(showState.standbyCue)
  }, [enabled, showState.standbyCue])

  // Cue audio / video follows the show; switching sound off silences it.
  const unlocked = state !== 'none'
  useEffect(() => {
    stageAudio.sync(enabled ? showState.active : {}, showState.pausedAt)
  }, [enabled, unlocked, audience, showState.active, showState.pausedAt])
  useEffect(() => {
    stageAudio.setMaster(showState.masterVolume, showState.dim, showState.muted || !enabled, showState.dimDb)
  }, [enabled, unlocked, showState.masterVolume, showState.dim, showState.muted, showState.dimDb])
  // Headphone DIM: this operator's monitoring only.
  useEffect(() => stageAudio.setMonitorTrim(dimGain(monitorDim, monitorDimDb)), [unlocked, monitorDim, monitorDimDb])
  useEffect(() => {
    if (enabled) stageAudio.stopHits(showState.hitStop)
  }, [enabled, showState.hitStop])
  useEffect(() => stageAudio.setFx(showState.fx), [unlocked, showState.fx])
  useEffect(() => stageAudio.setLive({ xfade: showState.xfade, hitLevels: showState.hitLevels, execLevels: showState.execLevels }), [unlocked, showState.xfade, showState.hitLevels, showState.execLevels])
  useEffect(() => {
    if (enabled) stageAudio.playHit(showState.hit)
  }, [enabled, showState.hit])

  return { sound: enabled, playing: enabled && state === 'running' && !blocked, needsTap: enabled && (state !== 'running' || blocked), unlock }
}
