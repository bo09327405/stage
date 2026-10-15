import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { formatTime } from '../../hooks/useServerNow'
import {
  CATEGORY_FOLDERS,
  arrangeAssets,
  createAssetFolder,
  deleteAssetFolder,
  executeAssetDelete,
  parseStudioFolder,
  planAssetDelete,
  renameAsset,
  renameAssetFolder,
  sortAssets,
  studioFolderId,
  type AssetDeletePlan,
  type AssetFolder,
} from '../../services/assetLibrary'
import type { AppUser } from '../../services/auth'
import { logFileActivity } from '../../services/fileActivity'
import type { ProjectMedia } from '../../services/mediaLibrary'

/** Drag only starts after this much travel (a shorter press on the grip does nothing). */
const DRAG_THRESHOLD = 4

type Target = { kind: 'row'; id: string; after: boolean } | { kind: 'folder'; id: string } | { kind: 'root' }
interface Drag {
  id: string
  pointerId: number
  startX: number
  startY: number
  x: number
  y: number
  moving: boolean
  target: Target | null
}
type Menu = { kind: 'asset'; id: string; x: number; y: number; moving?: boolean } | { kind: 'folder'; id: string; x: number; y: number }

/** A folder in the tree: a Studio of the project, one of its standard folders, or a custom folder. */
interface FolderNode {
  id: string
  kind: 'studio' | 'category' | 'custom'
  name: string
  /** For a standard folder: its Studio's name (for labels like 「Mix / 錄音」). */
  parentName?: string
  children: FolderNode[]
  custom?: AssetFolder
}

/**
 * The Studio 素材 list with management.
 *
 * "project" mode shows the project's tree: one folder per Studio of the project (named after it,
 * live) holding the standard folders 背景音樂 / 錄音 / 上傳 / 語音, then custom folders, then
 * unfiled files. Every member can rename (double-click or menu), drag to reorder or into a folder,
 * move via the menu, and delete — one file from its menu, or many in 勾選刪除 mode (🗑️): tick
 * files (or whole folders, or 全選), 確認刪除, confirm.
 *
 * "shared" is the Default library for admins (rename / delete only); "view" has no management.
 */
export function AssetList({
  mode,
  projectId,
  projectName,
  base,
  user,
  assets,
  folders,
  studios,
  currentStudio,
  reveal = null,
  query,
  renderLead,
  renderAction,
  onNotify,
}: {
  mode: 'project' | 'shared' | 'view'
  projectId: string
  projectName: string
  /** The index the records live in: projects/{pid}/media or the shared Default index. */
  base: string
  user: AppUser | null
  assets: ProjectMedia[]
  /** Custom folders. */
  folders: AssetFolder[]
  /** The project's Studios (tab order): one folder each. */
  studios: { id: string; name: string }[]
  /** The Studio open now: its folder starts expanded. */
  currentStudio: string | null
  /** Reveal this file (a clip clicked on the timeline): expand its folders, scroll to it, highlight it. */
  reveal?: { id: string; nonce: number } | null
  query: string
  /** Preview button. */
  renderLead: (m: ProjectMedia) => ReactNode
  /** Insert / copy button. */
  renderAction: (m: ProjectMedia) => ReactNode
  onNotify: (text: string, error?: boolean) => void
}) {
  const manage = mode !== 'view'
  const organise = mode === 'project'

  /* ---------- tree ---------- */

  const tree: FolderNode[] = organise
    ? [
        ...studios.map((st) => ({
          id: studioFolderId(st.id),
          kind: 'studio' as const,
          name: st.name,
          children: CATEGORY_FOLDERS.map((c) => ({ id: studioFolderId(st.id, c.id), kind: 'category' as const, name: c.name, parentName: st.name, children: [] })),
        })),
        ...folders.map((f) => ({ id: f.id, kind: 'custom' as const, name: f.name, children: [], custom: f })),
      ]
    : []
  const nodes = new Map<string, FolderNode>()
  const index = (list: FolderNode[]) => list.forEach((n) => (nodes.set(n.id, n), index(n.children)))
  index(tree)
  const label = (id: string | null) => {
    const n = id ? nodes.get(id) : null
    return n ? (n.parentName ? `${n.parentName} / ${n.name}` : n.name) : '最上層'
  }

  // Open / closed per folder, remembered per browser. Studio folders start open only for the Studio
  // being edited; everything else starts open.
  const openKey = `theatre.assets.open.${projectId}`
  const [openState, setOpenState] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem(openKey) ?? '{}')
    } catch {
      return {}
    }
  })
  const isOpen = (n: FolderNode) => openState[n.id] ?? (n.kind === 'studio' ? n.id === studioFolderId(currentStudio ?? '') : true)
  const setOpen = (id: string, open: boolean) => {
    const next = { ...openState, [id]: open }
    setOpenState(next)
    try {
      localStorage.setItem(openKey, JSON.stringify(next))
    } catch {
      // Not remembered; harmless.
    }
  }

  const [renaming, setRenaming] = useState<{ kind: 'asset' | 'folder'; id: string } | null>(null)
  const [newFolder, setNewFolder] = useState<string | null>(null)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [deleting, setDeleting] = useState<ProjectMedia[] | null>(null)
  // 勾選刪除 mode: the ticked files; null = off.
  const [selected, setSelected] = useState<Set<string> | null>(null)
  const selecting = selected !== null
  const [drag, setDrag] = useState<Drag | null>(null)
  const dragRef = useRef<Drag | null>(null)
  useLayoutEffect(() => {
    dragRef.current = drag
  }, [drag])

  // Reveal: open every folder above the file, then scroll to it and flash it for two seconds.
  const [flash, setFlash] = useState<{ id: string; nonce: number; path: string } | null>(null)
  const [revealed, setRevealed] = useState<number | null>(null)
  if (reveal && revealed !== reveal.nonce) {
    // A new reveal (adjusting state while rendering, once per click): open the folders above it.
    setRevealed(reveal.nonce)
    const asset = assets.find((m) => m.id === reveal.id)
    if (asset) {
      const loc = organise && asset.assetFolder && nodes.has(asset.assetFolder) ? asset.assetFolder : null
      const chain = loc ? [...new Set(loc.startsWith('studio:') ? [loc.split(':').slice(0, 2).join(':'), loc] : [loc])] : []
      if (chain.some((id) => openState[id] !== true)) setOpenState({ ...openState, ...Object.fromEntries(chain.map((id) => [id, true])) })
      setFlash({ id: asset.id, nonce: reveal.nonce, path: [mode === 'project' ? projectName || '專案' : 'Default', ...(loc ? [label(loc)] : []), asset.name].join(' / ') })
    }
  }
  const notifyRef = useRef(onNotify)
  useLayoutEffect(() => {
    notifyRef.current = onNotify
  })
  useEffect(() => {
    if (!flash) return
    try {
      localStorage.setItem(openKey, JSON.stringify(openState))
    } catch {
      // Not remembered; harmless.
    }
    notifyRef.current(`📍 ${flash.path}`)
    // After the folders have opened: bring the row into view; the highlight lasts two seconds.
    const raf = requestAnimationFrame(() => document.querySelector(`[data-asset-row="${CSS.escape(flash.id)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }))
    const t = window.setTimeout(() => setFlash((f) => (f?.nonce === flash.nonce ? null : f)), 2000)
    return () => {
      cancelAnimationFrame(raf)
      window.clearTimeout(t)
    }
  }, [flash?.nonce]) // eslint-disable-line react-hooks/exhaustive-deps

  const locOf = (m: ProjectMedia) => (organise && m.assetFolder && nodes.has(m.assetFolder) ? m.assetFolder : null)
  const sorted = sortAssets(assets)
  const searching = !!query.trim()
  const visible = (m: ProjectMedia) => !searching || m.name.toLowerCase().includes(query.trim().toLowerCase())
  const inFolder = (id: string | null) => sorted.filter((m) => locOf(m) === id)
  /** Every file under a folder, its subfolders included. */
  const under = (n: FolderNode): ProjectMedia[] => [...inFolder(n.id), ...n.children.flatMap(under)]
  const run = (job: Promise<unknown>, done?: string) =>
    job.then(
      () => done && onNotify(done),
      (err: Error) => err.message !== 'read-only' && onNotify(err.message, true),
    )

  const toggleSelect = (ids: string[], on: boolean) =>
    setSelected((cur) => {
      const next = new Set(cur ?? [])
      for (const id of ids) {
        if (on) next.add(id)
        else next.delete(id)
      }
      return next
    })

  /* ---------- drag ---------- */

  const targetAt = (x: number, y: number, dragged: string): Target | null => {
    const el = document.elementFromPoint(x, y)
    const row = el?.closest<HTMLElement>('[data-asset-row]')
    if (row) {
      const id = row.dataset.assetRow!
      if (id === dragged) return null
      const r = row.getBoundingClientRect()
      return { kind: 'row', id, after: y > r.top + r.height / 2 }
    }
    const head = el?.closest<HTMLElement>('[data-asset-folder-head]')
    if (head) return { kind: 'folder', id: head.dataset.assetFolderHead! }
    if (el?.closest('[data-asset-root-zone]')) return { kind: 'root' }
    return null
  }

  const moveTo = (moved: ProjectMedia, folder: string | null, ids: string[]) => {
    const changed = locOf(moved) !== folder
    if (changed)
      void logFileActivity({
        action: 'move',
        name: moved.name,
        fileType: moved.kind,
        storage: moved.storage ?? null,
        url: moved.url,
        key: moved.publicId,
        record: `${base}/${moved.id}`,
        projectId,
        studioId: parseStudioFolder(folder)?.studioId ?? parseStudioFolder(locOf(moved))?.studioId ?? null,
        from: label(locOf(moved)),
        to: label(folder),
      })
    run(
      arrangeAssets(projectId, folder, ids, changed ? `把「${moved.name}」移到「${label(folder)}」` : `調整素材「${moved.name}」的順序`),
      changed ? `已移到「${label(folder)}」` : undefined,
    )
    // Open the destination (and its Studio) so the file stays in view.
    const n = folder ? nodes.get(folder) : null
    if (n && !isOpen(n)) setOpen(n.id, true)
    const parent = n?.kind === 'category' ? nodes.get(folder!.split(':').slice(0, 2).join(':')) : null
    if (parent && !isOpen(parent)) setOpen(parent.id, true)
  }

  const drop = (d: Drag) => {
    const t = d.target
    const moved = assets.find((m) => m.id === d.id)
    if (!t || !moved) return
    if (t.kind === 'row') {
      const at = assets.find((m) => m.id === t.id)
      if (!at) return
      const folder = locOf(at)
      const ids = inFolder(folder).map((m) => m.id).filter((id) => id !== d.id)
      ids.splice(ids.indexOf(t.id) + (t.after ? 1 : 0), 0, d.id)
      moveTo(moved, folder, ids)
    } else {
      const folder = t.kind === 'folder' ? t.id : null
      moveTo(moved, folder, [...inFolder(folder).map((m) => m.id).filter((id) => id !== d.id), d.id])
    }
  }

  const grip = (m: ProjectMedia) =>
    organise && !searching ? (
      <span
        className="flex h-8 w-4 shrink-0 cursor-grab touch-none items-center justify-center text-[11px] text-white/25 select-none hover:text-white/70 active:cursor-grabbing"
        title="拖曳調整順序，或拖到資料夾"
        aria-hidden
        data-asset-grip={m.id}
        onPointerDown={(e) => {
          if (e.button !== 0) return
          e.preventDefault()
          e.currentTarget.setPointerCapture(e.pointerId)
          setDrag({ id: m.id, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY, moving: false, target: null })
        }}
        onPointerMove={(e) => {
          const d = dragRef.current
          if (!d || d.pointerId !== e.pointerId) return
          const moving = d.moving || Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > DRAG_THRESHOLD
          setDrag({ ...d, x: e.clientX, y: e.clientY, moving, target: moving ? targetAt(e.clientX, e.clientY, d.id) : null })
        }}
        onPointerUp={(e) => {
          const d = dragRef.current
          if (!d || d.pointerId !== e.pointerId) return
          setDrag(null)
          if (d.moving) drop(d)
        }}
        onPointerCancel={() => setDrag(null)}
      >
        ⋮⋮
      </span>
    ) : null

  const checkbox = (checked: boolean, partial: boolean, onChange: (on: boolean) => void, label: string, data: Record<string, string>) => (
    <input
      type="checkbox"
      checked={checked}
      ref={(el) => {
        if (el) el.indeterminate = partial && !checked
      }}
      onChange={(e) => onChange(e.target.checked)}
      onClick={(e) => e.stopPropagation()}
      className="h-4 w-4 shrink-0 accent-[#ff453a]"
      aria-label={label}
      {...data}
    />
  )

  /* ---------- rows ---------- */

  const row = (m: ProjectMedia, depth: number) => {
    const dragging = drag?.moving && drag.id === m.id
    const t = drag?.moving && drag.target?.kind === 'row' && drag.target.id === m.id ? drag.target : null
    const ticked = !!selected?.has(m.id)
    return (
      <li
        key={m.id}
        className={`group relative flex items-center gap-1.5 rounded-lg py-1.5 pr-1.5 ${ticked ? 'bg-panic/10' : 'hover:bg-white/[0.05]'} ${dragging ? 'opacity-35' : ''} ${selecting ? 'cursor-pointer' : ''} ${flash?.id === m.id ? 'animate-asset-reveal' : ''}`}
        style={{ paddingLeft: 4 + depth * 12 }}
        data-asset-row={m.id}
        data-revealed={flash?.id === m.id ? 'true' : undefined}
        data-library-item={m.publicId}
        onClick={() => selecting && toggleSelect([m.id], !ticked)}
        onContextMenu={(e) => {
          if (!manage || selecting) return
          e.preventDefault()
          setMenu({ kind: 'asset', id: m.id, x: e.clientX, y: e.clientY })
        }}
      >
        {t && <span className={`pointer-events-none absolute right-1 left-1 h-0.5 rounded-full bg-accent shadow-[0_0_6px_#0a84ff] ${t.after ? '-bottom-px' : '-top-px'}`} data-asset-drop-line />}
        {selecting ? checkbox(ticked, false, (on) => toggleSelect([m.id], on), `勾選「${m.name}」`, { 'data-asset-check': m.id }) : grip(m)}
        {renderLead(m)}
        <span className="min-w-0 flex-1">
          {renaming?.kind === 'asset' && renaming.id === m.id ? (
            <RenameInput
              value={m.name}
              onDone={(name) => {
                setRenaming(null)
                if (name !== null && name.trim() && name.trim() !== m.name) run(renameAsset(base, m.id, name, '素材', m), `已重新命名為「${name.trim()}」`)
              }}
            />
          ) : (
            <span
              className="block truncate text-xs text-white/85"
              title={manage && !selecting ? `${m.name}（雙擊重新命名）` : m.name}
              onDoubleClick={() => manage && !selecting && setRenaming({ kind: 'asset', id: m.id })}
              data-asset-name={m.id}
            >
              {m.name}
            </span>
          )}
          <span className="block truncate font-mono text-[10px] text-white/30">
            {m.storage === 'r2' && <span className="mr-1 rounded bg-[#f6821f]/20 px-1 text-[#f6a35c]">R2</span>}
            {m.duration ? formatTime(m.duration) : ''} {m.folder}
          </span>
        </span>
        {!selecting && renderAction(m)}
        {manage && !selecting && (
          <button
            type="button"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              setMenu({ kind: 'asset', id: m.id, x: r.right - 200, y: r.bottom + 2 })
            }}
            className="h-8 w-6 shrink-0 rounded-md text-sm text-white/35 hover:bg-white/10 hover:text-white"
            aria-label={`「${m.name}」的更多操作`}
            data-asset-menu={m.id}
          >
            ⋯
          </button>
        )}
      </li>
    )
  }

  const folderBlock = (n: FolderNode, depth: number): ReactNode => {
    const all = under(n)
    const shown = all.filter(visible)
    // While searching, folders without a match are hidden.
    if (searching && shown.length === 0) return null
    const open = isOpen(n) || searching
    const hot = drag?.moving && drag.target?.kind === 'folder' && drag.target.id === n.id
    const own = inFolder(n.id).filter(visible)
    const tickedHere = shown.filter((m) => selected?.has(m.id)).length
    const icon = n.kind === 'studio' ? '🎛️' : open ? '📂' : '📁'
    return (
      <li key={n.id} data-asset-folder={n.id} data-asset-folder-kind={n.kind}>
        <div
          className={`flex items-center gap-1.5 rounded-lg py-1 pr-1 ${hot ? 'bg-accent/20 ring-1 ring-accent' : 'hover:bg-white/[0.05]'}`}
          style={{ paddingLeft: 4 + depth * 12 }}
          data-asset-folder-head={n.id}
          onContextMenu={(e) => {
            if (n.kind !== 'custom' || selecting) return
            e.preventDefault()
            setMenu({ kind: 'folder', id: n.id, x: e.clientX, y: e.clientY })
          }}
        >
          {selecting && shown.length > 0 && checkbox(tickedHere === shown.length, tickedHere > 0, (on) => toggleSelect(shown.map((m) => m.id), on), `勾選「${n.name}」裡的所有素材`, { 'data-asset-folder-check': n.id })}
          <button type="button" onClick={() => setOpen(n.id, !open)} className="flex min-h-7 min-w-0 flex-1 items-center gap-1.5 text-left" aria-expanded={open} data-asset-folder-toggle={n.id}>
            <span className="w-3 text-[10px] text-white/45">{open ? '▾' : '▸'}</span>
            <span>{icon}</span>
            {renaming?.kind === 'folder' && renaming.id === n.id ? (
              <RenameInput
                value={n.name}
                onDone={(name) => {
                  setRenaming(null)
                  if (name !== null && name.trim() && name.trim() !== n.name) run(renameAssetFolder(projectId, n.id, name))
                }}
              />
            ) : (
              <span
                className={`truncate text-xs ${n.kind === 'category' ? 'text-white/75' : 'font-semibold text-white/90'}`}
                onDoubleClick={() => n.kind === 'custom' && !selecting && setRenaming({ kind: 'folder', id: n.id })}
                title={n.kind === 'studio' ? `Studio「${n.name}」的素材（名稱跟著 Studio）` : n.kind === 'category' ? '新素材依來源自動歸入' : n.name}
              >
                {n.name}
              </span>
            )}
            <span className="font-mono text-[10px] text-white/30">{all.length}</span>
            {n.kind === 'studio' && <span className="rounded bg-[#bf5af2]/20 px-1 text-[9px] text-[#d7a6ff]">Studio</span>}
          </button>
          {n.kind === 'custom' && !selecting && (
            <button
              type="button"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect()
                setMenu({ kind: 'folder', id: n.id, x: r.right - 200, y: r.bottom + 2 })
              }}
              className="h-7 w-6 shrink-0 rounded-md text-sm text-white/35 hover:bg-white/10 hover:text-white"
              aria-label={`資料夾「${n.name}」的更多操作`}
              data-asset-folder-menu={n.id}
            >
              ⋯
            </button>
          )}
        </div>
        {open && (
          <ul className="ml-2.5 space-y-0.5 border-l border-white/10">
            {n.children.map((c) => folderBlock(c, depth + 1))}
            {own.map((m) => row(m, depth + 1))}
            {n.kind !== 'studio' && all.length === 0 && (
              <li className="py-1 text-[10px] text-white/25" style={{ paddingLeft: 16 + depth * 12 }}>
                {n.kind === 'category' ? '空的 · 新素材會依來源自動放進來' : '空資料夾 · 把素材拖到資料夾名稱上即可放入'}
              </li>
            )}
          </ul>
        )}
      </li>
    )
  }

  const rootItems = inFolder(null).filter(visible)
  const visibleAll = sorted.filter(visible)
  const draggedAsset = drag?.moving ? assets.find((m) => m.id === drag.id) : null
  const menuAsset = menu?.kind === 'asset' ? assets.find((m) => m.id === menu.id) : null
  const menuFolder = menu?.kind === 'folder' ? folders.find((f) => f.id === menu.id) : null
  const tickedCount = selected?.size ?? 0
  const allTicked = visibleAll.length > 0 && visibleAll.every((m) => selected?.has(m.id))
  const destinations: { id: string | null; label: string; indent: number; header?: boolean }[] = [
    { id: null, label: '（最上層，不放資料夾）', indent: 0 },
    ...tree.flatMap((n) =>
      n.kind === 'studio'
        ? [{ id: n.id, label: `🎛️ ${n.name}`, indent: 0 }, ...n.children.map((c) => ({ id: c.id, label: c.name, indent: 1 }))]
        : [{ id: n.id, label: `📁 ${n.name}`, indent: 0 }],
    ),
  ]

  return (
    <>
      {manage && (
        <div className="flex flex-wrap items-center gap-1.5 px-2 pt-2" data-asset-toolbar>
          {selecting ? (
            <>
              <label className="flex min-h-8 cursor-pointer items-center gap-1.5 rounded-lg bg-white/[0.07] px-2.5 text-xs text-white/85">
                {checkbox(allTicked, tickedCount > 0, (on) => setSelected(on ? new Set(visibleAll.map((m) => m.id)) : new Set()), '全選', { 'data-asset-select-all': '' })}
                全選
              </label>
              <span className="text-[11px] text-white/55" data-asset-selected-count>
                已選 {tickedCount} 個
              </span>
              <span className="ml-auto" />
              <button type="button" onClick={() => setSelected(null)} className="min-h-8 rounded-lg px-2.5 text-xs text-white/60 hover:bg-white/10" data-asset-select-cancel>
                取消
              </button>
              <button
                type="button"
                disabled={tickedCount === 0}
                onClick={() => setDeleting(sorted.filter((m) => selected!.has(m.id)))}
                className="min-h-8 rounded-lg bg-panic px-3 text-xs font-semibold text-white disabled:opacity-35"
                data-asset-select-delete
              >
                確認刪除（{tickedCount}）
              </button>
            </>
          ) : (
            <>
              {organise &&
                (newFolder === null ? (
                  <button type="button" onClick={() => setNewFolder('')} className="min-h-8 rounded-lg bg-white/[0.07] px-2.5 text-xs text-white/80 hover:bg-white/15" data-asset-new-folder>
                    📁 新增資料夾
                  </button>
                ) : (
                  <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs">
                    📁
                    <RenameInput
                      value=""
                      placeholder="資料夾名稱，例如：背景音效"
                      onDone={(name) => {
                        setNewFolder(null)
                        if (name?.trim()) run(createAssetFolder(projectId, name, folders.length), `已新增資料夾「${name.trim()}」`)
                      }}
                    />
                  </span>
                ))}
              <button
                type="button"
                disabled={assets.length === 0}
                onClick={() => {
                  setSelected(new Set())
                  setMenu(null)
                  setRenaming(null)
                }}
                className="min-h-8 rounded-lg bg-white/[0.07] px-2.5 text-xs text-white/80 hover:bg-panic/20 hover:text-panic disabled:opacity-35"
                title="勾選刪除：勾選多個素材後一次刪除"
                data-asset-select-mode
              >
                🗑️ 刪除
              </button>
              {organise && !searching && assets.length > 1 && <span className="ml-auto text-[10px] text-white/30">⋮⋮ 拖曳排序 · 拖到資料夾歸檔</span>}
            </>
          )}
        </div>
      )}
      <ul className="space-y-0.5 p-2" data-library-list>
        {tree.map((n) => folderBlock(n, 0))}
        {rootItems.map((m) => row(m, 0))}
        {drag?.moving && organise && (
          <li
            className={`rounded-lg border border-dashed px-3 py-2 text-center text-[10px] ${drag.target?.kind === 'root' ? 'border-accent bg-accent/15 text-white' : 'border-white/15 text-white/40'}`}
            data-asset-root-zone
          >
            放到這裡：移到最上層（不放資料夾）
          </li>
        )}
        {assets.length === 0 && tree.length === 0 && <li className="p-4 text-center text-xs text-white/35">這個 R2 資料夾還沒有音檔</li>}
        {searching && visibleAll.length === 0 && <li className="p-4 text-center text-xs text-white/35">沒有符合的檔案</li>}
      </ul>

      {draggedAsset &&
        createPortal(
          <div
            className="pointer-events-none fixed z-[95] max-w-72 truncate rounded-lg border border-accent/60 bg-[#2c2c2e]/95 px-3 py-1.5 text-xs text-white shadow-[0_8px_24px_rgba(0,0,0,0.6)]"
            style={{ left: drag!.x + 12, top: drag!.y - 14 }}
            data-asset-ghost
          >
            🎵 {draggedAsset.name}
            {drag!.target?.kind === 'folder' && <span className="ml-1 text-accent">→ 📁 {label(drag!.target.id)}</span>}
          </div>,
          document.body,
        )}

      {menu && (menuAsset || menuFolder) && (
        <PopMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} label={menuAsset ? `素材「${menuAsset.name}」` : `資料夾「${menuFolder!.name}」`}>
          {(item) =>
            menuAsset ? (
              <>
                {item('✏️ 重新命名', () => setRenaming({ kind: 'asset', id: menuAsset.id }), 'rename')}
                {organise &&
                  (menu.kind === 'asset' && menu.moving ? (
                    <div className="max-h-64 overflow-y-auto border-y border-white/10 py-1" data-asset-move-list>
                      <div className="px-3 pb-1 text-[10px] text-white/40">移動至資料夾</div>
                      {destinations.map((d) => (
                        <div key={d.id ?? 'root'} style={{ paddingLeft: d.indent * 14 }}>
                          {item(
                            `${locOf(menuAsset) === d.id ? '✓ ' : ''}${d.label}`,
                            () => locOf(menuAsset) !== d.id && moveTo(menuAsset, d.id, [...inFolder(d.id).map((m) => m.id), menuAsset.id]),
                            `move:${d.id ?? 'root'}`,
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    item('📁 移動至資料夾…', () => setMenu({ ...menu, moving: true } as Menu), 'move', false)
                  ))}
                {item('🗑️ 刪除', () => setDeleting([menuAsset]), 'delete')}
              </>
            ) : (
              <>
                {item('✏️ 重新命名資料夾', () => setRenaming({ kind: 'folder', id: menuFolder!.id }), 'rename-folder')}
                {item('🗑️ 刪除資料夾（內容移回最上層）', () => run(deleteAssetFolder(projectId, menuFolder!, assets), `已刪除資料夾「${menuFolder!.name}」，裡面的素材移回最上層`), 'delete-folder')}
              </>
            )
          }
        </PopMenu>
      )}

      {deleting && (
        <DeleteDialog
          assets={deleting}
          shared={mode === 'shared'}
          load={() => planAssetDelete({ projectId, projectName, base, user, assets: deleting })}
          onClose={() => setDeleting(null)}
          onConfirm={async (plan, force) => {
            const r = await executeAssetDelete({ projectId, projectName, base, user, plan, force })
            setSelected(null)
            const kept = r.records - r.files
            onNotify(
              `已刪除 ${r.records} 個素材${r.files ? `，並從 R2 永久刪除 ${r.files} 個檔案` : ''}${r.clips ? `，移除時間軸上 ${r.clips} 個區段` : ''}` +
                (kept > 0 ? `；${kept} 個檔案仍被使用或不屬於此專案，已保留` : '') +
                (r.skipped ? `；${r.skipped} 個使用中的素材未刪除` : ''),
            )
          }}
        />
      )}
    </>
  )
}

/** Inline text field: Enter / blur saves, Esc cancels (onDone(null)). */
function RenameInput({ value, placeholder, onDone }: { value: string; placeholder?: string; onDone: (name: string | null) => void }) {
  const [text, setText] = useState(value)
  const done = useRef(false)
  const input = useRef<HTMLInputElement>(null)
  // Focus and select the name without its extension, like Finder.
  useEffect(() => {
    const el = input.current
    if (!el) return
    el.focus()
    const dot = value.lastIndexOf('.')
    el.setSelectionRange(0, dot > 0 ? dot : value.length)
  }, [value])
  const finish = (v: string | null) => {
    if (done.current) return
    done.current = true
    onDone(v)
  }
  return (
    <input
      ref={input}
      value={text}
      placeholder={placeholder}
      maxLength={120}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') finish(text)
        if (e.key === 'Escape') finish(null)
      }}
      onBlur={() => finish(text)}
      onClick={(e) => e.stopPropagation()}
      className="w-full min-w-0 rounded border border-accent bg-black/60 px-1.5 py-0.5 text-xs text-white outline-none"
      data-asset-rename-input
    />
  )
}

type MenuItem = (label: string, run: () => void, id: string, closes?: boolean) => ReactNode

/** Small dark popover menu, rendered into <body>. */
function PopMenu({ x, y, label, onClose, children }: { x: number; y: number; label: string; onClose: () => void; children: (item: MenuItem) => ReactNode }) {
  const box = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  useLayoutEffect(() => {
    close.current = onClose
  })
  useEffect(() => {
    const away = (e: Event) => !box.current?.contains(e.target as Node) && close.current()
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopImmediatePropagation()
      close.current()
    }
    const onBlur = () => close.current()
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('pointerdown', away, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [])
  const item: MenuItem = (text, run, id, closes = true) => (
    <button
      key={id}
      type="button"
      role="menuitem"
      onClick={() => {
        run()
        if (closes) close.current()
      }}
      className="block w-full truncate rounded-md px-3 py-1.5 text-left text-[13px] text-white/90 hover:bg-white/10"
      data-asset-menu-item={id}
    >
      {text}
    </button>
  )
  const width = 220
  return createPortal(
    <div
      ref={box}
      data-sheet-menu className="fixed z-[95] rounded-xl border border-white/10 bg-[#202020]/95 p-1 text-white shadow-2xl backdrop-blur-xl"
      style={{ width, left: Math.max(8, Math.min(x, window.innerWidth - width - 8)), top: Math.max(8, Math.min(y, window.innerHeight - 260)) }}
      role="menu"
      aria-label={label}
      data-asset-popmenu
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="truncate px-3 pt-1 pb-1.5 text-[11px] font-semibold text-white/45">{label}</div>
      {children(item)}
    </div>,
    document.body,
  )
}

/**
 * Confirm a delete (one file or many). Files in use (timelines, Cues, …) are blocked by default:
 * the dialog says where each is used and offers 取消 or 強制刪除 (with a second confirmation),
 * which also removes the timeline clips that use them. When only some files are in use, the
 * others can be deleted on their own.
 */
function DeleteDialog({
  assets,
  shared,
  load,
  onClose,
  onConfirm,
}: {
  assets: ProjectMedia[]
  shared: boolean
  load: () => Promise<AssetDeletePlan[]>
  onClose: () => void
  onConfirm: (plan: AssetDeletePlan[], force: boolean) => Promise<void>
}) {
  const [plan, setPlan] = useState<AssetDeletePlan[] | null>(null)
  const [step, setStep] = useState<'review' | 'force'>('review')
  const [understood, setUnderstood] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const loadRef = useRef(load)
  useEffect(() => {
    let alive = true
    loadRef.current().then(
      (r) => alive && setPlan(r),
      (err: Error) => alive && setError(err.message),
    )
    return () => {
      alive = false
    }
  }, [])
  const one = assets.length === 1
  const inUse = plan?.filter((p) => p.inUse) ?? []
  const free = plan?.filter((p) => !p.inUse) ?? []
  const clips = new Set(inUse.flatMap((p) => p.clips)).size
  const go = async (force: boolean) => {
    if (!plan) return
    setBusy(true)
    setError(null)
    try {
      await onConfirm(plan, force)
      onClose()
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }
  const btn = 'min-h-10 rounded-xl px-4 text-sm font-semibold disabled:opacity-40'
  const fileLine = (p: AssetDeletePlan, force: boolean) => {
    const goes = force ? p.forceDeletesFile : p.willDeleteFile
    return (
      <li key={p.asset.id} className="flex gap-2" data-asset-delete-item={goes ? 'file' : 'record'}>
        <span className={goes ? 'text-panic' : 'text-go'}>{goes ? '✕' : '○'}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-white/85">{p.asset.name}</span>
          {!goes && <span className="block text-[10px] text-white/45">保留檔案：{p.kept ?? '只移除紀錄'}</span>}
        </span>
      </li>
    )
  }

  let body: ReactNode = null
  let actions: ReactNode = null
  if (plan && inUse.length === 0) {
    // Nothing in use: the usual confirmation.
    const files = plan.filter((p) => p.willDeleteFile).length
    body = (
      <>
        <p className={files ? 'text-panic' : 'text-go'} data-asset-delete-plan={files === plan.length ? 'file' : files ? 'mixed' : 'record'}>
          {files === plan.length
            ? `沒有任何時間軸或 Cue 使用${one ? '這個檔案' : '這些檔案'}。會同時從 Cloudflare R2 永久刪除${one ? `（${plan[0].key}）` : ` ${files} 個檔案`}，無法復原。`
            : files
              ? `會從 R2 永久刪除 ${files} 個檔案；另外 ${plan.length - files} 個只移除素材紀錄。`
              : '只移除素材紀錄，R2 上的檔案保留。'}
        </p>
        <ul className="space-y-1 rounded-lg bg-white/[0.05] px-3 py-2" data-asset-delete-list>
          {plan.map((p) => fileLine(p, false))}
        </ul>
      </>
    )
    actions = (
      <button type="button" disabled={busy} onClick={() => go(false)} className={`${btn} bg-panic text-white`} data-asset-delete-go>
        {busy ? '刪除中…' : one ? '刪除' : `刪除 ${plan.length} 個`}
      </button>
    )
  } else if (plan && step === 'review') {
    // Blocked: some files are in use.
    body = (
      <>
        <p className="rounded-lg border border-standby/40 bg-standby/10 px-3 py-2 text-standby" data-asset-in-use-warning>
          ⚠ {one ? '此素材目前正被使用中，無法直接刪除。' : `其中 ${inUse.length} 個素材正被使用中，無法直接刪除。`}
        </p>
        <ul className="space-y-2 rounded-lg bg-white/[0.05] px-3 py-2" data-asset-in-use-list>
          {inUse.map((p) => (
            <li key={p.asset.id} data-asset-in-use={p.asset.id}>
              <div className="truncate font-semibold text-white/90">🎵 {p.asset.name}</div>
              <ul className="mt-0.5 space-y-0.5 pl-4 text-[11px] text-white/60">
                {p.refs
                  .filter((r) => r.kind !== 'library')
                  .map((r) => (
                    <li key={r.where} data-asset-use={r.kind}>
                      {r.kind === 'timeline' ? '🎚' : '🔗'} 正被 {r.where} 使用{r.regions && r.regions.length > 1 ? `（${r.regions.length} 個區段）` : ''}
                    </li>
                  ))}
              </ul>
            </li>
          ))}
        </ul>
        {free.length > 0 && <p className="text-white/55">另外 {free.length} 個素材沒有被使用，可以直接刪除。</p>}
      </>
    )
    actions = (
      <>
        {free.length > 0 && (
          <button type="button" disabled={busy} onClick={() => go(false)} className={`${btn} bg-white/10 text-white hover:bg-white/15`} data-asset-delete-free>
            只刪除未使用的（{free.length}）
          </button>
        )}
        <button type="button" disabled={busy} onClick={() => setStep('force')} className={`${btn} border border-panic bg-panic/15 text-panic hover:bg-panic hover:text-white`} data-asset-force>
          強制刪除
        </button>
      </>
    )
  } else if (plan) {
    // Second confirmation for a force delete.
    const files = plan.filter((p) => p.forceDeletesFile).length
    body = (
      <>
        <p className="text-panic" data-asset-force-summary>
          強制刪除 {plan.length} 個素材：
          {clips > 0 && `會同時移除時間軸上使用這些素材的 ${clips} 個音檔區段，`}
          {files > 0 ? `並從 R2 永久刪除 ${files} 個檔案。` : 'R2 上的檔案保留。'}
          此動作無法復原。
        </p>
        <ul className="space-y-1 rounded-lg bg-white/[0.05] px-3 py-2" data-asset-delete-list>
          {plan.map((p) => fileLine(p, true))}
        </ul>
        {plan.some((p) => p.refs.some((r) => r.kind === 'other')) && (
          <p className="text-[11px] text-white/50">Cue、Hit、控制面板或其他專案仍在使用的檔案不會從 R2 刪除，那些地方照常可以播放。</p>
        )}
        <label className="flex items-start gap-2 rounded-lg border border-panic/40 bg-panic/[0.06] p-2.5">
          <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[#ff453a]" data-asset-force-understood />
          <span>我了解{clips > 0 ? '時間軸上的對應區段會被移除，且' : ''}刪除後無法復原。</span>
        </label>
      </>
    )
    actions = (
      <button type="button" disabled={busy || !understood} onClick={() => go(true)} className={`${btn} bg-panic text-white`} data-asset-force-go>
        {busy ? '刪除中…' : '確認強制刪除'}
      </button>
    )
  }

  return createPortal(
    <div className="fixed inset-0 z-[96] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onClick={() => !busy && onClose()}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85dvh] w-full max-w-md flex-col gap-3 rounded-2xl border border-line bg-panel p-5 text-white shadow-2xl"
        role="alertdialog"
        aria-label="刪除素材"
        data-asset-delete-dialog
        data-step={plan ? (inUse.length === 0 ? 'confirm' : step) : 'loading'}
      >
        <h2 className="text-base font-semibold">
          {step === 'force' ? '⚠ 確定要強制刪除？' : `🗑️ ${one ? `刪除素材「${assets[0].name}」？` : `刪除 ${assets.length} 個素材？`}`}
        </h2>
        {shared && <p className="rounded-lg bg-standby/10 px-3 py-2 text-xs text-standby">這是 Default 共用素材，所有專案都看得到。建議先在「全域資源管理」備份或確認沒有專案在使用。</p>}
        {!plan && !error && <p className="text-xs text-white/45">正在檢查這些素材是否被時間軸、音軌或 Cue 使用…</p>}
        {plan && (
          <div className="min-h-0 space-y-2 overflow-y-auto text-xs" data-asset-delete-info>
            {body}
          </div>
        )}
        {error && <p className="rounded-lg bg-panic/10 px-3 py-2 text-xs text-panic">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <button type="button" onClick={() => (step === 'force' ? setStep('review') : onClose())} disabled={busy} className="min-h-10 rounded-xl px-4 text-sm text-white/60 hover:bg-white/10" data-asset-delete-cancel>
            {step === 'force' ? '返回' : '取消'}
          </button>
          {actions}
        </div>
      </div>
    </div>,
    document.body,
  )
}
