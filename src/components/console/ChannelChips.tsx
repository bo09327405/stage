import { channelColor, channelIds, channelLabel, CHANNEL_ALL } from '../../types/channels'

/**
 * Horizontal, swipeable channel chips: ALL + Ch 1 … Ch N. Every chip is at least 44 px tall (thumb-sized),
 * the row scrolls sideways on narrow screens, and a switch gives a light haptic tick.
 */
export function ChannelChips({
  count,
  value,
  onChange,
  running,
}: {
  count: number
  /** CHANNEL_ALL or channel_n. */
  value: string
  onChange: (view: string) => void
  /** Running cue count per channel id (shown as a ▶ badge). */
  running: Record<string, number>
}) {
  if (count <= 0) return null
  const chips = [CHANNEL_ALL, ...channelIds(count)]
  return (
    <div
      className="flex min-h-14 items-center gap-2 overflow-x-auto overscroll-x-contain border-b border-line bg-panel/40 px-3 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      role="tablist"
      aria-label="頻道檢視"
      data-channel-chips
    >
      {chips.map((id) => {
        const active = id === value
        const color = channelColor(id)
        const n = id === CHANNEL_ALL ? Object.values(running).reduce((a, b) => a + b, 0) : (running[id] ?? 0)
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => {
              if (!active) navigator.vibrate?.(10)
              onChange(id)
            }}
            className={`flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border px-4 text-sm font-semibold whitespace-nowrap transition active:scale-95 ${
              active ? 'text-black' : 'border-white/15 bg-white/[0.05] text-white/75'
            }`}
            style={active ? { background: color, borderColor: color } : undefined}
            data-channel-chip={id}
          >
            {id !== CHANNEL_ALL && <span className="h-2 w-2 rounded-full" style={{ background: active ? '#000' : color }} />}
            {channelLabel(id)}
            {n > 0 && (
              <span className={`rounded-full px-1.5 text-[10px] font-bold ${active ? 'bg-black/25 text-black' : 'bg-go/25 text-go'}`}>▶ {n}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}
