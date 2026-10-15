import { AnimatePresence, motion } from 'motion/react'
import { useInputMonitor } from '../../services/inputBus'
import type { InputEvent } from '../../types/trigger'

/**
 * A status dot that flashes every time a signal arrives (any source, or only MIDI / OSC), so the
 * operator can see during rehearsal that hardware is actually reaching the system.
 */
export function ActivityDot({
  source,
  connected,
  error,
}: {
  source?: InputEvent['source']
  /** Steady state when idle: green = input available, red = problem, grey = off. */
  connected: boolean
  error?: boolean
}) {
  const { events } = useInputMonitor()
  const last = events.find((e) => !source || e.source === source)

  return (
    <span className="relative inline-flex h-2.5 w-2.5 shrink-0">
      <span
        className={`h-2.5 w-2.5 rounded-full ${connected ? 'bg-go shadow-[0_0_6px_#30d158]' : error ? 'bg-panic' : 'bg-white/25'}`}
      />
      <AnimatePresence>
        {last && (
          <motion.span
            key={last.at + (last.source === 'midi' ? `${last.channel}:${last.number}:${last.value}` : last.address)}
            className="absolute -inset-1 rounded-full bg-white"
            initial={{ opacity: 0.95, scale: 0.6 }}
            animate={{ opacity: 0, scale: 1.8 }}
            transition={{ duration: 0.45 }}
          />
        )}
      </AnimatePresence>
    </span>
  )
}

/** The latest signal of a source as text, flashing on arrival (for the Triggers panel rows). */
export function LastSignal({ source }: { source: InputEvent['source'] }) {
  const { events } = useInputMonitor()
  const last = events.find((e) => e.source === source)
  if (!last) return <span className="text-white/30">尚未收到</span>
  const text =
    last.source === 'midi'
      ? `${{ noteOn: 'Note On', noteOff: 'Note Off', cc: 'CC' }[last.message]} ch${last.channel} #${last.number} = ${last.value}`
      : `${last.address} ${last.args.map((a) => String(a.value)).join(' ')}`
  return (
    <motion.span
      key={last.at + text}
      initial={{ backgroundColor: 'rgba(48,209,88,0.45)' }}
      animate={{ backgroundColor: 'rgba(48,209,88,0)' }}
      transition={{ duration: 0.8 }}
      className="truncate rounded px-1 font-mono text-[11px] text-white/80"
    >
      {text}
    </motion.span>
  )
}
