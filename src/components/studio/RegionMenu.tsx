import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { StudioRegion } from '../../types/studio'

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
const K = (key: string) => (isMac ? `⌘${key}` : `Ctrl+${key}`)

export type RegionAction =
  | 'cut'
  | 'copy'
  | 'paste'
  | 'delete'
  | 'duplicate'
  | 'split'
  | 'mute'
  | 'reverse'
  | 'cleanup'
  | 'resetAutomation'
  | { rename: string }
  | { comment: string }
  | { pitch: number }

/** Right-click menu for regions (acts on the whole selection). */
export function RegionMenu({
  region,
  count,
  x,
  y,
  canPaste,
  onAction,
  onClose,
}: {
  region: StudioRegion
  count: number
  x: number
  y: number
  canPaste: boolean
  onAction: (a: RegionAction) => void
  onClose: () => void
}) {
  const [mode, setMode] = useState<'main' | 'rename' | 'comment' | 'pitch'>('main')
  const [text, setText] = useState('')
  const [pitch, setPitch] = useState(region.pitch)
  const box = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })

  // Keep the menu on screen.
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({ left: Math.min(x, window.innerWidth - r.width - 8), top: Math.min(y, window.innerHeight - r.height - 8) })
  }, [x, y, mode])

  useEffect(() => {
    const down = (e: PointerEvent) => !box.current?.contains(e.target as Node) && onClose()
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('keydown', key)
    }
  }, [onClose])

  const act = (a: RegionAction) => {
    onAction(a)
    onClose()
  }
  const item = (label: string, a: RegionAction | (() => void), shortcut?: string, opts: { danger?: boolean; disabled?: boolean; checked?: boolean } = {}) => (
    <button
      key={label}
      type="button"
      disabled={opts.disabled}
      onClick={() => (typeof a === 'function' ? a() : act(a))}
      className={`flex w-full items-center gap-3 rounded-md px-3 py-1.5 text-left text-[13px] disabled:opacity-35 ${opts.danger ? 'text-panic hover:bg-panic/15' : 'text-white/85 hover:bg-white/10'}`}
      role="menuitem"
      data-menu-item={label}
    >
      <span className="w-3 text-accent">{opts.checked ? '✓' : ''}</span>
      <span className="flex-1">{label}</span>
      {shortcut && <span className="font-mono text-[11px] text-white/35">{shortcut}</span>}
    </button>
  )
  const sep = (k: string) => <div key={k} className="my-1 h-px bg-white/10" />

  return createPortal(
    <div
      ref={box}
      className="fixed z-[90] w-60 rounded-xl border border-white/10 bg-[#202020]/95 p-1 shadow-2xl backdrop-blur-xl"
      style={pos}
      role="menu"
      aria-label="片段選單"
      onContextMenu={(e) => e.preventDefault()}
      data-region-menu
    >
      <div className="truncate px-3 pt-1 pb-1.5 text-[11px] text-white/40">{count > 1 ? `已選 ${count} 個片段` : region.name}</div>
      {mode === 'main' && (
        <>
          {item('剪下 Cut', 'cut', K('X'))}
          {item('複製 Copy', 'copy', K('C'))}
          {item('貼上 Paste', 'paste', K('V'), { disabled: !canPaste })}
          {item('複製一份 Duplicate', 'duplicate', K('D'))}
          {item('刪除 Delete', 'delete', '⌫', { danger: true })}
          {sep('a')}
          {item('重新命名 Edit name', () => {
            setText(region.name)
            setMode('rename')
          })}
          {item('分割 Split region', 'split', K('E'))}
          {item('靜音 Mute region', 'mute', K('M'), { checked: region.muted })}
          {item(region.comment ? '編輯註解 Comment' : '新增註解 Add comment', () => {
            setText(region.comment)
            setMode('comment')
          })}
          {sep('b')}
          {item(`變調 Change pitch${region.pitch ? `（${region.pitch > 0 ? '+' : ''}${region.pitch}）` : ''}`, () => setMode('pitch'), '▸')}
          {item('反轉 Reverse', 'reverse', undefined, { checked: region.reverse })}
          {item('人聲清理 Vocal Cleanup', 'cleanup', undefined, { checked: region.cleanup })}
          {region.automation.length > 0 && item('清除音量自動化', 'resetAutomation')}
        </>
      )}
      {(mode === 'rename' || mode === 'comment') && (
        <form
          className="space-y-2 p-2"
          onSubmit={(e) => {
            e.preventDefault()
            act(mode === 'rename' ? { rename: text.trim() || region.name } : { comment: text.trim() })
          }}
        >
          {mode === 'rename' ? (
            <input autoFocus value={text} onChange={(e) => setText(e.target.value)} className="w-full rounded-md border border-accent bg-black px-2 py-1.5 text-sm text-white outline-none" aria-label="片段名稱" />
          ) : (
            <textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} rows={3} className="w-full rounded-md border border-accent bg-black px-2 py-1.5 text-sm text-white outline-none" aria-label="註解" />
          )}
          <div className="flex justify-end gap-1">
            <button type="button" onClick={() => setMode('main')} className="rounded-md px-2.5 py-1 text-xs text-white/50 hover:bg-white/10">
              返回
            </button>
            <button type="submit" className="rounded-md bg-accent px-3 py-1 text-xs font-semibold text-white">
              確定
            </button>
          </div>
        </form>
      )}
      {mode === 'pitch' && (
        <div className="space-y-2 p-2" data-pitch-menu>
          <div className="grid grid-cols-4 gap-1">
            {[-12, -5, -2, -1, 1, 2, 5, 12].map((s) => (
              <button key={s} type="button" onClick={() => act({ pitch: Math.max(-12, Math.min(12, region.pitch + s)) })} className="rounded-md bg-white/[0.07] py-1.5 font-mono text-xs text-white/80 hover:bg-white/15">
                {s > 0 ? `+${s}` : s}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-xs text-white/60">
            設定為
            <input type="range" min={-12} max={12} step={1} value={pitch} onChange={(e) => setPitch(Number(e.target.value))} className="flex-1 accent-[#bf5af2]" aria-label="音高" />
            <span className="w-8 text-right font-mono text-white">{pitch > 0 ? `+${pitch}` : pitch}</span>
          </label>
          <div className="flex justify-end gap-1">
            <button type="button" onClick={() => act({ pitch: 0 })} className="rounded-md px-2.5 py-1 text-xs text-white/50 hover:bg-white/10">
              還原
            </button>
            <button type="button" onClick={() => act({ pitch })} className="rounded-md bg-[#bf5af2] px-3 py-1 text-xs font-semibold text-white">
              套用
            </button>
          </div>
        </div>
      )}
    </div>,
    document.body,
  )
}
