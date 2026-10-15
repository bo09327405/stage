import { onValue, ref } from 'firebase/database'
import { useSyncExternalStore } from 'react'
import { StudioPlayer } from '../studio/player'
import { normalizeStudio, projectLength, type StudioProject } from '../types/studio'
import { db } from './firebase'
import { studioPath } from './studio'

/*
 * Lobby playback of whole Studio projects: the full multitrack mix (tracks, volumes, pan, EQ,
 * effects, fades, automation, mute / solo) through the same engine the Studio uses, without opening
 * the Studio. One player for the whole lobby — playing another project stops the current one.
 * While loaded, the project is followed live, so edits made elsewhere are heard.
 */

export interface LobbyPlayerState {
  /** `${projectId}/${studioId}` of the loaded project, or null. */
  key: string | null
  projectId: string | null
  studioId: string | null
  name: string
  showName: string | null
  project: StudioProject | null
  playing: boolean
  loading: boolean
  /** Playhead, seconds (updated every frame while playing). */
  position: number
  length: number
  volume: number
  muted: boolean
  error: string | null
}

const VOLUME_KEY = 'theatre.lobby.volume'
const savedVolume = () => {
  try {
    const v = Number(localStorage.getItem(VOLUME_KEY))
    return localStorage.getItem(VOLUME_KEY) !== null && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.8
  } catch {
    return 0.8
  }
}

const EMPTY = { key: null, projectId: null, studioId: null, name: '', showName: null, project: null, playing: false, loading: false, position: 0, length: 0, error: null }
let state: LobbyPlayerState = { ...EMPTY, volume: savedVolume(), muted: false }
const listeners = new Set<() => void>()
const emit = (patch: Partial<LobbyPlayerState>) => {
  state = { ...state, ...patch }
  listeners.forEach((l) => l())
}

let player: StudioPlayer | null = null
let unwatch: (() => void) | null = null
let frame = 0
let loadToken = 0

function engine() {
  if (player) return player
  player = new StudioPlayer()
  player.setVolume(state.muted ? 0 : state.volume)
  player.onLoading = (loading) => emit({ loading })
  player.onEnded = () => {
    cancelAnimationFrame(frame)
    player!.stop(0)
    emit({ playing: false, position: 0 })
  }
  return player
}

function follow() {
  cancelAnimationFrame(frame)
  const step = () => {
    if (!player?.playing) return
    emit({ position: Math.min(player.position(), state.length || Infinity) })
    frame = requestAnimationFrame(step)
  }
  frame = requestAnimationFrame(step)
}

/** Load a project (following it live) without playing; resolves once it's read. */
function load(projectId: string, studioId: string, name: string, showName: string | null): Promise<StudioProject> {
  unwatch?.()
  const token = ++loadToken
  emit({ ...EMPTY, key: `${projectId}/${studioId}`, projectId, studioId, name, showName, loading: true })
  return new Promise((resolve, reject) => {
    let first = true
    unwatch = onValue(
      ref(db, studioPath(projectId, studioId)),
      (snap) => {
        if (token !== loadToken) return
        if (!snap.exists()) {
          emit({ loading: false, error: '找不到這個 Studio（可能已刪除）' })
          if (first) reject(new Error('missing'))
          first = false
          return
        }
        const prev = state.project
        const project = normalizeStudio(studioId, snap.val())
        emit({ project, length: projectLength(project), name: project.name || name })
        if (first) {
          first = false
          resolve(project)
        } else if (player && state.playing) {
          player.update(project, JSON.stringify(prev?.regions) !== JSON.stringify(project.regions))
        }
      },
      (err) => {
        if (token !== loadToken) return
        emit({ loading: false, error: /permission/i.test(err.message) ? '沒有權限播放這個專案' : err.message })
        if (first) reject(err)
        first = false
      },
    )
  })
}

async function start(from: number) {
  const p = engine()
  if (!state.project) return
  if (!Object.keys(state.project.regions).length) return emit({ error: '這個 Studio 的時間軸還沒有任何音訊' })
  emit({ error: null })
  try {
    await p.play(state.project, from)
  } catch {
    return emit({ playing: false, loading: false, error: '音檔載入失敗，無法播放' })
  }
  if (!p.playing) return // paused / switched while loading
  emit({ playing: true })
  follow()
}

/** The ▶ on a project: play it (switching from whatever plays), or pause / resume it. */
export async function toggleStudio(projectId: string, studioId: string, name: string, showName: string | null) {
  const p = engine()
  // Unlock audio inside the click, before any network wait.
  void p.context.resume()
  const key = `${projectId}/${studioId}`
  if (state.key === key && state.project) return togglePlay()
  p.stop(0)
  cancelAnimationFrame(frame)
  try {
    await load(projectId, studioId, name, showName)
  } catch {
    return
  }
  if (state.key === key) await start(0)
}

export function togglePlay() {
  const p = engine()
  if (!state.project) return
  if (p.playing || state.loading) {
    p.pause()
    cancelAnimationFrame(frame)
    emit({ playing: false, loading: false, position: p.position() })
  } else {
    void p.context.resume()
    void start(state.position >= state.length - 0.05 ? 0 : state.position)
  }
}

/** Stop: back to the start, project stays loaded. */
export function stopPlayback() {
  player?.stop(0)
  cancelAnimationFrame(frame)
  emit({ playing: false, loading: false, position: 0 })
}

export function seekTo(seconds: number) {
  const to = Math.max(0, Math.min(seconds, state.length))
  emit({ position: to })
  if (!player) return
  if (player.playing) void start(to)
  else player.seek(to)
}

export const skipBy = (seconds: number) => seekTo((player?.playing ? player.position() : state.position) + seconds)

export function setVolume(volume: number) {
  const v = Math.max(0, Math.min(1, volume))
  emit({ volume: v, muted: false })
  player?.setVolume(v)
  try {
    localStorage.setItem(VOLUME_KEY, String(v))
  } catch {
    // ignore
  }
}

export function toggleMute() {
  emit({ muted: !state.muted })
  player?.setVolume(state.muted ? 0 : state.volume)
}

/** Close the player: stop, unload, stop following the project. */
export function closePlayer() {
  ++loadToken
  unwatch?.()
  unwatch = null
  player?.stop(0)
  cancelAnimationFrame(frame)
  emit({ ...EMPTY })
}

export function useLobbyPlayer(): LobbyPlayerState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => state,
  )
}
