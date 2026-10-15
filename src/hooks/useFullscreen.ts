import { useCallback, useEffect, useState } from 'react'

/** Safari (older iPadOS / macOS) only has the webkit-prefixed API. */
type WebkitDocument = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> | void }
type WebkitElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void }

const fullscreenElement = () => document.fullscreenElement ?? (document as WebkitDocument).webkitFullscreenElement ?? null

/** When the page last left full screen (ms). */
let lastExitAt = 0
if (typeof document !== 'undefined') {
  const track = () => {
    if (!fullscreenElement()) lastExitAt = Date.now()
  }
  document.addEventListener('fullscreenchange', track)
  document.addEventListener('webkitfullscreenchange', track)
}

/**
 * Whether an Esc press belongs to full screen (the browser uses it to leave): true while full
 * screen, or just after leaving it. Shortcuts like "Esc = Fade Out All" should skip it then.
 */
export const escapeLeavesFullscreen = () => !!fullscreenElement() || Date.now() - lastExitAt < 500

/**
 * Browser full screen for this page: whether it's on, and enter / exit / toggle. The state follows
 * `fullscreenchange`, so leaving with Esc, F11 or the system's own controls updates it too.
 */
export function useFullscreen() {
  const [isFullscreen, setIsFullscreen] = useState(() => typeof document !== 'undefined' && !!fullscreenElement())
  const root = typeof document !== 'undefined' ? (document.documentElement as WebkitElement) : null
  const supported = !!(root && (root.requestFullscreen || root.webkitRequestFullscreen))

  useEffect(() => {
    const sync = () => setIsFullscreen(!!fullscreenElement())
    document.addEventListener('fullscreenchange', sync)
    document.addEventListener('webkitfullscreenchange', sync)
    sync()
    return () => {
      document.removeEventListener('fullscreenchange', sync)
      document.removeEventListener('webkitfullscreenchange', sync)
    }
  }, [])

  const enter = useCallback(async () => {
    const el = document.documentElement as WebkitElement
    if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' })
    else await el.webkitRequestFullscreen?.()
  }, [])
  const exit = useCallback(async () => {
    if (!fullscreenElement()) return
    const doc = document as WebkitDocument
    if (document.exitFullscreen) await document.exitFullscreen()
    else await doc.webkitExitFullscreen?.()
  }, [])
  /** Exit when full screen, enter otherwise (decided from the live document state, not React's). */
  const toggle = useCallback(() => (fullscreenElement() ? exit() : enter()), [enter, exit])

  return { isFullscreen, supported, enter, exit, toggle }
}
