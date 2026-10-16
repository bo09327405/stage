import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { parseTimecode, timecode } from '../../studio/format'
import { SECTION_COLORS, type StudioSection } from '../../types/studio'

export type SectionAction = { rename: string } | { color: string } | { length: number } | { start: number } | 'jump' | 'select' | 'delete'

/** Right-click menu for a timeline section: name, colour, exact length, jump, select its regions, delete. */
export function SectionMenu({ section, x, y, onAction, onClose }: { section: StudioSection; x: number; y: number; onAction: (a: SectionAction) => void; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null)
  const [name, setName] = useState(section.name)
  const [length, setLength] = useState((section.end - section.start).toFixed(2))
  const [start, setStart] = useState(timecode(section.start))
  const [pos, setPos] = useState({ left: x, top: y })
  useLayoutEffect(() => {
    const r = box.current?.getBoundingClientRect()
    if (r) setPos({ left: Math.min(x, window.innerWidth - r.width - 8), top: Math.min(y, window.innerHeight - r.height - 8) })
  }, [x, y])
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
  const act = (a: SectionAction) => {
    onAction(a)
    onClose()
  }
  const row = 'flex w-full items-center rounded-md px-3 py-1.5 text-left text-[13px] text-white/85 hover:bg-white/10'

  return createPortal(
    <div ref={box} data-sheet-menu className="fixed z-[90] w-60 space-y-1 rounded-xl border border-white/10 bg-[#202020]/95 p-1.5 shadow-2xl backdrop-blur-xl" style={pos} role="menu" aria-label="區段選單" onContextMenu={(e) => e.preventDefault()} data-section-menu>
      <form
        className="flex gap-1 p-1"
        onSubmit={(e) => {
          e.preventDefault()
          if (name.trim()) act({ rename: name.trim() })
        }}
      >
        <input value={name} onChange={(e) => setName(e.target.value)} className="min-w-0 flex-1 rounded-md border border-white/15 bg-black px-2 py-1 text-sm text-white outline-none focus:border-accent" aria-label="區段名稱" />
        <button type="submit" className="rounded-md bg-accent px-2 text-xs font-semibold text-white">
          改名
        </button>
      </form>
      <form
        className="flex items-center gap-1 px-1 pb-1 text-xs text-white/55"
        onSubmit={(e) => {
          e.preventDefault()
          const n = Number(length)
          if (n > 0.1) act({ length: n })
        }}
      >
        長度
        <input value={length} onChange={(e) => setLength(e.target.value)} inputMode="decimal" className="w-16 rounded-md border border-white/15 bg-black px-1.5 py-1 text-center font-mono text-xs text-white outline-none focus:border-accent" aria-label="區段長度（秒）" />
        秒
        <button type="submit" className="ml-auto rounded-md bg-white/10 px-2 py-1 text-white/80 hover:bg-white/20">
          套用
        </button>
      </form>
      <form
        className="flex items-center gap-1 px-1 pb-1 text-xs text-white/55"
        onSubmit={(e) => {
          e.preventDefault()
          const t = parseTimecode(start)
          if (t !== null) act({ start: t })
        }}
      >
        起點
        <input value={start} onChange={(e) => setStart(e.target.value)} inputMode="decimal" placeholder="0:16.000" className="w-24 rounded-md border border-white/15 bg-black px-1.5 py-1 text-right font-mono text-sm text-white outline-none focus:border-accent" aria-label="區段起始時間（分:秒.毫秒）" />
        <button type="submit" className="ml-auto rounded-md bg-white/10 px-2 py-1 text-white/80 hover:bg-white/20">
          套用
        </button>
      </form>
      <div className="flex gap-1.5 px-2 pb-1">
        {SECTION_COLORS.map((c) => (
          <button key={c} type="button" onClick={() => act({ color: c })} className={`h-6 w-6 rounded-full ${section.color === c ? 'ring-2 ring-white' : ''}`} style={{ background: c }} aria-label={`顏色 ${c}`} />
        ))}
      </div>
      <div className="h-px bg-white/10" />
      <button type="button" className={row} onClick={() => act('jump')}>
        ⇤ 跳到開頭 <span className="ml-auto font-mono text-[11px] text-white/35">{timecode(section.start)}</span>
      </button>
      <button type="button" className={row} onClick={() => act('select')}>
        ▭ 選取區段內的片段
      </button>
      <button type="button" className={`${row} text-panic hover:bg-panic/15`} onClick={() => act('delete')} data-section-delete>
        刪除區段
      </button>
    </div>,
    document.body,
  )
}

/** Exact start time of a section: type minutes:seconds.milliseconds (e.g. 0:16.500); its length is kept. */
export function SectionStartDialog({ section, onApply, onClose }: { section: StudioSection; onApply: (start: number) => void; onClose: () => void }) {
  const [text, setText] = useState(timecode(section.start))
  const parsed = parseTimecode(text)
  const length = section.end - section.start
  return createPortal(
    <div className="fixed inset-0 z-[130] flex items-end justify-center bg-black/60 p-4 sm:items-center" onPointerDown={(e) => e.target === e.currentTarget && onClose()} data-section-start-dialog>
      <form
        className="w-full max-w-sm space-y-3 rounded-2xl border border-white/10 bg-[#1c1c1e] p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl"
        onSubmit={(e) => {
          e.preventDefault()
          if (parsed !== null) onApply(parsed)
        }}
      >
        <div className="text-sm font-semibold text-white">⏱ 「{section.name}」起始時間</div>
        <input
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onFocus={(e) => e.target.select()}
          inputMode="decimal"
          placeholder="分:秒.毫秒，例如 0:16.500"
          className="w-full rounded-xl border border-white/15 bg-black px-3 py-3 text-center font-mono text-2xl text-white outline-none focus:border-accent"
          aria-label="起始時間（分:秒.毫秒）"
        />
        <div className="text-center text-xs text-white/45">
          {parsed === null ? <span className="text-panic">格式：分:秒.毫秒（例如 0:16.500），或直接輸入秒數</span> : `→ ${timecode(parsed)} ～ ${timecode(parsed + length)}（長度 ${length.toFixed(3)} 秒不變）`}
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className="min-h-12 flex-1 rounded-xl bg-white/10 text-sm font-semibold text-white">
            取消
          </button>
          <button type="submit" disabled={parsed === null} className="min-h-12 flex-1 rounded-xl bg-accent text-sm font-semibold text-white disabled:opacity-40">
            套用
          </button>
        </div>
      </form>
    </div>,
    document.body,
  )
}
