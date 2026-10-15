import { useEffect, useRef, useState } from 'react'
import { r2Available } from '../services/storage'
import { saveWithHistory, type Summarize, type VersionKind } from '../services/versionHistory'

export type AutoSaveStatus =
  | { phase: 'off' }
  | { phase: 'idle' }
  | { phase: 'pending' }
  | { phase: 'saving' }
  | { phase: 'saved'; at: number }
  | { phase: 'error'; message: string }

const DEBOUNCE_MS = 2000
/** Even while edits keep coming, save at least this often. */
const MAX_WAIT_MS = 15000
const RETRY_MS = 10000

/**
 * Keep a JSON file on R2 in step with live data: after a change (`signature` differs from what
 * was last saved) wait for a pause in editing, then overwrite `key` with `build()`, moving the
 * previous content into the file's embedded version history (see versionHistory.ts). Long editing
 * sessions still save every 15 s; failures retry. If the file doesn't exist yet when the data first
 * loads, it is written straight away. A pending save also goes out when the tab is hidden.
 *
 * `signature` is a cheap string that changes whenever the saved content would (null = not loaded).
 * `saveNow()` saves at once as a manual version. `revision` changes after every write.
 */
export function useR2AutoSave(
  key: string | null,
  signature: string | null,
  build: () => string | Promise<string>,
  summarize: Summarize,
): { status: AutoSaveStatus; saveNow: () => Promise<void>; revision: number } {
  const [status, setStatus] = useState<AutoSaveStatus>({ phase: 'idle' })
  const [revision, setRevision] = useState(0)
  const s = useRef({ key, signature, build, summarize, saved: null as string | null, ready: false, timer: 0, firstPending: 0, saving: false })
  s.current.signature = signature
  s.current.build = build
  s.current.summarize = summarize

  // New file (another studio / show): start over.
  useEffect(() => {
    const st = s.current
    st.key = key
    st.saved = null
    st.ready = false
    st.firstPending = 0
    clearTimeout(st.timer)
    if (!key) return
    let cancelled = false
    r2Available().then(async (on) => {
      if (cancelled) return
      if (!on) return setStatus({ phase: 'off' })
      // Does the file exist? If so, the data as loaded counts as saved.
      const head = await fetch(`/api/r2/o/${key.split('/').map(encodeURIComponent).join('/')}`, { method: 'HEAD', cache: 'no-store' }).catch(() => null)
      if (cancelled) return
      st.ready = true
      if (head?.ok) {
        st.saved = '__existing__'
        setStatus({ phase: 'saved', at: Date.parse(head.headers.get('last-modified') ?? '') || Date.now() })
      }
      kick()
    })
    return () => {
      cancelled = true
      clearTimeout(st.timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  async function save(kind: VersionKind = 'auto') {
    const st = s.current
    if (!st.key || st.signature === null || st.saving) return
    const sig = st.signature
    const forKey = st.key
    st.saving = true
    setStatus({ phase: 'saving' })
    try {
      const body = await st.build()
      const wrote = await saveWithHistory(forKey, JSON.parse(body), { kind, summarize: st.summarize })
      if (st.key !== forKey) return
      st.saved = sig
      st.firstPending = 0
      setStatus({ phase: 'saved', at: Date.now() })
      if (wrote) setRevision((r) => r + 1)
    } catch (err) {
      if (st.key !== forKey) return
      setStatus({ phase: 'error', message: (err as Error).message })
      clearTimeout(st.timer)
      st.timer = window.setTimeout(() => save(), RETRY_MS)
      return
    } finally {
      st.saving = false
    }
    kick()
  }

  /** Schedule a save if the data differs from what was saved. */
  function kick() {
    const st = s.current
    if (!st.ready || st.signature === null) return
    if (st.saved === '__existing__') {
      // First data after opening an existing file: that's the baseline, not an edit.
      st.saved = st.signature
      return
    }
    if (st.signature === st.saved || st.saving) return
    setStatus({ phase: 'pending' })
    const now = Date.now()
    st.firstPending ||= now
    clearTimeout(st.timer)
    const wait = st.saved === null ? 0 : Math.max(0, Math.min(DEBOUNCE_MS, st.firstPending + MAX_WAIT_MS - now))
    st.timer = window.setTimeout(() => save(), wait)
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => kick(), [signature])

  // Tab hidden (switching away, closing) with unsaved edits: save right away rather than after
  // the pause. (A save has to read the file to keep its history, so it can't be a keepalive beacon.)
  useEffect(() => {
    const flush = () => {
      const st = s.current
      if (document.visibilityState !== 'hidden' || !st.ready || st.signature === null || st.signature === st.saved || st.saved === '__existing__') return
      clearTimeout(st.timer)
      save()
    }
    document.addEventListener('visibilitychange', flush)
    return () => document.removeEventListener('visibilitychange', flush)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const saveNow = async () => {
    clearTimeout(s.current.timer)
    await save('manual')
  }

  return { status, saveNow, revision }
}
