import { useEffect, useRef, type PointerEvent } from 'react'
import { LONG_PRESS_MS } from '../studio/curveGeometry'

/** Finger travel (px) that turns a press into a drag / scroll instead of a long press. */
const SLOP = 8

/**
 * Touch and pen have no right-click: Safari on iPad doesn't fire `contextmenu` for a held press on
 * ordinary elements. Holding still for LONG_PRESS_MS dispatches a real `contextmenu` event on the
 * pressed element, so every existing onContextMenu menu (lane, region, section, automation node)
 * opens with no per-element wiring. Spread the returned handlers on a container (capture phase, so
 * children that stopPropagation() on pointerdown are still seen).
 */
export function useLongPressContextMenu() {
  const timer = useRef(0)
  const press = useRef<{ id: number; x: number; y: number } | null>(null)
  const down = useRef(new Set<number>())

  const cancel = () => {
    window.clearTimeout(timer.current)
    press.current = null
  }
  useEffect(() => cancel, [])

  return {
    onPointerDownCapture(e: PointerEvent) {
      if (e.pointerType === 'mouse') return
      down.current.add(e.pointerId)
      cancel()
      // A second finger is a pinch, not a long press.
      if (down.current.size > 1) return
      const target = e.target as Element
      // Curve grips already use a long press (reset the segment).
      if (target.closest?.('[data-curve-ui]')) return
      const { clientX, clientY, pointerId } = e
      press.current = { id: pointerId, x: clientX, y: clientY }
      timer.current = window.setTimeout(() => {
        press.current = null
        if (!target.isConnected) return
        target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX, clientY, button: 2 }))
      }, LONG_PRESS_MS)
    },
    onPointerMoveCapture(e: PointerEvent) {
      const p = press.current
      if (p && p.id === e.pointerId && Math.hypot(e.clientX - p.x, e.clientY - p.y) > SLOP) cancel()
    },
    onPointerUpCapture(e: PointerEvent) {
      down.current.delete(e.pointerId)
      cancel()
    },
    onPointerCancelCapture(e: PointerEvent) {
      down.current.delete(e.pointerId)
      cancel()
    },
  }
}
