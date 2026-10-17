import { useCallback, useEffect, useState } from 'react'
import { channelId, channelIds, type ChannelConfig } from '../types/channels'

const key = (projectId: string) => `theatre.audienceChannel.${projectId}`

/** Even while switching is locked, a device may correct a wrong pick this long after choosing. */
const GRACE_MS = 10 * 60 * 1000

interface Stored {
  channel: string
  epoch: number
  /** When it was chosen (ms), for the correction grace period. */
  at?: number
}

function read(projectId: string): Stored | null {
  try {
    const raw = localStorage.getItem(key(projectId))
    const v = raw ? (JSON.parse(raw) as Stored) : null
    return v && typeof v.channel === 'string' ? v : null
  } catch {
    return null
  }
}

/** `?group=3` (or `?ch=3`, `?channel=3`): the group this link is meant for, as a channel id. */
export function groupFromUrl(): string | null {
  const q = new URLSearchParams(location.search)
  const n = Number(q.get('group') ?? q.get('ch') ?? q.get('channel'))
  return Number.isInteger(n) && n >= 1 ? channelId(n) : null
}

/**
 * The audience device's group. Remembered per project on this device; it is only valid for the grouping
 * it was chosen under (same group count, same reset "epoch"), so the operator can re-group or reset and
 * every phone is asked again. Without grouping (count 0) the device has no channel.
 */
export function useAudienceChannel(projectId: string, config: ChannelConfig, audienceId: string) {
  const [stored, setStored] = useState<Stored | null>(() => read(projectId))
  // The user tapped "change group": show the full list again (also when the link named a group).
  const [switching, setSwitching] = useState(false)
  const [, setTick] = useState(0)
  // The operator may have placed this device in a group (console → 觀眾分配): that wins over its own pick.
  const assigned = config.count > 0 && channelIds(config.count).includes(config.assign[audienceId] ?? '') ? config.assign[audienceId] : null
  const picked = config.count > 0 && !!stored && stored.epoch === config.epoch && channelIds(config.count).includes(stored.channel)
  const valid = !!assigned || picked
  const channel = config.count > 0 && valid ? (assigned ?? stored!.channel) : null
  // The link's group, if it fits this show's grouping.
  const fromUrl = groupFromUrl()
  const linked = fromUrl && config.count > 0 && channelIds(config.count).includes(fromUrl) ? fromUrl : null

  const choose = useCallback(
    (next: string) => {
      const value = { channel: next, epoch: config.epoch, at: Date.now() }
      try {
        localStorage.setItem(key(projectId), JSON.stringify(value))
      } catch {
        // Not remembered across reloads; harmless.
      }
      setStored(value)
      setSwitching(false)
    },
    [projectId, config.epoch],
  )
  // Switching is open when the operator unlocked it, and always for a few minutes after choosing, so a
  // wrong tap can be corrected.
  // A pick saved before the timestamp existed counts as just made.
  const graceLeft = picked && !assigned ? (stored?.at ? stored.at + GRACE_MS - Date.now() : GRACE_MS) : 0
  const canSwitch = !assigned && picked && (config.open || graceLeft > 0)
  useEffect(() => {
    if (config.open || graceLeft <= 0) return
    const timer = window.setTimeout(() => setTick((t) => t + 1), graceLeft + 50)
    return () => window.clearTimeout(timer)
  }, [config.open, graceLeft])

  const startSwitch = useCallback(() => setSwitching(true), [])
  const cancelSwitch = useCallback(() => setSwitching(false), [])

  return {
    channel,
    needsPick: config.count > 0 && (!valid || (switching && !assigned)),
    /** The picker is open to change an existing choice (offers "keep my group"). */
    switching: valid && switching && !assigned,
    /** Placed in this group by the operator: can't be changed from the device. */
    assigned: !!assigned,
    canSwitch,
    linked: switching ? null : linked,
    choose,
    startSwitch,
    cancelSwitch,
  }
}
