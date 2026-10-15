import { AnimatePresence, motion } from 'motion/react'
import { useState, type ReactNode } from 'react'

interface ConfirmDialogProps {
  open: boolean
  title: string
  children?: ReactNode
  confirmLabel?: string
  /** Red confirm button for destructive actions. */
  danger?: boolean
  onConfirm: () => Promise<unknown> | void
  onClose: () => void
}

/** Modal confirmation that waits for an async action and shows its error instead of closing. */
export function ConfirmDialog({ open, title, children, confirmLabel = '確定', danger, onConfirm, onClose }: ConfirmDialogProps) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        >
          <motion.div
            initial={{ scale: 0.95, y: 10 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.95, y: 10 }}
            transition={{ type: 'spring', stiffness: 500, damping: 35 }}
            onClick={(e) => e.stopPropagation()}
            role="alertdialog"
            aria-modal="true"
            className="w-full max-w-md rounded-2xl border border-line bg-panel p-6 shadow-2xl"
          >
            <ConfirmBody title={title} confirmLabel={confirmLabel} danger={danger} onConfirm={onConfirm} onClose={onClose}>
              {children}
            </ConfirmBody>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function ConfirmBody({ title, children, confirmLabel, danger, onConfirm, onClose }: Omit<ConfirmDialogProps, 'open'>) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function confirm() {
    setBusy(true)
    setError(null)
    try {
      await onConfirm()
      onClose()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">{title}</h2>
      {children && <div className="text-sm leading-relaxed text-white/60">{children}</div>}
      {error && <p className="rounded-lg bg-panic/15 px-3 py-2 text-xs text-panic">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} disabled={busy} className="min-h-11 rounded-lg px-4 text-sm text-white/60 hover:bg-white/10">
          取消
        </button>
        <button
          type="button"
          onClick={confirm}
          disabled={busy}
          autoFocus={!danger}
          className={`min-h-11 rounded-lg px-5 text-sm font-semibold text-white disabled:opacity-40 ${danger ? 'bg-panic' : 'bg-accent'}`}
        >
          {busy ? '處理中…' : confirmLabel}
        </button>
      </div>
    </div>
  )
}
