import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import type { useIntercom } from '../../hooks/useIntercom'
import { INTERCOM_ROLES, roleColor, type IntercomMember, type IntercomRole } from '../../types/intercom'
import { Segmented, fieldClass } from '../ui/controls'
import { ChannelPicker } from './MiniIntercom'
import { IntercomChat } from './IntercomChat'

type Intercom = ReturnType<typeof useIntercom>

/**
 * Side drawer: join form, CALL, voice controls, crew list and chat. Rendered into <body> above
 * everything else on the page (top bars, side panels, header pop-ups), over a dimmed backdrop.
 */
/** Phones get a bottom sheet instead of a side drawer. */
const phone = () => typeof window !== 'undefined' && window.matchMedia('(max-width: 639px)').matches

export function IntercomPanel({ intercom, onClose }: { intercom: Intercom; onClose: () => void }) {
  const { markRead } = intercom
  // Reading the drawer clears the unread badge, including messages that arrive while it's open.
  useEffect(() => {
    markRead()
  }, [markRead, intercom.messages.length])

  // Esc closes the drawer only; it must not also reach the console's "Fade All".
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return
      e.stopImmediatePropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return createPortal(
    <>
      <motion.div
        key="intercom-backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.18 }}
        onClick={onClose}
        className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm"
        data-intercom-backdrop
      />
      <motion.aside
        key="intercom-panel"
        initial={phone() ? { y: 60, opacity: 0 } : { x: 40, opacity: 0 }}
        animate={{ x: 0, y: 0, opacity: 1 }}
        exit={phone() ? { y: 60, opacity: 0 } : { x: 40, opacity: 0 }}
        transition={{ duration: 0.18 }}
        data-safe-fixed className="fixed inset-y-0 right-0 z-[101] flex w-full max-w-md flex-col border-l border-line max-sm:inset-x-0 max-sm:top-auto max-sm:bottom-0 max-sm:h-[88dvh] max-sm:max-w-none max-sm:rounded-t-2xl max-sm:border-t max-sm:border-l-0 bg-panel text-white shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-label="Intercom"
        data-intercom-panel
      >
        <header className="flex items-center justify-between border-b border-line px-5 py-3">
          <div>
            <div className="text-[11px] font-semibold tracking-widest text-white/40 uppercase">Intercom</div>
            <div className="text-lg font-semibold">
              🎧 通訊頻道 <span className="ml-1 text-sm font-normal text-white/40">{intercom.members.length} 人在線</span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="flex h-11 w-11 items-center justify-center rounded-lg text-white/40 hover:bg-white/10 hover:text-white"
            aria-label="關閉"
          >
            ✕
          </button>
        </header>

        {!intercom.joined ? <JoinForm intercom={intercom} /> : <JoinedBody intercom={intercom} />}
      </motion.aside>
    </>,
    document.body,
  )
}

function JoinForm({ intercom }: { intercom: Intercom }) {
  const [name, setName] = useState(intercom.identity?.name ?? '')
  const [role, setRole] = useState<IntercomRole>(intercom.identity?.role ?? 'Sound')
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    try {
      await intercom.join({ name, role })
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-5 overflow-y-auto p-5">
      <p className="text-sm text-white/50">加入此專案的通訊頻道，與其他崗位即時文字、CALL 與語音對講。</p>
      <label className="block">
        <span className="mb-1.5 block text-[11px] font-medium tracking-wide text-white/50 uppercase">名字</span>
        <input className={fieldClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：小明" autoFocus />
      </label>
      <div>
        <span className="mb-1.5 block text-[11px] font-medium tracking-wide text-white/50 uppercase">崗位</span>
        <div className="grid grid-cols-2 gap-1.5">
          {INTERCOM_ROLES.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => setRole(r.id)}
              className={`flex min-h-11 items-center gap-2 rounded-lg border px-3 text-sm transition ${
                role === r.id ? 'border-white/60 bg-white/10 text-white' : 'border-line bg-black/30 text-white/55'
              }`}
            >
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: r.color }} />
              {r.label}
            </button>
          ))}
        </div>
      </div>
      {error && <p className="text-xs text-panic">{error}</p>}
      <button type="submit" className="min-h-12 w-full rounded-xl bg-accent text-sm font-semibold text-white">
        加入頻道
      </button>
    </form>
  )
}

function JoinedBody({ intercom }: { intercom: Intercom }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-3 border-b border-line p-4">
        <motion.button
          whileTap={{ scale: 0.97 }}
          onClick={() => intercom.call('*')}
          className="flex min-h-16 w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-b from-[#ff6a5f] to-[#e0362c] text-xl font-extrabold tracking-[0.2em] text-white shadow-[0_0_40px_-10px_rgba(255,69,58,0.8)]"
        >
          📣 CALL
          <span className="text-xs font-semibold tracking-normal opacity-80">呼叫全體</span>
        </motion.button>
        <ChannelPicker intercom={intercom} />
        <VoiceControls intercom={intercom} />
      </div>

      <MemberList intercom={intercom} />
      <IntercomChat intercom={intercom} />

      <footer className="flex items-center justify-between border-t border-line px-4 py-2 text-[11px] text-white/35">
        <span>
          以 <span className="text-white/70">{intercom.identity?.name}</span>（{intercom.identity?.role}）加入
        </span>
        <button onClick={() => intercom.leave()} className="rounded px-2 py-1 hover:bg-white/10 hover:text-white">
          離開頻道
        </button>
      </footer>
    </div>
  )
}

function VoiceControls({ intercom }: { intercom: Intercom }) {
  const { voice } = intercom
  const [starting, setStarting] = useState(false)

  if (!voice.on) {
    return (
      <button
        onClick={async () => {
          setStarting(true)
          await voice.enable()
          setStarting(false)
        }}
        disabled={starting}
        className="min-h-12 w-full rounded-xl bg-go/15 text-sm font-semibold text-go hover:bg-go/25 disabled:opacity-50"
      >
        {starting ? '開啟麥克風中…' : '🎙 加入語音對講'}
      </button>
    )
  }

  return (
    <div className="space-y-2.5">
      {voice.error && <p className="rounded-lg bg-standby/10 px-3 py-2 text-xs leading-relaxed text-standby">{voice.error}</p>}
      {voice.hasMic && (
        <Segmented<'ptt' | 'open'>
          columns={2}
          value={voice.micMode}
          onChange={(m) => {
            voice.setMicMode(m)
            voice.setPttHeld(false)
          }}
          options={[
            { id: 'ptt', label: 'Push-to-Talk', description: '按住說話 · 鍵盤 T' },
            { id: 'open', label: '持續開麥', description: '用 Mute 切換 · 按住 T 也可暫時發話' },
          ]}
        />
      )}
      <div className="flex gap-2">
        {voice.hasMic &&
          (voice.micMode === 'ptt' ? (
            <button
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId)
                voice.setPttHeld(true)
              }}
              onPointerUp={() => voice.setPttHeld(false)}
              onPointerCancel={() => voice.setPttHeld(false)}
              className={`min-h-14 flex-1 touch-none rounded-xl text-sm font-bold tracking-wider transition select-none ${
                voice.pttHeld ? 'bg-go text-black shadow-[0_0_30px_-6px_#30d158]' : 'bg-white/[0.08] text-white/80'
              }`}
            >
              {voice.pttHeld ? '● 說話中…' : '🎙 按住說話'}
            </button>
          ) : (
            <button
              onClick={() => voice.setMuted(!voice.muted)}
              className={`min-h-14 flex-1 rounded-xl text-sm font-bold tracking-wider transition ${
                voice.muted ? 'bg-panic/90 text-white' : 'bg-go text-black shadow-[0_0_30px_-6px_#30d158]'
              }`}
            >
              {voice.muted ? '🔇 已靜音 · 點擊開麥' : '🎙 開麥中 · 點擊靜音'}
            </button>
          ))}
        <button
          onClick={voice.disable}
          className="min-h-14 shrink-0 rounded-xl bg-white/[0.06] px-4 text-xs text-white/60 hover:bg-white/10"
        >
          離開語音
        </button>
      </div>
    </div>
  )
}

function MemberList({ intercom }: { intercom: Intercom }) {
  const { voice } = intercom
  return (
    <section className="max-h-[32%] shrink-0 overflow-y-auto border-b border-line px-4 py-3">
      <h3 className="mb-2 text-[11px] font-semibold tracking-wider text-white/40 uppercase">在線成員</h3>
      <ul className="space-y-1.5">
        {intercom.members.map((m) => (
          <MemberRow
            key={m.id}
            member={m}
            self={m.id === intercom.selfId}
            speaking={voice.speaking.has(m.id)}
            peerState={voice.peerStates[m.id]}
            onCall={() => intercom.call(m.id)}
          />
        ))}
      </ul>
    </section>
  )
}

function MemberRow({
  member,
  self,
  speaking,
  peerState,
  onCall,
}: {
  member: IntercomMember
  self: boolean
  speaking: boolean
  peerState?: RTCPeerConnectionState
  onCall: () => void
}) {
  const color = roleColor(member.role)
  const mic = !member.voice ? '—' : member.muted ? '🔇' : '🎙'
  const linkLabel =
    self || !member.voice
      ? null
      : peerState === 'connected'
        ? { text: '語音連線', tone: 'text-go' }
        : peerState === 'failed'
          ? { text: '連線失敗', tone: 'text-panic' }
          : peerState
            ? { text: '連線中…', tone: 'text-standby' }
            : null
  return (
    <li className="flex min-h-11 items-center gap-3 rounded-lg bg-white/[0.03] px-3">
      <span
        className={`relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-black transition ${
          speaking ? 'ring-2 ring-go ring-offset-2 ring-offset-panel' : ''
        }`}
        style={{ background: color }}
      >
        {member.role.slice(0, 3)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">
          {member.name}
          {self && <span className="ml-1.5 text-[10px] text-white/35">（你）</span>}
        </div>
        <div className="flex gap-2 text-[10px] text-white/35">
          <span>{member.voice ? (member.micMode === 'ptt' ? 'PTT' : '開麥模式') : '僅文字'}</span>
          {linkLabel && <span className={linkLabel.tone}>{linkLabel.text}</span>}
        </div>
      </div>
      <span className="text-sm" title={member.voice ? (member.muted ? '靜音' : '麥克風開啟') : '未加入語音'}>
        {mic}
      </span>
      {!self && (
        <button
          onClick={onCall}
          className="min-h-9 rounded-lg px-2.5 text-xs text-white/50 hover:bg-panic/20 hover:text-panic"
          title={`只呼叫 ${member.name}`}
        >
          📣
        </button>
      )}
    </li>
  )
}

/** Full-screen flashing frame + banner when someone presses CALL (shown even with the drawer closed). */
export function CallFlash({ intercom }: { intercom: Intercom }) {
  const alert = intercom.alert
  return (
    <AnimatePresence>
      {alert && (
        <>
          <motion.div
            key={`frame-${alert.call.seq}`}
            className="pointer-events-none fixed inset-0 z-[110] border-[10px]"
            style={{ borderColor: roleColor(alert.call.role) }}
            initial={{ opacity: 0 }}
            animate={{ opacity: [0, 1, 0.2, 1, 0.2, 1, 0] }}
            exit={{ opacity: 0 }}
            transition={{ duration: 3.6, times: [0, 0.08, 0.25, 0.4, 0.55, 0.7, 1] }}
          />
          <motion.button
            key={`banner-${alert.call.seq}`}
            onClick={intercom.dismissAlert}
            initial={{ y: -80, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -80, opacity: 0 }}
            className="fixed top-4 left-1/2 z-[111] -translate-x-1/2 rounded-2xl px-6 py-3 text-lg font-bold text-black shadow-2xl"
            style={{ background: roleColor(alert.call.role) }}
          >
            📣 {alert.call.role} {alert.call.name} {alert.direct ? '呼叫你' : '呼叫全體'}
          </motion.button>
        </>
      )}
    </AnimatePresence>
  )
}

/** Header button: unread chat count and a live-mic dot. */
export function IntercomButton({ intercom, onClick }: { intercom: Intercom; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="relative flex min-h-10 items-center gap-1.5 rounded-lg bg-white/[0.06] px-3 text-xs text-white/70 hover:bg-white/10 hover:text-white"
      title="Intercom 通訊"
    >
      🎧 Intercom
      {intercom.voice.on && (
        <span className={`h-2 w-2 rounded-full ${intercom.voice.micLive ? 'bg-go shadow-[0_0_6px_#30d158]' : 'bg-white/30'}`} />
      )}
      {intercom.unread > 0 && (
        <span className="absolute -top-1.5 -right-1.5 min-w-5 rounded-full bg-panic px-1.5 text-center text-[10px] leading-5 font-bold text-white">
          {intercom.unread}
        </span>
      )}
    </button>
  )
}
