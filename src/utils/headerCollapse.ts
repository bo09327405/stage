import { useEffect, useRef, useState } from 'react'

/*
 * The control panel's second bar (surface tabs, 面板 / Executor / 網格 / 側欄, Monitor / Notes /
 * Stage / OSC / MIDI, 編輯面板): it can be folded away completely — in a normal browser window,
 * full screen and the home-screen app alike — so the cue list and pads get the whole height. A folded
 * bar takes no layout space (it floats over the page while peeked) and is called back with the tab
 * at the top edge (or, with a mouse, by touching the top edge — it hides again when left).
 * Folded / shown is one preference, remembered per device (localStorage "isToolbarCollapsed").
 */

const KEY = 'isToolbarCollapsed'

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === 'true'
  } catch {
    return false
  }
}

/** A home-screen web app (iPad "Add to Home Screen") is full screen without the Fullscreen API. */
const standalone = () =>
  typeof window !== 'undefined' && (window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true)

export function useHeaderCollapse(isFullscreen: boolean) {
  const [collapsed, setCollapsedState] = useState(read)
  const [peek, setPeek] = useState(false)
  const immersive = isFullscreen || standalone()
  const hideTimer = useRef(0)

  const setCollapsed = (value: boolean) => {
    setPeek(false)
    setCollapsedState(value)
    try {
      localStorage.setItem(KEY, String(value))
    } catch {
      // Not remembered; still applies now.
    }
  }

  // Another tab / window of the same device changed it: follow.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => e.key === KEY && setCollapsedState(e.newValue === 'true')
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

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
