import { onDisconnect, onValue, push, ref, runTransaction, set } from 'firebase/database'
import { useCallback, useEffect, useRef, useState } from 'react'
import { migrateAction } from '../types/actions'
import type { GlobalTrigger, TriggerMatch } from '../types/trigger'
import { db } from './firebase'
import { recordedUpdate } from './history'

/* ---------- Global Profile: projects/{pid}/triggers/{id} ---------- */

const triggersPath = (projectId: string) => `projects/${projectId}/triggers`

let lastOrder = 0
/** Strictly increasing sort key, so rules added in the same millisecond keep their sequence. */
const nextOrder = () => (lastOrder = Math.max(lastOrder + 1, Date.now()))

export function useGlobalTriggers(projectId: string) {
  const [triggers, setTriggers] = useState<GlobalTrigger[]>([])
  useEffect(
    () =>
      onValue(ref(db, triggersPath(projectId)), (snapshot) => {
        const raw = (snapshot.val() ?? {}) as Record<string, Omit<GlobalTrigger, 'id'> & { order?: number }>
        setTriggers(
          Object.entries(raw)
            .sort(([, a], [, b]) => (a.order ?? 0) - (b.order ?? 0))
            .map(([id, t]) => ({ id, enabled: t.enabled ?? true, match: t.match, action: migrateAction(t.action) })),
        )
      }),
    [projectId],
  )
  return triggers
}

export async function addGlobalTrigger(projectId: string, match: TriggerMatch) {
  const id = push(ref(db, triggersPath(projectId))).key!
  await recordedUpdate({
    label: `新增 ${match.source.toUpperCase()} 觸發規則`,
    group: 'trigger',
    updates: { [`${triggersPath(projectId)}/${id}`]: { enabled: true, match, action: 'go', order: nextOrder() } },
  })
}

/** Append a complete rule (used when importing a layout file's Global Profile). */
export async function addGlobalTriggerFull(projectId: string, trigger: Omit<GlobalTrigger, 'id'>) {
  const id = push(ref(db, triggersPath(projectId))).key!
  await recordedUpdate({ label: '匯入觸發規則', group: 'trigger', updates: { [`${triggersPath(projectId)}/${id}`]: { ...trigger, order: nextOrder() } } })
}

/** Save a rule's fields; its position in the list (order) is kept. */
export function saveGlobalTrigger(projectId: string, trigger: GlobalTrigger) {
  const { id, ...rest } = trigger
  return recordedUpdate({
    label: '編輯觸發規則',
    group: 'trigger',
    updates: Object.fromEntries(Object.entries(rest).map(([k, v]) => [`${triggersPath(projectId)}/${id}/${k}`, v])),
    coalesceKey: `trigger:${id}`,
  })
}

/**
 * Persist a new rule order in one atomic write (order 1, 2, 3 … in list order), so every device
 * and every reload sees the same sequence.
 */
export function reorderGlobalTriggers(projectId: string, orderedIds: string[]) {
  const updates: Record<string, number> = {}
  orderedIds.forEach((id, i) => (updates[`${triggersPath(projectId)}/${id}/order`] = i + 1))
  lastOrder = Math.max(lastOrder, Date.now())
  return recordedUpdate({ label: '調整觸發規則順序', group: 'trigger', updates })
}

export function removeGlobalTrigger(projectId: string, id: string) {
  return recordedUpdate({ label: '刪除觸發規則', group: 'trigger', updates: { [`${triggersPath(projectId)}/${id}`]: null } })
}

/* ---------- Trigger host election: {versionPath}/triggerHost ---------- */

/**
 * Every console/surface tab receives every OSC message the bridge forwards (and every tab on the
 * same computer sees the same MIDI). Only one tab per show version may act on them, or a single
 * "/sys/go" would GO several times. That tab is the trigger host.
 */
const TAB_ID = Math.random().toString(36).slice(2, 10)

/** Stable per browser profile: MIDI hardware belongs to a machine, not to a tab. */
const MACHINE_ID = (() => {
  try {
    const existing = localStorage.getItem('theatre.machineId')
    if (existing) return existing
    const id = Math.random().toString(36).slice(2, 10)
    localStorage.setItem('theatre.machineId', id)
    return id
  } catch {
    return TAB_ID
  }
})()

export interface TriggerHost {
  tabId: string
  /** Absent on records written by older builds. */
  machineId?: string
  label: string
  at: number
}

export function useTriggerHost(basePath: string, label: string) {
  const [host, setHost] = useState<TriggerHost | null | undefined>(undefined)
  const hostPath = `${basePath}/triggerHost`
  // Whether this tab currently has an onDisconnect cleanup registered for the host record.
  const armed = useRef(false)

  const claim = useCallback(
    async (force: boolean) => {
      const node = ref(db, hostPath)
      const record: TriggerHost = { tabId: TAB_ID, machineId: MACHINE_ID, label, at: Date.now() }
      if (force) {
        await set(node, record)
      } else {
        const { committed } = await runTransaction(node, (current: TriggerHost | null) =>
          !current || current.tabId === TAB_ID ? record : undefined,
        )
        if (!committed) return
      }
      // If this tab vanishes, free the slot for another tab.
      await onDisconnect(node).remove()
      armed.current = true
    },
    [hostPath, label],
  )

  useEffect(() => onValue(ref(db, hostPath), (snapshot) => setHost(snapshot.val())), [hostPath])

  // Auto-claim whenever the slot is free; stand down cleanly when another tab takes over.
  useEffect(() => {
    if (host === undefined) return
    if (host === null) {
      claim(false).catch(() => {})
    } else if (host.tabId !== TAB_ID && armed.current) {
      // Our onDisconnect must not delete the new host's record.
      onDisconnect(ref(db, hostPath)).cancel().catch(() => {})
      armed.current = false
    }
  }, [host, claim, hostPath])

  // Release on unmount.
  useEffect(
    () => () => {
      const node = ref(db, hostPath)
      runTransaction(node, (current: TriggerHost | null) => (current?.tabId === TAB_ID ? null : undefined)).catch(() => {})
      onDisconnect(node).cancel().catch(() => {})
    },
    [hostPath],
  )

  return {
    host: host ?? null,
    isHost: host?.tabId === TAB_ID,
    /** The host tab runs on this computer (so it hears the same MIDI hardware). */
    hostOnThisMachine: host?.machineId === MACHINE_ID,
    takeOver: () => claim(true).catch(() => {}),
  }
}

/**
 * Leader among the tabs of this browser for `name` (Web Locks: the first tab holds the lock; the
 * next one takes over when it closes). MIDI only reaches the computer the controller is plugged
 * into, so when the trigger host is on another machine, the local leader acts on local MIDI.
 * Without the Locks API (plain-http LAN pages) every tab counts as leader.
 */
export function useLocalLeader(name: string) {
  const supported = typeof navigator !== 'undefined' && 'locks' in navigator
  const [leader, setLeader] = useState(!supported)

  useEffect(() => {
    if (!supported) return
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => (release = resolve))
    const abort = new AbortController()
    navigator.locks
      .request(name, { signal: abort.signal }, async () => {
        setLeader(true)
        await held
      })
      .catch(() => {})
    return () => {
      abort.abort()
      release()
      setLeader(false)
    }
  }, [name, supported])

  return leader
}
