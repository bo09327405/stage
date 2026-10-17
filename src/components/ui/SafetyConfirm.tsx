import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

interface Ask {
  title: string
  /** What will happen to the live audience. */
  detail: ReactNode
  confirmLabel?: string
}

/**
 * "Show safety" confirmation for actions that instantly change what the live audience experiences
 * (regrouping, resetting channels, unlocking switching). A red-warning dialog — a bottom sheet with a
 * blurred backdrop on phones — with Cancel and Confirm; nothing changes until Confirm is pressed.
 *
 *   const [safety, confirm] = useSafetyConfirm()
 *   if (!(await confirm({ title, detail }))) return
 *   …render {safety} once…
 */
export function useSafetyConfirm() {
  const [ask, setAsk] = useState<Ask | null>(null)
  const resolver = useRef<(ok: boolean) => void>(() => {})

  const confirm = useCallback(
    (next: Ask) =>
      new Promise<boolean>((resolve) => {
        resolver.current = resolve
        setAsk(next)
      }),
    [],
  )
  const answer = (ok: boolean) => {
    resolver.current(ok)
    setAsk(null)
  }

  const node = createPortal(
    <AnimatePresence>
      {ask && (
        <>
          <motion.div
            key="safety-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => answer(false)}
            className="fixed inset-0 z-[200] bg-black/70 backdrop-blur-md"
            data-safety-backdrop
          />
          <motion.div
            key="safety-sheet"
            role="alertdialog"
            aria-modal="true"
            aria-label={ask.title}
            initial={{ y: 80, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 80, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 420, damping: 38 }}
            className="fixed inset-x-0 bottom-0 z-[201] mx-auto w-full max-w-md rounded-t-3xl border border-b-0 border-panic/50 bg-[#1b1011] p-5 pb-[max(1.25rem,env(safe-area-inset-bottom,0px))] shadow-[0_-20px_60px_-20px_rgba(255,69,58,0.55)] sm:inset-auto sm:top-1/2 sm:left-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-3xl sm:border-b"
            data-safety-dialog
          >
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-white/20 sm:hidden" />
            <div className="flex items-start gap-3">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-panic/20 text-2xl">⚠️</span>
              <div className="min-w-0">
                <div className="text-[11px] font-bold tracking-widest text-panic uppercase">演出安全警告</div>
                <h2 className="text-lg font-bold text-white">{ask.title}</h2>
              </div>
            </div>
            <div className="mt-3 text-sm leading-relaxed text-white/75">{ask.detail}</div>
            <p className="mt-3 rounded-lg bg-panic/10 px-3 py-2 text-xs font-semibold text-panic">此操作會即時影響現場觀眾的手機，請確認後再執行。</p>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <button
                type="button"
                autoFocus
                onClick={() => answer(false)}
                className="min-h-14 rounded-2xl bg-white/10 text-base font-semibold text-white active:bg-white/20"
                data-safety-cancel
              >
                取消 (Cancel)
              </button>
              <button
                type="button"
                onClick={() => answer(true)}
                className="min-h-14 rounded-2xl bg-panic text-base font-bold text-white shadow-[0_0_30px_-8px_rgba(255,69,58,0.9)] active:brightness-90"
                data-safety-confirm
              >
                {ask.confirmLabel ?? '確認變更 (Confirm)'}
              </button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>,
    document.body,
  )

  return [node, confirm] as const
}
