import { GoogleAuthProvider, getAuth, onAuthStateChanged, onIdTokenChanged, signInWithPopup, signInWithRedirect, signOut, type User } from 'firebase/auth'
import { ref, serverTimestamp, update } from 'firebase/database'
import { useSyncExternalStore } from 'react'
import { app, db } from './firebase'

/*
 * Google sign-in for the operator side (hub, Set Cue console, control panel, DAW Studio). The
 * audience view never needs it. Any Google account may sign in; the accounts in
 * VITE_ADMIN_EMAILS see every project.
 */

export interface AppUser {
  uid: string
  name: string
  email: string
  photo: string
}

export const auth = getAuth(app)

const ADMIN_EMAILS = String(import.meta.env.VITE_ADMIN_EMAILS ?? '')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean)
export const isAdmin = (user: AppUser | null | undefined) => !!user && ADMIN_EMAILS.includes(user.email.toLowerCase())

/**
 * Development only, on this computer only: a signed-in identity set in localStorage
 * ("theatre.testUser"), so automated tests can run without a real Google popup. Never active
 * in a production build or when the dev server is reached through any other host name.
 */
function testUser(): AppUser | null {
  if (!import.meta.env.DEV || !['localhost', '127.0.0.1'].includes(location.hostname)) return null
  try {
    const raw = localStorage.getItem('theatre.testUser')
    const u = raw ? (JSON.parse(raw) as Partial<AppUser>) : null
    return u?.uid && u.email ? { uid: u.uid, email: u.email, name: u.name ?? u.email, photo: u.photo ?? '' } : null
  } catch {
    return null
  }
}

const toAppUser = (u: User | null): AppUser | null =>
  u ? { uid: u.uid, name: u.displayName || u.email || 'Google 使用者', email: u.email ?? '', photo: u.photoURL ?? '' } : null

type State = { user: AppUser | null; ready: boolean }
let state: State = { user: testUser(), ready: !!testUser() }
const listeners = new Set<() => void>()
const set = (next: State) => {
  state = next
  listeners.forEach((l) => l())
}

onAuthStateChanged(auth, (u) => {
  const user = testUser() ?? toAppUser(u)
  set({ user, ready: true })
  if (user) {
    // A profile others can see (collaborator lists, activity log).
    update(ref(db, `users/${user.uid}`), { name: user.name, email: user.email, photo: user.photo, lastSeen: serverTimestamp() }).catch(() => {})
  }
})

// The dev server's file storage (/api/r2) checks access with the same database rules, as the
// signed-in user: their ID token rides along as a cookie, so <audio src> and plain fetches carry
// it too. Firebase refreshes the token hourly and this keeps the cookie in step.
onIdTokenChanged(auth, async (u) => {
  try {
    const token = u ? await u.getIdToken() : null
    document.cookie = token
      ? `theatre_id=${encodeURIComponent(token)}; path=/api; max-age=3600; SameSite=Strict${location.protocol === 'https:' ? '; Secure' : ''}`
      : 'theatre_id=; path=/api; max-age=0; SameSite=Strict'
  } catch {
    // No cookie: the server treats the request as signed out.
  }
})

/** The signed-in operator right now (null when signed out or still loading). */
export const currentUser = () => state.user

export function useAuth() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => state,
  )
}

/** Readable message for sign-in failures. */
function explain(err: unknown): string {
  const code = (err as { code?: string }).code ?? ''
  if (code === 'auth/unauthorized-domain') return `這個網址（${location.hostname}）還沒加入 Firebase 的「已授權網域」，請到 Firebase Console → Authentication → Settings 加入`
  if (code === 'auth/operation-not-allowed') return 'Firebase 尚未啟用 Google 登入'
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return '登入視窗已關閉'
  if (code === 'auth/network-request-failed') return '網路連線失敗，請稍後再試'
  return (err as Error).message || '登入失敗'
}

/** Sign in with Google: a popup, or a full-page redirect where popups are blocked. */
export async function signInWithGoogle() {
  const provider = new GoogleAuthProvider()
  provider.setCustomParameters({ prompt: 'select_account' })
  try {
    await signInWithPopup(auth, provider)
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment') return signInWithRedirect(auth, provider)
    throw new Error(explain(err))
  }
}

export async function signOutUser() {
  try {
    localStorage.removeItem('theatre.testUser')
  } catch {
    // ignore
  }
  await signOut(auth)
  set({ user: null, ready: true })
}

/** Who did something, as stored in activity logs and version histories. */
export const byUser = (u: AppUser | null = state.user) => (u ? { uid: u.uid, name: u.name, email: u.email, photo: u.photo } : null)
