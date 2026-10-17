import { useCallback, useState } from 'react'
import { channelId, channelIds, type ChannelConfig } from '../types/channels'

const key = (projectId: string) => `theatre.audienceChannel.${projectId}`

interface Stored {
  channel: string
  epoch: number
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
export function useAudienceChannel(projectId: string, config: ChannelConfig) {
  const [stored, setStored] = useState<Stored | null>(() => read(projectId))
  const valid = config.count > 0 && !!stored && stored.epoch === config.epoch && channelIds(config.count).includes(stored.channel)
  const channel = config.count > 0 && valid ? stored!.channel : null
  // The link's group, if it fits this show's grouping.
  const fromUrl = groupFromUrl()
  const linked = fromUrl && config.count > 0 && channelIds(config.count).includes(fromUrl) ? fromUrl : null

  const choose = useCallback(
    (next: string) => {
      const value = { channel: next, epoch: config.epoch }
      try {
        localStorage.setItem(key(projectId), JSON.stringify(value))
      } catch {
        // Not remembered across reloads; harmless.
      }
      setStored(value)
    },
    [projectId, config.epoch],
  )
  /** Back to the group picker (only offered while the operator has unlocked switching). */
  const forget = useCallback(() => {
    try {
      localStorage.removeItem(key(projectId))
    } catch {
      // Harmless.
    }
    setStored(null)
  }, [projectId])

  return { channel, needsPick: config.count > 0 && !valid, linked, choose, forget }
}
