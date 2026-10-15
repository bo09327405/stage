import { CLOUD_NAME, UPLOAD_PRESET, type CloudinaryUploadResult } from './cloudinary'

/*
 * Cloudinary Upload Widget, for audience uploads of any media (photos, videos, sound files).
 * Unsigned like the rest of the audience flow: the preset decides what's allowed, including the
 * moderation add-on. The widget script is loaded on first use.
 */

const SCRIPT_URL = 'https://upload-widget.cloudinary.com/global/all.js'

interface WidgetResult {
  event: string
  info: CloudinaryUploadResult & Record<string, unknown>
}
interface Widget {
  open: () => void
  close: () => void
  destroy: () => Promise<void> | void
}
declare global {
  interface Window {
    cloudinary?: {
      createUploadWidget: (options: Record<string, unknown>, callback: (error: unknown, result: WidgetResult) => void) => Widget
    }
  }
}

let loading: Promise<void> | null = null
function loadScript(): Promise<void> {
  if (window.cloudinary) return Promise.resolve()
  loading ??= new Promise<void>((resolve, reject) => {
    const el = document.createElement('script')
    el.src = SCRIPT_URL
    el.async = true
    el.onload = () => (window.cloudinary ? resolve() : reject(new Error('Upload Widget 載入失敗')))
    el.onerror = () => {
      loading = null
      el.remove()
      reject(new Error('無法載入 Cloudinary Upload Widget（請檢查網路）'))
    }
    document.head.appendChild(el)
  })
  return loading
}

export type WidgetMedia = 'image' | 'video' | 'audio'

const FORMATS: Record<WidgetMedia, string[]> = {
  image: ['jpg', 'jpeg', 'png', 'heic', 'heif', 'webp', 'gif'],
  video: ['mp4', 'mov', 'm4v', 'webm', '3gp'],
  audio: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'webm'],
}

export interface AudienceWidgetOptions {
  folder: string
  tags: string[]
  context: Record<string, string>
  /** Which kinds of file the audience may send. */
  accept: WidgetMedia[]
  onUploaded: (result: CloudinaryUploadResult) => void
  onError: (message: string) => void
  onClose?: () => void
}

/** Open the Upload Widget for one audience upload. Resolves once the widget is showing. */
export async function openAudienceWidget(opts: AudienceWidgetOptions): Promise<Widget> {
  await loadScript()
  const widget = window.cloudinary!.createUploadWidget(
    {
      cloudName: CLOUD_NAME,
      uploadPreset: UPLOAD_PRESET,
      folder: opts.folder,
      tags: opts.tags,
      context: opts.context,
      sources: ['local', 'camera'],
      multiple: false,
      maxFiles: 1,
      resourceType: 'auto',
      clientAllowedFormats: [...new Set(opts.accept.flatMap((k) => FORMATS[k]))],
      maxFileSize: 100 * 1024 * 1024,
      // Phones upload multi-megapixel photos; scale them down before they leave the device.
      maxImageWidth: 2560,
      maxImageHeight: 2560,
      showPoweredBy: false,
      showAdvancedOptions: false,
      singleUploadAutoClose: true,
      language: 'zh_TW',
      text: {
        zh_TW: {
          or: '或',
          menu: { files: '我的檔案', camera: '相機' },
          local: { browse: '選擇檔案', dd_title_single: '把檔案拖到這裡' },
          camera: { capture: '拍攝', cancel: '取消', take_pic: '拍照並上傳', explanation: '請允許使用相機' },
          queue: { title: '上傳中', done: '完成', upload_more: '再傳一個' },
        },
      },
      styles: {
        palette: { window: '#111111', windowBorder: '#444444', tabIcon: '#0A84FF', menuIcons: '#FFFFFF', textDark: '#000000', textLight: '#FFFFFF', link: '#0A84FF', action: '#0A84FF', inactiveTabIcon: '#888888', error: '#FF453A', inProgress: '#0A84FF', complete: '#30D158', sourceBg: '#1C1C1E' },
      },
    },
    (error, result) => {
      if (error) return opts.onError(typeof error === 'object' && error && 'statusText' in error ? String((error as { statusText: unknown }).statusText) : '上傳失敗')
      if (result?.event === 'success') opts.onUploaded(result.info)
      if (result?.event === 'close') opts.onClose?.()
    },
  )
  widget.open()
  return widget
}
