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
const PREFIX = '/api/r2/'

/**
 * "/api/r2/…" → the Worker. Also fixes full addresses saved while developing (a LAN / ngrok host in
 * front of the same path) so old library entries still resolve.
 */
const rewrite = (u: string) => {
  if (!BASE) return u
  if (u.startsWith(PREFIX)) return BASE + u
  if (/^https?:\/\//i.test(u) && !u.startsWith(BASE)) {
    try {
      const x = new URL(u)
      if (x.pathname.startsWith(PREFIX)) return BASE + x.pathname + x.search
    } catch {
      /* not a URL */
    }
  }
  return u
}

if (BASE) {
  const auth = getAuth(app)
  const nativeFetch = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = typeof input === 'string' ? rewrite(input) : ''
    if (typeof input !== 'string' || !target.startsWith(BASE + PREFIX)) return nativeFetch(input, init)
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
    Object.defineProperty(proto, 'src', { ...d, set(this: unknown, v: string) { d.set!.call(this, rewrite(String(v))) } })
  }
  patchSrc(HTMLMediaElement.prototype)
  patchSrc(HTMLImageElement.prototype)
  const setAttr = Element.prototype.setAttribute
  Element.prototype.setAttribute = function (name: string, value: string) {
    return setAttr.call(this, name, name === 'src' || name === 'href' ? rewrite(String(value)) : value)
  }
  const NativeAudio = window.Audio
  window.Audio = function (src?: string) {
    const el = new NativeAudio()
    if (src !== undefined) el.src = src
    return el
  } as unknown as typeof Audio
  window.Audio.prototype = NativeAudio.prototype
}
