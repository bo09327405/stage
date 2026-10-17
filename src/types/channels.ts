/*
 * Audience channel groups. A show can split its audience into 2–10 groups (Ch 1 … Ch 10); cues can be
 * aimed at some of them, and announcements can go to one group or everybody. This is separate from the
 * crew Intercom (types/intercom.ts), which audience devices can never join.
 */

export const MAX_CHANNELS = 10
/** Global channel: every audience device, whatever its group. */
export const CHANNEL_ALL = 'channel_all'
/** Value in Cue.targetChannels meaning "no group restriction". */
export const TARGET_ALL = 'all'

export const channelId = (n: number) => `channel_${n}`
export const channelIds = (count: number) => Array.from({ length: Math.min(MAX_CHANNELS, Math.max(0, count)) }, (_, i) => channelId(i + 1))
export const channelNumber = (id: string) => Number(/^channel_(\d+)$/.exec(id)?.[1]) || 0
export const channelLabel = (id: string) => (id === CHANNEL_ALL || id === TARGET_ALL ? 'ALL' : `Ch ${channelNumber(id)}`)

/** Stable, distinguishable colours for the group chips and badges. */
const COLORS = ['#0a84ff', '#30d158', '#ff9f0a', '#bf5af2', '#ff453a', '#64d2ff', '#ffd60a', '#ff6bb5', '#8e8cff', '#5ac8a0']
export const channelColor = (id: string) => (id === CHANNEL_ALL || id === TARGET_ALL ? '#8e8e93' : COLORS[(channelNumber(id) - 1 + COLORS.length) % COLORS.length])

/** Per-show grouping settings, stored at showState/channels (the audience reads them without signing in). */
export interface ChannelConfig {
  /** 0 = no grouping ("ALL"), otherwise 2–10 groups. */
  count: number
  /** Audience may change its own group. Off = a device keeps the group it chose until the operator resets it. */
  open: boolean
  /** Bumped by "reset channels": devices that joined under an older epoch must choose again. */
  epoch: number
}
export const DEFAULT_CHANNELS: ChannelConfig = { count: 0, open: false, epoch: 0 }

export function normalizeChannels(raw: Partial<ChannelConfig> | null | undefined): ChannelConfig {
  const count = Number(raw?.count)
  return {
    count: Number.isFinite(count) && count >= 2 ? Math.min(MAX_CHANNELS, Math.floor(count)) : 0,
    open: raw?.open === true,
    epoch: Number(raw?.epoch) || 0,
  }
}

/** A one-way message from the operator to the audience (or one group of it): chime, vibration, spoken text. */
export interface Announcement {
  id: string
  /** CHANNEL_ALL or channel_n. */
  channel: string
  text: string
  tone: boolean
  vibrate: boolean
  speak: boolean
  /** Server-agnostic wall clock (only used to drop stale announcements on reconnect). */
  at: number
}

/** Does a cue / announcement aimed at `targets` reach a device in `channel` (null = not grouped)? */
export const reachesChannel = (targets: readonly string[] | undefined, channel: string | null) =>
  !channel || !targets || targets.length === 0 || targets.includes(TARGET_ALL) || targets.includes(CHANNEL_ALL) || targets.includes(channel)
