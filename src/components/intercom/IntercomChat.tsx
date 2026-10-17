import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { intercomChannelLabel, isGroupLike, roleColor, type ChatMessage, type IntercomChannel } from '../../types/intercom'
import { Avatar } from '../hub/Hub'
import type { Intercom } from './intercomContext'

const QUICK_REPLIES = ['收到 Copy', '稍等 Hold', 'Standby 中', '可以 GO', '請重來 Again']
/** How close to the bottom (px) still counts as "following" the conversation. */
const FOLLOW_SLACK = 48

const channelTag = (c: IntercomChannel | undefined) => intercomChannelLabel(c)
const channelClass = (c: IntercomChannel | undefined) => (isGroupLike(c) ? 'bg-go/20 text-go' : c === 'A' ? 'bg-accent/25 text-[#64a8ff]' : c === 'B' ? 'bg-[#bf5af2]/20 text-[#d29bf5]' : 'bg-standby/20 text-standby')
const time = (at: number) => (at ? new Date(at).toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '…')

/**
 * Intercom text chat: history (time, avatar, name, channel, text) for the channels this station
 * hears, and a message box (Enter sends; the IME's Enter only confirms the composition). Sends on
 * the station's current channel. Follows new messages while you're at the bottom; scrolled up,
 * it shows a "new messages" button instead of yanking the view.
 */
export function IntercomChat({
  intercom,
  compact = false,
  quickReplies = !compact,
  onBeforeSend,
}: {
  intercom: Intercom
  compact?: boolean
  quickReplies?: boolean
  /** Runs before sending (e.g. join the intercom first). */
  onBeforeSend?: () => Promise<void>
}) {
  const messages = intercom.visibleMessages
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [unseen, setUnseen] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const lastTop = useRef(0)
  const seen = useRef(messages.length)

  const { markRead } = intercom
  const toBottom = useCallback(
    (smooth: boolean) => {
      const el = listRef.current
      if (!el) return
      el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
      following.current = true
      setUnseen(0)
      markRead()
    },
    [markRead],
  )

  // Start at the latest message.
  useLayoutEffect(() => {
    toBottom(false)
  }, [toBottom])

  useEffect(() => {
    const added = messages.slice(seen.current)
    seen.current = messages.length
    if (added.length === 0) return
    const mine = added.some((m) => m.memberId === intercom.selfId)
    // Seen here (toBottom marks them read), so the 🎧 Intercom badge doesn't count them.
    if (following.current || mine) toBottom(true)
    else setUnseen((n) => n + added.length)
  }, [messages, intercom.selfId, toBottom])

  const send = async (body: string) => {
    const clean = body.trim()
    if (!clean) return
    setError(null)
    setText('')
    try {
      await onBeforeSend?.()
      await intercom.sendMessage(clean)
      following.current = true
    } catch (err) {
      setText(body)
      setError((err as Error).message || '送出失敗')
    }
  }

  const channelLabel = intercomChannelLabel(intercom.channel)

  return (
    <section className="relative flex min-h-0 flex-1 flex-col" data-intercom-chat>
      <div
        ref={listRef}
        onScroll={(e) => {
          // Only the reader scrolling up stops following (not our own smooth scroll catching up).
          const el = e.currentTarget
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_SLACK
          if (atBottom) {
            following.current = true
            setUnseen(0)
          } else if (el.scrollTop < lastTop.current - 2) {
            following.current = false
          }
          lastTop.current = el.scrollTop
        }}
        className={`min-h-0 flex-1 overflow-y-auto ${compact ? 'space-y-1.5 px-1 py-1' : 'space-y-2.5 px-4 py-3'}`}
        data-chat-list
      >
        {messages.length === 0 && <p className={`text-center text-white/30 ${compact ? 'py-3 text-[10px]' : 'py-8 text-xs'}`}>還沒有訊息</p>}
        {messages.map((m) => (
          <Message key={m.id} m={m} mine={m.memberId === intercom.selfId} compact={compact} />
        ))}
      </div>
      {unseen > 0 && (
        <button
          type="button"
          onClick={() => toBottom(true)}
          className={`absolute left-1/2 -translate-x-1/2 rounded-full bg-accent px-3 py-1 font-semibold text-white shadow-lg ${compact ? 'bottom-12 text-[10px]' : 'bottom-28 text-xs'}`}
          data-chat-unseen
        >
          ↓ {unseen} 則新訊息
        </button>
      )}
      <div className={`border-t border-line ${compact ? 'space-y-1 pt-1.5' : 'space-y-2 p-3'}`}>
        {quickReplies && (
          <div className="flex gap-1.5 overflow-x-auto">
            {QUICK_REPLIES.map((q) => (
              <button key={q} type="button" onClick={() => send(q)} className="min-h-8 shrink-0 rounded-full bg-white/[0.06] px-3 text-xs whitespace-nowrap text-white/60 hover:bg-white/10">
                {q}
              </button>
            ))}
          </div>
        )}
        {error && <p className="text-[10px] text-panic">{error}</p>}
        <form
          onSubmit={(e) => {
            e.preventDefault()
            send(text)
          }}
          className="flex gap-1.5"
        >
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends — except the Enter that confirms a Zhuyin / Pinyin composition.
              if (e.key !== 'Enter' || e.shiftKey) return
              if (e.nativeEvent.isComposing || e.keyCode === 229) {
                e.preventDefault()
                return
              }
              e.preventDefault()
              send(text)
            }}
            maxLength={500}
            placeholder={compact ? `訊息（${channelLabel}）` : `傳到 ${channelLabel}… 例如：Q3 燈光慢一點`}
            aria-label="訊息"
            className={`min-w-0 flex-1 rounded-lg border border-white/15 bg-black/40 text-white outline-none focus:border-accent ${compact ? 'h-8 px-2 text-xs' : 'h-11 px-3 text-sm'}`}
            data-chat-input
          />
          <button type="submit" disabled={!text.trim()} className={`shrink-0 rounded-lg bg-accent font-semibold text-white disabled:opacity-40 ${compact ? 'h-8 px-2.5 text-xs' : 'h-11 px-4 text-sm'}`} data-chat-send>
            Send
          </button>
        </form>
      </div>
    </section>
  )
}

function Message({ m, mine, compact }: { m: ChatMessage; mine: boolean; compact: boolean }) {
  return (
    <div className={`flex gap-1.5 ${mine ? 'flex-row-reverse' : ''}`} data-chat-message={m.channel ?? 'all'}>
      <Avatar user={{ name: m.name, photo: m.photo }} size={compact ? 18 : 26} />
      <div className={`flex min-w-0 flex-col ${mine ? 'items-end' : 'items-start'}`}>
        <span className={`mb-0.5 flex flex-wrap items-center gap-1 text-white/40 ${compact ? 'text-[9px]' : 'text-[10px]'}`}>
          <span className="font-semibold text-white/75">{m.name}</span>
          <span style={{ color: roleColor(m.role) }}>{m.role}</span>
          <span className={`rounded px-1 font-bold ${channelClass(m.channel)}`}>{channelTag(m.channel)}</span>
          <span className="font-mono">{time(m.at)}</span>
        </span>
        <span
          className={`max-w-full rounded-2xl leading-snug break-words whitespace-pre-wrap ${compact ? 'px-2 py-1 text-xs' : 'px-3 py-2 text-sm'} ${
            mine ? 'rounded-tr-md bg-accent text-white' : 'rounded-tl-md bg-white/[0.08] text-white/90'
          }`}
        >
          {m.text}
        </span>
      </div>
    </div>
  )
}
