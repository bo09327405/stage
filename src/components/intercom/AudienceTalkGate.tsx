import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'
import { createPortal } from 'react-dom'
import type { useIntercom } from '../../hooks/useIntercom'
import { intercomChannelLabel } from '../../types/intercom'

type Intercom = ReturnType<typeof useIntercom>

/**
 * Warning before the first words to the audience. Pressing TALK on a group channel whose target is the
 * audience doesn't open the mic until this is answered: Cancel, "fix the target" (back to crew), or
 * Confirm — optionally with "don't ask again for 30 minutes". A bottom sheet on phones.
 */
export function AudienceTalkGate({ intercom }: { intercom: Intercom }) {
  const gate = intercom.talkGate
  const [snooze, setSnooze] = useState(false)
  const label = intercomChannelLabel(gate.channel)

  return createPortal(
    <AnimatePresence>
      {gate.open && (
        <>
          <motion.div
            key="talk-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={gate.cancel}
            className="fixed inset-0 z-[210] bg-black/70 backdrop-blur-md"
          />
          <motion.div
            key="talk-sheet"
            role="alertdialog"
            aria-modal="true"
            aria-label="對觀眾發話警告"
            initial={{ y: 80, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 80, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 420, damping: 38 }}
            className="fixed inset-x-0 bottom-0 z-[211] mx-auto w-full max-w-md rounded-t-3xl border border-b-0 border-standby/60 bg-[#1b1708] p-5 pb-[max(1.25rem,env(safe-area-inset-bottom,0px))] shadow-[0_-20px_60px_-20px_rgba(255,214,10,0.45)] sm:inset-auto sm:top-1/2 sm:left-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-3xl sm:border-b"
            data-talk-gate
          >
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-white/20 sm:hidden" />
            <div className="flex items-start gap-3">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-standby/20 text-2xl">📣</span>
              <div className="min-w-0">
                <div className="text-[11px] font-bold tracking-widest text-standby uppercase">對觀眾發話警告</div>
                <h2 className="text-lg font-bold text-white">要對{gate.channel === 'channel_all' ? '全部組別' : ` ${label} `}的觀眾說話嗎？</h2>
              </div>
            </div>
            <p className="mt-3 text-sm leading-relaxed text-white/75">
              目前「{label}」的發話對象是<b className="text-white">觀眾</b>{gate.channel === 'channel_all' ? '（所有組別）' : ''}。你按住說話時，<b className="text-white">{intercom.audienceInGroup} 台</b>觀眾手機會即時聽到你的聲音（觀眾無法回話，演出人員也聽不到）。
              {intercom.audienceInGroup === 0 && ' 目前這一組還沒有觀眾在線。'}
            </p>
            <label className="mt-3 flex min-h-11 cursor-pointer items-center gap-3 rounded-xl bg-white/[0.05] px-3 text-sm text-white/80">
              <input type="checkbox" checked={snooze} onChange={(e) => setSnooze(e.target.checked)} className="h-5 w-5 accent-[#ffd60a]" data-talk-snooze />
              {gate.snoozeMinutes} 分鐘內不再提示
            </label>
            <div className="mt-4 grid gap-2">
              <button
                type="button"
                onClick={() => {
                  gate.confirm(snooze)
                  setSnooze(false)
                }}
                className="min-h-14 rounded-2xl bg-standby text-base font-bold text-black active:brightness-90"
                data-talk-confirm
              >
                確認對觀眾發話
              </button>
              <button
                type="button"
                onClick={() => {
                  gate.fixTarget()
                  setSnooze(false)
                }}
                className="min-h-12 rounded-2xl bg-accent/20 text-sm font-semibold text-[#64a8ff] active:bg-accent/30"
                data-talk-fix
              >
                ✎ 修正發話對象（改為演出人員）
              </button>
              <button type="button" onClick={gate.cancel} className="min-h-12 rounded-2xl bg-white/10 text-sm font-semibold text-white active:bg-white/20" data-talk-cancel>
                取消
              </button>
            </div>
            <p className="mt-3 text-center text-[11px] text-white/40">確認後，請再按住說話鍵（T 或畫面上的 TALK）開始說話。</p>
          </motion.div>
        </>
      )}
    </AnimatePresence>,
    document.body,
  )
}
