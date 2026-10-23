import { onValue, push, ref, remove, set, update } from 'firebase/database'
import { useEffect, useState } from 'react'
import { VJ_GRID_LIMITS, newDeck, normalizeDeck, type VjClip, type VjDeck } from '../types/vj'
import { db } from './firebase'
import { refuseIfReadOnly } from './projectLock'

/*
 * VJ decks: grids of clips, at projects/{pid}/vjDecks/{deckId}. Project-level (not per show version):
 * the clip library is the same for every version; a VJ cue snapshots what it needs into the cue itself.
 */

const decksPath = (projectId: string) => `projects/${projectId}/vjDecks`

/** The project's decks, in display order; null until loaded. */
export function useVjDecks(projectId: string) {
  const [decks, setDecks] = useState<VjDeck[] | null>(null)
  useEffect(
    () =>
      onValue(
        ref(db, decksPath(projectId)),
        (snap) =>
          setDecks(
            Object.entries((snap.val() ?? {}) as Record<string, Partial<VjDeck>>)
              .map(([id, raw]) => normalizeDeck(id, raw))
              .sort((a, b) => a.order - b.order),
          ),
        () => setDecks([]),
      ),
    [projectId],
  )
  return decks
}

/** A new deck (4 × 4); returns its id, or null when the project is read-only. */
export async function createDeck(projectId: string, name: string, order: number): Promise<string | null> {
  if (refuseIfReadOnly(projectId)) return null
  const r = push(ref(db, decksPath(projectId)))
  await set(r, newDeck(name.trim() || '新 Deck', order))
  return r.key
}

export async function renameDeck(projectId: string, deckId: string, name: string) {
  if (refuseIfReadOnly(projectId) || !name.trim()) return
  await update(ref(db, `${decksPath(projectId)}/${deckId}`), { name: name.trim() })
}

export async function resizeDeck(projectId: string, deckId: string, cols: number, rows: number) {
  if (refuseIfReadOnly(projectId)) return
  const c = Math.min(VJ_GRID_LIMITS.cols[1], Math.max(VJ_GRID_LIMITS.cols[0], Math.round(cols)))
  const r = Math.min(VJ_GRID_LIMITS.rows[1], Math.max(VJ_GRID_LIMITS.rows[0], Math.round(rows)))
  await update(ref(db, `${decksPath(projectId)}/${deckId}`), { cols: c, rows: r })
}

export async function deleteDeck(projectId: string, deckId: string) {
  if (refuseIfReadOnly(projectId)) return
  await remove(ref(db, `${decksPath(projectId)}/${deckId}`))
}

/** Put a clip in a slot (or empty it with null). */
export async function setClip(projectId: string, deckId: string, slot: string, clip: VjClip | null) {
  if (refuseIfReadOnly(projectId)) return
  const r = ref(db, `${decksPath(projectId)}/${deckId}/clips/${slot}`)
  if (clip) await set(r, clip)
  else await remove(r)
}

/** Change a clip's settings (play mode, speed, sound, name). */
export async function patchClip(projectId: string, deckId: string, slot: string, patch: Partial<Pick<VjClip, 'name' | 'playMode' | 'speed' | 'audio'>>) {
  if (refuseIfReadOnly(projectId)) return
  await update(ref(db, `${decksPath(projectId)}/${deckId}/clips/${slot}`), patch)
}
