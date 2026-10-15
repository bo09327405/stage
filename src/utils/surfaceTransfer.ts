import type { Cue, Hit } from '../types/cue'
import { normalizeWidget, type Surface, type SurfaceAction, type SurfaceWidget } from '../types/surface'
import type { GlobalTrigger } from '../types/trigger'

/**
 * Surface layout files (Download / Upload JSON). Cue references travel with their cue number and
 * title, so a layout imported into another project re-links to the matching cues there.
 */

export const SURFACE_FILE_FORMAT = 'theatre-cue/surface'
export const SURFACE_FILE_VERSION = 1

export interface SurfaceFile {
  format: typeof SURFACE_FILE_FORMAT
  version: number
  exportedAt: string
  name: string
  columns: number
  oscHost: string
  oscPort: number
  /** Widgets without ids (ids are regenerated on import). */
  widgets: Omit<SurfaceWidget, 'id'>[]
  /** cueId → how to find the same cue in another project. */
  cueRefs: Record<string, { cueNumber: number; title: string }>
  /** hitId → its title, to re-link hit knobs / faders in another project. */
  hitRefs?: Record<string, { title: string }>
  /** The project's Global Profile, included so a team's whole control logic moves together. */
  globalTriggers: Omit<GlobalTrigger, 'id'>[]
}

export function buildSurfaceFile(surface: Surface, cues: Cue[], globalTriggers: GlobalTrigger[], hits: Hit[] = []): SurfaceFile {
  const widgets = Object.values(surface.widgets).sort((a, b) => a.y - b.y || a.x - b.x)
  const cueRefs: SurfaceFile['cueRefs'] = {}
  const hitRefs: NonNullable<SurfaceFile['hitRefs']> = {}
  for (const w of widgets) {
    for (const a of w.actions) {
      const cue = a.kind === 'cue' ? cues.find((c) => c.id === a.cueId) : undefined
      if (cue) cueRefs[cue.id] = { cueNumber: cue.cueNumber, title: cue.title }
      const hit = a.kind === 'hit' ? hits.find((h) => h.id === a.hitId) : undefined
      if (hit) hitRefs[hit.id] = { title: hit.title }
    }
  }
  return {
    format: SURFACE_FILE_FORMAT,
    version: SURFACE_FILE_VERSION,
    exportedAt: new Date().toISOString(),
    name: surface.name,
    columns: surface.columns,
    oscHost: surface.oscHost,
    oscPort: surface.oscPort,
    widgets: widgets.map(({ id: _id, ...rest }) => rest),
    cueRefs,
    hitRefs,
    globalTriggers: globalTriggers.map(({ id: _id, ...rest }) => rest),
  }
}

/** Trigger a browser download of the layout as surface_layout-<name>.json. */
export function downloadSurfaceFile(file: SurfaceFile) {
  const slug = file.name.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) || 'surface'
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `surface_layout-${slug}.json`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export interface ParsedImport {
  file: SurfaceFile
  widgets: SurfaceWidget[]
  /** Cue actions that couldn't be matched to a cue in this project (left unassigned). */
  unmatchedCues: number
  /** Hit actions that couldn't be matched to a hit in this project (left unassigned). */
  unmatchedHits: number
}

/** Validate an uploaded file and rebuild its widgets with fresh ids and re-linked cues. */
export function parseSurfaceFile(text: string, cues: Cue[], newId: () => string, hits: Hit[] = []): ParsedImport {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('不是有效的 JSON 檔案')
  }
  const file = data as Partial<SurfaceFile>
  if (file.format !== SURFACE_FILE_FORMAT) throw new Error('這不是 Theatre Cue 的控制面板檔案')
  if ((file.version ?? 0) > SURFACE_FILE_VERSION) throw new Error('檔案來自較新的版本，請先更新程式')
  if (!Array.isArray(file.widgets)) throw new Error('檔案缺少 widgets')

  let unmatchedCues = 0
  let unmatchedHits = 0
  const relink = (action: SurfaceAction): SurfaceAction => {
    if (action.kind === 'hit') {
      if (!action.hitId || hits.some((h) => h.id === action.hitId)) return action
      const title = file.hitRefs?.[action.hitId]?.title
      const match = title ? hits.find((h) => h.title === title) : undefined
      if (!match) unmatchedHits++
      return { ...action, hitId: match?.id ?? '' }
    }
    if (action.kind !== 'cue' || cues.some((c) => c.id === action.cueId)) return action
    const ref = file.cueRefs?.[action.cueId]
    const match = ref && (cues.find((c) => c.cueNumber === ref.cueNumber) ?? cues.find((c) => c.title === ref.title))
    if (!match) unmatchedCues++
    return { ...action, cueId: match?.id ?? '' }
  }

  const widgets = file.widgets.map((raw, i) => {
    const w = raw as Partial<SurfaceWidget>
    if (w.type !== 'button' && w.type !== 'fader' && w.type !== 'knob') throw new Error(`第 ${i + 1} 個元件類型無效`)
    for (const key of ['x', 'y', 'w', 'h'] as const) {
      if (!Number.isFinite(w[key])) throw new Error(`第 ${i + 1} 個元件缺少位置或大小`)
    }
    const widget = normalizeWidget({ ...w, type: w.type, id: newId() })
    return { ...widget, actions: widget.actions.map(relink) }
  })

  return { file: file as SurfaceFile, widgets, unmatchedCues, unmatchedHits }
}
