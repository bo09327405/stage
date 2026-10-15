import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AppUser } from '../../services/auth'
import { claimStudio } from '../../services/membership'
import { createStudio, useStudioList } from '../../services/studio'
import type { ShowRef } from '../../types/project'

const MENU_WIDTH = 288

const studioHref = (show: ShowRef, studioId?: string) =>
  `?role=studio&project=${encodeURIComponent(show.projectId)}&version=${encodeURIComponent(show.versionId)}${studioId ? `&studio=${encodeURIComponent(studioId)}` : ''}`

/**
 * The Set Cue console's Studio menu: this project's own DAW studios (its child Studio projects) —
 * open one, or add a new one here. Studios open in their own tab (one per project, reused).
 */
export function StudioMenu({ show, user, readOnly }: { show: ShowRef; user: AppUser | null; readOnly: boolean }) {
  const studios = useStudioList(show.projectId)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const btn = useRef<HTMLButtonElement>(null)
  // The list renders in <body> (fixed, above everything): headers and panels with their own
  // stacking contexts or overflow can't cover or clip it. It follows the button on scroll / resize.
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number; maxHeight: number } | null>(null)
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const r = btn.current?.getBoundingClientRect()
      if (!r) return
      // Right-aligned with the button, but never past either edge of the screen.
      const width = Math.min(MENU_WIDTH, window.innerWidth - 16)
      const left = Math.min(Math.max(8, r.right - width), window.innerWidth - width - 8)
      const below = window.innerHeight - r.bottom - 12
      const above = r.top - 12
      // Open upward only when there's clearly more room there.
      setPos(below >= 240 || below >= above ? { left, top: r.bottom + 4, maxHeight: below } : { left, bottom: window.innerHeight - r.top + 4, maxHeight: above })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])
  useEffect(() => {
    if (!open) return
    const close = (e: PointerEvent) => !box.current?.contains(e.target as Node) && !menu.current?.contains(e.target as Node) && setOpen(false)
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('pointerdown', close, true)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('pointerdown', close, true)
      window.removeEventListener('keydown', key)
    }
  }, [open])
  const openStudio = (id?: string) => {
    setOpen(false)
    window.open(studioHref(show, id), `theatre-studio-${show.projectId}`)?.focus()
  }
  return (
    <div ref={box} className="relative" data-studio-menu-root>
      <button
        ref={btn}
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex min-h-10 items-center gap-1 rounded-lg bg-[#bf5af2]/15 px-3 text-xs font-semibold text-[#d7a6ff] hover:bg-[#bf5af2]/25"
        title="這個專案的 DAW Studio（多軌音訊編輯）"
        data-open-studio
      >
        🎚 Studio{studios?.length ? ` ${studios.length}` : ''} ▾
      </button>
      {open && pos && createPortal(
        <div
          ref={menu}
          className="fixed z-[9999] w-72 max-w-[calc(100vw-16px)] overflow-y-auto overscroll-contain rounded-xl border border-white/10 bg-[#202020]/95 p-1.5 shadow-2xl backdrop-blur-xl"
          style={pos}
          role="menu"
          data-studio-menu-list
        >
          <div className="px-2 pt-1 pb-1.5 text-[10px] font-semibold tracking-wider text-white/40">此專案的 Studio 工作區</div>
          {studios === null && <p className="px-2 py-2 text-xs text-white/35">載入中…</p>}
          {studios?.length === 0 && <p className="px-2 py-2 text-xs text-white/35">還沒有 Studio</p>}
          {studios?.map((s) => (
            <button key={s.id} type="button" onClick={() => openStudio(s.id)} className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs hover:bg-white/10" data-studio-item={s.id}>
              <span>🎛️</span>
              <span className="min-w-0 flex-1 truncate text-white/90">{s.name}</span>
              <span className="shrink-0 text-[10px] text-white/35">
                {s.tracks} 軌 · {s.regions} 片段
              </span>
              <span className="text-white/40">↗</span>
            </button>
          ))}
          {!readOnly && user && (
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                const name = prompt('新 Studio 名稱', `Studio ${(studios?.length ?? 0) + 1}`)?.trim()
                if (!name) return
                setBusy(true)
                try {
                  const sid = await createStudio(show.projectId, name, { parentProjectId: show.projectId })
                  await claimStudio(user, show.projectId, show.versionId, sid, name)
                  openStudio(sid)
                } finally {
                  setBusy(false)
                }
              }}
              className="mt-1 flex w-full items-center gap-2 rounded-lg border-t border-white/10 px-2 py-2 text-left text-xs text-[#d7a6ff] hover:bg-white/10 disabled:opacity-40"
              data-studio-new
            >
              ＋ 新增 Studio
            </button>
          )}
        </div>,
        document.body,
      )}
    </div>
  )
}
