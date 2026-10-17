/** Crew positions on the intercom, like the stations on a wired party-line system. */
export type IntercomRole = 'SM' | 'ASM' | 'Sound' | 'Light' | 'Video' | 'Stage' | 'FOH' | 'Other'

export const INTERCOM_ROLES: { id: IntercomRole; label: string; color: string }[] = [
  { id: 'SM', label: 'SM 舞台監督', color: '#ff453a' },
  { id: 'ASM', label: 'ASM 執行舞監', color: '#ff9f0a' },
  { id: 'Sound', label: 'Sound 音響', color: '#30d158' },
  { id: 'Light', label: 'Light 燈光', color: '#ffd60a' },
  { id: 'Video', label: 'Video 影像', color: '#bf5af2' },
  { id: 'Stage', label: 'Stage 舞台', color: '#64d2ff' },
  { id: 'FOH', label: 'FOH 前台', color: '#0a84ff' },
  { id: 'Other', label: '其他', color: '#8e8e93' },
]

export const roleColor = (role: IntercomRole) => INTERCOM_ROLES.find((r) => r.id === role)?.color ?? '#8e8e93'

export type MicMode = 'open' | 'ptt'

/** Party-line channels. "all" (All Call) talks to and hears every channel. */
export type IntercomChannel = 'A' | 'B' | 'all' | 'channel_all' | `channel_${number}`

export const INTERCOM_CHANNELS: { id: IntercomChannel; label: string }[] = [
  { id: 'A', label: 'Ch A' },
  { id: 'B', label: 'Ch B' },
  { id: 'all', label: 'All Call' },
]

/** A party-line channel that follows one of the show's audience groups (crew working a group together). */
export const isGroupChannel = (c: string | undefined): c is `channel_${number}` => /^channel_\d+$/.test(c ?? '')

/** The dropdown channels: Ch 1 … Ch N, or "All Channels" (every group). Unlike All Call (crew only), these can be aimed at the audience. */
export const isGroupLike = (c: string | undefined) => isGroupChannel(c) || c === 'channel_all'

/** Crew-only channels: they never reach the audience. */
export const CREW_CHANNELS = INTERCOM_CHANNELS

/** Who a group channel (Ch 1 … Ch 10) talks to: other crew on it, or the audience devices of that group. */
export type IntercomTarget = 'crew' | 'audience'
export const INTERCOM_TARGETS: { id: IntercomTarget; label: string; short: string }[] = [
  { id: 'crew', label: '👥 演出人員', short: '演出人員' },
  { id: 'audience', label: '📣 觀眾', short: '觀眾' },
]

/** The group channels Ch 1 … Ch N (audience groups of the show). */
export const groupChannelOptions = (groupCount: number): { id: IntercomChannel; label: string }[] =>
  groupCount > 0
    ? [{ id: 'channel_all', label: 'All Channels' }, ...Array.from({ length: groupCount }, (_, i) => ({ id: `channel_${i + 1}` as IntercomChannel, label: `Ch ${i + 1}` }))]
    : []

/** All selectable channels: Ch A / Ch B / All Call, plus one per audience group (Ch 1 … Ch N). */
export const intercomChannelOptions = (groupCount: number): { id: IntercomChannel; label: string }[] => [
  ...INTERCOM_CHANNELS.slice(0, 2),
  ...Array.from({ length: groupCount }, (_, i) => ({ id: `channel_${i + 1}` as IntercomChannel, label: `Ch ${i + 1}` })),
  INTERCOM_CHANNELS[2],
]

/** Short label for any channel id. */
export const intercomChannelLabel = (c: string | undefined) =>
  c === 'channel_all' ? 'All Channels' : isGroupChannel(c) ? `Ch ${c.replace('channel_', '')}` : c === 'A' || c === 'B' ? `Ch ${c}` : 'All Call'

/** Whether stations on these two channels hear each other. Older stations (no channel) are on All. */
export const channelsMeet = (a: IntercomChannel | undefined, b: IntercomChannel | undefined) =>
  !a ||
  !b ||
  a === 'all' ||
  b === 'all' ||
  a === b ||
  // "All Channels" reaches every group channel (not the crew-only A / B).
  (a === 'channel_all' && isGroupChannel(b)) ||
  (b === 'channel_all' && isGroupChannel(a))

/** One connected station, at projects/{pid}/intercom/members/{memberId}. Removed on disconnect. */
export interface IntercomMember {
  id: string
  name: string
  role: IntercomRole
  joinedAt: number
  /** Has a microphone open on the voice channel. */
  voice: boolean
  /** Mic currently muted (open mode) or not keyed (push-to-talk). */
  muted: boolean
  micMode: MicMode
  /** Party-line channel; missing on stations from before channels existed (treated as All). */
  channel?: IntercomChannel
  /** On a group channel: speaking to other crew (default) or to the audience of that group. */
  target?: IntercomTarget
}

export interface ChatMessage {
  id: string
  memberId: string
  name: string
  role: IntercomRole
  /** Sender's Google profile photo. */
  photo?: string
  /** Channel it was sent on; missing on older messages (shown to everyone). */
  channel?: IntercomChannel
  text: string
  at: number
}

/** The last CALL, at projects/{pid}/intercom/call. `target` is a member id, or "*" for everyone. */
export interface IntercomCall {
  seq: number
  from: string
  name: string
  role: IntercomRole
  target: string
  at: number
  /** Caller's channel; an all-stations CALL only rings on stations that share it. */
  channel?: IntercomChannel
}

/** WebRTC signaling envelope, delivered to projects/{pid}/intercom/signals/{toMemberId}/{pushId}. */
export type Signal =
  | { from: string; type: 'offer' | 'answer'; sdp: string }
  | { from: string; type: 'candidate'; candidate: RTCIceCandidateInit }
  | { from: string; type: 'bye' }

export const intercomPath = (projectId: string) => `projects/${projectId}/intercom`
