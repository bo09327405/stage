import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { NODE_UNITS, fromDisplay, nodeLabel, toDisplay, type NodeParam } from '../../studio/automationUnits'
import { timecode } from '../../studio/format'

/** A node being edited: its timeline time (s) and stored value, plus the limits it must stay in. */
export interface NodeInfo {
  param: NodeParam
  /** Timeline time in seconds (region nodes: region start + node time). */
  time: number
  value: number
  minTime: number
  maxTime: number
  /** e.g. "音軌 1 · 音量 Volume" or "片段「旁白」· 音量". */
  where: string
}

/**
 * Right-click menu on an automation node. Portaled to <body> at the pointer (kept inside the
 * window), above the timeline and track headers.
 */
export function AutomationNodeMenu({ x, y, node, onEdit, onDelete, onClose }: { x: number; y: number; node: NodeInfo; onEdit: () => void; onDelete: () => void; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  useEffect(() => {
    // Flip / shift so the whole menu stays on screen.
    const el = box.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    setPos({ left: Math.max(4, x + width > innerWidth - 4 ? x - width : x), top: Math.max(4, y + height > innerHeight - 4 ? y - height : y) })
  }, [x, y])
  // Registered once (the latest onClose is read through a ref): re-subscribing on every render
  // could drop the very Esc that caused a re-render. Capture phase, so Esc reaches the menu first.
  const close = useRef(onClose)
  useEffect(() => {
    close.current = onClose
  })
  useEffect(() => {
    const down = (e: PointerEvent) => !box.current?.contains(e.target as Node) && close.current()
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      close.current()
    }
    const scroll = () => close.current()
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key, true)
    window.addEventListener('wheel', scroll, { passive: true })
    return () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('wheel', scroll)
    }
  }, [])
  const item = 'flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-[13px] hover:bg-white/10'
  return createPortal(
    <div
      ref={box}
      data-sheet-menu className="fixed z-[200] w-56 rounded-xl border border-white/10 bg-[#202020]/95 p-1 text-white shadow-2xl backdrop-blur-xl"
      style={pos}
      role="menu"
      aria-label="自動化節點"
      onContextMenu={(e) => e.preventDefault()}
      data-node-menu
    >
      <div className="truncate px-3 pt-1 pb-1.5 text-[10px] text-white/45">
        {node.where} · {timecode(node.time)} · {nodeLabel(node.param, node.value)}
      </div>
      <button type="button" role="menuitem" onClick={onEdit} className={item} data-node-edit>
        ✎ 編輯數值…
      </button>
      <button type="button" role="menuitem" onClick={onDelete} className={`${item} text-panic hover:bg-panic/15`} data-node-delete>
        🗑 刪除節點<span className="ml-auto text-[10px] text-white/35">Delete</span>
      </button>
    </div>,
    document.body,
  )
}

/** Precise time / value editor for one node (Enter applies, Esc cancels). */
export function AutomationNodeEditor({ node, onApply, onClose }: { node: NodeInfo; onApply: (time: number, value: number) => void; onClose: () => void }) {
  const unit = NODE_UNITS[node.param]
  const [time, setTime] = useState(node.time.toFixed(3))
  const [value, setValue] = useState(String(toDisplay(node.param, node.value)))
  const [error, setError] = useState<string | null>(null)
  const first = useRef<HTMLInputElement>(null)
  useEffect(() => first.current?.select(), [])

  const apply = () => {
    const t = Number(time)
    const x = Number(value)
    if (!Number.isFinite(t) || time.trim() === '') return setError('時間要是數字（秒）')
    if (t < node.minTime - 1e-6 || t > node.maxTime + 1e-6) return setError(`時間要在 ${node.minTime.toFixed(3)} – ${node.maxTime.toFixed(3)} 秒之間`)
    if (!Number.isFinite(x) || value.trim() === '') return setError(`${unit.label}要是數字`)
    if (x < unit.min - 1e-9 && !(unit.unit === 'dB')) return setError(`${unit.label}最小 ${unit.min}`)
    if (x > unit.max + 1e-9) return setError(`${unit.label}最大 ${unit.max}`)
    onApply(Math.round(t * 1000) / 1000, fromDisplay(node.param, x))
  }

  const field = 'w-full rounded-lg border border-white/15 bg-black/40 px-2.5 py-2 font-mono text-sm text-white outline-none focus:border-accent'
  return createPortal(
    <div className="fixed inset-0 z-[210] flex items-center justify-center bg-black/50 p-4" onPointerDown={(e) => e.target === e.currentTarget && onClose()} data-node-editor>
      <form
        className="w-full max-w-xs space-y-3 rounded-2xl border border-line bg-panel p-4 text-white shadow-2xl"
        role="dialog"
        aria-label="編輯自動化節點"
        onSubmit={(e) => {
          e.preventDefault()
          apply()
        }}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      >
        <div>
          <h2 className="text-sm font-semibold">編輯自動化節點</h2>
          <p className="truncate text-[11px] text-white/40">{node.where}</p>
        </div>
        <label className="block">
          <span className="mb-1 block text-xs text-white/60">時間（秒，時間軸位置）</span>
          <input ref={first} value={time} onChange={(e) => setTime(e.target.value)} inputMode="decimal" className={field} data-node-time />
          <span className="mt-0.5 block text-[10px] text-white/35">
            可設定範圍 {node.minTime.toFixed(3)} – {node.maxTime.toFixed(3)} 秒
          </span>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-white/60">
            {unit.label}（{unit.unit}）
          </span>
          <input value={value} onChange={(e) => setValue(e.target.value)} inputMode="decimal" className={field} data-node-value />
          <span className="mt-0.5 block text-[10px] text-white/35">{unit.hint}</span>
        </label>
        {error && <p className="text-xs text-panic" data-node-error>{error}</p>}
        <div className="flex gap-2">
          <button type="submit" className="min-h-9 flex-1 rounded-lg bg-accent text-sm font-semibold text-white" data-node-apply>
            套用
          </button>
          <button type="button" onClick={onClose} className="min-h-9 rounded-lg px-3 text-sm text-white/60 hover:bg-white/10">
            取消
          </button>
        </div>
      </form>
    </div>,
    document.body,
  )
}
