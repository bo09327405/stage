import type { FFmpeg } from '@ffmpeg/ffmpeg'

/*
 * In-browser media conversion with ffmpeg compiled to WebAssembly: nothing to install, works on phones, tablets and
 * computers, and the file never leaves the device until the converted result is uploaded. The engine (~30 MB) is
 * downloaded once, only when someone opens the converter, from a pinned CDN version (the single-threaded build,
 * so no special server headers are needed).
 */

const CORE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd'
/** The browser has to hold the input, the output and ffmpeg's memory at once. */
export const MAX_CONVERT_BYTES = 500 * 1024 * 1024

export type OutputFormat = 'mp3' | 'wav' | 'mp4'

export interface ConvertOptions {
  format: OutputFormat
  /** MP3 bitrate, kbit/s. */
  bitrate: 128 | 192 | 320
  channels: 'keep' | 'mono' | 'stereo'
  sampleRate: 'keep' | 44100 | 48000
  /** Even out the loudness (EBU R128, about −16 LUFS), so cues sit at a similar level. */
  normalize: boolean
}

export const DEFAULT_CONVERT: ConvertOptions = { format: 'mp3', bitrate: 192, channels: 'keep', sampleRate: 'keep', normalize: false }

let instance: Promise<FFmpeg> | null = null

/** Load (once) and return the ffmpeg engine. */
export function loadFFmpeg(): Promise<FFmpeg> {
  instance ??= (async () => {
    const [{ FFmpeg }, { toBlobURL }] = await Promise.all([import('@ffmpeg/ffmpeg'), import('@ffmpeg/util')])
    const ff = new FFmpeg()
    await ff.load({
      coreURL: await toBlobURL(`${CORE}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${CORE}/ffmpeg-core.wasm`, 'application/wasm'),
    })
    return ff
  })().catch((err) => {
    instance = null
    throw new Error(`無法載入轉檔引擎（需要網路連線）：${(err as Error).message}`)
  })
  return instance
}

/** Stop a running conversion and drop the engine (it is reloaded on the next use). */
export function cancelConversion() {
  const pending = instance
  instance = null
  void pending?.then((ff) => ff.terminate()).catch(() => {})
}

const stem = (name: string) => name.replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 80) || 'media'
const ext = (name: string) => /\.([a-z0-9]{1,5})$/i.exec(name)?.[1].toLowerCase() ?? 'bin'

/** The ffmpeg arguments for one conversion (exported for tests). */
export function ffmpegArgs(input: string, output: string, o: ConvertOptions): string[] {
  const args = ['-i', input]
  const audioFilters = o.normalize ? ['-af', 'loudnorm=I=-16:TP=-1.5:LRA=11'] : []
  const channels = o.channels === 'mono' ? ['-ac', '1'] : o.channels === 'stereo' ? ['-ac', '2'] : []
  const rate = o.sampleRate === 'keep' ? [] : ['-ar', String(o.sampleRate)]
  if (o.format === 'mp3') return [...args, '-vn', ...audioFilters, ...channels, ...rate, '-c:a', 'libmp3lame', '-b:a', `${o.bitrate}k`, output]
  if (o.format === 'wav') return [...args, '-vn', ...audioFilters, ...channels, ...rate, '-c:a', 'pcm_s16le', output]
  // MP4: H.264 + AAC, at most 720p, fast start for streaming. Slow in a browser: meant for short clips.
  return [...args, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-vf', "scale='min(1280,iw)':-2", '-pix_fmt', 'yuv420p', ...audioFilters, ...channels, ...rate, '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', output]
}

/** Convert one file. `onProgress` gets 0–1. */
export async function convertFile(file: File, options: ConvertOptions, onProgress: (ratio: number) => void): Promise<File> {
  if (file.size > MAX_CONVERT_BYTES) throw new Error(`檔案太大（${Math.round(file.size / 1048576)} MB）：瀏覽器轉檔上限 ${MAX_CONVERT_BYTES / 1048576} MB`)
  const ff = await loadFFmpeg()
  const inName = `in-${Date.now().toString(36)}.${ext(file.name)}`
  const outName = `out-${Date.now().toString(36)}.${options.format}`
  const handler = ({ progress }: { progress: number }) => onProgress(Math.min(1, Math.max(0, progress)))
  ff.on('progress', handler)
  try {
    await ff.writeFile(inName, new Uint8Array(await file.arrayBuffer()))
    const code = await ff.exec(ffmpegArgs(inName, outName, options))
    if (code !== 0) throw new Error('轉檔失敗：這個檔案的格式或內容無法處理')
    const data = (await ff.readFile(outName)) as Uint8Array<ArrayBuffer>
    const type = options.format === 'mp3' ? 'audio/mpeg' : options.format === 'wav' ? 'audio/wav' : 'video/mp4'
    return new File([data], `${stem(file.name)}.${options.format}`, { type })
  } finally {
    ff.off('progress', handler)
    await ff.deleteFile(inName).catch(() => {})
    await ff.deleteFile(outName).catch(() => {})
  }
}
