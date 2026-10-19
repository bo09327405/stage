import { activeStartAt, cueRunLength, segmentLength, type ActiveCue, type Cue } from '../types/cue'
import { fadeRamp } from '../types/studio'

/** The YouTube video id a pasted link names (watch / youtu.be / embed / shorts / live), or null. */
export function youtubeIdOf(input: string): string | null {
  let u: URL
  try {
    u = new URL(input.trim())
  } catch {
    return null
  }
  const host = u.hostname.toLowerCase().replace(/^www\.|^m\./, '')
  let id: string | null = null
  if (host === 'youtu.be') id = u.pathname.split('/')[1] ?? null
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com' || host === 'music.youtube.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v')
    else id = /^\/(?:embed|shorts|live|v)\/([\w-]{6,})/.exec(u.pathname)?.[1] ?? null
  }
  return id && /^[\w-]{6,20}$/.test(id) ? id : null
}

/** Start offset in seconds from `?t=1m30s` / `&start=90` / `?t=90`, or 0. */
export function youtubeStartOf(input: string): number {
  try {
    const u = new URL(input.trim())
    const raw = u.searchParams.get('t') ?? u.searchParams.get('start') ?? ''
    const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(raw)
    if (!m || !raw) return 0
    return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)
  } catch {
    return 0
  }
}

/** The address the app stores for a YouTube cue. */
export const youtubeWatchUrl = (id: string) => `https://www.youtube.com/watch?v=${id}`

/** A VIDEO cue whose media is a YouTube link: played with YouTube's own embedded player, not the audio engine. */
export const isYoutubeCue = (cue: Pick<Cue, 'type' | 'targetUrl'>) => cue.type === 'VIDEO' && youtubeIdOf(cue.targetUrl) !== null

/* ---------- the official IFrame Player API ---------- */

export interface YTPlayer {
  playVideo(): void
  pauseVideo(): void
  stopVideo(): void
  seekTo(seconds: number, allowSeekAhead: boolean): void
  setVolume(volume: number): void
  mute(): void
  unMute(): void
  isMuted(): boolean
  getCurrentTime(): number
  getDuration(): number
  getPlayerState(): number
  destroy(): void
}
/** YouTube IFrame API error codes → what it means for the operator. */
export function youtubeErrorMessage(code: number): string {
  if (code === 101 || code === 150) return '這部影片的作者不允許嵌入播放（錯誤 ' + code + '）：請換一部影片，或改用你有權使用的檔案上傳'
  if (code === 100) return '找不到這部影片（已移除或設為私人，錯誤 100）'
  if (code === 2) return '影片網址不正確（錯誤 2）'
  if (code === 5) return '這台裝置的播放器無法播放這部影片（錯誤 5，HTML5 播放器問題）'
  return `這部影片無法嵌入播放（錯誤 ${code}）`
}

export interface YTNamespace {
  Player: new (
    el: HTMLElement,
    options: {
      host?: string
      videoId: string
      width?: string | number
      height?: string | number
      playerVars?: Record<string, string | number>
      events?: { onReady?: (e: { target: YTPlayer }) => void; onStateChange?: (e: { data: number; target: YTPlayer }) => void; onError?: (e: { data: number; target: YTPlayer }) => void }
    },
  ) => YTPlayer
  PlayerState: { UNSTARTED: -1; ENDED: 0; PLAYING: 1; PAUSED: 2; BUFFERING: 3; CUED: 5 }
}

let apiPromise: Promise<YTNamespace> | null = null

/** Load YouTube's IFrame Player API script once. */
export function loadYouTubeApi(): Promise<YTNamespace> {
  const w = window as unknown as { YT?: YTNamespace & { loaded?: number }; onYouTubeIframeAPIReady?: () => void }
  if (w.YT?.Player) return Promise.resolve(w.YT)
  apiPromise ??= new Promise<YTNamespace>((resolve, reject) => {
    const previous = w.onYouTubeIframeAPIReady
    w.onYouTubeIframeAPIReady = () => {
      previous?.()
      resolve(w.YT!)
    }
    const script = document.createElement('script')
    script.src = 'https://www.youtube.com/iframe_api'
    script.async = true
    script.onerror = () => {
      apiPromise = null
      reject(new Error('無法載入 YouTube 播放器（網路被擋住或離線）'))
    }
    document.head.appendChild(script)
  })
  return apiPromise
}

/** Player parameters: no related videos, minimal branding, no controls / keyboard / fullscreen button, inline on iOS. */
export const YT_PLAYER_VARS = { rel: 0, modestbranding: 1, controls: 0, disablekb: 1, fs: 0, iv_load_policy: 3, playsinline: 1, enablejsapi: 1 } as const
/** The privacy-enhanced host (no tracking cookies until the video is played). Ads may still appear. */
export const YT_HOST = 'https://www.youtube-nocookie.com'

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

/** The cue's own volume × its fade-in / fade-out / stop-fade at this moment (0–1), like the audio engine's envelope. */
export function youtubeEnvelope(inst: ActiveCue, clock: number): number {
  const { cue } = inst
  const elapsed = Math.max(0, clock - activeStartAt(inst)) / 1000
  let g = cue.volume / 100
  if (cue.fadeInTime > 0 && elapsed < cue.fadeInTime) g *= fadeRamp(cue.fadeInShape, clamp01(elapsed / cue.fadeInTime))
  const length = cueRunLength(cue)
  if (Number.isFinite(length) && cue.fadeOutTime > 0) {
    const remaining = length - elapsed
    if (remaining < cue.fadeOutTime) g *= fadeRamp(cue.fadeOutShape, clamp01(remaining / cue.fadeOutTime), true)
  }
  if (inst.stopAt != null) {
    const fade = inst.stopFade ?? cue.fadeOutTime
    const t = (clock - inst.stopAt) / 1000
    g *= fade > 0 ? fadeRamp(cue.fadeOutShape, clamp01(1 - t / fade), true) : 0
  }
  return clamp01(g)
}


/** Where in the video (seconds) this cue should be at `clock`: trim start + time since it started, wrapped when looping. */
export function youtubePosition(inst: ActiveCue, clock: number): number {
  const { cue } = inst
  const elapsed = Math.max(0, clock - activeStartAt(inst)) / 1000
  const segment = segmentLength(cue)
  const into = cue.loop && Number.isFinite(segment) && segment > 0 ? elapsed % segment : elapsed
  return cue.mediaStartTime + into
}

/** Player states of the IFrame API. */
export const YT_STATE = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 } as const

/** The browser refused autoplay when this many start attempts over this long have not produced playback. */
export const BLOCKED_ATTEMPTS = 3
export const BLOCKED_AFTER_MS = 2200
export const isAutoplayBlocked = (attempts: number, msSinceFirstAttempt: number) => attempts >= BLOCKED_ATTEMPTS && msSinceFirstAttempt >= BLOCKED_AFTER_MS
