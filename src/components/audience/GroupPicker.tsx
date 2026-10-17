import { channelColor, channelIds, channelLabel } from '../../types/channels'

/**
 * Audience onboarding: pick your group. Big cards for Ch 1 … Ch N, or — when the link already names a
 * group (?group=3) — a single locked card that only needs a tap to join.
 */
export function GroupPicker({ count, linked, onPick }: { count: number; linked: string | null; onPick: (channel: string) => void }) {
  const choose = (id: string) => {
    navigator.vibrate?.(15)
    onPick(id)
  }
  return (
    <div className="flex h-full flex-col overflow-y-auto px-5 pt-[max(2rem,env(safe-area-inset-top))] pb-[max(2rem,env(safe-area-inset-bottom))]" data-group-picker>
      <div className="mb-6 text-center">
        <span className="text-sm tracking-[0.4em] text-white/50">THEATRE</span>
        <h1 className="mt-3 text-2xl font-bold">{linked ? '確認你的組別' : '請選擇你的組別'}</h1>
        <p className="mt-1.5 text-sm text-white/50">{linked ? '此連結已為你指定組別，點一下即可加入' : '依現場工作人員的指示選擇，之後會收到該組的畫面與聲音'}</p>
      </div>

      {linked ? (
        <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-4">
          <div className="flex min-h-40 flex-col items-center justify-center rounded-3xl border-2 text-center" style={{ borderColor: channelColor(linked), background: `${channelColor(linked)}22` }}>
            <span className="text-sm text-white/60">📍 您的組別</span>
            <span className="text-6xl font-extrabold" style={{ color: channelColor(linked) }}>
              {channelLabel(linked)}
            </span>
          </div>
          <button type="button" onClick={() => choose(linked)} className="min-h-16 rounded-2xl text-xl font-bold text-black active:scale-[0.98]" style={{ background: channelColor(linked) }} data-group-confirm>
            加入 {channelLabel(linked)}
          </button>
        </div>
      ) : (
        <div className="mx-auto grid w-full max-w-md grid-cols-2 gap-3">
          {channelIds(count).map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => choose(id)}
              className="flex min-h-28 flex-col items-center justify-center gap-1 rounded-3xl border-2 bg-white/[0.04] active:scale-[0.97]"
              style={{ borderColor: `${channelColor(id)}88` }}
              data-group-card={id}
            >
              <span className="text-4xl font-extrabold" style={{ color: channelColor(id) }}>
                {id.replace('channel_', '')}
              </span>
              <span className="text-sm text-white/60">第 {id.replace('channel_', '')} 組</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
