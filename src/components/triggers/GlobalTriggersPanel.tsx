import { AnimatePresence, motion } from 'motion/react'
import type { useTriggerRouter } from '../../hooks/useTriggerRouter'
import { useInputMonitor } from '../../services/inputBus'
import { useMidi } from '../../services/midi'
import { oscBridge, useOscBridge } from '../../services/oscBridge'
import { addGlobalTrigger, addGlobalTriggerFull } from '../../services/triggers'
import type { ShowAction } from '../../types/actions'
import { defaultMatch, type TriggerMatch } from '../../types/trigger'
import { ActivityDot, LastSignal } from './ActivityDot'
import { TriggerRuleList } from './TriggerRuleList'

type Router = ReturnType<typeof useTriggerRouter>

/** A sensible starting profile, in the spirit of Go Button's defaults. */
const STANDARD_PROFILE: { match: TriggerMatch; action: ShowAction }[] = [
  { match: { source: 'osc', address: '/sys/go' }, action: 'go' },
  { match: { source: 'osc', address: '/sys/pause' }, action: 'pauseResumeShow' },
  { match: { source: 'osc', address: '/sys/panic' }, action: 'panicShow' },
  { match: { source: 'osc', address: '/sys/next' }, action: 'selectNext' },
  { match: { source: 'osc', address: '/sys/prev' }, action: 'selectPrev' },
  { match: { source: 'midi', message: 'noteOn', channel: 0, number: 60 }, action: 'go' },
  { match: { source: 'midi', message: 'noteOn', channel: 0, number: 61 }, action: 'pauseResumeShow' },
  { match: { source: 'midi', message: 'noteOn', channel: 0, number: 62 }, action: 'panicShow' },
]

/**
 * Per signal: whether this tab acted on it, what fired (with caveats such as "GO only selected
 * Q1"), and why each rule of the same kind didn't match. Mirrors the [Trigger] console groups.
 */
function DispatchLog({ router }: { router: Router }) {
  if (router.dispatches.length === 0) {
    return <p className="rounded-lg bg-black/30 p-3 text-xs text-white/30">尚未收到任何訊號。操作 MIDI 控制器或傳送 OSC 試試看。</p>
  }
  return (
    <ul className="space-y-1.5">
      <AnimatePresence initial={false}>
        {router.dispatches.map((d) => (
          <motion.li
            key={d.at + d.event}
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            className={`rounded-lg border px-2.5 py-2 text-[11px] ${
              d.fired.length > 0 ? 'border-go/40 bg-go/[0.07]' : d.executed ? 'border-line bg-black/30' : 'border-line bg-black/20 opacity-70'
            }`}
          >
            <div className="flex items-center justify-between gap-2 font-mono text-white/80">
              <span className="truncate">{d.event}</span>
              <span className={`shrink-0 ${d.fired.length ? 'text-go' : 'text-white/35'}`}>
                {!d.executed ? '略過' : d.fired.length ? `✓ ${d.fired.length}` : '無符合'}
              </span>
            </div>
            {d.skipped && <div className="mt-1 text-white/40">{d.skipped}</div>}
            {d.fired.map((f) => (
              <div key={f.text} className="mt-1 text-go">
                ⚡ {f.text}
                {f.note && <span className="block pl-4 text-standby">⚠ {f.note}</span>}
              </div>
            ))}
            {d.fired.length === 0 &&
              d.misses.slice(0, 3).map((m) => (
                <div key={m} className="mt-1 text-white/40">
                  ✕ {m}
                </div>
              ))}
          </motion.li>
        ))}
      </AnimatePresence>
    </ul>
  )
}

/** "Global Triggers": the project's external signal → show action profile, plus input status. */
export function GlobalTriggersPanel({ projectId, router, onClose }: { projectId: string; router: Router; onClose: () => void }) {
  const bridge = useOscBridge()
  const midiState = useMidi()
  const { isLearning } = useInputMonitor()

  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 backdrop-blur-sm sm:p-6"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.97, y: 12 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.97, y: 12 }}
        transition={{ type: 'spring', stiffness: 450, damping: 35 }}
        onClick={(e) => e.stopPropagation()}
        className="flex h-full max-h-[900px] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-line bg-panel/95 shadow-2xl backdrop-blur-2xl"
      >
        <header className="flex items-center justify-between border-b border-line px-6 py-4">
          <div>
            <div className="text-[11px] font-semibold tracking-widest text-white/40 uppercase">Show Control Logic</div>
            <h2 className="text-lg font-semibold">⚡ Global Triggers · 外部觸發設定</h2>
          </div>
          <button
            onClick={onClose}
            className="flex h-11 w-11 items-center justify-center rounded-lg text-white/40 hover:bg-white/10 hover:text-white"
            aria-label="關閉"
          >
            ✕
          </button>
        </header>

        <div className="grid min-h-0 flex-1 lg:grid-cols-[320px_1fr]">
          {/* Left: status + monitor */}
          <aside className="space-y-5 overflow-y-auto border-b border-line p-5 lg:border-r lg:border-b-0">
            <section
              className={`rounded-xl border p-4 ${router.isHost ? 'border-go/40 bg-go/[0.07]' : 'border-standby/40 bg-standby/[0.07]'}`}
            >
              <div className={`text-sm font-semibold ${router.isHost ? 'text-go' : 'text-standby'}`}>
                {router.isHost ? '● 此分頁負責執行外部觸發' : '○ 由其他分頁執行外部觸發'}
              </div>
              <p className="mt-1 text-xs text-white/45">
                {router.isHost
                  ? '同一個演出版本只會有一個分頁執行觸發，避免重複 GO。'
                  : `目前由「${router.host?.label ?? '—'}」處理。此分頁收到的訊號只會顯示，不會執行。`}
              </p>
              {!router.isHost && (
                <button onClick={router.takeOver} className="mt-3 min-h-10 w-full rounded-lg bg-standby text-sm font-semibold text-black">
                  改由此分頁執行
                </button>
              )}
            </section>

            <section className="space-y-2">
              <h3 className="text-xs font-semibold tracking-wider text-white/60">輸入來源</h3>
              <div className="space-y-1 rounded-lg bg-black/30 px-3 py-2.5 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2">
                    <ActivityDot source="osc" connected={bridge.status === 'connected'} error={bridge.status === 'error'} /> 📡 OSC Bridge
                  </span>
                  {bridge.status === 'connected' ? (
                    <span className="text-go">{bridge.listenPort ? `接收 UDP ${bridge.listenPort}` : '未監聽'}</span>
                  ) : (
                    <button onClick={() => oscBridge.connect()} className="rounded-md bg-white/10 px-2 py-1 text-white/70">
                      {bridge.status === 'connecting' ? '連線中…' : '連線'}
                    </button>
                  )}
                </div>
                <div className="flex justify-end">
                  <LastSignal source="osc" />
                </div>
              </div>
              <div className="space-y-1 rounded-lg bg-black/30 px-3 py-2.5 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2">
                    <ActivityDot
                      source="midi"
                      connected={midiState.status === 'ready' && midiState.inputs.length > 0}
                      error={midiState.status === 'denied'}
                    />{' '}
                    🎹 MIDI Input
                  </span>
                  {midiState.status === 'ready' ? (
                    <span className="truncate text-go">
                      {midiState.inputs.length > 0 ? midiState.inputs.map((i) => i.name).join('、') : '無輸入裝置'}
                    </span>
                  ) : midiState.status === 'unsupported' ? (
                    <span className="text-white/35">瀏覽器不支援</span>
                  ) : (
                    <button onClick={midiState.connect} className="rounded-md bg-white/10 px-2 py-1 text-white/70">
                      啟用
                    </button>
                  )}
                </div>
                <div className="flex justify-end">
                  <LastSignal source="midi" />
                </div>
              </div>
              {!router.isHost && (
                <p className="rounded-lg bg-white/[0.04] px-3 py-2 text-[11px] text-white/45">
                  {router.hostOnThisMachine
                    ? 'MIDI：由這台電腦上的觸發主機分頁執行。'
                    : router.localLeader
                      ? 'MIDI：觸發主機在另一台電腦，接在這台電腦的 MIDI 由此分頁執行。'
                      : 'MIDI：由這台電腦的另一個分頁執行。'}
                </p>
              )}
              <p className="text-[11px] leading-relaxed text-white/35">
                外部設備（TouchOSC、QLab、燈控台）把 OSC 送到執行 <code className="rounded bg-white/10 px-1">npm run osc</code>{' '}
                的電腦，port {bridge.listenPort || 8000}。
              </p>
            </section>

            <section className="space-y-2">
              <div className="flex items-baseline justify-between">
                <h3 className="text-xs font-semibold tracking-wider text-white/60">觸發判定 · 即時監看</h3>
                {isLearning && <span className="animate-pulse text-[11px] text-standby">Learn 等待中…</span>}
              </div>
              <DispatchLog router={router} />
            </section>
          </aside>

          {/* Right: profile */}
          <main className="min-h-0 space-y-3 overflow-y-auto p-5">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="mr-auto text-xs font-semibold tracking-wider text-white/60">
                Global Profile · {router.globalTriggers.length} 條規則
              </h3>
              {router.globalTriggers.length === 0 && (
                <button
                  onClick={() =>
                    Promise.all(STANDARD_PROFILE.map((p) => addGlobalTriggerFull(projectId, { enabled: true, ...p }))).catch(() => {})
                  }
                  className="min-h-10 rounded-lg bg-standby/15 px-3 text-xs font-semibold text-standby"
                >
                  套用標準 Profile
                </button>
              )}
              <button
                onClick={() => addGlobalTrigger(projectId, defaultMatch('midi')).catch(() => {})}
                className="min-h-10 rounded-lg bg-white/[0.07] px-3 text-xs text-white/80 hover:bg-white/15"
              >
                ＋ MIDI 規則
              </button>
              <button
                onClick={() => addGlobalTrigger(projectId, defaultMatch('osc')).catch(() => {})}
                className="min-h-10 rounded-lg bg-white/[0.07] px-3 text-xs text-white/80 hover:bg-white/15"
              >
                ＋ OSC 規則
              </button>
            </div>

            {router.globalTriggers.length === 0 && (
              <p className="rounded-xl border border-dashed border-white/15 p-6 text-center text-sm text-white/35">
                還沒有規則。例如：收到 OSC <code>/sys/go</code> → GO、收到 MIDI Note 60 → Pause Show。
              </p>
            )}

            <TriggerRuleList projectId={projectId} triggers={router.globalTriggers} />
          </main>
        </div>
      </motion.div>
    </motion.div>
  )
}
