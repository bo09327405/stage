import { useState } from 'react'
import { pushAnnouncement } from '../../services/audiencePush'
import { CHANNEL_ALL, channelColor, channelIds, channelLabel, type Announcement } from '../../types/channels'
import { BottomSheet } from '../ui/BottomSheet'
import { fieldClass } from '../ui/controls'

const PRESETS = ['演出即將開始，請就座並關閉手機鈴聲', '請跟隨工作人員指示移動', '中場休息 15 分鐘', '請保持安靜，演出繼續']

/**
 * One-way announcement to audience devices: pick ALL or one group (Ch 1 – Ch N), type a message, choose
 * chime / vibration / spoken text, send. Audience devices only listen — they cannot reply, and the crew
 * Intercom is a separate channel they can't join. Phones with the app in the background get a push.
 */
export function AnnouncePanel({
  open,
  onClose,
  projectId,
  count,
  admin,
  online,
  send,
  defaultChannel,
}: {
  open: boolean
  onClose: () => void
  projectId: string
  count: number
  admin: boolean
  online: number
  send: (message: Omit<Announcement, 'id' | 'at'>) => Promise<void>
  /** The channel the console is viewing (pre-selected). */
  defaultChannel: string
}) {
  const [channel, setChannel] = useState(defaultChannel)
  const [text, setText] = useState('')
  const [tone, setTone] = useState(true)
  const [vibrate, setVibrate] = useState(true)
  const [speak, setSpeak] = useState(true)
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle')
  const [error, setError] = useState<string | null>(null)
  const targets = [CHANNEL_ALL, ...channelIds(count)]
  const target = targets.includes(channel) ? channel : CHANNEL_ALL

  const submit = async () => {
    const message = text.trim().slice(0, 200)
    if (!message && !tone && !vibrate) return setError('請輸入訊息，或至少開啟提示音／震動')
    setState('sending')
    setError(null)
    try {
      await send({ channel: target, text: message, tone, vibrate, speak: speak && !!message })
      pushAnnouncement(projectId, { channel: target, text: message })
      navigator.vibrate?.(15)
      setState('sent')
      setText('')
      window.setTimeout(() => setState('idle'), 1800)
    } catch (err) {
      setError((err as Error).message)
      setState('idle')
    }
  }

  const toggle = (on: boolean, set: (v: boolean) => void, label: string) => (
    <button
      type="button"
      onClick={() => set(!on)}
      aria-pressed={on}
      className={`min-h-11 flex-1 rounded-xl border text-sm font-semibold transition ${on ? 'border-accent bg-accent/20 text-white' : 'border-line bg-white/[0.04] text-white/50'}`}
    >
      {label}
    </button>
  )

  return (
    <BottomSheet open={open} onClose={onClose} title="📢 觀眾導引廣播" subtitle={`單向發送 · 觀眾端無法回話 · ${online} 台觀眾在線`}>
      {!admin && <p className="rounded-lg bg-standby/10 px-3 py-2 text-xs text-standby">只有管理員可以對觀眾廣播。</p>}
      <div>
        <div className="mb-2 text-[11px] font-semibold tracking-widest text-white/50 uppercase">發送對象</div>
        <div className="flex flex-wrap gap-2">
          {targets.map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => {
                navigator.vibrate?.(10)
                setChannel(id)
              }}
              className={`min-h-11 rounded-full border px-4 text-sm font-semibold transition ${target === id ? 'text-black' : 'border-white/15 bg-white/[0.05] text-white/75'}`}
              style={target === id ? { background: channelColor(id), borderColor: channelColor(id) } : undefined}
              data-announce-target={id}
            >
              {channelLabel(id)}
            </button>
          ))}
        </div>
        {count === 0 && <p className="mt-1.5 text-xs text-white/40">尚未分組：廣播會送給所有觀眾。</p>}
      </div>

      <div>
        <div className="mb-2 text-[11px] font-semibold tracking-widest text-white/50 uppercase">訊息</div>
        <textarea
          className={`${fieldClass} min-h-24 resize-none`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="例如：請往右側出口移動"
          maxLength={200}
          data-announce-text
        />
        <div className="mt-2 flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {PRESETS.map((p) => (
            <button key={p} type="button" onClick={() => setText(p)} className="min-h-10 shrink-0 rounded-full bg-white/[0.07] px-3 text-xs text-white/70 active:bg-white/15">
              {p}
            </button>
          ))}
        </div>
      </div>

      <div className="flex gap-2">
        {toggle(tone, setTone, '🔔 提示音')}
        {toggle(vibrate, setVibrate, '📳 震動')}
        {toggle(speak, setSpeak, '🗣 朗讀')}
      </div>

      {error && <p className="text-xs text-panic">{error}</p>}
      <button
        type="button"
        disabled={!admin || state === 'sending'}
        onClick={() => void submit()}
        className={`min-h-14 w-full rounded-2xl text-base font-bold transition disabled:opacity-40 ${state === 'sent' ? 'bg-go text-black' : 'bg-accent text-white'}`}
        data-announce-send
      >
        {state === 'sent' ? '✓ 已發送' : state === 'sending' ? '發送中…' : `發送給 ${channelLabel(target)}`}
      </button>
    </BottomSheet>
  )
}
