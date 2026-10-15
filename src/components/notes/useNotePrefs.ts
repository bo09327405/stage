import { useEffect, useState } from 'react'
import type { NoteTheme } from './stageTheme'

const readPref = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
const writePref = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Not remembered; harmless.
  }
}

/** A Note window's view settings — text size, follow, look — remembered per window on this device. */
export function useNotePrefs(prefKey: string, defaults: { font?: number; follow?: boolean } = {}) {
  const [font, setFont] = useState(() => Number(readPref(`${prefKey}.font`)) || defaults.font || 1)
  const [follow, setFollow] = useState(() => {
    const v = readPref(`${prefKey}.follow`)
    return v === null ? (defaults.follow ?? true) : v !== '0'
  })
  const [theme, setTheme] = useState<NoteTheme>(() => {
    const t = readPref(`${prefKey}.theme`)
    return t === 'normal' || t === 'dark' ? t : 'auto'
  })
  useEffect(() => {
    writePref(`${prefKey}.font`, String(font))
    writePref(`${prefKey}.follow`, follow ? '1' : '0')
    writePref(`${prefKey}.theme`, theme)
  }, [prefKey, font, follow, theme])
  return { font, setFont, follow, setFollow, theme, setTheme }
}
export type NotePrefs = ReturnType<typeof useNotePrefs>
