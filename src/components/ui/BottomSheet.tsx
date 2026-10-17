import { AnimatePresence, motion } from 'motion/react'
import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * Modal panel: slides up from the bottom on phones (with a blurred dark backdrop), centred card on
 * larger screens. Tapping the backdrop or pressing Esc closes it.
 */
export function BottomSheet({ open, onClose, title, subtitle, children }: { open: boolean; onClose: () => void; title: string; subtitle?: string; children: ReactNode }) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return
      e.stopImmediatePropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  return createPortal(
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="sheet-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 z-[110] bg-black/60 backdrop-blur-sm"
          />
          <motion.div
            key="sheet"
            role="dialog"
            aria-modal="true"
            aria-label={title}
            initial={{ y: 80, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 80, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 420, damping: 38 }}
            className="fixed inset-x-0 bottom-0 z-[111] mx-auto flex max-h-[92dvh] w-full max-w-lg flex-col rounded-t-3xl border border-b-0 border-line bg-panel text-white shadow-2xl sm:inset-auto sm:top-1/2 sm:left-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-3xl sm:border-b"
          >
            <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-white/20 sm:hidden" />
            <header className="flex shrink-0 items-center justify-between px-5 pt-3 pb-2">
              <div>
                <h2 className="text-lg font-bold">{title}</h2>
                {subtitle && <p className="text-xs text-white/45">{subtitle}</p>}
              </div>
              <button onClick={onClose} aria-label="關閉" className="flex h-11 w-11 items-center justify-center rounded-lg text-white/45 hover:bg-white/10 hover:text-white">
                ✕
              </button>
            </header>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 pb-[max(1.25rem,env(safe-area-inset-bottom,0px))]">{children}</div>
          </motion.div>
        </>
      )}
    </AnimatePresence>,
    document.body,
  )
}
