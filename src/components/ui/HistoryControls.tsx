import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { GROUP_ICONS, MAX_STEPS, clearHistory, jumpTo, redo, undo, useActivity, useHistory, useHistoryScope } from '../../services/history'
import { Avatar } from '../hub/Hub'

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
const MOD = isMac ? '⌘' : 'Ctrl+'

const ago = (at: number, now: number) => {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return `${s} 秒前`
  if (s < 3600) return `${Math.floor(s / 60)} 分前`
  return new Date(at).toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit' })
}

/**
 * Undo / Redo buttons plus the history log, opened as a centred modal: every recorded edit (newest
 * first) with its field changes. Click a step to jump the project back (or forward) to just after it.
 */
export function HistoryControls({ compact = false }: { compact?: boolean }) {
  const { entries, index, busy, notice } = useHistory()
  const [open, setOpen] = useState(false)
  // "mine": this tab's undoable steps. "team": everyone's edits to the project (shared log).
  const [view, setView] = useState<'mine' | 'team'>('mine')
  const scope = useHistoryScope()
  const activity = useActivity(open && view === 'team' ? scope : null)
  const [now, setNow] = useState(() => Date.now())
  // The notice timestamp that has already faded out.
  const [dismissedAt, setDismissedAt] = useState(0)
  useEffect(() => {
    if (!open) return
    const timer = setInterval(() => setNow(Date.now()), 5000)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Esc closes the dialog only — it must not also reach the console's "Fade All".
        e.stopImmediatePropagation()
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      clearInterval(timer)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  // Flash the result of each undo / redo for a few seconds.
  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setDismissedAt(notice.at), 3500)
    return () => clearTimeout(t)
  }, [notice])
  const showNotice = !!notice && notice.at !== dismissedAt

  const canUndo = index > 0 && !busy
  const canRedo = index < entries.length && !busy
  const nextUndo = entries[index - 1]
  const nextRedo = entries[index]
  const btn =
    'flex min-h-10 items-center justify-center gap-1 rounded-lg bg-white/[0.06] px-2.5 text-sm text-white/80 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-30'

  return (
    <div className="relative flex items-center gap-1" data-history>
      <button
        type="button"
        onClick={() => undo()}
        disabled={!canUndo}
        className={btn}
        title={nextUndo ? `復原：${nextUndo.label}（${MOD}Z）` : `沒有可復原的步驟（${MOD}Z）`}
        aria-label="復原 Undo"
      >
        ↶{!compact && <span className="text-xs">復原</span>}
      </button>
      <button
        type="button"
        onClick={() => redo()}
        disabled={!canRedo}
        className={btn}
        title={nextRedo ? `重做：${nextRedo.label}（${isMac ? '⌘⇧Z' : 'Ctrl+Y'}）` : '沒有可重做的步驟'}
        aria-label="重做 Redo"
      >
        ↷{!compact && <span className="text-xs">重做</span>}
      </button>
      <button
        type="button"
        onClick={() => {
          setNow(Date.now())
          setOpen(true)
        }}
        aria-haspopup="dialog"
        className={`${btn} ${open ? 'bg-white/15 text-white' : ''}`}
        title="編輯歷史紀錄"
        aria-label="歷史紀錄"
      >
        🕘<span className="font-mono text-[11px] text-white/50 tabular">{index}</span>
      </button>

      <AnimatePresence>
        {showNotice && notice && (
          <motion.div
            key={notice.at}
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className={`pointer-events-none absolute top-full right-0 z-50 mt-2 max-w-80 rounded-lg border px-3 py-1.5 text-xs whitespace-nowrap shadow-xl ${
              notice.tone === 'warn' ? 'border-standby/40 bg-[#2a2410] text-standby' : 'border-line bg-panel text-white/80'
            }`}
            role="status"
            data-history-notice
          >
            {notice.text}
          </motion.div>
        )}
      </AnimatePresence>

      {createPortal(
        <AnimatePresence>
          {open && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              onClick={() => setOpen(false)}
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
              data-history-backdrop
            >
              <motion.div
                initial={{ opacity: 0, scale: 0.96, y: 8 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.96, y: 8 }}
                transition={{ type: 'spring', stiffness: 480, damping: 36 }}
                onClick={(e) => e.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-labelledby="history-title"
                className="flex max-h-[min(720px,88dvh)] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-line bg-panel text-white shadow-2xl"
                data-history-panel
              >
                <header className="flex items-start gap-3 border-b border-line px-5 py-4">
                  <div className="min-w-0 flex-1">
                    <h2 id="history-title" className="text-base font-semibold">
                      編輯歷史紀錄
                    </h2>
                    <p className="mt-0.5 text-xs text-white/45">
                      {view === 'mine' ? `保留最近 ${MAX_STEPS} 步（目前 ${entries.length} 步，已套用 ${index} 步）· 點選任一步驟即跳回該狀態` : '所有協作者對這個專案的編輯（最近 80 筆）'}
                    </p>
                    <div className="mt-2 grid w-fit grid-cols-2 gap-1 rounded-lg bg-black/40 p-1 text-xs" role="tablist">
                      {(
                        [
                          ['mine', '↶ 我的步驟（可復原）'],
                          ['team', '👥 協作紀錄'],
                        ] as const
                      ).map(([id, label]) => (
                        <button key={id} type="button" role="tab" aria-selected={view === id} onClick={() => setView(id)} className={`min-h-7 rounded-md px-3 ${view === id ? 'bg-white/15 text-white' : 'text-white/50'}`} data-history-view={id}>
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button type="button" onClick={() => undo()} disabled={!canUndo} className={btn} aria-label="復原上一步">
                      ↶
                    </button>
                    <button type="button" onClick={() => redo()} disabled={!canRedo} className={btn} aria-label="重做下一步">
                      ↷
                    </button>
                    <button
                      type="button"
                      onClick={() => setOpen(false)}
                      className="flex h-10 w-10 items-center justify-center rounded-lg text-lg text-white/50 hover:bg-white/10 hover:text-white"
                      aria-label="關閉"
                      autoFocus
                    >
                      ✕
                    </button>
                  </div>
                </header>

                {view === 'team' ? (
                  <ol className="flex-1 overflow-y-auto py-1" data-activity-list>
                    {activity === null && <li className="px-5 py-10 text-center text-sm text-white/35">載入中…</li>}
                    {activity?.length === 0 && <li className="px-5 py-10 text-center text-sm text-white/35">還沒有協作紀錄</li>}
                    {activity?.map((a) => (
                      <li key={a.key} className="flex gap-3 px-5 py-2.5" data-activity={a.key}>
                        {a.by ? <Avatar user={a.by} size={26} /> : <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full bg-white/10 text-[11px] text-white/40">?</span>}
                        <span className="min-w-0 flex-1">
                          <span className="flex items-baseline gap-2">
                            <span className="truncate text-sm text-white">{a.label}</span>
                            <span className="ml-auto shrink-0 text-[10px] text-white/30">{a.at ? ago(a.at, now) : ''}</span>
                          </span>
                          <span className="block truncate text-[11px] text-white/45" title={a.by?.email}>
                            {a.group === 'undo' ? '↶ ' : `${GROUP_ICONS[a.group as keyof typeof GROUP_ICONS] ?? ''} `}
                            {a.by ? `${a.by.name} · ${a.by.email}` : '未登入的使用者'}
                          </span>
                          {a.details && a.details.length > 0 && (
                            <span className="mt-0.5 block space-y-px font-mono text-[11px] text-white/35">
                              {a.details.map((d, i) => (
                                <span key={i} className="block truncate">
                                  {d}
                                </span>
                              ))}
                            </span>
                          )}
                        </span>
                      </li>
                    ))}
                  </ol>
                ) : (
                <ol className="flex-1 overflow-y-auto py-1">
                  {entries.length === 0 && <li className="px-5 py-10 text-center text-sm text-white/35">還沒有編輯紀錄</li>}
                  {[...entries].reverse().map((entry) => {
                    const position = entries.indexOf(entry) + 1
                    const applied = position <= index
                    const current = position === index
                    return (
                      <li key={entry.id}>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => jumpTo(position)}
                          className={`relative flex w-full gap-3 px-5 py-2.5 text-left transition hover:bg-white/[0.06] disabled:cursor-wait ${current ? 'bg-accent/10' : ''}`}
                          data-history-step={position}
                        >
                          {current && <span className="absolute inset-y-1 left-0 w-1 rounded-r bg-accent" />}
                          <span className="w-6 shrink-0 pt-0.5 text-right font-mono text-[11px] text-white/30 tabular">{position}</span>
                          <span className={`mt-0.5 w-4 shrink-0 text-center text-sm ${applied ? '' : 'opacity-30'}`}>{GROUP_ICONS[entry.group]}</span>
                          <span className="min-w-0 flex-1">
                            <span className="flex items-baseline gap-2">
                              <span className={`truncate text-sm ${applied ? 'text-white' : 'text-white/35 line-through'}`}>{entry.label}</span>
                              {current && <span className="shrink-0 rounded bg-accent px-1.5 text-[10px] font-semibold text-white">目前</span>}
                              {!applied && <span className="shrink-0 text-[10px] text-white/35">已復原</span>}
                            </span>
                            {entry.by && (
                              <span className="mt-0.5 flex items-center gap-1 text-[10px] text-white/40" data-history-by>
                                <Avatar user={entry.by} size={14} />
                                {entry.by.name}
                              </span>
                            )}
                            {entry.details.length > 0 && (
                              <span className={`mt-0.5 block space-y-px font-mono text-[11px] ${applied ? 'text-white/50' : 'text-white/25'}`}>
                                {entry.details.map((d, i) => (
                                  <span key={i} className="block truncate">
                                    {d}
                                  </span>
                                ))}
                              </span>
                            )}
                          </span>
                          <span className="shrink-0 pt-0.5 text-[10px] text-white/30">{ago(entry.at, now)}</span>
                        </button>
                      </li>
                    )
                  })}
                  <li>
                    <button
                      type="button"
                      disabled={busy || entries.length === 0}
                      onClick={() => jumpTo(0)}
                      className={`relative flex w-full items-center gap-3 px-5 py-2.5 text-left text-xs transition hover:bg-white/[0.06] disabled:opacity-40 ${
                        index === 0 ? 'bg-accent/10 text-white' : 'text-white/45'
                      }`}
                      data-history-step={0}
                    >
                      {index === 0 && <span className="absolute inset-y-1 left-0 w-1 rounded-r bg-accent" />}
                      <span className="w-6 shrink-0 text-right font-mono text-[11px] text-white/30">0</span>
                      <span className="w-4 text-center">◎</span>
                      開始紀錄前的狀態
                    </button>
                  </li>
                </ol>
                )}

                <footer className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line px-5 py-3 text-xs text-white/50">
                  <span>
                    <Kbd>{isMac ? '⌘Z' : 'Ctrl+Z'}</Kbd> 復原
                  </span>
                  <span>
                    <Kbd>{isMac ? '⌘⇧Z' : 'Ctrl+Y'}</Kbd> 重做
                  </span>
                  <span>
                    <Kbd>Esc</Kbd> 關閉
                  </span>
                  {entries.length > 0 && (
                    <button
                      type="button"
                      onClick={() => confirm('清除歷史紀錄？（不會改變目前的資料）') && clearHistory()}
                      className="ml-auto min-h-8 rounded-md px-2 text-white/40 hover:bg-white/10 hover:text-white"
                    >
                      清除紀錄
                    </button>
                  )}
                  <span className="w-full text-[11px] text-white/30">只記錄此分頁的編輯；GO、Standby、推桿等演出操作不列入。</span>
                </footer>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  )
}

function Kbd({ children }: { children: string }) {
  return <kbd className="mr-1 rounded border border-white/15 bg-black/40 px-1.5 py-0.5 font-mono text-[11px] text-white/70">{children}</kbd>
}
