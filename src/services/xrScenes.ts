/*
 * A project's XR scene library: projects/{pid}/xr/{sceneId} = { name, scene, updatedAt }.
 *
 * Scenes are made in the XR workspace (components/xr/XrWorkspace.tsx) and can be bound to any number of
 * AUDIENCE_XR cues by id (Cue.xrSceneId) — like a DAW Studio project bound to an AUDIO cue. The console
 * fills a bound cue's `xr` with the library's current scene (hooks/useCueList.ts), so the audience keeps
 * receiving the whole scene inside the show state and never reads the library itself.
 */
import { onValue, push, ref, remove, serverTimestamp, set, update } from 'firebase/database'
import { useEffect, useState } from 'react'
import { newXrScene, normalizeXr, type XrMode, type XrScene } from '../types/xr'
import { db } from './firebase'
import { refuseIfReadOnly } from './projectLock'

export interface XrSceneDoc {
  id: string
  name: string
  scene: XrScene
  updatedAt: number
}

export const xrScenesPath = (projectId: string, sceneId?: string) => `projects/${projectId}/xr${sceneId ? `/${sceneId}` : ''}`

/** The project's scenes, newest edit first; null while loading. */
export function useXrScenes(projectId: string) {
  const [state, setState] = useState<{ projectId: string; scenes: XrSceneDoc[] | null; error: string | null }>({ projectId, scenes: null, error: null })
  useEffect(
    () =>
      onValue(
        ref(db, xrScenesPath(projectId)),
        (snapshot) => {
          const raw = (snapshot.val() ?? {}) as Record<string, { name?: unknown; scene?: unknown; updatedAt?: unknown }>
          const scenes = Object.entries(raw)
            .map(([id, doc]) => ({ id, name: typeof doc?.name === 'string' && doc.name ? doc.name : '未命名場景', scene: normalizeXr(doc?.scene) ?? newXrScene(), updatedAt: Number(doc?.updatedAt) || 0 }))
            .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'))
          setState({ projectId, scenes, error: null })
        },
        (err) => setState({ projectId, scenes: [], error: err.message }),
      ),
    [projectId],
  )
  return state.projectId === projectId ? state : { projectId, scenes: null, error: null }
}

export async function createXrScene(projectId: string, name: string, scene: XrScene | XrMode = 'vr_stage'): Promise<string> {
  if (refuseIfReadOnly(projectId)) throw new Error('這個專案目前是唯讀')
  const record = push(ref(db, xrScenesPath(projectId)))
  await set(record, { name: name.trim() || '未命名場景', scene: typeof scene === 'string' ? newXrScene(scene) : scene, updatedAt: serverTimestamp() })
  return record.key!
}

export function saveXrScene(projectId: string, sceneId: string, scene: XrScene) {
  if (refuseIfReadOnly(projectId)) return Promise.reject(new Error('這個專案目前是唯讀'))
  return update(ref(db, xrScenesPath(projectId, sceneId)), { scene, updatedAt: serverTimestamp() })
}

export function renameXrScene(projectId: string, sceneId: string, name: string) {
  if (refuseIfReadOnly(projectId)) return Promise.reject(new Error('這個專案目前是唯讀'))
  return update(ref(db, xrScenesPath(projectId, sceneId)), { name: name.trim() || '未命名場景', updatedAt: serverTimestamp() })
}

/** Cues bound to it keep the last copy they were saved with (see resolveXrScene). */
export function removeXrScene(projectId: string, sceneId: string) {
  if (refuseIfReadOnly(projectId)) return Promise.reject(new Error('這個專案目前是唯讀'))
  return remove(ref(db, xrScenesPath(projectId, sceneId)))
}
