import { ref, remove, set } from 'firebase/database'
import { db } from './firebase'
import type { ShowRef } from "../types/project"

/*
 * Background announcements for the audience. A device that opts in stores its Web Push subscription at
 * projects/{pid}/audiencePush/{audienceId} (with its group), the Worker's /api/push/announce pushes to
 * the matching ones, and sw.js shows the notification with a vibration pattern. The audience isn't
 * signed in, so the subscription is the only thing it writes (shape-checked by the database rules).
 */

const PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined
const BASE = import.meta.env.BASE_URL
const FLAG = 'theatre.audiencePush'
const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

export type AudiencePushStatus = 'unsupported' | 'needs-install' | 'denied' | 'off' | 'on'

export function audiencePushStatus(): AudiencePushStatus {
  if (!PUBLIC_KEY) return 'unsupported'
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return isIos() ? 'needs-install' : 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  let on = false
  try {
    on = localStorage.getItem(FLAG) === '1'
  } catch {
    on = false
  }
  return on && Notification.permission === 'granted' ? 'on' : 'off'
}

const keyBytes = (b64u: string) => Uint8Array.from(atob(b64u.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
const node = (show: ShowRef, audienceId: string) => ref(db, `projects/${show.projectId}/audiencePush/${audienceId}`)

async function store(show: ShowRef, audienceId: string, channel: string, sub: PushSubscription) {
  await set(node(show, audienceId), { sub: sub.toJSON(), channel, updatedAt: Date.now() })
}

/** Call from a tap: asks permission, subscribes, and registers this device under its group. */
export async function enableAudiencePush(show: ShowRef, audienceId: string, channel: string) {
  if (!PUBLIC_KEY) throw new Error('此版本尚未設定推播金鑰')
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('通知權限被拒絕，請到瀏覽器／系統設定開啟')
  const reg = await navigator.serviceWorker.register(`${BASE}sw.js`, { scope: BASE })
  await navigator.serviceWorker.ready
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(PUBLIC_KEY) }))
  await store(show, audienceId, channel, sub)
  try {
    localStorage.setItem(FLAG, '1')
  } catch {
    // Not remembered; harmless.
  }
}

export async function disableAudiencePush(show: ShowRef, audienceId: string) {
  try {
    localStorage.setItem(FLAG, '0')
  } catch {
    // Not remembered; harmless.
  }
  await remove(node(show, audienceId)).catch(() => {})
  const reg = await navigator.serviceWorker.getRegistration(BASE)
  await (await reg?.pushManager.getSubscription())?.unsubscribe().catch(() => {})
}

/** Keep the stored record's group current after the device changes group. */
export async function syncAudiencePush(show: ShowRef, audienceId: string, channel: string) {
  if (audiencePushStatus() !== 'on') return
  const reg = await navigator.serviceWorker.getRegistration(BASE)
  const sub = await reg?.pushManager.getSubscription()
  if (sub) await store(show, audienceId, channel, sub).catch(() => {})
}

/** Operator side: ask the Worker to push an announcement to the opted-in devices of a group. */
export function pushAnnouncement(projectId: string, params: { channel: string; text: string }) {
  fetch('/api/push/announce', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId, ...params }),
  }).catch(() => {})
}
