import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { DIM_MAX_DB, DIM_MIN_DB, DIM_PRESETS, clampDimDb, dbToGain, formatDimDb } from '../../utils/dim'

/**
 * DIM button (see utils/dim.ts): left-click toggles, right-click (or long-press) sets the amount —
 * −10 / −15 / −20 / −30 dB or a custom value. Lit while active; shows its dB.
 */
export function DimButton({
  active,
  db,
  onToggle,
  onDbChange,
  scope,
  className,
  activeClassName,
  inactiveClassName,
  area,
}: {
  active: boolean
  db: number
  onToggle: () => void
  onDbChange: (db: number) => void
  /** What it affects, for the tooltip and menu ("只影響你自己聽到的", "所有觀眾裝置"…). */
  scope: string
  className: string
  activeClassName: string
  inactiveClassName: string
  /** data-dim-button value (tests, styling). */
  area: string
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  return (
    <>
      <button
        type="button"
        onClick={onToggle}
        onContextMenu={(e) => {
          e.preventDefault()
          setMenu({ x: e.clientX, y: e.clientY })
        }}
        aria-pressed={active}
        className={`${className} ${active ? activeClassName : inactiveClassName}`}
        title={`DIM ${formatDimDb(db)}（${scope}）· 左鍵開／關 · 右鍵設定衰減量`}
        data-dim-button={area}
        data-dim-db={db}
        data-dim-active={active ? 'true' : 'false'}
      >
        DIM
        <span className={`ml-1 font-mono text-[0.8em] font-semibold tabular ${active ? '' : 'opacity-50'}`} data-dim-label>
          {formatDimDb(db).replace(' dB', '')}
        </span>
      </button>
      {menu && <DimMenu x={menu.x} y={menu.y} db={db} scope={scope} area={area} onPick={onDbChange} onClose={() => setMenu(null)} />}
    </>
  )
}

function DimMenu({ x, y, db, scope, area, onPick, onClose }: { x: number; y: number; db: number; scope: string; area: string; onPick: (db: number) => void; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  useLayoutEffect(() => {
    close.current = onClose
  })
  const [custom, setCustom] = useState(String(Math.abs(db)))
  useEffect(() => {
    const away = (e: Event) => !box.current?.contains(e.target as Node) && close.current()
    // Esc closes the menu only; it must not reach the console's own shortcuts (Fade All…).
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopImmediatePropagation()
      close.current()
    }
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('pointerdown', away, true)
      window.removeEventListener('keydown', key, true)
    }
  }, [])
  const pick = (value: number) => {
    onPick(clampDimDb(value))
    close.current()
  }
  const isPreset = (DIM_PRESETS as readonly number[]).includes(db)
  const width = 220
  return createPortal(
    <div
      ref={box}
      className="fixed z-[96] rounded-xl border border-white/10 bg-[#202020]/95 p-1 text-white shadow-2xl backdrop-blur-xl"
      style={{ width, left: Math.max(8, Math.min(x, window.innerWidth - width - 8)), top: Math.max(8, Math.min(y, window.innerHeight - 290)) }}
      role="menu"
      aria-label="DIM 衰減量"
      data-dim-menu={area}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="px-3 pt-1 pb-1.5">
        <div className="text-[11px] font-semibold text-white/60">DIM 衰減量</div>
        <div className="text-[10px] text-white/35">{scope}</div>
      </div>
      {DIM_PRESETS.map((p) => (
        <button
          key={p}
          type="button"
          role="menuitemradio"
          aria-checked={db === p}
          onClick={() => pick(p)}
          className="flex w-full items-center justify-between rounded-md px-3 py-1.5 text-left text-[13px] hover:bg-white/10"
          data-dim-preset={p}
        >
          <span>
            {db === p ? '✓ ' : '  '}
            {formatDimDb(p)}
            {p === -20 && <span className="ml-1 text-[10px] text-white/40">預設</span>}
          </span>
          <span className="font-mono text-[10px] text-white/35">×{dbToGain(p).toFixed(3)}</span>
        </button>
      ))}
      <form
        className="mt-1 flex items-center gap-1.5 border-t border-white/10 px-3 pt-2 pb-1.5"
        onSubmit={(e) => {
          e.preventDefault()
          const v = Number(custom)
          if (Number.isFinite(v) && v !== 0) pick(-Math.abs(v))
        }}
      >
        <span className="text-[12px] text-white/70">{isPreset ? '自訂' : '✓ 自訂'} −</span>
        <input
          value={custom}
          onChange={(e) => setCustom(e.target.value.replace(/[^\d.]/g, ''))}
          inputMode="decimal"
          className="h-7 w-14 rounded border border-white/15 bg-black/40 px-1.5 text-right font-mono text-xs outline-none focus:border-accent"
          aria-label="自訂衰減（dB）"
          title={`${Math.abs(DIM_MAX_DB)}–${Math.abs(DIM_MIN_DB)} dB`}
          data-dim-custom
        />
        <span className="text-[12px] text-white/50">dB</span>
        <button type="submit" className="ml-auto h-7 rounded-md bg-accent px-2 text-[11px] font-semibold text-white" data-dim-custom-apply>
          套用
        </button>
      </form>
      <p className="px-3 pb-1 text-[10px] text-white/30">只降低音量、不靜音；關閉 DIM 會精確回到原本音量。</p>
    </div>,
    document.body,
  )
}
