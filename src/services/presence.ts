import { onDisconnect, onValue, ref, remove, serverTimestamp, set } from 'firebase/database'
import { useEffect, useState } from 'react'
import { versionPath, type ShowRef } from '../types/project'
import { db } from './firebase'

export interface PresenceEntry {
  audienceId: string
  joinedAt: number
  /** The audience group (channel_n) this device chose, when the show is grouped. */
  channel?: string
}

/** Audience side: announce this device under the version's presence node while connected. */
export function useAnnouncePresence(show: ShowRef | null, audienceId: string, channel: string | null = null) {
  const projectId = show?.projectId
  const versionId = show?.versionId

  useEffect(() => {
    if (!projectId || !versionId) return
    const node = ref(db, `${versionPath({ projectId, versionId })}/presence/${audienceId}`)
    // Re-announce on every reconnect: onDisconnect handlers are consumed when they fire.
    const unsub = onValue(ref(db, '.info/connected'), (snapshot) => {
      if (snapshot.val() !== true) return
      onDisconnect(node)
        .remove()
        .then(() => set(node, { joinedAt: serverTimestamp(), ...(channel ? { channel } : {}) }))
        .catch(() => {})
    })
    return () => {
      unsub()
      onDisconnect(node).cancel().catch(() => {})
      remove(node).catch(() => {})
    }
  }, [projectId, versionId, audienceId, channel])
}

/** Console side: audience codes currently connected to this version. */
export function usePresence(basePath: string): PresenceEntry[] {
  const [entries, setEntries] = useState<PresenceEntry[]>([])
  useEffect(
    () =>
      onValue(ref(db, `${basePath}/presence`), (snapshot) => {
        const raw = (snapshot.val() ?? {}) as Record<string, { joinedAt: number; channel?: string }>
        setEntries(
          Object.entries(raw)
            .map(([audienceId, v]) => ({ audienceId, joinedAt: v.joinedAt, ...(v.channel ? { channel: v.channel } : {}) }))
            .sort((a, b) => a.audienceId.localeCompare(b.audienceId)),
        )
      }),
    [basePath],
  )
  return entries
}
