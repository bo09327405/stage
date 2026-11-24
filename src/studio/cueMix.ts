import { onValue, ref } from 'firebase/database'
import { db } from '../services/firebase'
import type { SpatialPart } from '../services/spatialStage'
import { normalizeStudio, projectLength, sortedTracks, type StudioProject } from '../types/studio'
import { encodeWav } from './audio'
import { TAIL, renderMix } from './mixer'
import { effectiveTrajectory, trackPathOrigin } from './spatial'

/**
 * Cues bound to a DAW Studio project play its live mix, rendered on each device:
 *
 *  · an ordinary studio is rendered to a WAV in memory and played like any media file — so the audience engine's
 *    fades, pause, seek and DIM work unchanged, and no export is needed;
 *  · a studio with 3D trajectories keeps its spatial tracks apart: every such track is rendered dry as a stem and
 *    the rest as one bed, all the same length. The stage engine plays the stems through live HRTF panners that
 *    follow the tracks' paths (so the sound can react to head tracking and costs one tiny curve per second to
 *    move), instead of baking the movement into the mix.
 *
 * Each studio is watched while in use; when someone edits it the mix is re-rendered in the background and the
 * next GO plays the new version.
 */

export type StudioMix = { kind: 'wav'; url: string } | { kind: 'spatial'; parts: SpatialPart[] }

interface Entry {
  mix: Promise<StudioMix>
  stamp: number
  unsubscribe: () => void
  previous: string | null
  /** The studio as last read, for the baked (stereo-with-HRTF) WAV the console previews with. */
  raw: unknown
  baked: Promise<string> | null
}

const entries = new Map<string, Entry>()

/** Studio → the parts of a spatial cue: the bed (all non-spatial tracks) and one dry stem per spatial track. */
async function renderSpatial(project: StudioProject): Promise<SpatialPart[]> {
  const tracks = sortedTracks(project)
  const hasRegions = (id: string) => Object.values(project.regions).some((r) => r.trackId === id && !r.muted)
  const spatial = tracks.filter((t) => t.trajectoryConfig.enabled && hasRegions(t.id))
  const bedIds = tracks.filter((t) => !t.trajectoryConfig.enabled && hasRegions(t.id)).map((t) => t.id)
  // One length for everything, so a looping cue wraps all parts at the same moment.
  const seconds = Math.max(0.1, projectLength(project) + TAIL)
  const parts: SpatialPart[] = []
  if (bedIds.length) parts.push({ buffer: await renderMix(project, { trackIds: bedIds, seconds }), traj: null, origin: 0 })
  for (const t of spatial) {
    // The stem is the track as it sounds without placement; the engine adds the placement live.
    const dry: StudioProject = { ...project, tracks: { ...project.tracks, [t.id]: { ...t, trajectoryConfig: { ...t.trajectoryConfig, enabled: false } } } }
    parts.push({
      buffer: await renderMix(dry, { trackIds: [t.id], seconds }),
      traj: effectiveTrajectory(project, t),
      origin: trackPathOrigin(project, t.id),
    })
  }
  return parts
}

async function render(studioId: string, raw: unknown): Promise<StudioMix> {
  const project = normalizeStudio(studioId, (raw ?? {}) as Parameters<typeof normalizeStudio>[1])
  if (Object.values(project.tracks).some((t) => t.trajectoryConfig.enabled)) return { kind: 'spatial', parts: await renderSpatial(project) }
  return { kind: 'wav', url: URL.createObjectURL(encodeWav(await renderMix(project), 16)) }
}

const urlOf = (mix: StudioMix) => (mix.kind === 'wav' ? mix.url : null)

/** The current mix of a studio (a playable blob URL, or the parts of a spatial cue); renders on first use. */
export function studioMix(projectId: string, studioId: string): Promise<StudioMix> {
  const key = `${projectId}/${studioId}`
  const existing = entries.get(key)
  if (existing) return existing.mix
  let resolveFirst: (mix: StudioMix) => void = () => {}
  let rejectFirst: (err: Error) => void = () => {}
  const entry: Entry = {
    mix: new Promise<StudioMix>((res, rej) => {
      resolveFirst = res
      rejectFirst = rej
    }),
    stamp: -1,
    unsubscribe: () => {},
    previous: null,
    raw: null,
    baked: null,
  }
  entries.set(key, entry)
  let first = true
  entry.unsubscribe = onValue(
    ref(db, `projects/${projectId}/studio/${studioId}`),
    (snap) => {
      if (!snap.exists()) {
        if (first) rejectFirst(new Error('此 Cue 綁定的 Studio 專案已被刪除'))
        return
      }
      const stamp = Number((snap.val() as { updatedAt?: number }).updatedAt) || 0
      if (stamp === entry.stamp) return
      entry.stamp = stamp
      entry.raw = snap.val()
      entry.baked = null
      const job = render(studioId, snap.val())
      if (first) {
        first = false
        job.then(resolveFirst, rejectFirst)
      } else {
        // Swap in the new mix once it's ready; keep the old URL alive briefly for voices using it.
        job.then((mix) => {
          const old = entry.previous
          entry.mix = Promise.resolve(mix)
          entry.previous = urlOf(mix)
          if (old) setTimeout(() => URL.revokeObjectURL(old), 60_000)
        }, () => {})
      }
      job.then((mix) => (entry.previous ??= urlOf(mix)), () => {})
    },
    (err) => first && rejectFirst(err),
  )
  return entry.mix
}

/**
 * A playable URL of the whole studio: its WAV mix, or — for a studio with 3D trajectories — the same sound with the
 * movement baked in as binaural stereo. The console previews with this; audience devices use `studioMix` and move the
 * sound live instead.
 */
export async function studioMixUrl(projectId: string, studioId: string): Promise<string> {
  const mix = await studioMix(projectId, studioId)
  if (mix.kind === 'wav') return mix.url
  const entry = entries.get(`${projectId}/${studioId}`)!
  entry.baked ??= renderMix(normalizeStudio(studioId, (entry.raw ?? {}) as Parameters<typeof normalizeStudio>[1])).then((b) => URL.createObjectURL(encodeWav(b, 16)))
  return entry.baked
}

/** Render ahead of time (e.g. when a studio cue goes on standby), ignoring errors. */
export function prepareStudioMix(projectId: string, studioId: string) {
  studioMix(projectId, studioId).catch(() => {})
}
