import { useEffect, useRef, useState } from 'react'

/**
 * A number that glides to `target` over `ms` (ease-out) instead of jumping — for faders that move
 * on their own (DIM on / off). While `hold` is true (the user is dragging) it follows at once.
 */
export function useGlide(target: number, hold = false, ms = 180): number {
  const [shown, setShown] = useState(target)
  const from = useRef(target)
  const frame = useRef(0)
  const shownRef = useRef(target)

  useEffect(() => {
    cancelAnimationFrame(frame.current)
    if (hold || !Number.isFinite(target) || !Number.isFinite(shownRef.current)) {
      shownRef.current = target
      frame.current = requestAnimationFrame(() => setShown(target))
      return () => cancelAnimationFrame(frame.current)
    }
    from.current = shownRef.current
    const start = performance.now()
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / ms)
      const v = from.current + (target - from.current) * (1 - (1 - t) ** 3)
      shownRef.current = v
      setShown(v)
      if (t < 1) frame.current = requestAnimationFrame(step)
    }
    frame.current = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame.current)
  }, [target, hold, ms])

  return shown
}
