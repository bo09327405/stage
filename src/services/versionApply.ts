import { get, ref } from 'firebase/database'
import { db } from './firebase'
import { recordedUpdate } from './history'
import { isSetCueMedia } from './projectTransfer'
import { studioPath } from './studio'
import { formatVersionTime } from './versionHistory'

/*
 * Applying a saved version back to the live project, and previewing one — per system.
 * Restores go through the undo history, so ⌘Z works on them as well.
 */

type Json = Record<string, unknown>
const rec = (v: unknown): Record<string, Json> => (v && typeof v === 'object' ? (v as Record<string, Json>) : {})

/* ---------- DAW Studio ---------- */

export function applyStudioVersion(projectId: string, studioId: string) {
  return async (state: Json) => {
    const studio = rec(state.studio)
    const path = studioPath(projectId, studioId)
    await recordedUpdate({
      label: `還原 Studio 版本「${String(state.name ?? '')}」`,
      group: 'studio',
      updates: {
        [`${path}/name`]: state.name ?? 'Studio',
        [`${path}/length`]: state.length ?? 0,
        [`${path}/masterVolume`]: studio.masterVolume ?? 1,
        [`${path}/tracks`]: studio.tracks ?? null,
        [`${path}/regions`]: studio.regions ?? null,
        [`${path}/sections`]: studio.sections ?? null,
      },
      extra: { [`${path}/updatedAt`]: Date.now() },
    })
  }
}

/* ---------- Set Cue ---------- */

/**
 * Put a Set Cue version back: project name, version list, and for every version it contains the
 * cue list, hits and notes; plus control surfaces, triggers and the Set Cue part of the media
 * library. Live playback state, audience uploads (kept permanently) and the DAW Studios are not
 * touched — neither their data nor their recordings / imports in the media library (source
 * 'studio'), which the Studio's own version history covers. Versions created after that snapshot
 * are left as they are.
 */
export function applySetCueVersion(projectId: string) {
  return async (state: Json) => {
    const project = rec(state.project)
    const data = rec(state.data)
    const versions = rec(data.versions)
    const updates: Record<string, unknown> = {
      [`projectIndex/${projectId}/name`]: project.name ?? null,
      [`projects/${projectId}/surfaces`]: data.surfaces ?? null,
      [`projects/${projectId}/triggers`]: data.triggers ?? null,
    }
    // Media: entry by entry, so the Studio's entries stay whatever they are now.
    const restored = rec(data.media)
    const current = rec((await get(ref(db, `projects/${projectId}/media`))).val())
    for (const [id, m] of Object.entries(current)) if (isSetCueMedia(m) && !(id in restored)) updates[`projects/${projectId}/media/${id}`] = null
    for (const [id, m] of Object.entries(restored)) if (isSetCueMedia(m)) updates[`projects/${projectId}/media/${id}`] = m
    for (const [vid, meta] of Object.entries(rec(project.versions))) updates[`projectIndex/${projectId}/versions/${vid}`] = meta
    for (const [vid, v] of Object.entries(versions)) {
      for (const node of ['cueList', 'hits', 'script']) updates[`projects/${projectId}/versions/${vid}/${node}`] = v[node] ?? null
    }
    await recordedUpdate({ label: `還原 Set Cue 版本（${formatVersionTime(Date.now())}）`, group: 'cue', updates })
  }
}
