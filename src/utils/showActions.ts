import type { useTheatreEngine } from '../hooks/useTheatreEngine'
import { HITS_PER_PAGE, PANIC_FADE, VOLUME_STEP, parseHitAction, type ShowAction } from '../types/actions'
import { activeList, type ActiveCue, type Cue, type Hit } from '../types/cue'

type Engine = ReturnType<typeof useTheatreEngine>

export interface ShowActionContext {
  engine: Engine
  cues: Cue[]
  hits: Hit[]
}

const ignore = () => {}

/**
 * The "selected cue" is the standby cue (the playhead). For pause/unpause, when the playhead cue
 * isn't running (GO already advanced it), fall back to the most recently started running cue.
 */
function selectedInstance(engine: Engine, preferPaused: boolean | null): ActiveCue | null {
  const { showState } = engine
  const running = activeList(showState).filter((i) => i.stopAt == null)
  const standbyId = showState.standbyCue?.id
  const ofStandby = running.filter((i) => i.cue.id === standbyId)
  const pool = ofStandby.length > 0 ? ofStandby : running
  const candidates = preferPaused == null ? pool : pool.filter((i) => (i.pausedAt != null) === preferPaused)
  return candidates[candidates.length - 1] ?? null
}

/** Run one standard show action against the cue engine. */
export function executeShowAction(action: ShowAction, { engine, hits }: ShowActionContext) {
  const { showState, playbackState } = engine
  const hitOnPage = (slot: number) => hits[showState.hitsPage * HITS_PER_PAGE + slot - 1]

  const hit = parseHitAction(action)
  if (hit) {
    const target = hitOnPage(hit.slot)
    if (!target) return
    if (hit.op === 'play') engine.fireHit(target).catch(ignore)
    else engine.stopHits(target.id).catch(ignore)
    return
  }

  switch (action) {
    case 'none':
      return
    case 'go':
      // With nothing selected, the engine's GO selects the first cue instead of firing.
      if (playbackState !== 'paused') engine.go().catch(ignore)
      return
    case 'selectNext':
      engine.selectRelative(1).catch(ignore)
      return
    case 'selectPrev':
      engine.selectRelative(-1).catch(ignore)
      return
    case 'pauseResumeShow':
      ;(playbackState === 'paused' ? engine.resume() : engine.pause()).catch(ignore)
      return
    case 'pauseShow':
      engine.pause().catch(ignore)
      return
    case 'resumeShow':
      engine.resume().catch(ignore)
      return
    case 'panicShow':
      engine.panic().catch(ignore)
      return
    case 'panicCues':
      // A paused show can't fade (its clock is frozen), so panic cuts instead. Either way the
      // selection is cleared.
      ;(playbackState === 'paused' ? engine.panic() : engine.stopAll(PANIC_FADE, { clearSelection: true })).catch(ignore)
      return
    case 'playPauseSelected': {
      const inst = selectedInstance(engine, null)
      const standbyRunning = inst && inst.cue.id === showState.standbyCue?.id
      if (inst?.pausedAt != null) engine.unpauseInstance(inst.instanceId).catch(ignore)
      else if (standbyRunning) engine.pauseInstance(inst.instanceId).catch(ignore)
      // The selected cue isn't running: play it without moving the playhead.
      else if (showState.standbyCue && playbackState !== 'paused') engine.go(showState.standbyCue, showState.standbyCue).catch(ignore)
      else if (inst) engine.pauseInstance(inst.instanceId).catch(ignore)
      return
    }
    case 'pauseSelected': {
      const inst = selectedInstance(engine, false)
      if (inst) engine.pauseInstance(inst.instanceId).catch(ignore)
      return
    }
    case 'unpauseSelected': {
      const inst = selectedInstance(engine, true)
      if (inst) engine.unpauseInstance(inst.instanceId).catch(ignore)
      return
    }
    case 'oops':
      engine.oops().catch(ignore)
      return
    case 'dimToggle':
      engine.setDim(!showState.dim).catch(ignore)
      return
    case 'dim':
      engine.setDim(true).catch(ignore)
      return
    case 'undim':
      engine.setDim(false).catch(ignore)
      return
    case 'muteToggle':
      engine.setMuted(!showState.muted).catch(ignore)
      return
    case 'mute':
      engine.setMuted(true).catch(ignore)
      return
    case 'unmute':
      engine.setMuted(false).catch(ignore)
      return
    case 'volumeUp':
      engine.setMasterVolume(Math.min(100, showState.masterVolume + VOLUME_STEP)).catch(ignore)
      return
    case 'volumeDown':
      engine.setMasterVolume(Math.max(0, showState.masterVolume - VOLUME_STEP)).catch(ignore)
      return
    case 'panicHits':
      engine.stopHits('*').catch(ignore)
      return
    case 'hitsPagePrev':
      engine.setHitsPage(showState.hitsPage - 1).catch(ignore)
      return
    case 'hitsPageNext': {
      const pages = Math.max(1, Math.ceil(hits.length / HITS_PER_PAGE))
      engine.setHitsPage(Math.min(pages - 1, showState.hitsPage + 1)).catch(ignore)
      return
    }
  }
}

/**
 * Why an action will do less than the operator expects right now (for the trigger debug log),
 * or null when it will simply run.
 */
export function explainShowAction(action: ShowAction, { engine, cues }: ShowActionContext): string | null {
  const { showState, playbackState, serverNow } = engine
  if (action === 'go') {
    if (playbackState === 'paused') return '演出暫停中，GO 被忽略（請先 Resume）'
    if (serverNow() < showState.goLockedUntil) return 'GO 鎖定中（Prevent GO），被忽略'
    if (cues.length === 0) return 'Cue 清單是空的'
    if (!showState.standbyCue) return `尚未選取：這次 GO 只會選取 Q${cues[0].cueNumber}，再觸發一次才會執行`
    return null
  }
  if ((action === 'pauseShow' || action === 'pauseResumeShow') && playbackState === 'idle') return '沒有播放中的 Cue，Pause 無作用'
  if (action === 'resumeShow' && playbackState !== 'paused') return '演出沒有暫停，Resume 無作用'
  return null
}
