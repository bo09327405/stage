import { TARGET_ALL, channelColor, channelIds, channelLabel } from '../../types/channels'

/** Cue editor: which audience groups this cue plays for (all, or a set of Ch n). */
export function ChannelTargets({ count, value, onChange }: { count: number; value: string[]; onChange: (targets: string[]) => void }) {
  if (count <= 0) return null
  const all = value.length === 0 || value.includes(TARGET_ALL)
  const toggle = (id: string) => {
    navigator.vibrate?.(10)
    const next = value.includes(id) ? value.filter((v) => v !== id) : [...value.filter((v) => v !== TARGET_ALL), id]
    onChange(next.length === 0 ? [TARGET_ALL] : next)
  }
  return (
    <div data-channel-targets>
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-[11px] font-semibold tracking-widest text-white/50 uppercase">目標頻道（觀眾組別）</span>
        <span className="text-[11px] text-white/35">{all ? '全部組別' : `${value.length} 組`}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onChange([TARGET_ALL])}
          aria-pressed={all}
          className={`min-h-11 rounded-full border px-4 text-sm font-semibold transition ${all ? 'border-white/70 bg-white text-black' : 'border-white/15 bg-white/[0.05] text-white/70'}`}
          data-target-channel="all"
        >
          ALL 全部
        </button>
        {channelIds(count).map((id) => {
          const on = !all && value.includes(id)
          return (
            <button
              key={id}
              type="button"
              onClick={() => toggle(id)}
              aria-pressed={on}
              className={`min-h-11 rounded-full border px-4 text-sm font-semibold transition ${on ? 'text-black' : 'border-white/15 bg-white/[0.05] text-white/70'}`}
              style={on ? { background: channelColor(id), borderColor: channelColor(id) } : undefined}
              data-target-channel={id}
            >
              {channelLabel(id)}
            </button>
          )
        })}
      </div>
      <p className="mt-2 text-xs text-white/35">只有所選組別的觀眾會看到／聽到這個 Cue；與下方「派發對象」同時成立才會送達。</p>
    </div>
  )
}
