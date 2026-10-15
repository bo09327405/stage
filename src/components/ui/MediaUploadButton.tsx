import { useState } from 'react'
import type { CloudinaryUploadResult } from '../../services/cloudinary'
import { uploadMediaFile } from '../../services/storage'
import { recordProjectMedia, recordSharedMedia, type ProjectMedia } from '../../services/mediaLibrary'

/**
 * File picker that uploads to Cloudflare R2 (image / audio / video; Cloudinary is only for audience
 * uploads). With `library`, the
 * upload is also added to the project's media library so pickers can offer it again later — or,
 * with `shared`, to the Default library every project can pick from.
 */
export function MediaUploadButton({
  accept,
  folder,
  label = '上傳檔案',
  library,
  upload,
  onUploaded,
}: {
  accept: string
  folder: string
  label?: string
  /** `studioId`: uploaded from a Studio — filed in that Studio's 上傳 folder (素材 panel). */
  library?: { projectId: string; source: ProjectMedia['source']; shared?: boolean; studioId?: string | null }
  /** Upload some other way (e.g. a different R2 helper). */
  upload?: (file: File) => Promise<CloudinaryUploadResult>
  onUploaded: (result: CloudinaryUploadResult, file: File) => void
}) {
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleFile(file: File | undefined) {
    if (!file) return
    setUploading(true)
    setError(null)
    try {
      const result = upload ? await upload(file) : ((await uploadMediaFile(file, folder)) as unknown as CloudinaryUploadResult)
      onUploaded(result, file)
      if (library) {
        // The file is already usable; a failed index write only means it won't show in pickers.
        await (library.shared ? recordSharedMedia(result, file, library.source, folder) : recordProjectMedia(library.projectId, result, file, folder, library.source, library.studioId ? { studioId: library.studioId, category: 'upload' } : null)).catch(
          (err) => setError(`已上傳，但未能加入${library.shared ? ' Default 共用' : '專案'}素材庫：${(err as Error).message}`),
        )
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="space-y-1.5">
      <label
        className={`relative flex h-9 cursor-pointer items-center justify-center overflow-hidden rounded-lg border border-dashed border-white/20 text-xs font-medium text-white/70 transition hover:border-accent hover:text-white ${
          uploading ? 'pointer-events-none' : ''
        }`}
      >
        {uploading && (
          <span className="absolute inset-y-0 left-0 w-1/3 animate-[upload-slide_1.2s_ease-in-out_infinite] bg-accent/30" />
        )}
        <span className="relative">{uploading ? '上傳中…' : `⇪ ${label}`}</span>
        <input
          type="file"
          accept={accept}
          className="hidden"
          disabled={uploading}
          onChange={(e) => {
            handleFile(e.target.files?.[0])
            e.target.value = ''
          }}
        />
      </label>
      {error && <p className="text-xs text-panic">{error}</p>}
    </div>
  )
}
