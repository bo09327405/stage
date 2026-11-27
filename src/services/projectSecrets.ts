import { onValue, ref, remove, set } from 'firebase/database'
import { useEffect, useState } from 'react'
import { db } from './firebase'

/*
 * Keys an admin sets for a whole project (the project's default ElevenLabs API Key):
 *
 *   projectSecrets/{pid}/projectElevenLabsApiKey
 *
 * Kept apart from projects/{pid} so forking, exporting and version history never copy it. The database rules let admins write it and
 * the project's members read it (their browser needs it to call ElevenLabs); the app shows it to nobody, not even the admin.
 */

const path = (projectId: string) => `projectSecrets/${projectId}/projectElevenLabsApiKey`

/** The project's default ElevenLabs key ('' when none is set, or when this user may not read it). */
export function useProjectElevenKey(projectId: string | undefined): { key: string; ready: boolean } {
  const [state, setState] = useState<{ id: string | undefined; key: string; ready: boolean }>({ id: projectId, key: '', ready: false })
  useEffect(() => {
    if (!projectId) return
    return onValue(
      ref(db, path(projectId)),
      (snap) => setState({ id: projectId, key: typeof snap.val() === 'string' ? (snap.val() as string) : '', ready: true }),
      () => setState({ id: projectId, key: '', ready: true }),
    )
  }, [projectId])
  return state.id === projectId ? { key: state.key, ready: state.ready } : { key: '', ready: false }
}

/** Admins only (the database rules refuse anyone else). An empty key removes it. */
export async function setProjectElevenKey(projectId: string, key: string): Promise<void> {
  const clean = key.trim()
  if (!clean) return remove(ref(db, path(projectId)))
  await set(ref(db, path(projectId)), clean)
}

/** Whether a project has a key, for the admin's button (a key's own text is never needed there). */
export function useHasProjectElevenKey(projectId: string): boolean | null {
  const { key, ready } = useProjectElevenKey(projectId)
  return ready ? !!key : null
}
