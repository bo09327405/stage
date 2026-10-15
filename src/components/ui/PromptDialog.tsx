import { AnimatePresence, motion } from 'motion/react'
import { useState, type FormEvent } from 'react'
import { fieldClass } from './controls'

interface PromptDialogProps {
  open: boolean
  title: string
  description?: string
  initialValue?: string
  placeholder?: string
  confirmLabel?: string
  onConfirm: (value: string) => Promise<unknown> | void
  onClose: () => void
}

/** Modal text prompt (name a project, name a saved version). */
export function PromptDialog(props: PromptDialogProps) {
  return (
    <AnimatePresence>
      {props.open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={props.onClose}
        >
          <motion.div
            initial={{ scale: 0.95, y: 10 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.95, y: 10 }}
            transition={{ type: 'spring', stiffness: 500, damping: 35 }}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-2xl border border-line bg-panel p-6 shadow-2xl"
          >
            <PromptBody {...props} />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function PromptBody({ title, description, initialValue = '', placeholder, confirmLabel = '確定', onConfirm, onClose }: PromptDialogProps) {
  const [value, setValue] = useState(initialValue)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!value.trim()) return setError('請輸入名稱')
    setBusy(true)
    try {
      await onConfirm(value.trim())
      onClose()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">{title}</h2>
        {description && <p className="mt-1 text-sm text-white/45">{description}</p>}
      </div>
      <input className={fieldClass} value={value} placeholder={placeholder} onChange={(e) => setValue(e.target.value)} autoFocus />
      {error && <p className="text-xs text-panic">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className="min-h-11 rounded-lg px-4 text-sm text-white/60 hover:bg-white/10">
          取消
        </button>
        <button
          type="submit"
          disabled={busy}
          className="min-h-11 rounded-lg bg-accent px-5 text-sm font-semibold text-white disabled:opacity-40"
        >
          {busy ? '處理中…' : confirmLabel}
        </button>
      </div>
    </form>
  )
}
