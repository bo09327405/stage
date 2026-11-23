import { getAuth } from 'firebase/auth'
import { app } from './firebase'

/**
 * Static hosting (GitHub Pages) has no /api. When VITE_API_BASE points at the Cloudflare Worker,
 * every "/api/r2/…" address — fetches and the media/image URLs stored in project data — is sent
 * there instead, and fetches carry the signed-in user's ID token as a Bearer header (the Worker
 * is cross-origin, so the theatre_id cookie can't reach it). Media files stay readable by URL.
 * Without VITE_API_BASE (dev server) this does nothing.
 */
const BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/+$/, '')
/** Served by the Worker: file storage, the Notion page reader and text-to-speech. */
// On the dev server the local proxies for these two work (and know the local keys / model), so only
// the hosted build sends them to the Worker.
const PREFIXES = import.meta.env.DEV ? ['/api/r2/', '/api/live/'] : ['/api/r2/', '/api/notion', '/api/tts', '/api/push/', '/api/live/']
const isApiPath = (path: string) => PREFIXES.some((p) => path.startsWith(p))

/**
 * "/api/r2/…" → the Worker (exported for code that loads files without `fetch(string)` or an element's
 * `src`, e.g. the Three.js loaders). Also fixes full addresses saved while developing (a LAN / ngrok host in
 * front of the same path) so old library entries still resolve.
 */
export const apiUrl = (u: string) => {
  if (!BASE) return u
  if (isApiPath(u)) return BASE + u
  if (/^https?:\/\//i.test(u) && !u.startsWith(BASE)) {
    try {
      const x = new URL(u)
      if (isApiPath(x.pathname)) return BASE + x.pathname + x.search
    } catch {
      /* not a URL */
    }
  }
  return u
}

/** The browser's own `src` setters, kept from before they are patched below. */
const nativeSrc = new Map<object, (this: unknown, v: string) => void>()

/**
 * Assign `src` exactly as given, without sending "/api/r2/…" to the Worker — for code that picks the address
 * itself (the XR loaders read through the dev server first: see xrAssets.ts).
 */
export function setSrcAsIs(el: HTMLImageElement | HTMLMediaElement, url: string) {
  const proto = el instanceof HTMLImageElement ? HTMLImageElement.prototype : HTMLMediaElement.prototype
  const set = nativeSrc.get(proto)
  if (set) set.call(el, url)
  else el.src = url
}

if (BASE) {
  const auth = getAuth(app)
  const nativeFetch = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = typeof input === 'string' ? apiUrl(input) : ''
    if (typeof input !== 'string' || !isApiPath(target.slice(BASE.length)) || !target.startsWith(BASE)) return nativeFetch(input, init)
    const headers = new Headers(init?.headers)
    try {
      const token = await auth.currentUser?.getIdToken()
      if (token && !headers.has('authorization')) headers.set('authorization', `Bearer ${token}`)
    } catch {
      /* signed out: the Worker treats it as anonymous */
    }
    try {
      const res = await nativeFetch(target, { ...init, headers, credentials: 'omit' })
      if (!res.ok) console.warn(`[R2] ${init?.method ?? 'GET'} ${target} → HTTP ${res.status}`)
      return res
    } catch (err) {
      // "Failed to fetch" alone says nothing: name the address (CORS, offline, blocked or wrong host).
      if ((err as Error).name !== 'AbortError') console.error(`[R2] ${init?.method ?? 'GET'} ${target} failed from ${location.origin}:`, err)
      throw err instanceof TypeError ? new TypeError(`${err.message}（${target}）`) : err
    }
  }

  // Media / image elements: React and the audio engine assign stored "/api/r2/o/…" strings to src.
  const patchSrc = (proto: object) => {
    const d = Object.getOwnPropertyDescriptor(proto, 'src')
    if (!d?.set) return
    nativeSrc.set(proto, d.set)
    Object.defineProperty(proto, 'src', { ...d, set(this: unknown, v: string) { d.set!.call(this, apiUrl(String(v))) } })
  }
  patchSrc(HTMLMediaElement.prototype)
  patchSrc(HTMLImageElement.prototype)
  const setAttr = Element.prototype.setAttribute
  Element.prototype.setAttribute = function (name: string, value: string) {
    return setAttr.call(this, name, name === 'src' || name === 'href' ? apiUrl(String(value)) : value)
  }
  const NativeAudio = window.Audio
  window.Audio = function (src?: string) {
    const el = new NativeAudio()
    if (src !== undefined) el.src = src
    return el
  } as unknown as typeof Audio
  window.Audio.prototype = NativeAudio.prototype
}
