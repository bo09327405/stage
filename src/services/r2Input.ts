import type { MediaKind, ProjectMedia } from './mediaLibrary'
import { objectName, r2KeyOf } from './storage'

/*
 * Files typed or pasted by hand: an R2 object key (theatre/cues/Default/檔名.mp3), this server's
 * R2 address (/api/r2/o/…, also with any host in front, e.g. the ngrok link), or the bucket's public
 * URL (R2_PUBLIC_BASE_URL, *.r2.dev). Everything resolves to the key and is played through
 * /api/r2/o/<key>, like files picked from the list.
 */

export const R2_INPUT_PLACEHOLDER = 'theatre/cues/Default/檔名.mp3 或 R2 網址'

/** The app's address for an R2 object. */
export const r2ObjectUrl = (key: string) => `/api/r2/o/${key.split('/').map(encodeURIComponent).join('/')}`

let publicBase: Promise<string | null> | null = null
let knownBase: string | null = null
function serverPublicBase(): Promise<string | null> {
  publicBase ??= fetch('/api/r2/status')
    .then((r) => r.json())
    .then((b: { publicBaseUrl?: string | null }) => (knownBase = b.publicBaseUrl?.replace(/\/+$/, '') || null))
    .catch(() => null)
  return publicBase
}

const decodeKey = (path: string) => {
  try {
    return path.split('/').map(decodeURIComponent).join('/')
  } catch {
    return path
  }
}

/** The R2 key an input names, or null when it isn't an R2 path / URL. */
export function r2KeyFromInput(input: string, base: string | null = null): string | null {
  const text = input.trim().replace(/^["'「]|["'」]$/g, '')
  if (!text) return null
  if (text.startsWith('/api/r2/o/')) return r2KeyOf(text)
  if (/^https?:\/\//i.test(text)) {
    let url: URL
    try {
      url = new URL(text)
    } catch {
      return null
    }
    if (url.pathname.startsWith('/api/r2/o/')) return r2KeyOf(url.pathname)
    if (base && text.startsWith(`${base}/`)) return decodeKey(text.slice(base.length + 1).split(/[?#]/)[0])
    // Public bucket URL (https://pub-….r2.dev/<key>) or the S3 endpoint (…r2.cloudflarestorage.com/<bucket>/<key>).
    if (url.hostname.endsWith('.r2.dev')) return decodeKey(url.pathname.slice(1)) || null
    if (url.hostname.endsWith('.r2.cloudflarestorage.com')) return decodeKey(url.pathname.split('/').slice(2).join('/')) || null
    return null
  }
  // A bare key: theatre/… (a leading slash or "r2:" is tolerated).
  const key = text.replace(/^r2:\/*/i, '').replace(/^\/+/, '')
  return /^[^\s?#][^?#]*\/[^/?#]+\.[a-z0-9]{2,5}$/i.test(key) ? key : null
}

/**
 * A typed media address as the app stores it: R2 paths / URLs become /api/r2/o/<key>; anything
 * else is kept as typed.
 */
export function normalizeMediaInput(input: string): string {
  void serverPublicBase()
  const text = input.trim()
  if (!text || text.startsWith('/api/r2/o/')) return text
  const key = r2KeyFromInput(text, knownBase)
  return key ? r2ObjectUrl(key) : text
}

const EXT_KIND: [RegExp, MediaKind][] = [
  [/\.(mp3|wav|m4a|aac|ogg|oga|opus|flac|aif|aiff|weba)$/i, 'audio'],
  [/\.(mp4|mov|m4v|webm|mkv)$/i, 'video'],
  [/\.(png|jpe?g|gif|webp|avif|svg)$/i, 'image'],
]

/**
 * Look up a typed R2 path: checks the file exists and returns it as a library entry (not saved
 * anywhere). Throws a message for the person when it can't be used.
 */
export async function lookupR2Input(input: string): Promise<ProjectMedia> {
  const key = r2KeyFromInput(input, await serverPublicBase())
  if (!key) throw new Error('看不懂這個路徑：請輸入 R2 檔案路徑（例如 theatre/cues/Default/檔名.mp3）或 R2 網址')
  const url = r2ObjectUrl(key)
  let res: Response
  try {
    res = await fetch(url, { method: 'HEAD', cache: 'no-store' })
  } catch {
    throw new Error('無法連線到伺服器，請稍後再試')
  }
  if (res.status === 404) throw new Error(`R2 上找不到「${key}」`)
  if (res.status === 403) throw new Error('沒有權限讀取這個檔案')
  if (!res.ok) throw new Error(`讀取 R2 檔案失敗（HTTP ${res.status}）`)
  const type = res.headers.get('content-type') ?? ''
  const kind: MediaKind | undefined = type.startsWith('image/')
    ? 'image'
    : type.startsWith('video/')
      ? 'video'
      : type.startsWith('audio/')
        ? 'audio'
        : EXT_KIND.find(([re]) => re.test(key))?.[1]
  if (!kind) throw new Error('這不是圖片、音訊或影片檔')
  return {
    id: `r2:${key}`,
    kind,
    url,
    publicId: key,
    folder: key.slice(0, key.lastIndexOf('/')),
    name: objectName(key),
    duration: 0,
    bytes: Number(res.headers.get('content-length')) || 0,
    source: 'link',
    createdAt: Date.now(),
    storage: 'r2',
  }
}
