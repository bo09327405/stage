import { useEffect, useRef } from 'react'
import type { PanelMode, PanelTarget } from '../types/surface'

/*
 * Window commands from control-panel buttons (on screen, or pressed remotely by MIDI / OSC):
 * "toggle the Stage window", "open Notes"… Whatever view owns that window on this page reacts.
 */

const EVENT = 'theatre:panel'

export function emitPanel(target: PanelTarget, mode: PanelMode) {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { target, mode } }))
}

/** New open/closed state for a window after a command. */
export const applyPanelMode = (shown: boolean, mode: PanelMode) => (mode === 'toggle' ? !shown : mode === 'open')

/** Handle window commands for the given targets while `enabled`. */
export function usePanelCommands(targets: PanelTarget[], handler: (target: PanelTarget, mode: PanelMode) => void, enabled = true) {
  const latest = useRef(handler)
  useEffect(() => {
    latest.current = handler
  })
  const key = targets.join(',')
  useEffect(() => {
    if (!enabled) return
    const owned = key.split(',')
    const listen = (e: Event) => {
      const { target, mode } = (e as CustomEvent<{ target: PanelTarget; mode: PanelMode }>).detail
      if (owned.includes(target)) latest.current(target, mode)
    }
    window.addEventListener(EVENT, listen)
    return () => window.removeEventListener(EVENT, listen)
  }, [key, enabled])
}
