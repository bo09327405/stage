import { onValue, push, ref } from 'firebase/database'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { db } from '../services/firebase'
import { recordedUpdate } from '../services/history'
import { normalizeCue, type Cue } from '../types/cue'
import { resolveXrScene } from '../types/xr'
import { useXrScenes } from '../services/xrScenes'

const cueName = (c: Pick<Cue, 'cueNumber' | 'title'> | undefined) => (c ? `Q${c.cueNumber}${c.title ? ` ${c.title}` : ''}` : 'Cue')

/**
 * A version's cue list, stored at {basePath}/cueList/{id} and sorted by cue number. Every edit is
 * recorded in the undo history.
 */
export function useCueList(basePath: string) {
  const listPath = `${basePath}/cueList`
  const [stored, setCues] = useState<Cue[]>([])
  // XR cues bound to a library scene always carry that scene's current content (the cue's own copy is the
  // fallback): what goes to STANDBY / GO, the Stage simulation and the editor all see the latest edit.
  const projectId = /^projects\/([^/]+)\//.exec(basePath)?.[1] ?? ''
  const { scenes } = useXrScenes(projectId)
  const cues = useMemo(() => {
    if (!scenes?.length || !stored.some((c) => c.xrSceneId)) return stored
    const library = Object.fromEntries(scenes.map((s) => [s.id, s.scene]))
    return stored.map((c) => (c.type === 'AUDIENCE_XR' && c.xrSceneId && library[c.xrSceneId] ? { ...c, xr: resolveXrScene(c.xr, c.xrSceneId, library) } : c))
  }, [stored, scenes])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  // For naming history steps ("Delete Q3 …") from inside stable callbacks.
  const cuesRef = useRef<Cue[]>([])
  useEffect(() => {
    cuesRef.current = cues
  }, [cues])
  const byId = (id: string) => cuesRef.current.find((c) => c.id === id)

  useEffect(
    () =>
      onValue(ref(db, listPath), (snapshot) => {
        const raw = (snapshot.val() ?? {}) as Record<string, unknown>
        const list = Object.entries(raw)
          .map(([id, cue]) => normalizeCue({ ...(cue as object), id }))
          .sort((a, b) => a.cueNumber - b.cueNumber)
        setCues(list)
        setLoaded(true)
        setError(null)
      }, setError),
    [listPath],
  )

  const addCue = useCallback(
    async (cue: Omit<Cue, 'id'>) => {
      const id = push(ref(db, listPath)).key!
      const saved: Cue = { ...cue, id }
      await recordedUpdate({ label: `新增 ${cueName(cue)}`, group: 'cue', updates: { [`${listPath}/${id}`]: saved } })
      return saved
    },
    [listPath],
  )

  /** Overwrite a cue completely (drops any stage-3 legacy fields still stored on it). */
  const saveCue = useCallback(
    (id: string, cue: Omit<Cue, 'id'>) =>
      recordedUpdate({ label: `編輯 ${cueName(cue)}`, group: 'cue', updates: { [`${listPath}/${id}`]: { ...cue, id } }, coalesceKey: `cue:${id}` }),
    [listPath],
  )

  const removeCue = useCallback(
    (id: string) => recordedUpdate({ label: `刪除 ${cueName(byId(id))}`, group: 'cue', updates: { [`${listPath}/${id}`]: null } }),
    [listPath],
  )

  /** Apply the same field changes to many cues in one atomic write. */
  const updateCues = useCallback(
    (ids: string[], changes: Partial<Omit<Cue, 'id'>>) => {
      const updates: Record<string, unknown> = {}
      for (const id of ids) for (const [key, value] of Object.entries(changes)) updates[`${listPath}/${id}/${key}`] = value
      return recordedUpdate({ label: ids.length === 1 ? `編輯 ${cueName(byId(ids[0]))}` : `批次編輯 ${ids.length} 個 Cue`, group: 'cue', updates })
    },
    [listPath],
  )

  /** Delete many cues in one atomic write. */
  const removeCues = useCallback(
    (ids: string[]) =>
      recordedUpdate({
        label: ids.length === 1 ? `刪除 ${cueName(byId(ids[0]))}` : `批次刪除 ${ids.length} 個 Cue`,
        group: 'cue',
        updates: Object.fromEntries(ids.map((id) => [`${listPath}/${id}`, null])),
      }),
    [listPath],
  )

  /** Set cue numbers (id → number) in one atomic write — used by drag reordering and renumbering. */
  const setCueNumbers = useCallback(
    (numbers: Record<string, number>) => {
      const ids = Object.keys(numbers)
      return recordedUpdate({
        label: ids.length === 1 ? `移動 ${cueName(byId(ids[0]))} → Q${numbers[ids[0]]}` : `重新編號 ${ids.length} 個 Cue`,
        group: 'cue',
        updates: Object.fromEntries(Object.entries(numbers).map(([id, n]) => [`${listPath}/${id}/cueNumber`, n])),
      })
    },
    [listPath],
  )

  return { cues, loaded, error, addCue, saveCue, removeCue, updateCues, removeCues, setCueNumbers }
}
