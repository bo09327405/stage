import { encodeWav } from '../studio/audio'
import { analyzeMediaUrl, isAudioExt } from '../utils/mediaUrl'
import { uploadMediaFile, type StoredFile } from './storage'

/*
 * Bring a media FILE from a link into the app. Platform pages (YouTube, Vimeo, SoundCloud …) are not files and
 * are refused (see utils/mediaUrl.ts). Two ways in:
 *  · "direct": the address is used as it is (the audience devices load it themselves);
 *  · "download": the server fetches the file (Worker /api/r2/fetch-url) and it is stored in the project.
 * "Audio only" from a video file is done here in the browser: decode the audio track and keep it as a WAV.
 */

export type ImportContent = 'video' | 'audio'
type Status = (message: string) => void
/** Download progress 0–100, or null while the length is unknown / a later step has no measurable progress. */
export type Progress = (percent: number | null) => void

const safe = (name: string) => name.replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 80) || 'media'
const stem = (name: string) => name.replace(/\.[^.]+$/, '')

async function relay(url: string, onStatus?: Status, onProgress?: Progress): Promise<{ blob: Blob; name: string }> {
  onStatus?.('伺服器下載中…')
  const res = await fetch(`/api/r2/fetch-url?store=0&url=${encodeURIComponent(url)}`, { method: 'POST' })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `下載失敗（HTTP ${res.status}）`)
  }
  const name = decodeURIComponent(res.headers.get('x-source-name') ?? '') || analyzeMediaUrl(url).name
  const total = Number(res.headers.get('content-length') ?? 0)
  if (!res.body || !total) {
    onProgress?.(null)
    return { blob: await res.blob(), name }
  }
  // Read the stream so the bar moves while the file arrives.
  const reader = res.body.getReader()
  const chunks: Uint8Array<ArrayBuffer>[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value as Uint8Array<ArrayBuffer>)
    received += value.length
    onProgress?.(Math.min(99, Math.round((received / total) * 100)))
  }
  return { blob: new Blob(chunks, { type: res.headers.get('content-type') ?? '' }), name }
}

/** The audio track of any media file the browser can decode, as a WAV file. */
async function extractAudio(blob: Blob, name: string, onStatus?: Status): Promise<File> {
  onStatus?.('擷取音訊中…')
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  const ctx = new Ctx()
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer())
    return new File([encodeWav(decoded, 16)], `${stem(safe(name))}.wav`, { type: 'audio/wav' })
  } catch {
    throw new Error('無法擷取這個檔案的音訊（瀏覽器解不開這個格式，或檔案太大）。可以改選「完整影片」，或換成 mp3 / wav / mp4 檔案。')
  } finally {
    void ctx.close()
  }
}

/** A file ready to hand to something that uploads it itself (the Studio): audio only, as a File. */
export async function fetchAudioFile(url: string, onStatus?: Status, onProgress?: Progress): Promise<File> {
  const info = analyzeMediaUrl(url)
  if (info.kind !== 'file') throw new Error(info.kind === 'platform' ? `${info.platform} 不是影音檔連結，無法匯入` : (info.note ?? '網址不合法'))
  const { blob, name } = await relay(info.url, onStatus, onProgress)
  if (isAudioExt(info.ext) || blob.type.startsWith('audio/')) return new File([blob], safe(name), { type: blob.type || 'audio/mpeg' })
  onProgress?.(null)
  return extractAudio(blob, name, onStatus)
}

/** Download a file from a link into the project's R2 folder. `content` 'audio' keeps only the sound. */
export async function downloadToProject(url: string, { folder, content, onStatus, onProgress }: { folder: string; content: ImportContent; onStatus?: Status; onProgress?: Progress }): Promise<{ result: StoredFile; name: string; bytes: number }> {
  const info = analyzeMediaUrl(url)
  if (info.kind !== 'file') throw new Error(info.kind === 'platform' ? `${info.platform} 不是影音檔連結，無法匯入` : (info.note ?? '網址不合法'))

  // Audio from an audio file, or the whole file: the server stores it directly (no round trip through the browser).
  if (content === 'video' || isAudioExt(info.ext)) {
    onStatus?.('伺服器下載並存到專案中…')
    onProgress?.(null)
    const key = `${folder.replace(/\/+$/, '')}/${Date.now().toString(36)}-${safe(info.name || 'media')}`
    const res = await fetch(`/api/r2/fetch-url?store=1&key=${encodeURIComponent(key)}&url=${encodeURIComponent(info.url)}`, { method: 'POST' })
    const body = (await res.json().catch(() => null)) as { url?: string; key?: string; bytes?: number; contentType?: string; name?: string; error?: string } | null
    if (!res.ok || !body?.url) throw new Error(body?.error ?? `匯入失敗（HTTP ${res.status}）`)
    const type = body.contentType ?? ''
    return {
      name: info.name || 'media',
      bytes: body.bytes ?? 0,
      result: {
        storage: 'r2',
        public_id: body.key!,
        secure_url: body.url,
        resource_type: 'video',
        format: key.split('.').pop()?.toLowerCase() ?? '',
        bytes: body.bytes ?? 0,
        is_audio: type.startsWith('audio/') || undefined,
      },
    }
  }

  // Audio track of a video: relay the bytes, decode in the browser, keep the WAV.
  const { blob, name } = await relay(info.url, onStatus, onProgress)
  onProgress?.(null)
  const file = await extractAudio(blob, name, onStatus)
  onStatus?.('上傳音訊到專案中…')
  const result = await uploadMediaFile(file, folder)
  return { result, name: file.name, bytes: file.size }
}
