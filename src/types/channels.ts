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
  /** Audience may change its own group (default). Off = only a short correction window after choosing. */
  open: boolean
  /** Bumped by "reset channels": devices that joined under an older epoch must choose again. */
  epoch: number
  /** Devices the operator placed in a group by hand: audience code → channel_n. Wins over the device's own pick. */
  assign: Record<string, string>
}
export const DEFAULT_CHANNELS: ChannelConfig = { count: 0, open: true, epoch: 0, assign: {} }

export function normalizeChannels(raw: Partial<ChannelConfig> | null | undefined): ChannelConfig {
  const count = Number(raw?.count)
  return {
    count: Number.isFinite(count) && count >= 2 ? Math.min(MAX_CHANNELS, Math.floor(count)) : 0,
    // Self-service switching is on unless the operator locked it.
    open: raw?.open !== false,
    epoch: Number(raw?.epoch) || 0,
    assign: Object.fromEntries(Object.entries(raw?.assign ?? {}).filter(([, v]) => typeof v === 'string' && /^channel_\d+$/.test(v))),
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

/** Is this cue target list "everybody" (no group restriction)? */
export const targetsAllChannels = (targets: readonly string[] | undefined) =>
  !targets || targets.length === 0 || targets.includes(TARGET_ALL) || targets.includes(CHANNEL_ALL)

/**
 * May an action of a cue aimed at `actor` (STOP OTHERS, fade on next GO, a new picture replacing the old one)
 * touch a running cue aimed at `other`? A cue for everybody reaches every group; a cue for specific groups
 * only reaches cues that play entirely inside those groups — never another group's cue, and never a cue
 * that is also running for groups outside its own.
 */
export const channelScopeCovers = (actor: readonly string[] | undefined, other: readonly string[] | undefined) =>
  targetsAllChannels(actor) || (!targetsAllChannels(other) && (other as readonly string[]).every((c) => (actor as readonly string[]).includes(c)))
