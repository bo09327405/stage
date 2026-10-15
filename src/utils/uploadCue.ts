import { playableUrl } from '../services/uploads'
import { DEFAULT_CUE, type AudienceUpload, type Cue } from '../types/cue'

const KIND_LABEL: Record<AudienceUpload['kind'], string> = { image: '照片', audio: '錄音', video: '影片' }

/** Media fields a cue gets from an audience upload. */
export function mediaFromUpload(upload: AudienceUpload): Pick<Cue, 'type' | 'targetUrl' | 'duration' | 'mediaStartTime' | 'mediaEndTime'> {
  return {
    type: upload.kind === 'image' ? 'IMAGE' : upload.kind === 'video' ? 'VIDEO' : 'AUDIO',
    targetUrl: playableUrl(upload),
    // Photos hold until replaced; recordings and videos use their own length.
    duration: upload.kind === 'image' ? 0 : Math.round(upload.duration * 100) / 100,
    mediaStartTime: 0,
    mediaEndTime: 0,
  }
}

export const uploadTitle = (upload: AudienceUpload) => `觀眾 ${upload.audienceId} 的${KIND_LABEL[upload.kind]}`

/** A complete new cue built from an upload (Quick Create). */
export function cueFromUpload(upload: AudienceUpload, cueNumber: number): Omit<Cue, 'id'> {
  return {
    ...DEFAULT_CUE,
    ...mediaFromUpload(upload),
    cueNumber,
    title: uploadTitle(upload),
    subtitle: `收件匣 · ${new Date(upload.createdAt).toLocaleTimeString('zh-TW', { hour12: false })}`,
  }
}
