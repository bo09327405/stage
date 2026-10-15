import { useCueMonitorState } from '../../hooks/useCueMonitorState'
import type { useTheatreEngine } from '../../hooks/useTheatreEngine'

/**
 * The Cue Monitor folded into a slim tab on the surface's left edge. It still shows the Active
 * and Standby cue numbers, so the operator sees the show state without opening it.
 */
export function MonitorDrawerTab({
  engine,
  onOpen,
  hidden,
}: {
  engine: ReturnType<typeof useTheatreEngine>
  onOpen: () => void
  hidden: boolean
}) {
  const { newest, standby } = useCueMonitorState(engine)
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`absolute inset-y-0 left-0 z-20 flex w-9 flex-col items-center gap-3 border-r border-line bg-panel/80 py-3 text-white/60 transition hover:bg-white/10 hover:text-white ${
        hidden ? 'pointer-events-none opacity-0' : ''
      }`}
      aria-label="展開 Cue Monitor 側欄"
      title="展開 Cue Monitor"
      data-monitor-tab
    >
      <span className="text-sm">▸</span>
      <span className="flex flex-col items-center gap-1">
        <span className={`h-2 w-2 rounded-full ${newest ? 'bg-go shadow-[0_0_6px_#30d158]' : 'bg-white/20'}`} />
        {newest && <span className="font-mono text-[10px] text-go tabular">{newest.cue.cueNumber}</span>}
      </span>
      <span className="flex flex-col items-center gap-1">
        <span className={`h-2 w-2 rounded-full ${standby ? 'bg-standby' : 'bg-white/20'}`} />
        {standby && <span className="font-mono text-[10px] text-standby tabular">{standby.cueNumber}</span>}
      </span>
      <span className="text-[10px] font-semibold tracking-widest uppercase [writing-mode:vertical-rl]">Cue Monitor</span>
    </button>
  )
}
