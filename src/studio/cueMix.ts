import { onValue, ref } from 'firebase/database'
import { db } from '../services/firebase'
import { normalizeStudio } from '../types/studio'
import { encodeWav } from './audio'
import { renderMix } from './mixer'

/**
 * Cues bound to a DAW Studio project play its live mix: each device renders the project (with all
 * tracks, automation, EQ and effects) to a WAV in memory and plays that like any media file — so
 * the audience engine's fades, pause, seek and DIM work unchanged, and no export is needed.
 *
 * Each studio is watched while in use; when someone edits it the mix is re-rendered in the
 * background and the next GO plays the new version.
 */

interface Entry {
  url: Promise<string>
  stamp: number
  unsubscribe: () => void
  previous: string | null
}

const entries = new Map<string, Entry>()

function render(studioId: string, raw: unknown): Promise<string> {
  return renderMix(normalizeStudio(studioId, (raw ?? {}) as Parameters<typeof normalizeStudio>[1])).then((buffer) =>
    URL.createObjectURL(encodeWav(buffer, 16)),
  )
}

/** The current mix of a studio as a playable (blob) URL; renders on first use. */
export function studioMixUrl(projectId: string, studioId: string): Promise<string> {
  const key = `${projectId}/${studioId}`
  const existing = entries.get(key)
  if (existing) return existing.url
  let resolveFirst: (url: string) => void = () => {}
  let rejectFirst: (err: Error) => void = () => {}
  const entry: Entry = {
    url: new Promise<string>((res, rej) => {
      resolveFirst = res
      rejectFirst = rej
    }),
    stamp: -1,
    unsubscribe: () => {},
    previous: null,
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
      const job = render(studioId, snap.val())
      if (first) {
        first = false
        job.then(resolveFirst, rejectFirst)
      } else {
        // Swap in the new mix once it's ready; keep the old URL alive briefly for voices using it.
        job.then((url) => {
          const old = entry.previous
          entry.url = Promise.resolve(url)
          entry.previous = url
          if (old) setTimeout(() => URL.revokeObjectURL(old), 60_000)
        }, () => {})
      }
      job.then((url) => (entry.previous ??= url), () => {})
    },
    (err) => first && rejectFirst(err),
  )
  return entry.url
}

/** Render ahead of time (e.g. when a studio cue goes on standby), ignoring errors. */
export function prepareStudioMix(projectId: string, studioId: string) {
  studioMixUrl(projectId, studioId).catch(() => {})
}
