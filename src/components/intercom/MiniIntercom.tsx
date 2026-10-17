import { useState } from 'react'
import { useAuth } from '../../services/auth'
import { CREW_CHANNELS, INTERCOM_TARGETS, groupChannelOptions, intercomChannelLabel, isGroupLike, roleColor, type IntercomChannel } from '../../types/intercom'
import type { SurfaceWidget } from '../../types/surface'
import { IntercomChat } from './IntercomChat'
import { useIntercomContext, type Intercom } from './intercomContext'

/** A status light: off, lit, or blinking. */
function Lamp({ label, on, color, blink, id }: { label: string; on: boolean; color: string; blink?: boolean; id: string }) {
  return (
    <div className="flex flex-col items-center gap-0.5" data-intercom-lamp={id} data-on={on ? '1' : '0'}>
      <span
        className={`h-3 w-3 rounded-full ${on && blink ? 'animate-pulse' : ''}`}
        style={{ background: on ? color : 'rgba(255,255,255,0.12)', boxShadow: on ? `0 0 10px ${color}` : 'none' }}
      />
      <span className={`text-[9px] font-bold tracking-wider ${on ? 'text-white' : 'text-white/35'}`}>{label}</span>
    </div>
  )
}

/**
 * Channel selector, shared with the Intercom drawer. Crew-only channels (Ch A / Ch B / All Call) are buttons;
 * the show's audience-group channels (Ch 1 … Ch N) are one dropdown. On a group channel you choose who you
 * talk to — the other crew on it, or the audience of that group — and the audience choice is flagged in orange.
 */
export function ChannelPicker({ intercom, small }: { intercom: Intercom; small?: boolean }) {
  const crew = CREW_CHANNELS
  const groups = groupChannelOptions(intercom.groupCount)
  const onGroup = isGroupLike(intercom.channel)
  const pick = (id: IntercomChannel) => {
    if (intercom.channel !== id) navigator.vibrate?.(10)
    intercom.setChannel(id)
  }
  return (
    <div className="space-y-1.5" data-intercom-channels>
      <div className="grid grid-cols-3 gap-1 rounded-lg bg-black/40 p-0.5" role="radiogroup" aria-label="演出人員頻道">
        {crew.map((c) => (
          <button
            key={c.id}
            type="button"
            role="radio"
            aria-checked={intercom.channel === c.id}
            onClick={() => pick(c.id)}
            className={`rounded-md font-bold ${small ? 'min-h-7 text-[10px]' : 'min-h-9 text-xs'} ${
              intercom.channel === c.id ? (c.id === 'all' ? 'bg-standby text-black' : 'bg-accent text-white') : 'text-white/50 hover:text-white/80'
            }`}
            data-intercom-channel={c.id}
          >
            {c.label}
          </button>
        ))}
      </div>
      <p className={`px-0.5 text-white/35 ${small ? 'text-[9px]' : 'text-[10px]'}`} data-all-call-note>
        Ch A / Ch B / All Call 只供演出人員，不會傳到觀眾。要對觀眾說話，請從下方「分組頻道」選擇。
      </p>
      {groups.length > 0 && (
        <>
          <select
            value={onGroup ? intercom.channel : ''}
            onChange={(e) => e.target.value && pick(e.target.value as IntercomChannel)}
            aria-label="分組頻道 Ch 1–10"
            className={`w-full rounded-lg border bg-black/40 px-2 font-semibold ${small ? 'min-h-7 text-[10px]' : 'min-h-10 text-xs'} ${
              onGroup ? (intercom.target === 'audience' ? 'border-standby text-standby' : 'border-accent text-white') : 'border-white/10 text-white/55'
            }`}
            data-intercom-group-select
          >
            <option value="">分組頻道（可對觀眾）· All Channels / Ch 1 – {intercom.groupCount}</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.label} · {intercom.targetOf(g.id) === 'audience' ? '對觀眾' : '演出人員'}
              </option>
            ))}
          </select>
          {onGroup && (
            <div className="grid grid-cols-2 gap-1 rounded-lg bg-black/40 p-0.5" role="radiogroup" aria-label="發話對象" data-intercom-target>
              {INTERCOM_TARGETS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="radio"
                  aria-checked={intercom.target === t.id}
                  onClick={() => intercom.setGroupTarget(intercom.channel, t.id)}
                  className={`rounded-md font-bold ${small ? 'min-h-7 text-[10px]' : 'min-h-9 text-xs'} ${
                    intercom.target === t.id ? (t.id === 'audience' ? 'bg-standby text-black' : 'bg-accent text-white') : 'text-white/50 hover:text-white/80'
                  }`}
                  data-intercom-target-option={t.id}
                >
                  {t.label}
                </button>
              ))}
            </div>
          )}
          {onGroup && intercom.target === 'audience' && (
            <p className={`rounded-md bg-standby/10 px-2 py-1 text-standby ${small ? 'text-[9px]' : 'text-[11px]'}`} data-intercom-audience-note>
              📣 發話會傳給{intercom.channel === 'channel_all' ? '「全部組別」' : ` ${intercomChannelLabel(intercom.channel)} `}的觀眾（{intercom.audienceReach}/{intercom.audienceInGroup} 台已連線）
            </p>
          )}
        </>
      )}
    </div>
  )
}

const channelLabel = (c: IntercomChannel) => intercomChannelLabel(c)

/**
 * A surface button in "Intercom" display: a belt-pack style station — channel select, TALK
 * (push-to-talk, or a latching mic with mute), CALL, the CALL / LISTEN / TALK lights and the
 * listen level. Uses the page's intercom station, so it stays in step with the Intercom drawer.
 */
export function MiniIntercom({ widget, preview = false }: { widget: SurfaceWidget; preview?: boolean }) {
  const intercom = useIntercomContext()
  const { user } = useAuth()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const frame = (body: React.ReactNode) => (
    <div
      className={`flex h-full w-full flex-col gap-1.5 overflow-hidden rounded-2xl border bg-black/50 p-2 text-white select-none ${preview ? 'pointer-events-none' : ''}`}
      style={{ borderColor: `${widget.color}70` }}
      data-mini-intercom={widget.id}
    >
      <div className="flex items-center gap-1.5 text-[11px]">
        <span className="h-2 w-2 rounded-full" style={{ background: widget.color }} />
        <span className="min-w-0 flex-1 truncate font-semibold text-white/85">{widget.label}</span>
        {intercom?.joined && <span className="font-mono text-[10px] text-white/40">{channelLabel(intercom.channel)}</span>}
      </div>
      {body}
    </div>
  )

  if (!intercom) return frame(<p className="text-[11px] text-white/40">此頁面沒有 Intercom</p>)

  const { voice } = intercom
  const others = intercom.members.filter((m) => m.id !== intercom.selfId)
  const onMyChannel = others.filter((m) => intercom.audible(m.id))
  // LISTEN: someone I can hear has TALK keyed (their mic is open), or is being heard right now.
  const listening = voice.on && (onMyChannel.some((m) => m.voice && !m.muted) || [...voice.speaking].some((id) => id !== intercom.selfId && intercom.audible(id)))
  const run = async (job: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await job()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const mode = widget.intercomMode
  const name = intercom.identity?.name || user?.name || ''
  const joinNow = () => intercom.join({ name, role: intercom.identity?.role ?? 'Other' })
  const chat = (
    <IntercomChat intercom={intercom} compact onBeforeSend={async () => {
      if (!intercom.joined) await joinNow()
    }} />
  )

  if (mode === 'chat') {
    return frame(
      <>
        <ChannelPicker intercom={intercom} small />
        {chat}
      </>,
    )
  }

  if (!intercom.joined) {
    return frame(
      <>
      <div className={`flex flex-col items-center justify-center gap-2 text-center ${mode === 'full' ? 'py-1' : 'flex-1'}`}>
        <span className="text-[11px] text-white/45">{others.length} 人在線</span>
        <button
          type="button"
          disabled={busy || !name}
          onClick={() => run(joinNow)}
          className="min-h-10 rounded-xl bg-go/20 px-4 text-xs font-bold text-go disabled:opacity-40"
          data-intercom-join
        >
          🎧 以「{name || '—'}」加入
        </button>
        {error && <span className="text-[10px] text-panic">{error}</span>}
      </div>
      {mode === 'full' && chat}
      </>,
    )
  }

  const talkButton = !voice.on ? (
    <button
      type="button"
      disabled={busy}
      onClick={() => run(voice.enable)}
      className="min-h-11 flex-1 rounded-xl bg-go/15 text-xs font-bold text-go disabled:opacity-40"
      data-intercom-voice
    >
      {busy ? '開啟麥克風…' : '🎙 開啟語音（或按住 T）'}
    </button>
  ) : !voice.hasMic ? (
    <span className="flex min-h-11 flex-1 items-center justify-center rounded-xl bg-white/[0.05] text-[10px] text-white/45">只能收聽（沒有麥克風）</span>
  ) : voice.micMode === 'ptt' ? (
    <button
      type="button"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        voice.setPttHeld(true)
      }}
      onPointerUp={() => voice.setPttHeld(false)}
      onPointerCancel={() => voice.setPttHeld(false)}
      className={`min-h-11 flex-1 touch-none rounded-xl text-xs font-extrabold tracking-wider ${voice.micLive ? 'bg-go text-black shadow-[0_0_20px_-4px_#30d158]' : 'bg-white/10 text-white/80'}`}
      data-intercom-talk="ptt"
      title="按住說話（鍵盤 T）"
    >
      {voice.micLive ? '● TALK' : '按住 TALK · T'}
    </button>
  ) : (
    <button
      type="button"
      onClick={() => voice.setMuted(!voice.muted)}
      aria-pressed={!voice.muted}
      className={`min-h-11 flex-1 rounded-xl text-xs font-extrabold tracking-wider ${voice.micLive ? 'bg-go text-black' : 'bg-panic/20 text-panic'}`}
      data-intercom-talk="latch"
    >
      {voice.pttHeld ? '● TALK (T)' : voice.muted ? '🔇 MUTED' : '● TALK ON'}
    </button>
  )

  return frame(
    <>
      <ChannelPicker intercom={intercom} small />
      <div className="flex items-center justify-around py-0.5">
        <Lamp id="call" label="CALL" on={!!intercom.alert} color="#ff453a" blink />
        <Lamp id="listen" label="LISTEN" on={listening} color="#ffd60a" />
        <Lamp id="talk" label="TALK" on={voice.micLive} color="#30d158" />
      </div>
      <div className="flex gap-1.5">
        {talkButton}
        <button
          type="button"
          onClick={() => intercom.call('*')}
          className="min-h-11 rounded-xl bg-gradient-to-b from-[#ff6a5f] to-[#e0362c] px-3 text-xs font-extrabold tracking-wider text-white"
          title={`呼叫 ${channelLabel(intercom.channel)} 的所有人`}
          data-intercom-call
        >
          CALL
        </button>
      </div>
      {voice.on && voice.hasMic && (
        <div className="grid grid-cols-2 gap-1 rounded-lg bg-black/40 p-0.5 text-[10px]">
          {(
            [
              ['ptt', 'Push-to-Talk'],
              ['open', '開麥 / Mute'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => {
                voice.setMicMode(id)
                voice.setPttHeld(false)
              }}
              className={`min-h-7 rounded-md font-semibold ${voice.micMode === id ? 'bg-white/15 text-white' : 'text-white/45'}`}
              data-intercom-micmode={id}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      <label className="flex items-center gap-1.5 text-[10px] text-white/50">
        🔈
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={intercom.listenVolume}
          onChange={(e) => intercom.setListenVolume(Number(e.target.value))}
          className="h-3 min-w-0 flex-1 accent-[#30d158]"
          aria-label="收聽音量"
          data-intercom-volume
        />
        <span className="w-8 text-right font-mono">{Math.round(intercom.listenVolume * 100)}%</span>
      </label>
      {mode === 'full' ? (
        chat
      ) : (
      <div className="flex min-h-0 flex-1 flex-wrap content-start gap-1 overflow-hidden" data-intercom-roster>
        {others.length === 0 && <span className="text-[10px] text-white/30">沒有其他人在線</span>}
        {others.map((m) => {
          const hear = onMyChannel.includes(m)
          return (
            <span
              key={m.id}
              className={`flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] ${hear ? 'bg-white/10 text-white/80' : 'bg-white/[0.03] text-white/30 line-through'}`}
              title={hear ? '同頻道，聽得到' : '不同頻道'}
            >
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: voice.speaking.has(m.id) && hear ? '#ffd60a' : roleColor(m.role) }} />
              {m.name}
              <span className="font-mono opacity-60">{m.channel === 'all' || !m.channel ? 'ALL' : m.channel}</span>
            </span>
          )
        })}
      </div>
      )}
      {voice.error && <span className="text-[10px] text-standby">{voice.error}</span>}
      {voice.on && !voice.hasMic && (
        <button type="button" onClick={() => void voice.retryMic()} className="min-h-9 rounded-lg bg-go/15 px-3 text-[11px] font-semibold text-go">
          🎙 重新開啟麥克風
        </button>
      )}
    </>,
  )
}
