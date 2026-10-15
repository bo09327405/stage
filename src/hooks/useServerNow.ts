import { useEffect, useState } from 'react'

/**
 * Server-clock time that re-renders while `running`: every animation frame by default (progress
 * bars), or every `intervalMs` when given (cheaper, for phones that only need coarse timing).
 */
export function useServerNow(serverNow: () => number, running: boolean, intervalMs?: number): number {
  const [now, setNow] = useState(serverNow)

  useEffect(() => {
    if (!running) return
    if (intervalMs) {
      const timer = setInterval(() => setNow(serverNow()), intervalMs)
      return () => clearInterval(timer)
    }
    let frame = requestAnimationFrame(function tick() {
      setNow(serverNow())
      frame = requestAnimationFrame(tick)
    })
    return () => cancelAnimationFrame(frame)
  }, [serverNow, running, intervalMs])

  return now
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return '∞'
  const s = Math.max(0, seconds)
  const m = Math.floor(s / 60)
  const rest = s - m * 60
  return `${String(m).padStart(2, '0')}:${rest.toFixed(1).padStart(4, '0')}`
}

/** Millisecond-precise time, e.g. 00:05.000 (for fade and wait settings). */
export function formatPrecise(seconds: number): string {
  if (!Number.isFinite(seconds)) return '∞'
  const s = Math.max(0, seconds)
  const m = Math.floor(s / 60)
  return `${String(m).padStart(2, '0')}:${(s - m * 60).toFixed(3).padStart(6, '0')}`
}
