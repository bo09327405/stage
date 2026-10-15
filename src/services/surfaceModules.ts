import { onValue, ref, remove, set } from 'firebase/database'
import { useEffect, useState } from 'react'
import type { Cue, Hit } from '../types/cue'
import { SURFACE_COLUMNS, type Surface, type SurfaceWidget } from '../types/surface'
import type { BuiltinModule } from '../utils/builtinModules'
import { buildSurfaceFile, parseSurfaceFile, type SurfaceFile } from '../utils/surfaceTransfer'
import { isAdmin, type AppUser } from './auth'
import { db } from './firebase'
import { deleteR2, putR2, readR2Json } from './storage'
import { replaceSurfaceLayout } from './surfaces'

/*
 * Layout modules: a saved control-panel layout (buttons, faders, knobs, Cue Monitor / Note / Stage
 * / Intercom blocks) that any project can load.
 *
 *   theatre/modules/{id}.json      the layout file on Cloudflare R2 (same format as 匯出面板 JSON)
 *   surfaceModules/{id}            global index: name, who saved it, what's in it
 *
 * Cue and hit bindings travel by cue number / title and hit title, and re-link on load.
 */

export const MODULES_PREFIX = 'theatre/modules/'
const INDEX = 'surfaceModules'
export const moduleKey = (id: string) => `${MODULES_PREFIX}${id}.json`

export interface SurfaceModule {
  id: string
  name: string
  description: string
  by: { uid: string; name: string; email: string }
  createdAt: number
  /** Project the layout was saved from. */
  source: { projectId: string; projectName: string; surfaceName: string }
  columns: number
  counts: { buttons: number; faders: number; knobs: number; windows: number }
  /** R2 object key of the layout file. */
  key: string
}

function countWidgets(widgets: SurfaceWidget[]): SurfaceModule['counts'] {
  const c = { buttons: 0, faders: 0, knobs: 0, windows: 0 }
  for (const w of widgets) {
    if (w.type === 'knob') c.knobs++
    else if (w.type === 'fader') c.faders++
    else if (w.display !== 'action') c.windows++
    else c.buttons++
  }
  return c
}

/** Every module, newest first. */
export function useSurfaceModules() {
  const [modules, setModules] = useState<SurfaceModule[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(
    () =>
      onValue(
        ref(db, INDEX),
        (snap) =>
          setModules(
            Object.entries((snap.val() ?? {}) as Record<string, Omit<SurfaceModule, 'id'>>)
              .map(([id, m]) => ({ ...m, id }))
              .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)),
          ),
        (err) => {
          setError(err.message)
          setModules([])
        },
      ),
    [],
  )
  return { modules, error }
}

const newModuleId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`

/** Save a surface's current layout as a module (file on R2, entry in the global index). */
export async function saveSurfaceModule(opts: {
  user: AppUser
  name: string
  description?: string
  surface: Surface
  cues: Cue[]
  hits: Hit[]
  projectId: string
  projectName: string
}): Promise<SurfaceModule> {
  const name = opts.name.trim().slice(0, 60)
  if (!name) throw new Error('請輸入模組名稱')
  const widgets = Object.values(opts.surface.widgets)
  if (widgets.length === 0) throw new Error('這個控台還沒有任何元件')
  // Modules carry the layout only; Global Trigger rules stay with their project.
  const file: SurfaceFile = { ...buildSurfaceFile(opts.surface, opts.cues, [], opts.hits), name }
  const id = newModuleId()
  const key = moduleKey(id)
  await putR2(key, JSON.stringify(file))
  const entry: Omit<SurfaceModule, 'id'> = {
    name,
    description: (opts.description ?? '').trim().slice(0, 200),
    by: { uid: opts.user.uid, name: opts.user.name, email: opts.user.email },
    createdAt: Date.now(),
    source: { projectId: opts.projectId, projectName: opts.projectName, surfaceName: opts.surface.name },
    columns: opts.surface.columns,
    counts: countWidgets(widgets),
    key,
  }
  try {
    await set(ref(db, `${INDEX}/${id}`), entry)
  } catch (err) {
    await deleteR2([key]).catch(() => {})
    throw err
  }
  return { ...entry, id }
}

export const canDeleteModule = (m: SurfaceModule, user: AppUser | null) => !!user && (m.by?.uid === user.uid || isAdmin(user))

export async function deleteSurfaceModule(m: SurfaceModule) {
  await deleteR2([m.key])
  await remove(ref(db, `${INDEX}/${m.id}`))
}

export interface LoadResult {
  widgets: number
  unmatchedCues: number
  unmatchedHits: number
}

/** Put a module's widgets on a surface: replace the layout, or add them below what's there. */
function placeWidgets(surface: Surface, incoming: SurfaceWidget[], mode: 'replace' | 'append') {
  if (mode === 'replace') return incoming
  const existing = Object.values(surface.widgets)
  const top = existing.reduce((m, w) => Math.max(m, w.y + w.h), 0)
  return [...existing, ...incoming.map((w) => ({ ...w, y: w.y + top }))]
}

/** Load one of the built-in modules (Theatre, Live Music) into a surface; one undoable step. */
export async function loadBuiltinModule(opts: { module: BuiltinModule; mode: 'replace' | 'append'; projectId: string; surface: Surface; newId: () => string }) {
  const incoming = opts.module.build(opts.newId)
  await replaceSurfaceLayout(
    opts.projectId,
    opts.surface.id,
    placeWidgets(opts.surface, incoming, opts.mode),
    { columns: opts.mode === 'replace' ? SURFACE_COLUMNS : Math.max(opts.surface.columns, SURFACE_COLUMNS) },
    `${opts.mode === 'replace' ? '套用' : '加入'}內建模組「${opts.module.name}」`,
  )
  return incoming.length
}

/**
 * Load a module into a surface. `replace` swaps the whole layout; `append` adds the module's
 * widgets below the existing ones. Either way it's one undoable step.
 */
export async function loadSurfaceModule(opts: {
  module: SurfaceModule
  mode: 'replace' | 'append'
  projectId: string
  surface: Surface
  cues: Cue[]
  hits: Hit[]
  newId: () => string
}): Promise<LoadResult> {
  const file = await readR2Json<SurfaceFile>(opts.module.key)
  const parsed = parseSurfaceFile(JSON.stringify(file), opts.cues, opts.newId, opts.hits)
  const widgets = placeWidgets(opts.surface, parsed.widgets, opts.mode)
  const columns = Math.max(opts.surface.columns, parsed.file.columns || 0)
  await replaceSurfaceLayout(
    opts.projectId,
    opts.surface.id,
    widgets,
    opts.mode === 'replace' ? { columns: parsed.file.columns || opts.surface.columns } : { columns },
    `${opts.mode === 'replace' ? '載入' : '加入'}面板模組「${opts.module.name}」`,
  )
  return { widgets: parsed.widgets.length, unmatchedCues: parsed.unmatchedCues, unmatchedHits: parsed.unmatchedHits }
}
