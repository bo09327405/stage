import { ref, remove, set } from 'firebase/database'
import { db } from './firebase'

/*
 * Background CALL alerts. A device that opts in registers a Web Push subscription (via the service
 * worker in public/sw.js) under projects/{pid}/intercom/push/{deviceId}. When someone rings CALL, the
 * Worker (/api/push/call) pushes to those devices, so a phone whose web app is in the background or
 * locked still buzzes: Android with the vibration pattern in sw.js, iPhone / iPad (web app added to the
 * Home Screen, iOS 16.4+) with the system notification alert.
 */

const PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined
const DEVICE_KEY = 'theatre.pushDeviceId'
const ENABLED_KEY = 'theatre.callPush'
const BASE = import.meta.env.BASE_URL

export type PushStatus = 'unsupported' | 'needs-install' | 'denied' | 'off' | 'on'

const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

export function pushStatus(): PushStatus {
  if (typeof window === 'undefined' || !PUBLIC_KEY) return 'unsupported'
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    // iOS only exposes push to web apps added to the Home Screen.
    return isIos() ? 'needs-install' : 'unsupported'
  }
  if (Notification.permission === 'denied') return 'denied'
  return readEnabled() && Notification.permission === 'granted' ? 'on' : 'off'
}

function readEnabled() {
  try {
    return localStorage.getItem(ENABLED_KEY) === '1'
  } catch {
    return false
  }
}
function writeEnabled(on: boolean) {
  try {
    localStorage.setItem(ENABLED_KEY, on ? '1' : '0')
  } catch {
    // Not remembered; harmless.
  }
}

/** A stable id for this browser (the Intercom member id changes on every page load). */
export function deviceId() {
  try {
    let id = localStorage.getItem(DEVICE_KEY)
    if (!id) {
      id = `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
      localStorage.setItem(DEVICE_KEY, id)
    }
    return id
  } catch {
    return `d${Math.random().toString(36).slice(2, 10)}`
  }
}

const keyBytes = (b64u: string) => Uint8Array.from(atob(b64u.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))

async function registration() {
  const reg = await navigator.serviceWorker.register(`${BASE}sw.js`, { scope: BASE })
  await navigator.serviceWorker.ready
  return reg
}

export interface PushInfo {
  memberId: string
  name: string
  role: string
  channel: string
}

/** Where this device's subscription lives. */
const recordRef = (base: string) => ref(db, `${base}/push/${deviceId()}`)

async function publish(base: string, sub: PushSubscription, info: PushInfo) {
  await set(recordRef(base), { sub: sub.toJSON(), ...info, updatedAt: Date.now() })
}

/** Ask for notification permission (call from a tap), subscribe and register this device for the project. */
export async function enableCallPush(base: string, info: PushInfo) {
  if (!PUBLIC_KEY) throw new Error('此版本尚未設定推播金鑰')
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new Error('通知權限被拒絕，請到瀏覽器／系統設定開啟通知')
  const reg = await registration()
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(PUBLIC_KEY) }))
  await publish(base, sub, info)
  writeEnabled(true)
}

export async function disableCallPush(base: string) {
  writeEnabled(false)
  await remove(recordRef(base)).catch(() => {})
  const reg = await navigator.serviceWorker.getRegistration(BASE)
  await (await reg?.pushManager.getSubscription())?.unsubscribe().catch(() => {})
}

/** Keep the stored record current (member id for direct calls, channel for the party line). */
export async function syncCallPush(base: string, info: PushInfo) {
  if (pushStatus() !== 'on') return
  const reg = await navigator.serviceWorker.getRegistration(BASE)
  const sub = await reg?.pushManager.getSubscription()
  if (sub) await publish(base, sub, info).catch(() => {})
}

/**
 * Push a test notification to this device only and report what happened, so a phone that "never buzzes"
 * can be diagnosed: not registered, rejected by the push service (HTTP status), or sent (then the phone's
 * own notification / focus / battery settings decide).
 */
export async function testCallPush(projectId: string): Promise<string> {
  const res = await fetch('/api/push/call', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId, fromDevice: deviceId(), target: '*', channel: 'all', name: 'Intercom', role: '', test: true }),
  })
  if (!res.ok) throw new Error(res.status === 401 ? '請先登入' : res.status === 403 ? '你不是此專案成員' : `推播伺服器回應 ${res.status}`)
  const r = (await res.json()) as { sent?: number; registered?: number; statuses?: number[]; reason?: string }
  if (r.reason === 'push_not_configured') throw new Error('伺服器尚未設定推播金鑰')
  if (!r.registered) throw new Error('這台裝置還沒有登記推播訂閱：請先關閉再重新開啟「背景震動通知」')
  if (!r.sent) throw new Error(`推播服務拒絕了這則通知（HTTP ${(r.statuses ?? []).join(', ') || '無回應'}）：請關閉再重新開啟背景震動通知`)
  return '已送出測試通知：把 App 切到背景或鎖屏，幾秒內應該會收到'
}

/** Ask the Worker to push this CALL to the other opted-in devices. Fire and forget. */
export function ringCallPush(projectId: string, params: { target: string; channel: string; name: string; role: string }) {
  fetch('/api/push/call', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId, fromDevice: deviceId(), ...params }),
  }).catch(() => {})
}
