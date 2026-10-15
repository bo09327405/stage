// Unsigned uploads: the browser only needs the cloud name and an *unsigned* upload preset.
// No SDK, no API key, no API secret.
export const CLOUD_NAME: string = import.meta.env.VITE_CLOUDINARY_CLOUD_NAME
export const UPLOAD_PRESET: string = import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET

if (!CLOUD_NAME || !UPLOAD_PRESET) {
  throw new Error(
    'Cloudinary 設定缺少環境變數：VITE_CLOUDINARY_CLOUD_NAME / VITE_CLOUDINARY_UPLOAD_PRESET（請檢查 .env.local）',
  )
}

// resource_type "auto" lets one endpoint accept images, audio (stored as "video") and video.
const UPLOAD_URL = `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/auto/upload`

/** Subset of Cloudinary's upload response that the app uses. */
export interface CloudinaryUploadResult {
  public_id: string
  secure_url: string
  /** "image" for pictures; "video" for both video and audio files. */
  resource_type: 'image' | 'video' | 'raw'
  format: string
  bytes: number
  width?: number
  height?: number
  /** Seconds; present for audio and video. */
  duration?: number
  /** Present when the file has an audio track. */
  is_audio?: boolean
  /** Present when the upload preset runs a moderation add-on (AI or manual). */
  moderation?: { kind: string; status: 'pending' | 'approved' | 'rejected' | 'queued' | 'aborted' }[]
  tags?: string[]
}

export interface UploadMediaOptions {
  /** Target folder; only honoured if the upload preset allows overriding it. */
  folder?: string
  /** Cloudinary tags (allowed on unsigned uploads), used to find files again later. */
  tags?: string[]
  /** Key/value context stored with the asset (show, cue, audience code…). */
  context?: Record<string, string>
  signal?: AbortSignal
}

/** Cloudinary's "key=value|key=value" context string; '|' and '=' in values are escaped. */
export const contextString = (context: Record<string, string>) =>
  Object.entries(context)
    .map(([k, v]) => `${k}=${v.replace(/([|=])/g, '\\$1')}`)
    .join('|')

// Cloudinary's raw messages are misleading for config mistakes; translate the common ones.
function explainError(message: string): string {
  if (/unknown api key/i.test(message)) {
    return `Cloud name「${CLOUD_NAME}」不存在，請到 Cloudinary Dashboard 確認 VITE_CLOUDINARY_CLOUD_NAME`
  }
  if (/upload preset not found/i.test(message)) {
    return `Upload preset「${UPLOAD_PRESET}」不存在，請確認 VITE_CLOUDINARY_UPLOAD_PRESET`
  }
  if (/whitelisted for unsigned/i.test(message)) {
    return `Upload preset「${UPLOAD_PRESET}」不是 Unsigned 模式，請到 Cloudinary 設定改為 Unsigned`
  }
  return message
}

/** Upload an image, audio or video file with the unsigned preset. */
export async function uploadMedia(
  file: File | Blob,
  { folder, tags, context, signal }: UploadMediaOptions = {},
): Promise<CloudinaryUploadResult> {
  const body = new FormData()
  body.append('file', file)
  body.append('upload_preset', UPLOAD_PRESET)
  if (folder) body.append('folder', folder)
  if (tags?.length) body.append('tags', tags.join(','))
  if (context) body.append('context', contextString(context))

  let res: Response
  try {
    res = await fetch(UPLOAD_URL, { method: 'POST', body, signal })
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err
    throw new Error('Cloudinary 上傳失敗：網路錯誤')
  }

  const data = await res.json().catch(() => null)
  if (!res.ok) {
    throw new Error(`Cloudinary 上傳失敗：${explainError(data?.error?.message ?? res.statusText)}`)
  }
  return data as CloudinaryUploadResult
}
