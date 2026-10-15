import { uploadStudioFile, type StoredFile } from '../services/storage'
import { recordProjectMedia, recordSharedMedia } from '../services/mediaLibrary'
import type { AssetPlacement } from '../services/assetLibrary'
import { encodeWav, primeSource } from './audio'

/**
 * Put studio audio (a recording, a TTS clip, a mixdown) on Cloudflare R2, so collaborators, the
 * audience and other projects can load it, and list it in the project's (or the shared Default)
 * media library. The buffer is primed
 * under its URL so it plays here at once, without re-downloading.
 */
export async function uploadStudioAudio(
  buffer: AudioBuffer,
  {
    name,
    folder,
    projectId,
    shared = false,
    bitDepth = 16,
    placement = null,
  }: { name: string; folder: string; projectId: string; shared?: boolean; bitDepth?: 16 | 24; placement?: AssetPlacement | null },
): Promise<StoredFile> {
  const fileName = `${name.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60) || 'studio'}.wav`
  const file = new File([encodeWav(buffer, bitDepth)], fileName, { type: 'audio/wav' })
  const result = await uploadStudioFile(file, { folder, name: fileName, duration: buffer.duration })
  primeSource(result.secure_url, buffer)
  // The file is usable even if the library index can't be written.
  await (shared ? recordSharedMedia(result, file, 'studio', folder) : recordProjectMedia(projectId, result, file, folder, 'studio', placement)).catch(() => {})
  return result
}

/** Save a buffer as a WAV download. */
export function downloadWav(buffer: AudioBuffer, name: string, bitDepth: 16 | 24 = 16) {
  const url = URL.createObjectURL(encodeWav(buffer, bitDepth))
  const a = document.createElement('a')
  a.href = url
  a.download = `${name.replace(/[\\/:*?"<>|]+/g, '_') || 'studio'}.wav`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}
