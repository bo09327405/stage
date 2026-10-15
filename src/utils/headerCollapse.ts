import { useEffect, useRef, useState } from 'react'

/*
 * The control panel's top bar in full screen (or as a home-screen app on iPad): it can be folded
 * away to give the executors, sequences and panel the whole height, and called back with the tab
 * at the top edge (or, with a mouse, by touching the top edge — it hides again when left).
 * Folded / shown is remembered per device, separately for full screen and the normal window.
 */

const KEY = 'theatre.surface.headerCollapsed'
type Pref = { fs: boolean; win: boolean; app: boolean }

function read(): Pref {
  try {
    const r = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Pref> | null
    // Full screen folds the bar by default: that's what it's for.
    // The home-screen app starts with the bar showing (folded only if the user folded it there).
    return { fs: r?.fs !== false, win: r?.win === true, app: r?.app === true }
  } catch {
    return { fs: true, win: false, app: false }
  }
}

/** A home-screen web app (iPad "Add to Home Screen") is full screen without the Fullscreen API. */
const standalone = () =>
  typeof window !== 'undefined' && (window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true)

export function useHeaderCollapse(isFullscreen: boolean) {
  const [pref, setPref] = useState(read)
  const [peek, setPeek] = useState(false)
  const immersive = isFullscreen || standalone()
  const homeApp = !isFullscreen && standalone()
  const collapsed = homeApp ? pref.app : immersive ? pref.fs : pref.win
  const hideTimer = useRef(0)

  const setCollapsed = (value: boolean) => {
    setPeek(false)
    setPref((p) => {
      const next = homeApp ? { ...p, app: value } : immersive ? { ...p, fs: value } : { ...p, win: value }
      try {
        localStorage.setItem(KEY, JSON.stringify(next))
      } catch {
        // Not remembered; still applies now.
      }
      return next
    })
  }

  /** Mouse at the top edge: show the folded bar over the page for a moment. */
  const startPeek = () => {
    clearTimeout(hideTimer.current)
    if (collapsed) setPeek(true)
  }
  /** Pointer left the bar: fold it again — unless one of its menus is open. */
  const endPeek = () => {
    clearTimeout(hideTimer.current)
    const check = () => {
      if (document.querySelector('[data-grid-menu], [data-studio-menu-list], [role="menu"], [role="dialog"]')) hideTimer.current = window.setTimeout(check, 600)
      else setPeek(false)
    }
    hideTimer.current = window.setTimeout(check, 700)
  }
  useEffect(() => () => clearTimeout(hideTimer.current), [])

  return { immersive, collapsed, peek: collapsed && peek, setCollapsed, startPeek, endPeek }
}
