import { formatTime } from '../../hooks/useServerNow'
import { instanceClock, type ActiveCue } from '../../types/cue'
import { channelColor, channelIds, channelLabel, reachesChannel } from '../../types/channels'
import { instanceTiming } from '../../utils/cueTiming'

/** ALL view: what each audience group is playing right now (running cues that reach it, with progress). */
export function ChannelOverview({ count, instances, now, online, onPick }: { count: number; instances: ActiveCue[]; now: number; online: Record<string, number>; onPick: (channel: string) => void }) {
  if (count <= 0) return null
  const live = instances.filter((i) => i.stopAt == null)
  return (
    <div className="grid grid-cols-2 gap-2 border-b border-line p-3 sm:grid-cols-3 lg:grid-cols-5" data-channel-overview>
      {channelIds(count).map((id) => {
        const playing = live.filter((i) => reachesChannel(i.cue.targetChannels, id))
        const lead = playing.at(-1)
        const timing = lead ? instanceTiming(lead, instanceClock(lead, now)) : null
        return (
          <button
            key={id}
            type="button"
            onClick={() => onPick(id)}
            className="min-h-[68px] overflow-hidden rounded-xl border border-white/10 bg-white/[0.04] p-2.5 text-left active:bg-white/10"
            data-overview-channel={id}
          >
            <div className="flex items-center gap-1.5 text-xs font-bold" style={{ color: channelColor(id) }}>
              <span className="h-2 w-2 rounded-full" style={{ background: playing.length ? channelColor(id) : 'rgba(255,255,255,0.2)' }} />
              {channelLabel(id)}
              <span className="ml-auto text-[10px] font-normal text-white/45">👥 {online[id] ?? 0}{playing.length > 1 ? ` · +${playing.length - 1}` : ''}</span>
            </div>
            {lead ? (
              <>
                <div className="mt-1 truncate text-sm text-white">
                  <span className="mr-1 font-mono text-white/50">{lead.cue.cueNumber}</span>
                  {lead.cue.title || '（未命名）'}
                </div>
                <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/10">
                  <div className="h-full rounded-full bg-go" style={{ width: `${Math.min(1, timing?.progress ?? 0) * 100}%` }} />
                </div>
                <div className="mt-0.5 text-right font-mono text-[10px] text-white/45">
                  {timing?.remaining != null ? `-${formatTime(timing.remaining)}` : formatTime(timing?.elapsed ?? 0)}
                </div>
              </>
            ) : (
              <div className="mt-2 text-xs text-white/30">待機中</div>
            )}
          </button>
        )
      })}
    </div>
  )
}
