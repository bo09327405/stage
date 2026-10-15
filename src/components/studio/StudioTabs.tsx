import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/** Window features for "將分頁移到新視窗": a separate, resizable browser window without toolbars. */
const POPUP_FEATURES = 'width=1280,height=800,menubar=no,toolbar=no,resizable=yes'

/** Pixels the pointer must travel before a press on a tab becomes a drag (a shorter press is a click). */
const DRAG_THRESHOLD = 5
/** Touch: hold this long to pick a tab up (a swipe before that scrolls the tab bar instead). */
const LONG_PRESS_MS = 350

interface Drag {
  id: string
  pointerId: number
  touch: boolean
  /** Ready to move: at once for a mouse, after the long press for touch. */
  armed: boolean
  startX: number
  startY: number
  /** Pointer travel since the press. */
  dx: number
  /** Past the threshold: the tab is being dragged, not clicked. */
  moving: boolean
  /** Tab rects (container coordinates) at the start of the drag, left to right. */
  slots: { id: string; left: number; width: number }[]
  from: number
  to: number
}

type Menu = { id: string; x: number; y: number }

/**
 * The Studio tab bar: one tab per open studio, in the shared tab order. It scrolls sideways
 * (wheel, trackpad, swipe) without showing a scrollbar.
 *
 * Tabs reorder by dragging — with a mouse at once, on touch after a long press: the dragged tab
 * follows the pointer, lifted and translucent, the others slide out of its way, and the slot where
 * it will land is highlighted. ⌥← / ⌥→ moves the focused tab.
 *
 * Right-click (or long-press and release, or the context-menu key) opens the tab menu: open the
 * studio in a new browser tab or move it out to its own window (both with the full Studio), copy
 * its link, or close it / the other tabs / the tabs to its right.
 */
export function StudioTabs({
  tabs,
  names,
  current,
  canReorder,
  hrefFor,
  onSelect,
  onClose,
  onCloseOthers,
  onCloseRight,
  onRename,
  onReorder,
  onPopOut,
  onNotify,
}: {
  tabs: string[]
  names: Record<string, string>
  current: string | null
  canReorder: boolean
  /** Full URL that opens one studio. */
  hrefFor: (id: string) => string
  onSelect: (id: string) => void
  onClose: (id: string) => void
  /** Close every tab but this one. */
  onCloseOthers: (id: string) => void
  /** Close the tabs to the right of this one. */
  onCloseRight: (id: string) => void
  onRename: (id: string) => void
  /** The open tabs in their new order, and the tab that moved. */
  onReorder: (ids: string[], moved: string) => void
  /** The studio now lives in its own window: drop it from this bar. */
  onPopOut: (id: string) => void
  onNotify: (text: string, error?: boolean) => void
}) {
  const box = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  // The latest drag, for timers and native listeners.
  const dragRef = useRef<Drag | null>(null)
  useLayoutEffect(() => {
    dragRef.current = drag
  }, [drag])
  const [menu, setMenu] = useState<Menu | null>(null)
  // A drag ends with a click on the tab under the pointer; swallow it.
  const justDragged = useRef(false)
  const pressTimer = useRef<number | undefined>(undefined)

  // A plain mouse wheel scrolls the tab bar sideways (trackpads already scroll it natively).
  useEffect(() => {
    const el = box.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || el.scrollWidth <= el.clientWidth) return
      e.preventDefault()
      el.scrollLeft += e.deltaY
    }
    // Once a tab is picked up by a long press, the finger drags it instead of scrolling the bar.
    // (Registered up front: Chrome decides at touchstart whether touchmove can be cancelled.)
    const onTouchMove = (e: TouchEvent) => dragRef.current?.armed && e.cancelable && e.preventDefault()
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('touchmove', onTouchMove, { passive: false })
    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('touchmove', onTouchMove)
    }
  }, [])

  // Keep the active tab in view (after opening one off-screen, or switching with the menu).
  useEffect(() => {
    if (current) box.current?.querySelector(`[data-studio-tab-item="${CSS.escape(current)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [current, tabs.length])

  const endTouch = () => window.clearTimeout(pressTimer.current)
  useEffect(() => endTouch, [])

  const measure = () => {
    const el = box.current
    if (!el) return []
    const origin = el.getBoundingClientRect().left - el.scrollLeft
    return tabs.map((id) => {
      const r = el.querySelector<HTMLElement>(`[data-studio-tab-item="${CSS.escape(id)}"]`)!.getBoundingClientRect()
      return { id, left: r.left - origin, width: r.width }
    })
  }

  /** Where the dragged tab lands: the slot its centre is over. */
  const targetIndex = (d: Drag, dx: number) => {
    const me = d.slots[d.from]
    const centre = me.left + me.width / 2 + dx
    const others = d.slots.filter((s) => s.id !== d.id)
    return others.filter((s) => s.left + s.width / 2 < centre).length
  }

  const finish = (d: Drag | null) => {
    endTouch()
    setDrag(null)
    if (!d?.moving) return
    justDragged.current = true
    setTimeout(() => (justDragged.current = false), 0)
    if (d.to === d.from) return
    const next = tabs.filter((id) => id !== d.id)
    next.splice(d.to, 0, d.id)
    onReorder(next, d.id)
  }

  const openMenuAt = (id: string, x: number, y: number) => {
    const el = box.current?.querySelector(`[data-studio-tab-item="${CSS.escape(id)}"]`)
    // Keyboard (context-menu key / ⇧F10) has no pointer position: open under the tab.
    if (!x && !y && el) {
      const r = el.getBoundingClientRect()
      setMenu({ id, x: r.left, y: r.bottom + 4 })
    } else setMenu({ id, x, y })
  }

  /** Visual offset of each tab while dragging: the dragged one follows the pointer, the others make room. */
  const offset = (id: string, index: number) => {
    if (!drag?.moving) return 0
    if (id === drag.id) return drag.dx
    const gap = drag.slots[drag.from].width + 4
    if (drag.from < drag.to && index > drag.from && index <= drag.to) return -gap
    if (drag.from > drag.to && index >= drag.to && index < drag.from) return gap
    return 0
  }

  // Where the dragged tab will land (container coordinates): highlighted, with an accent edge.
  let landing: { left: number; width: number } | null = null
  if (drag?.moving && drag.to !== drag.from) {
    const width = drag.slots[drag.from].width
    const at = drag.slots[drag.to]
    landing = { left: drag.to < drag.from ? at.left : at.left + at.width - width, width }
  }

  return (
    <div ref={box} className="no-scrollbar relative flex min-w-0 items-center gap-1 overflow-x-auto overscroll-x-contain" data-studio-tab-strip>
      {tabs.map((id, index) => {
        const on = id === current
        const dragging = drag?.moving && drag.id === id
        const lifted = drag?.id === id && drag.touch && drag.armed && !drag.moving
        const name = names[id] ?? '…'
        return (
          <div
            key={id}
            className={`group relative flex shrink-0 touch-pan-x items-center rounded-lg select-none [-webkit-touch-callout:none] ${on ? 'bg-white/12' : 'hover:bg-white/[0.06]'} ${
              dragging ? 'z-10 cursor-grabbing bg-[#3a3a3c] opacity-90 shadow-[0_8px_24px_rgba(0,0,0,0.6)] ring-1 ring-accent/70' : canReorder ? 'cursor-grab' : ''
            } ${lifted ? 'ring-1 ring-accent/70' : ''}`}
            style={{
              transform: offset(id, index) ? `translateX(${offset(id, index)}px)${dragging ? ' scale(1.04)' : ''}` : lifted ? 'scale(1.04)' : undefined,
              transition: dragging || !drag?.moving ? 'none' : 'transform 150ms ease',
            }}
            data-studio-tab-item={id}
            data-dragging={dragging ? 'true' : undefined}
            onContextMenu={(e) => {
              e.preventDefault()
              // Touch long-press opens the menu on release instead (the same press may become a drag).
              if (dragRef.current?.touch) return
              openMenuAt(id, e.clientX, e.clientY)
            }}
            onPointerDown={(e) => {
              if (e.button !== 0 || (e.target as Element).closest('[data-tab-close]')) return
              const touch = e.pointerType === 'touch'
              if (!canReorder && !touch) return
              const d: Drag = { id, pointerId: e.pointerId, touch, armed: !touch, startX: e.clientX, startY: e.clientY, dx: 0, moving: false, slots: measure(), from: index, to: index }
              setDrag(d)
              if (!touch) return
              window.clearTimeout(pressTimer.current)
              pressTimer.current = window.setTimeout(() => {
                const now = dragRef.current
                if (!now || now.pointerId !== d.pointerId) return
                navigator.vibrate?.(10)
                const armed = { ...now, armed: true, slots: measure() }
                dragRef.current = armed
                setDrag(armed)
              }, LONG_PRESS_MS)
            }}
            onPointerMove={(e) => {
              if (!drag || drag.id !== id || drag.pointerId !== e.pointerId) return
              const dx = e.clientX - drag.startX
              if (!drag.armed) {
                // Moved before the long press: it's a swipe — let the bar scroll.
                if (Math.hypot(dx, e.clientY - drag.startY) > DRAG_THRESHOLD) finish(null)
                return
              }
              if (!canReorder || (!drag.moving && Math.abs(dx) < DRAG_THRESHOLD)) return
              if (!drag.moving) e.currentTarget.setPointerCapture(e.pointerId)
              setDrag({ ...drag, dx, moving: true, to: targetIndex(drag, dx) })
            }}
            onPointerUp={(e) => {
              if (drag?.pointerId !== e.pointerId) return
              // Touch: long press and release without moving opens the tab menu.
              if (drag.touch && drag.armed && !drag.moving) {
                justDragged.current = true
                setTimeout(() => (justDragged.current = false), 0)
                const r = e.currentTarget.getBoundingClientRect()
                openMenuAt(id, r.left, r.bottom + 4)
              }
              finish(drag)
            }}
            onPointerCancel={() => finish(null)}
            onLostPointerCapture={() => dragRef.current?.moving && finish(dragRef.current)}
          >
            <button
              type="button"
              role="tab"
              aria-selected={on}
              aria-haspopup="menu"
              onClick={() => !justDragged.current && onSelect(id)}
              onDoubleClick={() => on && onRename(id)}
              onKeyDown={(e) => {
                if (!canReorder || !e.altKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return
                e.preventDefault()
                const to = index + (e.key === 'ArrowLeft' ? -1 : 1)
                if (to < 0 || to >= tabs.length) return
                const next = tabs.filter((x) => x !== id)
                next.splice(to, 0, id)
                onReorder(next, id)
              }}
              className={`max-w-48 truncate py-1.5 pr-1 pl-3 text-xs ${on ? 'font-semibold text-white' : 'text-white/55'}`}
              title={canReorder ? '雙擊重新命名 · 拖曳調整順序（⌥← / ⌥→）· 右鍵更多選項' : '雙擊重新命名 · 右鍵更多選項'}
              data-studio-tab={id}
            >
              {name}
            </button>
            <button type="button" onClick={() => onClose(id)} className="px-2 py-1.5 text-[11px] text-white/30 hover:text-white" aria-label={`關閉分頁 ${name}`} data-tab-close>
              ✕
            </button>
          </div>
        )
      })}
      {landing && (
        <span
          className="pointer-events-none absolute top-0.5 bottom-0.5 rounded-lg border border-dashed border-accent/80 bg-accent/15 shadow-[inset_2px_0_0_#0a84ff]"
          style={{ left: landing.left, width: landing.width }}
          data-tab-drop-indicator
        />
      )}
      {menu && (
        <TabMenu
          menu={menu}
          name={names[menu.id] ?? 'Studio'}
          others={tabs.length - 1}
          right={tabs.length - 1 - tabs.indexOf(menu.id)}
          onClose={() => setMenu(null)}
          onNewTab={() => {
            // noopener: the new tab is its own app instance, not tied to this window.
            window.open(hrefFor(menu.id), '_blank', 'noopener')
          }}
          onPopOut={() => {
            // Runs synchronously inside the menu item's click (no await before it), so the browser
            // counts it as user-initiated and its popup blocker lets it through. Always a fresh,
            // separate window ('_blank' + window features): a named target would reuse a window
            // left open by an earlier pop-out instead of opening a new one.
            const popup = window.open(hrefFor(menu.id), '_blank', POPUP_FEATURES)
            if (!popup) return onNotify('瀏覽器擋下了彈出視窗：請點網址列右側的「已封鎖彈出式視窗」圖示，允許此網站後再試', true)
            popup.focus()
            // Only once the window is open does the tab leave this window.
            onPopOut(menu.id)
            onNotify(`已將「${names[menu.id] ?? 'Studio'}」移到新視窗`)
          }}
          onCopyLink={() =>
            navigator.clipboard?.writeText(hrefFor(menu.id)).then(
              () => onNotify('已複製 Studio 連結'),
              () => onNotify('無法複製連結', true),
            )
          }
          onCloseTab={() => onClose(menu.id)}
          onCloseOthers={() => onCloseOthers(menu.id)}
          onCloseRight={() => onCloseRight(menu.id)}
        />
      )}
    </div>
  )
}

/** The tab's right-click menu: dark, rendered into <body> so the scrolling tab bar never clips it. */
function TabMenu({
  menu,
  name,
  others,
  right,
  onClose,
  onNewTab,
  onPopOut,
  onCopyLink,
  onCloseTab,
  onCloseOthers,
  onCloseRight,
}: {
  menu: Menu
  name: string
  /** How many other tabs / tabs to the right there are. */
  others: number
  right: number
  onClose: () => void
  onNewTab: () => void
  onPopOut: () => void
  onCopyLink: () => void
  onCloseTab: () => void
  onCloseOthers: () => void
  onCloseRight: () => void
}) {
  const box = useRef<HTMLDivElement>(null)
  // The Studio re-renders constantly (meters, playhead, presence): keep the listeners and the
  // keyboard focus stable instead of resetting them on every render.
  const close = useRef(onClose)
  useLayoutEffect(() => {
    close.current = onClose
  })
  useEffect(() => {
    box.current?.querySelector<HTMLButtonElement>('[role=menuitem]:not(:disabled)')?.focus({ preventScroll: true })
  }, [menu.id])
  useEffect(() => {
    const onClose = () => close.current()
    const away = (e: Event) => !box.current?.contains(e.target as Node) && onClose()
    // Esc closes the menu only; it must not reach the Studio's own shortcuts.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation()
        onClose()
        return
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      e.preventDefault()
      const items = [...(box.current?.querySelectorAll<HTMLButtonElement>('[role=menuitem]:not(:disabled)') ?? [])]
      const at = items.indexOf(document.activeElement as HTMLButtonElement)
      items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus()
    }
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', onClose)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('pointerdown', away, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('blur', onClose)
    }
  }, [])

  const item = (label: string, hint: string, run: () => void, data: string, disabled = false) => (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={() => {
        run()
        onClose()
      }}
      className="flex w-full flex-col rounded-md px-3 py-1.5 text-left outline-none hover:bg-white/10 focus-visible:bg-white/10 disabled:pointer-events-none disabled:opacity-35"
      data-tab-menu-item={data}
    >
      <span className="text-[13px] text-white/90">{label}</span>
      <span className="text-[10px] text-white/40">{hint}</span>
    </button>
  )
  const width = 256
  return createPortal(
    <div
      ref={box}
      data-sheet-menu className="fixed z-[95] rounded-xl border border-white/10 bg-[#202020]/95 p-1 text-white shadow-2xl backdrop-blur-xl"
      style={{ width, left: Math.max(8, Math.min(menu.x, window.innerWidth - width - 8)), top: Math.max(8, Math.min(menu.y, window.innerHeight - 340)) }}
      role="menu"
      aria-label={`分頁「${name}」`}
      data-tab-menu
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="truncate px-3 pt-1 pb-1.5 text-[11px] font-semibold text-white/45">{name}</div>
      {item('↗ 在瀏覽器開啟新分頁', '以新的瀏覽器分頁開啟這個 Studio', onNewTab, 'new-tab')}
      {item('⧉ 將分頁移到新視窗開啟', '開啟獨立的瀏覽器視窗，並從這裡的分頁列移除', onPopOut, 'pop-out')}
      <div className="my-1 h-px bg-white/10" />
      {item('🔗 複製連結', '這個 Studio 的網址', onCopyLink, 'copy-link')}
      <div className="my-1 h-px bg-white/10" />
      {item('✕ 關閉分頁', '只從這個視窗的分頁列移除', onCloseTab, 'close')}
      {item('關閉其他分頁', others ? `關閉其他 ${others} 個分頁，只留下這個` : '沒有其他分頁', onCloseOthers, 'close-others', !others)}
      {item('關閉右側分頁', right ? `關閉右邊 ${right} 個分頁` : '右邊沒有分頁', onCloseRight, 'close-right', !right)}
    </div>,
    document.body,
  )
}
