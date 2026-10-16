/** Timecode m:ss.mmm (or h:mm:ss.mmm). */
/** "1:23.456", "0:16", "1:02:03.5" or plain seconds → seconds, or null when it isn't a time. */
export function parseTimecode(text: string): number | null {
  const parts = text.trim().replace(/,/g, '.').split(':')
  if (parts.length === 0 || parts.length > 3 || parts.some((p) => !/^\d+(\.\d*)?$|^\.\d+$/.test(p))) return null
  const nums = parts.map(Number)
  const seconds = nums.reduce((total, n) => total * 60 + n, 0)
  return Number.isFinite(seconds) ? seconds : null
}

export function timecode(seconds: number, ms = true) {
  const s = Math.max(0, seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const secText = ms ? sec.toFixed(3).padStart(6, '0') : Math.floor(sec).toString().padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${secText}` : `${m}:${secText}`
}

/** Ruler label m:ss, with as many decimals as the step needs. */
export function rulerLabel(seconds: number, step: number) {
  const m = Math.floor(seconds / 60)
  const s = seconds - m * 60
  const decimals = step < 0.1 ? 2 : step < 1 ? 1 : 0
  return `${m}:${s.toFixed(decimals).padStart(decimals ? 3 + decimals : 2, '0')}`
}

export const toDb = (gain: number) => (gain <= 0.0001 ? -Infinity : 20 * Math.log10(gain))
export const fromDb = (db: number) => 10 ** (db / 20)
export const dbLabel = (gain: number) => {
  const db = toDb(gain)
  return Number.isFinite(db) ? `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB` : '−∞ dB'
}

/** Ruler step (seconds) for a zoom (px per second): labels roughly every 90 px. */
export function rulerStep(zoom: number) {
  const steps = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300]
  return steps.find((s) => s * zoom >= 90) ?? 600
}

export const ZOOM_MIN = 4
export const ZOOM_MAX = 1200
export const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z))

/** Files that look like audio (by type, or by extension when the OS gives no type). */
export const isAudioFile = (f: File) => /^(audio|video)\//.test(f.type) || /\.(mp3|wav|wave|webm|ogg|oga|opus|m4a|aac|flac|aif|aiff|mp4|mov)$/i.test(f.name)
