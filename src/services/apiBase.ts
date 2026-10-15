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

const rewrite = (u: string) => (BASE && u.startsWith(PREFIX) ? BASE + u : u)

if (BASE) {
  const auth = getAuth(app)
  const nativeFetch = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input !== 'string' || !input.startsWith(PREFIX)) return nativeFetch(input, init)
    const headers = new Headers(init?.headers)
    try {
      const token = await auth.currentUser?.getIdToken()
      if (token && !headers.has('authorization')) headers.set('authorization', `Bearer ${token}`)
    } catch {
      /* signed out: the Worker treats it as anonymous */
    }
    return nativeFetch(rewrite(input), { ...init, headers, credentials: 'omit' })
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
