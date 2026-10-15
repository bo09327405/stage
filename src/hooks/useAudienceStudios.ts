import { onValue, ref, update } from 'firebase/database'
import { useEffect } from 'react'
import { db } from '../services/firebase'
import type { Cue } from '../types/cue'

/**
 * Keep projects/{pid}/audienceStudios in step with the cues bound to DAW studios: audience devices
 * render those studios themselves, and the database rules let them read exactly these (and no other
 * project data) without signing in.
 */
export function useAudienceStudios(projectId: string, cues: Cue[]) {
  const wanted = [...new Set(cues.map((c) => c.studioId).filter(Boolean))].sort().join(',')
  useEffect(() => {
    const path = `projects/${projectId}/audienceStudios`
    return onValue(
      ref(db, path),
      (snap) => {
        const current = Object.keys((snap.val() ?? {}) as Record<string, true>).sort()
        const next = wanted ? wanted.split(',') : []
        const updates: Record<string, true> = {}
        // Add only: another version (maybe the one on air) can still use a studio this one dropped.
        for (const sid of next) if (!current.includes(sid)) updates[sid] = true
        if (Object.keys(updates).length) update(ref(db, path), updates).catch(() => {})
      },
      () => {},
    )
  }, [projectId, wanted])
}
