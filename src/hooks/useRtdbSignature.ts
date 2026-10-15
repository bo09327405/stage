import { onValue, ref } from 'firebase/database'
import { useEffect, useState } from 'react'
import { db } from '../services/firebase'

/**
 * A string that changes whenever any of the given Realtime Database paths changes (null until all
 * have loaded). Used to notice edits for auto-save without holding the data itself.
 */
export function useRtdbSignature(paths: string[]): string | null {
  const joined = paths.join('\n')
  const [state, setState] = useState<{ joined: string; values: Record<string, string> }>({ joined, values: {} })
  useEffect(() => {
    const list = joined.split('\n')
    const unsubs = list.map((path) =>
      onValue(ref(db, path), (snap) =>
        setState((s) => ({ joined, values: { ...(s.joined === joined ? s.values : {}), [path]: JSON.stringify(snap.val()) } })),
      ),
    )
    return () => unsubs.forEach((u) => u())
  }, [joined])
  if (state.joined !== joined) return null
  const list = joined.split('\n')
  if (!list.every((p) => p in state.values)) return null
  return list.map((p) => state.values[p]).join('\u0000')
}
