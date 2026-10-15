import { onValue, push, ref } from 'firebase/database'
import { useCallback, useEffect, useState } from 'react'
import { db } from '../services/firebase'
import { recordedUpdate } from '../services/history'
import type { Hit } from '../types/cue'

/** A version's hits grid, stored at {basePath}/hits/{id}. */
export function useHits(basePath: string) {
  const hitsPath = `${basePath}/hits`
  const [hits, setHits] = useState<Hit[]>([])

  useEffect(
    () =>
      onValue(ref(db, hitsPath), (snapshot) => {
        const raw = (snapshot.val() ?? {}) as Record<string, Partial<Hit>>
        setHits(
          Object.entries(raw)
            .map(([id, hit]): Hit => ({ title: '', targetUrl: '', volume: 100, order: 0, ...hit, id }))
            .sort((a, b) => a.order - b.order),
        )
      }),
    [hitsPath],
  )

  const addHit = useCallback(
    async (hit: Omit<Hit, 'id' | 'order'>) => {
      const id = push(ref(db, hitsPath)).key!
      await recordedUpdate({
        label: `新增 Hit「${hit.title || '未命名'}」`,
        group: 'hit',
        updates: { [`${hitsPath}/${id}`]: { ...hit, id, order: Date.now() } },
      })
    },
    [hitsPath],
  )

  const updateHit = useCallback(
    (id: string, changes: Partial<Omit<Hit, 'id'>>) =>
      recordedUpdate({
        label: `編輯 Hit「${changes.title ?? hits.find((h) => h.id === id)?.title ?? ''}」`,
        group: 'hit',
        updates: Object.fromEntries(Object.entries(changes).map(([k, v]) => [`${hitsPath}/${id}/${k}`, v])),
        coalesceKey: `hit:${id}`,
      }),
    [hitsPath, hits],
  )

  const removeHit = useCallback(
    (id: string) =>
      recordedUpdate({
        label: `刪除 Hit「${hits.find((h) => h.id === id)?.title ?? ''}」`,
        group: 'hit',
        updates: { [`${hitsPath}/${id}`]: null },
      }),
    [hitsPath, hits],
  )

  return { hits, addHit, updateHit, removeHit }
}
