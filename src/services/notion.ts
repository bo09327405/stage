import { useCallback, useEffect, useRef, useState } from 'react'
import type { NotionError, NotionPage } from '../types/notion'

/* ---------- URL recognition ---------- */

const HOST = /(^|\.)notion\.(so|site|com)$/i
const HEX32 = /[0-9a-f]{32}/gi
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

export interface NotionRef {
  /** 32-hex page id */
  id: string
  /** The link as the user gave it (to open in Notion). */
  url: string
}

/**
 * Recognise a Notion page link: notion.so / www.notion.so / app.notion.com / <name>.notion.site,
 * with the page id at the end of the path ("Title-<32 hex>") or in ?p= (pages opened as a peek).
 * Returns null for anything else.
 */
export function parseNotionUrl(input: string): NotionRef | null {
  const match = input.trim().match(/https?:\/\/[^\s<>"'）)]+/i) ?? (/^[\w.-]*notion\.(so|site|com)\//i.test(input.trim()) ? [`https://${input.trim()}`] : null)
  if (!match) return null
  let url: URL
  try {
    url = new URL(match[0])
  } catch {
    return null
  }
  if (!HOST.test(url.hostname)) return null
  const fromParam = url.searchParams.get('p')
  const candidates = [fromParam ?? '', url.pathname].join(' ')
  const hex = candidates.match(HEX32)?.[0] ?? candidates.match(UUID)?.[0]?.replace(/-/g, '')
  if (!hex) return null
  return { id: hex.toLowerCase(), url: url.toString() }
}

/** True when the whole text is a single Notion page link (a paste that means "show this page"). */
export const isOnlyNotionUrl = (text: string) => /^\S+$/.test(text.trim()) && parseNotionUrl(text) !== null

/* ---------- loading ---------- */

export type NotionState =
  | { status: 'idle' }
  | { status: 'loading' }
  | {
      status: 'ready'
      page: NotionPage
      refreshing: boolean
      /** Some synced / nested blocks are still missing and another attempt is scheduled. */
      syncing: boolean
      /** The last refresh failed; the page shown is the previous copy. */
      refreshError?: NotionError
    }
  | { status: 'error'; error: NotionError; retrying: boolean }

/** Automatic retries when synced blocks came back empty (they often load on a second try). */
const SYNC_RETRY_MS = [2500, 5000, 10000]
/** Automatic retries after a rate limit or a network hiccup. */
const ERROR_RETRY_MS = [8000, 15000, 30000]
const AUTO_REFRESH_MS = 120_000
// One request per page at a time, shared by every view showing it (panel + note buttons).
const inflight = new Map<string, Promise<NotionPage>>()

/**
 * The preview is rendered by a server-side proxy (/api/notion in the dev / preview server). On static
 * hosting (GitHub Pages) there is none: the path 404s or answers with the site's HTML. That is not an
 * error to retry — it is "this environment has no preview", shown as a friendly card with an
 * "open in Notion" button. Remembered so the page isn't asked again until the user taps retry.
 */
const UNAVAILABLE: NotionError = {
  error: 'preview_unavailable',
  message: '這個環境沒有 Notion 預覽服務（預覽需要在本機以 npm run dev 開啟）。你仍然可以在 Notion 直接開啟這個頁面。',
}
let previewUnavailable = false
const staticHost = () => /\.github\.io$|\.pages\.dev$|\.netlify\.app$/i.test(location.hostname)

async function fetchPage(id: string): Promise<NotionPage> {
  if (previewUnavailable) throw UNAVAILABLE
  const running = inflight.get(id)
  if (running) return running
  const job = (async () => {
    let res: Response
    try {
      res = await fetch(`/api/notion?id=${id}`)
    } catch {
      if (staticHost()) {
        previewUnavailable = true
        throw UNAVAILABLE
      }
      throw { error: 'unreachable', message: '無法連線到預覽服務，請確認 npm run dev 仍在執行' } satisfies NotionError
    }
    const body = (await res.json().catch(() => null)) as NotionPage | NotionError | null
    if (!body || res.status === 404 || res.status === 405) {
      // Not JSON (the host's HTML 404 page) or no such route: there is no preview server here.
      if (!body || staticHost()) {
        previewUnavailable = true
        throw UNAVAILABLE
      }
    }
    if (!body) throw { error: 'unreachable', message: `預覽服務沒有回應（HTTP ${res.status}）。` } satisfies NotionError
    if ('error' in body) throw body
    return body
  })()
  inflight.set(id, job)
  try {
    return await job
  } finally {
    inflight.delete(id)
  }
}

type LoadResult = { id: string; nonce: number; page?: NotionPage; error?: NotionError; willRetry: boolean }

/**
 * Load a public Notion page for preview. Refreshes every 2 minutes while shown; retries on its own
 * (a few times, backing off) when synced blocks are still missing or Notion is busy, keeping the
 * last good copy on screen meanwhile.
 */
export function useNotionPage(url: string) {
  const ref = parseNotionUrl(url)
  const id = ref?.id ?? null
  // Bumped by refresh(), retries and the auto-refresh timer; each value is one load.
  const [nonce, setNonce] = useState(0)
  // The latest finished load (which page, which load, and its outcome).
  const [result, setResult] = useState<LoadResult | null>(null)
  // Automatic retries used so far for the current page.
  const retries = useRef({ id: null as string | null, n: 0 })

  useEffect(() => {
    if (!id) return
    if (retries.current.id !== id) retries.current = { id, n: 0 }
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const bump = () => setNonce((n) => n + 1)
    /** Schedule the next load: a quick retry while attempts remain, else the regular refresh. */
    const next = (delays: number[] | null) => {
      const n = retries.current.n
      if (delays && n < delays.length) {
        retries.current.n = n + 1
        timer = setTimeout(bump, delays[n])
        return true
      }
      if (!delays) retries.current.n = 0
      timer = setTimeout(bump, AUTO_REFRESH_MS)
      return false
    }
    fetchPage(id).then(
      (page) => {
        if (cancelled) return
        const willRetry = next(page.unresolved > 0 ? SYNC_RETRY_MS : null)
        setResult({ id, nonce, page, willRetry })
      },
      (error: NotionError) => {
        if (cancelled) return
        const willRetry = next(error.error === 'rate_limited' || error.error === 'unreachable' ? ERROR_RETRY_MS : null)
        // A failed refresh keeps showing the copy we already have.
        setResult((prev) => (prev?.id === id && prev.page ? { ...prev, nonce, error, willRetry } : { id, nonce, error, willRetry }))
      },
    )
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [id, nonce])

  // Derived: a different page shows "loading"; a newer load of the same page keeps the old content.
  let state: NotionState
  if (!id) state = { status: 'idle' }
  else if (!result || result.id !== id) state = { status: 'loading' }
  else if (result.page)
    state = {
      status: 'ready',
      page: result.page,
      refreshing: result.nonce !== nonce,
      syncing: result.willRetry && result.page.unresolved > 0,
      refreshError: result.error,
    }
  else if (result.nonce !== nonce) state = { status: 'loading' } // retrying after an error
  else state = { status: 'error', error: result.error!, retrying: result.willRetry }

  const refresh = useCallback(() => {
    previewUnavailable = false // retry = ask once more
    retries.current.n = 0
    setNonce((n) => n + 1)
  }, [])
  return { ref, state, refresh }
}
