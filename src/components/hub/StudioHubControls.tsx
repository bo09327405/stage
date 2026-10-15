import { motion } from 'motion/react'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { GROUP_MODES, TAG_NAME_MAX, TAG_PALETTE, tagLabel, type GroupMode, type TagDef, type ViewMode } from '../../services/hubLayout'

/* ---------- drag & drop ---------- */

const HOLD_MS = 350 // touch: press and hold to pick up (a quick swipe still scrolls)
const SLOP = 6

interface DragState {
  key: string
  label: string
  x: number
  y: number
}

/**
 * A reorderable list / grid. Mouse: drag an item (not its buttons / links); touch: press and hold,
 * then drag. Items make room as the dragged one passes (animated); a small chip follows the pointer.
 * `handle`: only start from an element marked data-drag-handle (e.g. a section's grip).
 * Esc cancels.
 */
export function SortableList<T>({
  id,
  items,
  keyOf,
  labelOf,
  enabled,
  handle = false,
  onReorder,
  className,
  itemClassName,
  render,
}: {
  id: string
  items: T[]
  keyOf: (t: T) => string
  labelOf: (t: T) => string
  enabled: boolean
  handle?: boolean
  onReorder: (keys: string[]) => void
  className?: string
  itemClassName?: string
  render: (item: T, state: { dragging: boolean }) => ReactNode
}) {
  const [live, setLive] = useState<string[] | null>(null)
  const [drag, setDrag] = useState<DragState | null>(null)
  const pending = useRef<{ key: string; label: string; pointerId: number; x: number; y: number; touch: boolean; timer?: ReturnType<typeof setTimeout>; el: HTMLElement } | null>(null)
  const active = useRef(false)
  const liveRef = useRef<string[] | null>(null)
  const justDropped = useRef(false)
  const box = useRef<HTMLUListElement>(null)
  const keys = items.map(keyOf)
  const order = live ?? keys
  const byKey = new Map(items.map((t) => [keyOf(t), t]))
  const shown = order.map((k) => byKey.get(k)).filter((t): t is T => !!t)

  // Touch: once an item is picked up, the page mustn't scroll under the finger.
  useEffect(() => {
    const el = box.current
    if (!el) return
    const block = (e: TouchEvent) => active.current && e.cancelable && e.preventDefault()
    el.addEventListener('touchmove', block, { passive: false })
    return () => el.removeEventListener('touchmove', block)
  }, [])

  // Scroll the page when dragging near its top / bottom edge.
  useEffect(() => {
    if (!drag) return
    let frame = 0
    const step = () => {
      const y = drag.y
      const bottom = window.innerHeight - 140
      if (y < 90) window.scrollBy(0, -Math.ceil((90 - y) / 6))
      else if (y > bottom) window.scrollBy(0, Math.ceil((y - bottom) / 6))
      frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [drag])

  const begin = () => {
    const p = pending.current
    if (!p) return
    active.current = true
    liveRef.current = keys
    setLive(keys)
    setDrag({ key: p.key, label: p.label, x: p.x, y: p.y })
    try {
      p.el.setPointerCapture(p.pointerId)
    } catch {
      // pointer already gone
    }
    navigator.vibrate?.(10)
  }

  const end = (commit: boolean) => {
    const p = pending.current
    clearTimeout(p?.timer)
    pending.current = null
    if (active.current) {
      active.current = false
      justDropped.current = true
      setTimeout(() => (justDropped.current = false), 0)
      const final = liveRef.current
      if (commit && final && final.join() !== keys.join()) onReorder(final)
    }
    liveRef.current = null
    setLive(null)
    setDrag(null)
  }

  useEffect(() => {
    if (!drag) return
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopImmediatePropagation()
      end(false)
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  })

  const moveOver = (x: number, y: number) => {
    const from = liveRef.current
    const p = pending.current
    if (!from || !p) return
    const hit = document
      .elementsFromPoint(x, y)
      .map((el) => (el as HTMLElement).closest<HTMLElement>(`[data-sort-list="${id}"]`))
      .find((el) => el && el.dataset.sortKey !== p.key)
    const target = hit?.dataset.sortKey
    if (!target) return
    const fromIdx = from.indexOf(p.key)
    const toIdx = from.indexOf(target)
    if (fromIdx < 0 || toIdx < 0) return
    const next = from.filter((k) => k !== p.key)
    next.splice(toIdx, 0, p.key)
    if (next.join() === from.join()) return
    liveRef.current = next
    setLive(next)
  }

  return (
    <>
      <ul ref={box} className={className} data-sortable={id}>
        {shown.map((item) => {
          const k = keyOf(item)
          const dragging = drag?.key === k
          return (
            <motion.li
              key={k}
              layout={!!drag}
              transition={{ type: 'spring', stiffness: 520, damping: 40 }}
              className={`${itemClassName ?? ''} ${dragging ? 'opacity-40 outline-2 outline-dashed outline-accent' : ''} ${enabled && !handle ? 'touch-pan-y' : ''}`}
              style={dragging ? { borderRadius: 16 } : undefined}
              data-sort-list={id}
              data-sort-key={k}
              data-dragging={dragging ? 'true' : undefined}
              onPointerDown={(e) => {
                if (!enabled || e.button !== 0 || pending.current) return
                const t = e.target as HTMLElement
                // Each list only takes presses on its own items (not ones in a nested list).
                if (t.closest('[data-sort-list]') !== e.currentTarget) return
                if (handle ? !t.closest('[data-drag-handle]') : t.closest('button, a, input, select, textarea, [data-no-drag]')) return
                const touch = e.pointerType !== 'mouse'
                pending.current = { key: k, label: labelOf(item), pointerId: e.pointerId, x: e.clientX, y: e.clientY, touch, el: e.currentTarget }
                if (touch) pending.current.timer = setTimeout(begin, HOLD_MS)
              }}
              onPointerMove={(e) => {
                const p = pending.current
                if (!p || p.pointerId !== e.pointerId) return
                if (!active.current) {
                  const moved = Math.hypot(e.clientX - p.x, e.clientY - p.y)
                  if (p.touch) {
                    if (moved > 8) end(false) // a swipe: let it scroll
                    return
                  }
                  if (moved < SLOP) return
                  begin()
                }
                e.preventDefault()
                p.x = e.clientX
                p.y = e.clientY
                setDrag((d) => (d ? { ...d, x: e.clientX, y: e.clientY } : d))
                moveOver(e.clientX, e.clientY)
              }}
              onPointerUp={() => end(true)}
              onPointerCancel={() => end(false)}
              onClickCapture={(e) => {
                if (justDropped.current) {
                  e.preventDefault()
                  e.stopPropagation()
                }
              }}
              onContextMenu={(e) => active.current && e.preventDefault()}
            >
              {render(item, { dragging })}
            </motion.li>
          )
        })}
      </ul>
      {drag &&
        createPortal(
          <div
            className="pointer-events-none fixed z-[90] max-w-64 -translate-x-1/2 -translate-y-[130%] truncate rounded-xl bg-accent px-3 py-1.5 text-sm font-semibold text-white shadow-2xl"
            style={{ left: drag.x, top: drag.y }}
            data-drag-ghost
          >
            ⠿ {drag.label}
          </div>,
          document.body,
        )}
    </>
  )
}

/* ---------- toolbar: group by / view ---------- */

/** macOS-style "分組方式" menu. */
export function GroupMenu({ value, onChange }: { value: GroupMode; onChange: (g: GroupMode) => void }) {
  const [open, setOpen] = useState<DOMRect | null>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const label = GROUP_MODES.find((g) => g.id === value)?.label ?? '無'
  return (
    <>
      <button
        ref={btn}
        type="button"
        onClick={(e) => setOpen(open ? null : e.currentTarget.getBoundingClientRect())}
        className={`flex min-h-10 items-center gap-2 rounded-xl px-3 text-sm ${open ? 'bg-white/15 text-white' : 'bg-white/[0.06] text-white/75 hover:bg-white/10'}`}
        aria-haspopup="menu"
        aria-expanded={!!open}
        title="分組方式"
        data-group-menu-button
      >
        <GroupIcon />
        <span className="hidden text-white/45 sm:inline">分組：</span>
        <span className="max-w-32 truncate font-semibold">{label}</span>
        <span className="text-[10px] text-white/40">▾</span>
      </button>
      {open && <GroupPopup rect={open} anchor={btn} value={value} onPick={(g) => (onChange(g), setOpen(null))} onClose={() => setOpen(null)} />}
    </>
  )
}

function GroupPopup({ rect, anchor, value, onPick, onClose }: { rect: DOMRect; anchor: RefObject<HTMLElement | null>; value: GroupMode; onPick: (g: GroupMode) => void; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  useLayoutEffect(() => {
    close.current = onClose
  })
  const pos = { left: Math.max(8, Math.min(rect.left, window.innerWidth - 248)), top: rect.bottom + 6 }
  useEffect(() => {
    const away = (e: Event) => !box.current?.contains(e.target as Node) && !anchor.current?.contains(e.target as Node) && close.current()
    const key = (e: KeyboardEvent) => e.key === 'Escape' && close.current()
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('keydown', key)
    box.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus()
    return () => {
      window.removeEventListener('pointerdown', away, true)
      window.removeEventListener('keydown', key)
    }
  }, [anchor])
  return createPortal(
    <div
      ref={box}
      className="fixed z-[80] w-60 rounded-xl border border-white/10 bg-[#2a2a2c]/95 p-1.5 text-[13px] text-white shadow-2xl backdrop-blur-xl"
      style={pos}
      role="menu"
      aria-label="分組方式"
      data-group-menu
      onKeyDown={(e) => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
        e.preventDefault()
        const items = [...box.current!.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
        const i = items.indexOf(document.activeElement as HTMLElement)
        items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus()
      }}
    >
      <div className="px-2.5 pt-1 pb-1 text-[11px] font-semibold text-white/40">分組方式</div>
      {GROUP_MODES.map((g, i) => (
        <div key={g.id}>
          {(i === 1 || i === 3 || i === 7) && <div className="mx-2 my-1 h-px bg-white/10" />}
          <button
            type="button"
            role="menuitemradio"
            aria-checked={value === g.id}
            onClick={() => onPick(g.id)}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left outline-none hover:bg-accent focus:bg-accent"
            data-group-mode={g.id}
          >
            <span className="w-3.5 text-center text-xs">{value === g.id ? '✓' : ''}</span>
            {g.label}
            {g.id === 'none' && <span className="ml-auto text-[10px] text-white/40">可拖曳排列</span>}
          </button>
        </div>
      ))}
    </div>,
    document.body,
  )
}

export function ViewToggle({ value, onChange }: { value: ViewMode; onChange: (v: ViewMode) => void }) {
  return (
    <div className="flex rounded-xl bg-white/[0.06] p-1" role="radiogroup" aria-label="檢視方式">
      {(
        [
          ['grid', '卡片', <GridIcon key="g" />],
          ['list', '列表', <ListIcon key="l" />],
        ] as const
      ).map(([id, label, icon]) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={value === id}
          onClick={() => onChange(id)}
          className={`flex h-8 w-9 items-center justify-center rounded-lg ${value === id ? 'bg-white/15 text-white' : 'text-white/45 hover:text-white/80'}`}
          title={`${label}檢視`}
          aria-label={`${label}檢視`}
          data-view-mode={id}
        >
          {icon}
        </button>
      ))}
    </div>
  )
}

/* ---------- tags ---------- */

/**
 * A card's tags: a named tag shows its colour dot and name; a tag without a name shows just the dot.
 */
export function TagChips({ ids, defs, size = 'md' }: { ids: string[]; defs: TagDef[]; size?: 'sm' | 'md' }) {
  const tags = defs.filter((d) => ids.includes(d.id))
  if (!tags.length) return null
  const named = tags.filter((t) => t.name)
  const dots = tags.filter((t) => !t.name)
  return (
    <span className="ml-2 inline-flex min-w-0 shrink items-center gap-1 overflow-hidden" data-tag-chips={tags.map((t) => t.id).join(',')}>
      {named.map((t) => (
        <span
          key={t.id}
          className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 font-semibold whitespace-nowrap ${size === 'sm' ? 'text-[10px] leading-4' : 'text-[11px] leading-[18px]'}`}
          style={{ borderColor: `${t.color}66`, background: `${t.color}22`, color: t.color }}
          title={t.name}
          data-tag-chip={t.id}
        >
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: t.color }} />
          {t.name}
        </span>
      ))}
      {dots.length > 0 && (
        <span className="inline-flex shrink-0 -space-x-1" data-tag-dots={dots.map((t) => t.id).join(',')}>
          {dots.map((t) => (
            <span key={t.id} className="h-2.5 w-2.5 rounded-full ring-2 ring-panel" style={{ background: t.color }} title={tagLabel(t)} data-tag-dot={t.id} />
          ))}
        </span>
      )}
    </span>
  )
}

export interface TagActions {
  toggle: (id: string) => void
  update: (id: string, change: Partial<Omit<TagDef, 'id'>>) => void
  add: () => string
  remove: (id: string) => void
  reset: () => void
}

/** The 🏷 button on a card: tick tags, rename / recolour them, add or delete tags. */
export function TagButton({ tags, defs, actions, name }: { tags: string[]; defs: TagDef[]; actions: TagActions; name: string }) {
  const [open, setOpen] = useState<DOMRect | null>(null)
  const btn = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button
        ref={btn}
        type="button"
        onClick={(e) => setOpen(open ? null : e.currentTarget.getBoundingClientRect())}
        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${open ? 'bg-white/15 text-white' : 'text-white/45 hover:bg-white/10 hover:text-white'}`}
        aria-label={`「${name}」的標籤`}
        aria-expanded={!!open}
        title="標籤"
        data-tag-button
      >
        <TagIcon />
      </button>
      {open && <TagPopup rect={open} anchor={btn} tags={tags} defs={defs} actions={actions} onClose={() => setOpen(null)} />}
    </>
  )
}

const POPUP_W = 288
const POPUP_H = 420

function TagPopup({ rect, anchor, tags, defs, actions, onClose }: { rect: DOMRect; anchor: RefObject<HTMLElement | null>; tags: string[]; defs: TagDef[]; actions: TagActions; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  useLayoutEffect(() => {
    close.current = onClose
  })
  const [editing, setEditing] = useState<string | null>(null)
  const editingRef = useRef(editing)
  useLayoutEffect(() => {
    editingRef.current = editing
  })
  const below = rect.bottom + 6 + POPUP_H <= window.innerHeight
  const pos = { left: Math.max(8, Math.min(rect.right - POPUP_W, window.innerWidth - POPUP_W - 8)), top: below ? rect.bottom + 6 : Math.max(8, rect.top - 6 - POPUP_H), maxHeight: POPUP_H }
  useEffect(() => {
    const away = (e: Event) => !box.current?.contains(e.target as Node) && !anchor.current?.contains(e.target as Node) && close.current()
    // Esc: leave the tag being edited first, then close.
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (editingRef.current) setEditing(null)
      else close.current()
    }
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('pointerdown', away, true)
      window.removeEventListener('keydown', key)
    }
  }, [anchor])
  return createPortal(
    <div
      ref={box}
      className="fixed z-[80] flex flex-col overflow-hidden rounded-xl border border-white/10 bg-[#2a2a2c]/95 text-[13px] text-white shadow-2xl backdrop-blur-xl"
      style={{ ...pos, width: POPUP_W }}
      role="dialog"
      aria-label="標籤"
      data-tag-menu
    >
      <div className="flex items-baseline gap-2 px-3 pt-2.5 pb-1.5">
        <span className="text-[12px] font-semibold text-white/70">標籤</span>
        <span className="text-[10px] text-white/35">勾選套用 · ✎ 改名稱與顏色 · 只有你看得到</span>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto px-1.5" role="group">
        {defs.map((t) => {
          const on = tags.includes(t.id)
          return (
            <li key={t.id} data-tag-row={t.id}>
              <div className={`group flex items-center gap-1 rounded-md ${editing === t.id ? 'bg-white/[0.06]' : 'hover:bg-white/10'}`}>
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={on}
                  onClick={() => actions.toggle(t.id)}
                  className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-1.5 text-left"
                  data-tag={t.id}
                >
                  <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-black/80" style={{ background: t.color }}>
                    {on ? '✓' : ''}
                  </span>
                  <span className={`truncate ${t.name ? '' : 'text-white/40 italic'}`}>{t.name || '只有顏色（無名稱）'}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setEditing(editing === t.id ? null : t.id)}
                  className={`mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-xs ${editing === t.id ? 'bg-white/15 text-white' : 'text-white/35 hover:bg-white/10 hover:text-white'}`}
                  aria-label={`編輯標籤「${tagLabel(t)}」`}
                  aria-expanded={editing === t.id}
                  data-tag-edit={t.id}
                >
                  ✎
                </button>
              </div>
              {editing === t.id && <TagEditor tag={t} actions={actions} onDone={() => setEditing(null)} />}
            </li>
          )
        })}
      </ul>
      <div className="flex items-center gap-1 border-t border-white/10 p-1.5">
        <button
          type="button"
          onClick={() => setEditing(actions.add())}
          className="flex flex-1 items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-white/80 hover:bg-white/10"
          data-tag-add
        >
          <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full border border-dashed border-white/40 text-xs">＋</span>
          新增標籤
        </button>
        <button
          type="button"
          onClick={() => confirm('恢復預設標籤（A、B、C、串場）？自訂的標籤會從所有卡片移除。') && (actions.reset(), setEditing(null))}
          className="rounded-md px-2 py-1.5 text-[11px] text-white/40 hover:bg-white/10 hover:text-white/70"
          data-tag-reset
        >
          恢復預設
        </button>
      </div>
    </div>,
    document.body,
  )
}

/** Inline editor under a tag: name (may be left empty = colour only) and colour. */
function TagEditor({ tag, actions, onDone }: { tag: TagDef; actions: TagActions; onDone: () => void }) {
  const [name, setName] = useState(tag.name)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])
  const commitName = () => name.trim() !== tag.name && actions.update(tag.id, { name })
  // Closing the menu (clicking elsewhere) unmounts the editor without a blur: keep what was typed.
  const pending = useRef({ name, tag, actions })
  useLayoutEffect(() => {
    pending.current = { name, tag, actions }
  })
  useEffect(
    () => () => {
      const p = pending.current
      if (p.name.trim() !== p.tag.name) p.actions.update(p.tag.id, { name: p.name })
    },
    [],
  )
  return (
    <div className="mx-1 mb-1.5 space-y-2 rounded-b-md bg-white/[0.06] px-2.5 pt-1 pb-2.5" data-tag-editor={tag.id}>
      <input
        ref={input}
        value={name}
        maxLength={TAG_NAME_MAX}
        onChange={(e) => setName(e.target.value)}
        onBlur={commitName}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commitName()
            onDone()
          }
        }}
        placeholder="名稱（留空 = 只顯示顏色）"
        aria-label="標籤名稱"
        className="h-8 w-full rounded-md border border-white/15 bg-black/40 px-2 text-[13px] outline-none focus:border-accent"
        data-tag-name-input
      />
      <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="標籤顏色">
        {TAG_PALETTE.map((p) => {
          const on = p.color.toLowerCase() === tag.color.toLowerCase()
          return (
            <button
              key={p.color}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={p.name}
              title={p.name}
              onClick={() => actions.update(tag.id, { color: p.color })}
              className={`h-5 w-5 rounded-full transition ${on ? 'ring-2 ring-white ring-offset-2 ring-offset-[#2a2a2c]' : 'hover:scale-110'}`}
              style={{ background: p.color }}
              data-tag-color={p.color}
            />
          )
        })}
        <label className="relative flex h-5 w-5 cursor-pointer items-center justify-center rounded-full bg-[conic-gradient(red,yellow,lime,cyan,blue,magenta,red)]" title="其他顏色">
          <input type="color" value={tag.color} onChange={(e) => actions.update(tag.id, { color: e.target.value })} className="absolute inset-0 cursor-pointer opacity-0" aria-label="自訂顏色" data-tag-custom-color />
        </label>
      </div>
      <div className="flex items-center justify-between pt-0.5">
        <button
          type="button"
          onClick={() => confirm(`刪除標籤「${tagLabel(tag)}」？它會從所有卡片移除。`) && actions.remove(tag.id)}
          className="rounded-md px-1.5 py-1 text-[11px] text-white/45 hover:bg-panic/15 hover:text-panic"
          data-tag-delete={tag.id}
        >
          刪除標籤
        </button>
        <button
          type="button"
          onClick={() => {
            commitName()
            onDone()
          }}
          className="h-7 rounded-md bg-accent px-3 text-[12px] font-semibold text-white"
          data-tag-done
        >
          完成
        </button>
      </div>
    </div>
  )
}

/* ---------- icons ---------- */

const GroupIcon = () => (
  <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
    <rect x="3" y="3" width="6" height="6" rx="1.2" />
    <rect x="11" y="3" width="6" height="6" rx="1.2" />
    <path d="M3 13h14M3 16.5h14" strokeLinecap="round" />
  </svg>
)
const GridIcon = () => (
  <svg viewBox="0 0 20 20" className="h-4 w-4" fill="currentColor" aria-hidden>
    <rect x="3" y="3" width="6" height="6" rx="1.5" />
    <rect x="11" y="3" width="6" height="6" rx="1.5" />
    <rect x="3" y="11" width="6" height="6" rx="1.5" />
    <rect x="11" y="11" width="6" height="6" rx="1.5" />
  </svg>
)
const ListIcon = () => (
  <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
    <path d="M7 5h10M7 10h10M7 15h10" />
    <circle cx="3.5" cy="5" r="0.9" fill="currentColor" />
    <circle cx="3.5" cy="10" r="0.9" fill="currentColor" />
    <circle cx="3.5" cy="15" r="0.9" fill="currentColor" />
  </svg>
)
const TagIcon = () => (
  <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden>
    <path d="M3 3h7l7 7-7 7-7-7z" />
    <circle cx="7" cy="7" r="1.3" fill="currentColor" />
  </svg>
)
