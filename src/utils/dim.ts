import { useState } from 'react'

/*
 * DIM — one behaviour everywhere (Set Cue console, Studio monitoring, Set Cue headphone monitoring):
 *
 *   · Left-click toggles. DIM never touches a fader or volume value: it is a separate gain stage
 *     multiplied on top, so switching it off returns exactly to where the mix was.
 *   · Gain = 10^(dB / 20) — e.g. −20 dB → ×0.1 (10 % amplitude), −10 dB → ×0.316. Never silence:
 *     that's MUTE.
 *   · Right-click picks the amount: −10 / −15 / −20 (default) / −30 dB, or a custom value; each area
 *     remembers its own on this device (localStorage).
 */

export type DimArea = 'console' | 'studio' | 'monitor'

export const DIM_PRESETS = [-10, -15, -20, -30] as const
export const DEFAULT_DIM_DB = -20
/** Custom values: between −1 and −60 dB (any deeper is practically MUTE). */
export const DIM_MIN_DB = -60
export const DIM_MAX_DB = -1

/** A DIM amount kept within range (anything invalid → the default). */
export function clampDimDb(db: unknown): number {
  const n = Number(db)
  if (!Number.isFinite(n)) return DEFAULT_DIM_DB
  return Math.round(Math.min(DIM_MAX_DB, Math.max(DIM_MIN_DB, n)) * 10) / 10
}

/** Amplitude factor for an attenuation in dB: 10^(dB / 20). */
export const dbToGain = (db: number) => 10 ** (db / 20)

/** The gain DIM applies: 1 when off, 10^(dB / 20) when on. */
export const dimGain = (on: boolean, db: number | undefined | null) => (on ? dbToGain(clampDimDb(db ?? DEFAULT_DIM_DB)) : 1)

/** "−20 dB" with a real minus sign. */
export const formatDimDb = (db: number) => `${db < 0 ? '−' : ''}${Math.abs(clampDimDb(db))} dB`

const key = (area: DimArea) => `theatre.dim.db.${area}`

export function readDimDb(area: DimArea): number {
  try {
    const v = localStorage.getItem(key(area))
    return v === null ? DEFAULT_DIM_DB : clampDimDb(v)
  } catch {
    return DEFAULT_DIM_DB
  }
}

export function writeDimDb(area: DimArea, db: number) {
  try {
    localStorage.setItem(key(area), String(clampDimDb(db)))
  } catch {
    // Not remembered on this device; the value still applies now.
  }
}

/** This device's DIM amount for an area, remembered in localStorage. */
export function useDimDb(area: DimArea): [number, (db: number) => void] {
  const [db, setDb] = useState(() => readDimDb(area))
  return [
    db,
    (next: number) => {
      const v = clampDimDb(next)
      writeDimDb(area, v)
      setDb(v)
    },
  ]
}
