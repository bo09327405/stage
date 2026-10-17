import type { Announcement, ChannelConfig } from './channels'
import { DEFAULT_CHANNELS, reachesChannel } from './channels'
import type { FadeShape } from './studio'
import type { ExecutorRun } from './sequence'
import type { CueTrigger } from './trigger'

export type CueType = 'AUDIO' | 'VIDEO' | 'IMAGE' | 'TEXT' | 'INTERACTIVE_UPLOAD' | 'BLACKOUT'

export const CUE_TYPE_LABELS: Record<CueType, string> = {
  AUDIO: '音訊',
  VIDEO: '影片',
  IMAGE: '圖片',
  TEXT: '文字',
  INTERACTIVE_UPLOAD: '互動上傳',
  BLACKOUT: '暗場',
}

/** Compact glyphs for list rows and type pickers. */
export const CUE_TYPE_GLYPHS: Record<CueType, string> = {
  AUDIO: '♪',
  VIDEO: '▶',
  IMAGE: '◪',
  TEXT: 'T',
  INTERACTIVE_UPLOAD: '⇪',
  BLACKOUT: '●',
}

export type UploadKind = 'photo' | 'audio' | 'both' | 'video' | 'any'

export const UPLOAD_KIND_LABELS: Record<UploadKind, string> = {
  photo: '照片',
  audio: '錄音',
  both: '照片或錄音',
  video: '影片',
  any: '照片／影片／音效',
}

/** What happens to other running cues when this one starts. */
export type StopOthersMode = 'none' | 'fade' | 'cut'

export const STOP_OTHERS_LABELS: Record<StopOthersMode, string> = {
  none: '不影響',
  fade: '淡出其他',
  cut: '立即停止其他',
}

/**
 * What happens after this cue starts (Go Button "After this cue starts").
 * - autoContinue: GO the next cue `postWaitTime` after this one STARTS (0 = in sync; overlaps
 *   when shorter than the cue).
 * - autoFollow: GO the next cue `postWaitTime` after this one's fade-out BEGINS (0 = crossfade);
 *   with no fade-out that is simply the end of the cue.
 */
export type FollowMode = 'none' | 'autoFollow' | 'autoContinue'

export const FOLLOW_MODE_LABELS: Record<FollowMode, string> = {
  none: '無（等待手動 GO）',
  autoFollow: '淡出開始 / 結束時接續',
  autoContinue: '開始後接續（可交疊）',
}

/** Who receives a cue. `selected` uses the audience codes in `targetIds`. */
export type TargetMode = 'all' | 'selected'

export interface Cue {
  id: string
  /** Played by a control-panel executor (its number): its fader rides the level. */
  executor?: string
  /** Stereo position, −1 (left) … 1 (right); 0 / absent = centre. */
  pan?: number
  /** Theatre-style cue number; decimals allow inserted cues such as 12.5. */
  cueNumber: number
  title: string
  subtitle: string
  /** Free-form group label (e.g. "Act 1", "Sound FX"), shown as a tag and editable in bulk. */
  group: string
  type: CueType
  /** Media URL (audio / video / image); empty string when the type doesn't use one. */
  targetUrl: string
  /** Text shown to the audience (TEXT body, INTERACTIVE_UPLOAD prompt, image caption). */
  text: string
  /** What INTERACTIVE_UPLOAD cues ask the audience for. */
  uploadKind: UploadKind
  /** Cloudinary folder for this cue's audience uploads; empty = the project default. */
  uploadFolder: string
  /**
   * AUDIO/VIDEO: length of the media file in seconds (auto-detected on upload).
   * IMAGE/TEXT/INTERACTIVE_UPLOAD/BLACKOUT: how long to hold; 0 = until stopped.
   */
  duration: number
  /** Trim: seconds into the media file to start from. */
  mediaStartTime: number
  /** Trim: seconds into the media file to end at; 0 = end of file. */
  mediaEndTime: number
  /** 0–100. */
  volume: number

  // — When this cue starts —
  /** Seconds to wait after GO before the cue starts. */
  preWaitTime: number
  stopOthers: StopOthersMode
  /** Lower every other running audio cue by this many percent while this cue plays (0 = off). */
  duckOthers: number
  fadeInTime: number
  /** Fade-in curve (same shapes as the Studio's region fades); linear when unset. */
  fadeInShape: FadeShape

  // — After this cue starts —
  followMode: FollowMode
  /** Delay before the follow action fires. */
  postWaitTime: number
  /**
   * Automatic fade-out point: the fade-out begins this many seconds into playback and the cue stops
   * when it finishes (fadeOutTime later). 0 = no time point; the cue fades out just before its
   * natural end instead.
   */
  autoStopAfter: number
  /**
   * Fade out (over fadeOutTime) as soon as the next GO fires another cue — the "Loop ∞ / Fade Out +
   * Start Next" pattern for vamps and ambiences.
   */
  fadeOnNextGo: boolean
  /** Loop the trimmed media segment. */
  loop: boolean
  /** Number of plays when looping; 0 = forever. */
  loopCount: number
  fadeOutTime: number
  fadeOutShape: FadeShape
  /** Seconds after this cue's GO during which GO is locked (guards against double presses). */
  preventGoDuration: number

  // — Audience routing —
  targetMode: TargetMode
  /** Audience codes that receive this cue when targetMode is 'selected'. */
  targetIds: string[]
  /** Audience channel groups this cue plays for: ['all'] (default) or channel_1 … channel_10. */
  targetChannels: string[]

  // — External triggers —
  /** OSC / MIDI signals that GO this cue directly. */
  triggers: CueTrigger[]
  /**
   * AUDIO cues: a DAW Studio project (projects/{pid}/studio/{id}) to play instead of a file.
   * Its multitrack mix is rendered live on each device, so studio edits need no export.
   */
  studioId: string
}

export const DEFAULT_CUE: Omit<Cue, 'id'> = {
  cueNumber: 0,
  title: '',
  subtitle: '',
  group: '',
  type: 'AUDIO',
  targetUrl: '',
  text: '',
  uploadKind: 'photo',
  uploadFolder: '',
  duration: 0,
  mediaStartTime: 0,
  mediaEndTime: 0,
  volume: 100,
  preWaitTime: 0,
  stopOthers: 'none',
  duckOthers: 0,
  fadeInTime: 0,
  fadeInShape: 'linear',
  followMode: 'none',
  postWaitTime: 0,
  autoStopAfter: 0,
  fadeOnNextGo: false,
  loop: false,
  loopCount: 0,
  fadeOutTime: 0,
  fadeOutShape: 'linear',
  preventGoDuration: 0,
  targetMode: 'all',
  targetIds: [],
  targetChannels: ['all'],
  triggers: [],
  studioId: '',
}

/** Stage 2/3 field names, migrated on read. */
interface LegacyCueFields {
  startTime?: number
  endTime?: number
  autoFollow?: boolean
  stopOthers?: boolean | StopOthersMode
}

/** Fill fields that older or partial RTDB records may lack, and migrate stage-3 field names. */
export function normalizeCue(raw: Omit<Partial<Cue>, 'stopOthers'> & LegacyCueFields & { id: string }): Cue {
  const { startTime, endTime, autoFollow, stopOthers, ...rest } = raw
  return {
    ...DEFAULT_CUE,
    mediaStartTime: startTime ?? 0,
    mediaEndTime: endTime ?? 0,
    followMode: autoFollow ? 'autoFollow' : 'none',
    ...rest,
    stopOthers: stopOthers === true ? 'fade' : stopOthers === false || stopOthers == null ? 'none' : stopOthers,
    // RTDB drops empty arrays and may hand back arrays as objects.
    targetIds: Object.values(rest.targetIds ?? {}),
    // RTDB drops empty arrays: a cue with no stored list is for every group.
    targetChannels: (Object.values(rest.targetChannels ?? {}) as string[]).length ? (Object.values(rest.targetChannels ?? {}) as string[]) : ['all'],
    triggers: Object.values(rest.triggers ?? {}),
  }
}

/** A one-shot sound effect button, independent of the cue list. */
export interface Hit {
  id: string
  title: string
  targetUrl: string
  /** 0–100. */
  volume: number
  /** Display order in the grid. */
  order: number
}

export const isMediaCue = (cue: Cue) => cue.type === 'AUDIO' || cue.type === 'VIDEO'
/** Cues that own the audience screen; a new one replaces the previous one for the same audience. */
export const isVisualCue = (cue: Cue) => cue.type !== 'AUDIO'

/** Whether a cue is delivered to the given audience code. */
export const cueTargets = (cue: Cue, audienceId: string, channel: string | null = null) =>
  (cue.targetMode === 'all' || cue.targetIds.includes(audienceId)) && reachesChannel(cue.targetChannels, channel)

/** Length of one pass through the trimmed media, or Infinity if unknown. */
export function segmentLength(cue: Cue): number {
  const end = cue.mediaEndTime > 0 ? cue.mediaEndTime : cue.duration
  return end > 0 ? Math.max(0, end - cue.mediaStartTime) : Infinity
}

/**
 * Seconds the cue runs after its pre-wait, or Infinity when it holds until stopped
 * (including media whose length is still unknown and endless loops).
 */
export function cueRunLength(cue: Cue): number {
  let length: number
  if (isMediaCue(cue)) {
    const segment = segmentLength(cue)
    length = cue.loop ? (cue.loopCount > 0 ? segment * cue.loopCount : Infinity) : segment
  } else {
    length = cue.duration > 0 ? cue.duration : Infinity
  }
  // An automatic fade-out point ends the cue once its fade has run.
  return cue.autoStopAfter > 0 ? Math.min(length, cue.autoStopAfter + cue.fadeOutTime) : length
}

/** Seconds after playback starts at which the automatic fade-out begins, or Infinity if never. */
export function fadeOutStartsAt(cue: Cue): number {
  const length = cueRunLength(cue)
  return Number.isFinite(length) ? Math.max(0, length - cue.fadeOutTime) : Infinity
}

/** One firing of a cue, stored at showState/active/{instanceId}. */
export interface ActiveCue {
  instanceId: string
  cue: Cue
  /** Server ms when GO was pressed (playback begins after preWaitTime). */
  firedAt: number
  /** Server ms when the cue was told to stop. */
  stopAt: number | null
  /** Fade length used when stopped; null = the cue's own fadeOutTime. */
  stopFade: number | null
  /** Set once the follow action has fired, so it only fires once. */
  followed: boolean
  /** Server ms when this one cue was paused on its own ("Pause Selected Cue"); null while running. */
  pausedAt: number | null
}

/**
 * The clock an instance runs on: frozen at its own pausedAt while it is individually paused.
 * Pass the show clock (see showClock) as `now`, so a show-wide pause freezes it too.
 */
export const instanceClock = (inst: ActiveCue, now: number) => (inst.pausedAt != null ? Math.min(now, inst.pausedAt) : now)

/** Server ms when playback begins (after pre-wait). */
export const activeStartAt = ({ cue, firedAt }: ActiveCue) => firedAt + cue.preWaitTime * 1000

/** Server ms when an instance will be completely finished; Infinity if it holds. */
export function activeEndAt(inst: ActiveCue): number {
  const naturalEnd = activeStartAt(inst) + cueRunLength(inst.cue) * 1000
  const fade = inst.stopFade ?? inst.cue.fadeOutTime
  const stoppedEnd = inst.stopAt == null ? Infinity : inst.stopAt + fade * 1000
  return Math.min(naturalEnd, stoppedEnd)
}

/** Server ms when this instance's follow action should fire, or null if it has none. */
export function activeFollowAt(inst: ActiveCue): number | null {
  const { cue } = inst
  if (cue.followMode === 'autoContinue') return activeStartAt(inst) + cue.postWaitTime * 1000
  if (cue.followMode === 'autoFollow') {
    // Anchored to the start of the fade-out, so post-wait 0 is a crossfade and post-wait equal
    // to the fade time starts the next cue as this one falls silent.
    const fadeStart = activeStartAt(inst) + fadeOutStartsAt(cue) * 1000
    return Number.isFinite(fadeStart) ? fadeStart + cue.postWaitTime * 1000 : null
  }
  return null
}

export interface HitTrigger {
  hitId: string
  url: string
  volume: number
  firedAt: number
  /** Increments on every trigger so the same hit can be fired repeatedly. */
  seq: number
}

/** Derived playback state: idle (nothing running), playing, or paused (timeline frozen). */
export type PlaybackState = 'idle' | 'playing' | 'paused'

/** Shape of the showState node of a show version. */
export interface ShowState {
  /** Running cue instances keyed by instanceId. */
  active: Record<string, ActiveCue>
  /**
   * Server ms when the show was paused, or null while running. While paused every device
   * freezes its clock at this moment; resuming shifts all instances forward by the pause length.
   */
  pausedAt: number | null
  /** The cue the next GO will fire. */
  standbyCue: Cue | null
  /** 0–100, applied on every audience device. */
  masterVolume: number
  dim: boolean
  /** DIM amount in dB (−1…−60; absent → −20). Applied as 10^(dB/20) on top of the master. */
  dimDb?: number
  /** Server ms until which GO is locked (preventGoDuration). */
  goLockedUntil: number
  hit: HitTrigger | null
  /** Stop request for hits: a hit id, or "*" for all ("Panic All Hits"). */
  hitStop: { target: string; seq: number; at: number } | null
  /** Which page of 8 hits the "Play Hit n" actions address. */
  hitsPage: number
  /** Main volume muted (independent of DIM and the fader). */
  muted: boolean
  /** The most recent GO, for "Oops (Reset to Last Cue)". */
  lastGo: { cueId: string; instanceId: string } | null
  /** Increments on every GO. */
  sequence: number
  /** Live effects on the show output of every audience device (control-panel knobs / faders). */
  fx: ShowFx
  /** A manual crossfade in progress (a control-panel "走 Cue" fader): `from` fades out as `to` fades in. */
  xfade: ShowXfade | null
  /** Live level per hit (0–1, multiplies its volume); a fader can ride a hit. */
  hitLevels: Record<string, number>
  /** Control-panel executors: what each is running (see types/sequence.ts). */
  executors: Record<string, ExecutorRun>
  /** Executor fader levels (0–1), multiplying their cues' volume. */
  execLevels: Record<string, number>
  /** Audience grouping (Ch 1 … Ch 10); count 0 = everyone together. */
  channels: ChannelConfig
  /** The latest operator announcement to the audience. */
  announce: Announcement | null
}

/** Show-wide effects: EQ (dB), low-pass cutoff (0–1, log 20 Hz–20 kHz; 1 = open), reverb / delay sends (0–1), pan (−1…1). */
export interface ShowFx {
  eqLow: number
  eqMid: number
  eqHigh: number
  filter: number
  reverb: number
  delay: number
  pan: number
}
export const DEFAULT_SHOW_FX: ShowFx = { eqLow: 0, eqMid: 0, eqHigh: 0, filter: 1, reverb: 0, delay: 0, pan: 0 }

export interface ShowXfade {
  from: string[]
  to: string
  /** 0 = all "from", 1 = all "to". */
  pos: number
}

export const INITIAL_SHOW_STATE: ShowState = {
  active: {},
  pausedAt: null,
  standbyCue: null,
  masterVolume: 100,
  dim: false,
  goLockedUntil: 0,
  hit: null,
  hitStop: null,
  hitsPage: 0,
  muted: false,
  lastGo: null,
  sequence: 0,
  fx: DEFAULT_SHOW_FX,
  xfade: null,
  hitLevels: {},
  executors: {},
  execLevels: {},
  channels: DEFAULT_CHANNELS,
  announce: null,
}

export function playbackState(state: ShowState): PlaybackState {
  if (state.pausedAt != null) return 'paused'
  return Object.keys(state.active).length > 0 ? 'playing' : 'idle'
}

/** The show clock: frozen at pausedAt while paused, otherwise the live server time. */
export const showClock = (state: ShowState, serverNow: number) => state.pausedAt ?? serverNow

/** Running instances sorted oldest first. */
export const activeList = (state: ShowState): ActiveCue[] =>
  Object.values(state.active).sort((a, b) => a.firedAt - b.firedAt)

/** One audience upload, stored in the project's media pool at projects/{pid}/uploads/{pushId}. */
export type ModerationStatus = 'pending' | 'approved' | 'rejected'

/** Whether an upload has passed moderation and may be used in a cue. */
export const isApproved = (upload: Pick<AudienceUpload, 'moderation'>) => (upload.moderation ?? 'approved') === 'approved'

export interface AudienceUpload {
  id: string
  /** The INTERACTIVE_UPLOAD cue that collected it. */
  cueId: string
  /** Cloudinary folder the file was stored in. */
  folder: string
  /** The version that was on stage when it was uploaded. */
  versionId: string
  kind: 'image' | 'audio' | 'video'
  url: string
  publicId: string
  width: number
  height: number
  /** Seconds, for audio. */
  duration: number
  audienceId: string
  createdAt: number
  /**
   * Content check before the file may reach the big screen or the speakers. "approved" by
   * Cloudinary's AI moderation or by the operator; absent on uploads from before moderation
   * existed, which count as approved.
   */
  moderation?: ModerationStatus
  /** Who decided: Cloudinary's AI moderation, or the operator in the inbox. */
  moderatedBy?: 'ai' | 'operator'
  /** The Cloudinary moderation add-on that checked it (e.g. aws_rek), if any. */
  moderationKind?: string
  /** Hidden from the inbox. Uploads are never deleted (retention policy): hiding is reversible. */
  hidden?: boolean
  /** Cloudinary tags the file was stored with (show, cue, audience), for later review. */
  tags?: string[]
  /** How it was sent: the built-in camera / recorder, or the Cloudinary Upload Widget. */
  via?: 'direct' | 'widget'
}
