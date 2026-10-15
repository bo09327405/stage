import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { dbLabel } from '../../studio/format'
import { PARAM_INFO, TRACK_PARAMS, type StudioTrack, type TrackParam } from '../../types/studio'

/** One track's controls in the left column: name, mute / solo / record-arm, volume and pan. */
export function TrackHeader({
  track,
  armed,
  onArm,
  onChange,
  onRemove,
  onToggleLane,
}: {
  track: StudioTrack
  armed: boolean
  onArm: () => void
  onChange: (changes: Partial<StudioTrack>, label: string) => void
  onRemove: () => void
  /** Show / hide an automation lane under the track. */
  onToggleLane: (param: TrackParam) => void
}) {
  const [autoMenu, setAutoMenu] = useState<{ x: number; y: number } | null>(null)
  const panAutomated = !!track.automation.pan?.points.length
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(track.name)
  const toggle = 'flex h-6 w-6 items-center justify-center rounded text-[10px] font-bold transition pointer-coarse:h-11 pointer-coarse:w-11 pointer-coarse:rounded-lg pointer-coarse:text-sm'

  return (
    <div className="flex h-full flex-col justify-between gap-1 py-1.5 pr-2 pl-3" data-track-header={track.id}>
      <div className="flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: track.color }} />
        {editing ? (
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => {
              setEditing(false)
              if (name.trim() && name !== track.name) onChange({ name: name.trim() }, `音軌重新命名為「${name.trim()}」`)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') {
                setName(track.name)
                setEditing(false)
              }
            }}
            className="min-w-0 flex-1 rounded border border-accent bg-black px-1 text-xs text-white outline-none"
            aria-label="音軌名稱"
          />
        ) : (
          <button
            type="button"
            onDoubleClick={() => {
              setName(track.name)
              setEditing(true)
            }}
            className="min-w-0 flex-1 truncate text-left text-xs font-semibold text-white/90"
            title="雙擊重新命名"
          >
            {track.name}
          </button>
        )}
        <button
          type="button"
          onClick={() => confirm(`刪除音軌「${track.name}」與其中所有片段？`) && onRemove()}
          className="h-6 w-6 shrink-0 rounded text-xs text-white/30 hover:bg-panic/20 hover:text-panic pointer-coarse:h-9 pointer-coarse:w-9"
          aria-label={`刪除音軌 ${track.name}`}
        >
          ✕
        </button>
      </div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          data-haptic="tap"
          onClick={() => onChange({ mute: !track.mute }, track.mute ? '取消靜音音軌' : '靜音音軌')}
          aria-pressed={track.mute}
          className={`${toggle} ${track.mute ? 'bg-standby text-black' : 'bg-white/[0.07] text-white/55 hover:bg-white/15'}`}
          title="靜音 Mute"
        >
          M
        </button>
        <button
          type="button"
          data-haptic="tap"
          onClick={() => onChange({ solo: !track.solo }, track.solo ? '取消 Solo' : 'Solo 音軌')}
          aria-pressed={track.solo}
          className={`${toggle} ${track.solo ? 'bg-accent text-white' : 'bg-white/[0.07] text-white/55 hover:bg-white/15'}`}
          title="獨奏 Solo"
        >
          S
        </button>
        <button
          type="button"
          data-haptic="tap"
          onClick={onArm}
          aria-pressed={armed}
          className={`${toggle} ${armed ? 'bg-panic text-white' : 'bg-white/[0.07] text-panic/70 hover:bg-white/15'}`}
          title="錄音預備：錄音會錄到這個音軌"
          data-arm={track.id}
        >
          ●
        </button>
        <button
          type="button"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            setAutoMenu(autoMenu ? null : { x: r.left, y: r.bottom + 4 })
          }}
          aria-expanded={!!autoMenu}
          className={`ml-1 h-6 rounded px-1.5 text-[10px] font-semibold pointer-coarse:h-11 pointer-coarse:px-2.5 pointer-coarse:text-xs ${TRACK_PARAMS.some((p) => track.automation[p]?.shown) ? 'bg-[#da77f2]/20 text-[#e9b8ff]' : 'bg-white/[0.07] text-white/55 hover:bg-white/15'}`}
          title="音軌自動化：Volume / Pan / Filter"
          data-automation-menu={track.id}
        >
          ＋ 自動化
        </button>
        <span className="ml-auto font-mono text-[10px] text-white/40 tabular">{dbLabel(track.volume)}</span>
      </div>
      <div className="flex items-center gap-2">
        <HeldRange tip={dbLabel(track.volume)} className="min-w-0 flex-1">
          <input
            type="range"
            min={0}
            max={1.5}
            step={0.01}
            value={track.volume}
            onChange={(e) => onChange({ volume: Number(e.target.value) }, `音軌「${track.name}」音量`)}
            onDoubleClick={() => onChange({ volume: 1 }, `音軌「${track.name}」音量`)}
            className="h-1 w-full accent-[#30d158] pointer-coarse:h-11"
            aria-label={`${track.name} 音量`}
            title="音量（雙擊回到 0 dB）"
          />
        </HeldRange>
        <HeldRange tip={track.pan === 0 ? 'C' : track.pan < 0 ? `L ${Math.round(-track.pan * 100)}%` : `R ${Math.round(track.pan * 100)}%`} className="w-14 pointer-coarse:w-20">
          <input
            type="range"
            min={-1}
            max={1}
            step={0.02}
            value={track.pan}
            disabled={panAutomated}
            onChange={(e) => onChange({ pan: Number(e.target.value) }, `音軌「${track.name}」聲相`)}
            onDoubleClick={() => onChange({ pan: 0 }, `音軌「${track.name}」聲相`)}
            className="h-1 w-full accent-[#0a84ff] pointer-coarse:h-11"
            aria-label={`${track.name} 聲相`}
            title={panAutomated ? '聲相由自動化控制' : '聲相（雙擊置中）'}
          />
        </HeldRange>
      </div>
      {autoMenu && (
        <AutomationMenu
          track={track}
          x={autoMenu.x}
          y={autoMenu.y}
          onPick={(param) => {
            onToggleLane(param)
            setAutoMenu(null)
          }}
          onClose={() => setAutoMenu(null)}
        />
      )}
    </div>
  )
}

/** "+ Automation" pop-up: which parameters get a lane under this track. */
function AutomationMenu({ track, x, y, onPick, onClose }: { track: StudioTrack; x: number; y: number; onPick: (p: TrackParam) => void; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const down = (e: PointerEvent) => !box.current?.contains(e.target as Node) && !(e.target as Element).closest?.('[data-automation-menu]') && onClose()
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('keydown', key)
    }
  }, [onClose])
  return createPortal(
    <div
      ref={box}
      data-sheet-menu className="fixed z-[90] w-56 rounded-xl border border-white/10 bg-[#202020]/95 p-1 shadow-2xl backdrop-blur-xl"
      style={{ left: Math.min(x, window.innerWidth - 232), top: Math.min(y, window.innerHeight - 180) }}
      role="menu"
      aria-label="自動化參數"
      data-automation-popup
    >
      <div className="px-3 pt-1 pb-1.5 text-[11px] text-white/40">{track.name} · 自動化</div>
      {TRACK_PARAMS.map((p) => {
        const lane = track.automation[p]
        return (
          <button
            key={p}
            type="button"
            role="menuitemcheckbox"
            aria-checked={!!lane?.shown}
            onClick={() => onPick(p)}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-[13px] text-white/85 hover:bg-white/10"
            data-auto-param={p}
          >
            <span className="w-3 text-accent">{lane?.shown ? '✓' : ''}</span>
            <span className="h-2 w-2 rounded-full" style={{ background: PARAM_INFO[p].color }} />
            <span className="flex-1">{PARAM_INFO[p].label}</span>
            {lane?.points.length ? <span className="font-mono text-[10px] text-white/35">{lane.points.length}</span> : null}
          </button>
        )
      })}
    </div>,
    document.body,
  )
}

/** Wraps a range slider: while a finger (or mouse) holds it, the value floats above it in large type. */
function HeldRange({ tip, className = '', children }: { tip: string; className?: string; children: ReactNode }) {
  const [held, setHeld] = useState(false)
  useEffect(() => {
    if (!held) return
    const up = () => setHeld(false)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  }, [held])
  return (
    <div className={`relative ${className}`} onPointerDown={() => setHeld(true)}>
      {held && (
        <span className="pointer-events-none absolute -top-9 left-1/2 z-30 -translate-x-1/2 rounded-md bg-black/90 px-2.5 py-1 font-mono text-sm font-semibold whitespace-nowrap text-white shadow-lg ring-1 ring-white/20 pointer-coarse:-top-14 pointer-coarse:text-xl" data-fader-tip>
          {tip}
        </span>
      )}
      {children}
    </div>
  )
}
