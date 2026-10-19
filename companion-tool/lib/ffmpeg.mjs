import { spawn } from 'node:child_process'

/**
 * ffmpeg helpers: the command line for each output, a parser for `-progress pipe:1` output, and a probe for the
 * duration. Only files that already sit on this computer are processed — nothing here downloads anything.
 */

export const AUDIO_EXTS = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'aif', 'aiff']
export const VIDEO_EXTS = ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v']
export const MEDIA_EXTS = [...AUDIO_EXTS, ...VIDEO_EXTS]

export const DEFAULT_OPTIONS = { format: 'mp3', bitrate: 192, channels: 'keep', sampleRate: 'keep', normalize: false }

/** Validate / complete options coming from the web page. */
export function cleanOptions(raw = {}) {
  const format = ['mp3', 'wav', 'mp4'].includes(raw.format) ? raw.format : DEFAULT_OPTIONS.format
  return {
    format,
    bitrate: [128, 192, 256, 320].includes(Number(raw.bitrate)) ? Number(raw.bitrate) : DEFAULT_OPTIONS.bitrate,
    channels: ['keep', 'mono', 'stereo'].includes(raw.channels) ? raw.channels : 'keep',
    sampleRate: [44100, 48000].includes(Number(raw.sampleRate)) ? Number(raw.sampleRate) : 'keep',
    normalize: raw.normalize === true,
  }
}

/** ffmpeg arguments (without -y / -progress, which the runner adds) for one conversion. */
export function buildArgs(input, output, options) {
  const o = cleanOptions(options)
  const channels = o.channels === 'mono' ? ['-ac', '1'] : o.channels === 'stereo' ? ['-ac', '2'] : []
  const rate = o.sampleRate === 'keep' ? [] : ['-ar', String(o.sampleRate)]
  const loud = o.normalize ? ['-af', 'loudnorm=I=-16:TP=-1.5:LRA=11'] : []
  if (o.format === 'mp3') return ['-i', input, '-vn', ...loud, ...channels, ...rate, '-c:a', 'libmp3lame', '-b:a', `${o.bitrate}k`, output]
  if (o.format === 'wav') return ['-i', input, '-vn', ...loud, ...channels, ...rate, '-c:a', 'pcm_s24le', output]
  return ['-i', input, '-c:v', 'libx264', '-preset', 'medium', '-crf', '21', '-vf', "scale='min(1920,iw)':-2", '-pix_fmt', 'yuv420p', ...loud, ...channels, ...rate, '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', output]
}

/**
 * Feed it the text of ffmpeg's `-progress pipe:1` stream; it returns the latest `{ seconds, done }` seen in the chunk
 * (or null). Lines look like `out_time_us=1500000` and `progress=end`.
 */
export function parseProgress(chunk) {
  let seconds = null
  let done = false
  for (const line of String(chunk).split(/\r?\n/)) {
    const m = /^out_time_(?:us|ms)=(-?\d+)$/.exec(line.trim())
    if (m) seconds = Math.max(0, Number(m[1]) / 1_000_000) // both names carry microseconds
    if (line.trim() === 'progress=end') done = true
  }
  return seconds === null && !done ? null : { seconds, done }
}

/** Seconds of media in a file, via ffprobe (null when unknown). */
export function probeDuration(ffprobe, file) {
  return new Promise((resolve) => {
    const p = spawn(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file])
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.on('error', () => resolve(null))
    p.on('close', () => {
      const n = Number.parseFloat(out)
      resolve(Number.isFinite(n) && n > 0 ? n : null)
    })
  })
}

/** Is ffmpeg callable? Resolves with its version line, or null. */
export function ffmpegVersion(ffmpeg) {
  return new Promise((resolve) => {
    const p = spawn(ffmpeg, ['-version'])
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.on('error', () => resolve(null))
    p.on('close', (code) => resolve(code === 0 ? (out.split('\n')[0] ?? '').trim() : null))
  })
}

/**
 * Run one conversion. `onProgress(percent|null)` fires as ffmpeg reports; resolves when it finishes, rejects with
 * the tail of ffmpeg's error output. `handle.kill()` stops it.
 */
export function runFfmpeg({ ffmpeg, ffprobe, input, output, options, onProgress, handle = {} }) {
  return new Promise((resolve, reject) => {
    probeDuration(ffprobe, input).then((duration) => {
      if (handle.cancelled) return reject(new Error('cancelled'))
      const child = spawn(ffmpeg, ['-y', '-hide_banner', '-nostats', '-progress', 'pipe:1', ...buildArgs(input, output, options)], { stdio: ['ignore', 'pipe', 'pipe'] })
      handle.kill = () => {
        handle.cancelled = true
        child.kill('SIGTERM')
      }
      let tail = ''
      child.stderr.on('data', (d) => (tail = (tail + d).slice(-2000)))
      child.stdout.on('data', (d) => {
        const p = parseProgress(d)
        if (!p) return
        if (p.done) onProgress?.(100)
        else if (duration && p.seconds !== null) onProgress?.(Math.min(99, Math.round((p.seconds / duration) * 100)))
        else onProgress?.(null)
      })
      child.on('error', (err) => reject(new Error(err.code === 'ENOENT' ? `找不到 ffmpeg（${ffmpeg}）：請先安裝，或用 --ffmpeg 指定路徑` : err.message)))
      child.on('close', (code) => {
        if (handle.cancelled) return reject(new Error('cancelled'))
        if (code === 0) resolve()
        else reject(new Error(`ffmpeg 轉檔失敗（代碼 ${code}）：${tail.trim().split('\n').slice(-3).join(' ')}`))
      })
    })
  })
}
