/*
 * Media addresses typed into Set Cue / Studio. Pure (shared with the Worker).
 *
 * Two kinds are told apart:
 *  · a FILE address — a link that serves an audio / video file (…/song.mp3, a Dropbox or Drive share link, …):
 *    can be read directly, or fetched by the server and stored in the project;
 *  · a PLATFORM page — YouTube, Vimeo, SoundCloud, Spotify, TikTok …: a web page of a service that doesn't hand out
 *    files. Its terms forbid downloading / extracting media, and the content is almost always someone else's
 *    copyright, so the app does not fetch, rip or convert these.
 */

export interface UrlInfo {
  kind: 'file' | 'platform' | 'invalid'
  /** The address to use (share links rewritten to direct download links). */
  url: string
  host: string
  /** For kind 'platform': the service's name. */
  platform?: string
  /** A readable file name from the path. */
  name: string
  ext: string
  /** What was rewritten, or why it is invalid. */
  note?: string
}

const PLATFORMS: [RegExp, string][] = [
  [/(^|\.)youtube\.com$|(^|\.)youtu\.be$|(^|\.)youtube-nocookie\.com$/, 'YouTube'],
  [/(^|\.)vimeo\.com$/, 'Vimeo'],
  [/(^|\.)soundcloud\.com$|(^|\.)snd\.sc$/, 'SoundCloud'],
  [/(^|\.)spotify\.com$|(^|\.)spotify\.link$/, 'Spotify'],
  [/(^|\.)bilibili\.com$|(^|\.)b23\.tv$/, 'Bilibili'],
  [/(^|\.)tiktok\.com$/, 'TikTok'],
  [/(^|\.)instagram\.com$/, 'Instagram'],
  [/(^|\.)facebook\.com$|(^|\.)fb\.watch$/, 'Facebook'],
  [/(^|\.)twitter\.com$|(^|\.)x\.com$/, 'X (Twitter)'],
  [/(^|\.)dailymotion\.com$|(^|\.)dai\.ly$/, 'Dailymotion'],
  [/(^|\.)twitch\.tv$/, 'Twitch'],
  [/(^|\.)music\.apple\.com$|(^|\.)itunes\.apple\.com$/, 'Apple Music'],
  [/(^|\.)bandcamp\.com$/, 'Bandcamp'],
  [/(^|\.)netflix\.com$/, 'Netflix'],
  [/(^|\.)line\.me$|(^|\.)kkbox\.com$/, '音樂／影音平台'],
]

export const AUDIO_EXTS = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'aif', 'aiff', 'weba']
export const VIDEO_EXTS = ['mp4', 'mov', 'webm', 'm4v', 'mkv', 'ogv']
export const MEDIA_EXTS = [...AUDIO_EXTS, ...VIDEO_EXTS]

export const platformOf = (host: string) => PLATFORMS.find(([re]) => re.test(host.toLowerCase()))?.[1] ?? null

/** Is this host an IP literal / local name (never a public media server)? */
export const isPrivateHost = (host: string) =>
  host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':') || !host.includes('.')

export function analyzeMediaUrl(input: string): UrlInfo {
  const text = input.trim().replace(/^["'「]|["'」]$/g, '')
  const bad = (note: string): UrlInfo => ({ kind: 'invalid', url: text, host: '', name: '', ext: '', note })
  let u: URL
  try {
    u = new URL(text)
  } catch {
    return bad('請輸入完整網址（https://…）')
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return bad('只支援 http / https 網址')
  const host = u.hostname.toLowerCase()
  const platform = platformOf(host)
  if (platform) return { kind: 'platform', url: text, host, platform, name: '', ext: '' }
  if (isPrivateHost(host)) return bad('這不是公開網站的位址')

  let url = u.toString()
  let note: string | undefined
  // Share links → direct download links (the owner's own file, shared on purpose).
  if (/(^|\.)dropbox\.com$/.test(host)) {
    u.searchParams.delete('dl')
    u.searchParams.set('raw', '1')
    url = u.toString()
    note = '已將 Dropbox 分享連結轉為直接下載連結'
  } else if (host === 'drive.google.com') {
    const id = /\/file\/d\/([\w-]+)/.exec(u.pathname)?.[1] ?? u.searchParams.get('id')
    if (id) {
      url = `https://drive.google.com/uc?export=download&id=${id}`
      note = '已將 Google Drive 分享連結轉為直接下載連結（檔案需設為「知道連結的人可檢視」）'
    }
  }
  const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() ?? '')
  const ext = /\.([a-z0-9]{2,5})$/i.exec(last)?.[1].toLowerCase() ?? ''
  return { kind: 'file', url, host, name: last || 'media', ext, ...(note ? { note } : {}) }
}

export const isAudioExt = (ext: string) => AUDIO_EXTS.includes(ext.toLowerCase())
export const isVideoExt = (ext: string) => VIDEO_EXTS.includes(ext.toLowerCase())
