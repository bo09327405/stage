import { useState } from 'react'

/*
 * The control panel's Executor sidebar (per device, localStorage): shown or not, docked left or
 * right, and its width (dragged on the splitter, 200–600 px).
 */

export interface ExecSidebarPrefs {
  open: boolean
  side: 'left' | 'right'
  width: number
}

export const SIDEBAR_MIN = 200
export const SIDEBAR_MAX = 600
export const SIDEBAR_DEFAULT = 320
const KEY = 'theatre.surface.execSidebar'

export const clampWidth = (w: number) => Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w)))

function read(): ExecSidebarPrefs {
  try {
    const r = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<ExecSidebarPrefs> | null
    return { open: r?.open === true, side: r?.side === 'left' ? 'left' : 'right', width: clampWidth(Number(r?.width) || SIDEBAR_DEFAULT) }
  } catch {
    return { open: false, side: 'right', width: SIDEBAR_DEFAULT }
  }
}

export function useExecSidebar() {
  const [prefs, setPrefs] = useState(read)
  const save = (change: Partial<ExecSidebarPrefs>) =>
    setPrefs((p) => {
      const next = { ...p, ...change, ...(change.width != null ? { width: clampWidth(change.width) } : {}) }
      try {
        localStorage.setItem(KEY, JSON.stringify(next))
      } catch {
        // Not remembered; still applies now.
      }
      return next
    })
  return [prefs, save] as const
}
