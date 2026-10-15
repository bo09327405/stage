import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AppUser } from '../../services/auth'
import { executePurge, planPurge, type PurgePlan } from '../../services/purge'
import { formatBytes } from '../../utils/formatFile'

const CONFIRM_WORD = '永久刪除'

/**
 * Permanent delete from the trash: first a cleanup report (what goes, which shared files get
 * backed up where, what is kept), then two confirmations (a checkbox and typing 永久刪除).
 */
export function PurgeDialog({ ids, user, onClose, onDone }: { ids: string[] | null; user: AppUser; onClose: () => void; onDone: (message: string) => void }) {
  return createPortal(
    <AnimatePresence>
      {ids && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} className="fixed inset-0 z-[90] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
          <motion.div
            initial={{ scale: 0.96 }}
            animate={{ scale: 1 }}
            onClick={(e) => e.stopPropagation()}
            className="flex max-h-[88dvh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-panic/40 bg-panel text-white shadow-2xl"
            role="alertdialog"
            aria-label="徹底刪除"
            data-purge-dialog
          >
            <Body ids={ids} user={user} onClose={onClose} onDone={onDone} />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}

function Body({ ids, user, onClose, onDone }: { ids: string[]; user: AppUser; onClose: () => void; onDone: (message: string) => void }) {
  const [plan, setPlan] = useState<PurgePlan | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [understood, setUnderstood] = useState(false)
  const [typed, setTyped] = useState('')
  const [step, setStep] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    planPurge(ids, user).then(
      (p) => alive && setPlan(p),
      (err: Error) => alive && setError(err.message),
    )
    return () => {
      alive = false
    }
  }, [ids, user])

  const projects = plan?.items.filter((i) => i.type === 'project').length ?? 0
  const studios = plan?.items.filter((i) => i.type === 'studio').length ?? 0
  const audio = plan?.deleteKeys.filter((k) => /\.(wav|mp3|m4a|aac|ogg|flac|webm|mp4|mov)$/i.test(k.key)).length ?? 0
  const holders = [...new Set(plan?.backups.map((b) => b.holder) ?? [])]
  const summary = plan
    ? `將永久刪除 ${[projects ? `${projects} 個專案` : '', studios ? `${studios} 個 Studio` : ''].filter(Boolean).join('、')}、${plan.deleteKeys.length} 個檔案${plan.deleteKeys.length ? `（其中 ${audio} 個音檔／影片，共 ${formatBytes(plan.bytes)}）` : ''}` +
      (plan.backups.length ? `，已自動備份 ${new Set(plan.backups.map((b) => b.key)).size} 個共用素材至${holders.map((h) => `「${h}」`).join('、')}` : '')
    : ''

  return (
    <>
      <header className="border-b border-panic/30 bg-panic/10 px-5 py-4">
        <h2 className="text-lg font-semibold text-panic">⚠ 徹底刪除（無法復原）</h2>
        <p className="text-xs text-white/55">{ids.length > 1 ? `清空回收桶：${ids.length} 個項目` : '從回收桶永久刪除這個項目'}</p>
      </header>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5 text-sm">
        {error && <p className="rounded-lg bg-panic/10 px-3 py-2 text-xs text-panic">{error}</p>}
        {!plan && !error && <p className="text-white/40">正在檢查專案的檔案與其他專案的引用…</p>}
        {plan && (
          <>
            <p className="rounded-lg bg-white/[0.05] px-3 py-2.5 font-semibold" data-purge-summary>
              {summary}
            </p>
            <section className="space-y-1" data-purge-items>
              <h3 className="text-xs font-semibold text-white/60">刪除的項目</h3>
              <ul className="space-y-0.5 text-xs text-white/80">
                {plan.items.map((i) => (
                  <li key={i.id}>
                    {i.type === 'studio' ? '🎛️ Studio' : '🎭 專案'}「{i.name}」
                  </li>
                ))}
              </ul>
            </section>
            {plan.backups.length > 0 && (
              <section className="space-y-1" data-purge-backups>
                <h3 className="text-xs font-semibold text-go">自動備份（其他專案仍在使用）</h3>
                <ul className="space-y-0.5 text-[11px] text-white/70">
                  {plan.backups.map((b) => (
                    <li key={`${b.key}>${b.toKey}`}>
                      ✓ {b.key.split('/').pop()} → 「{b.holder}」<span className="text-white/35">（{b.toKey}，更新 {b.paths} 個引用）</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {plan.kept.length > 0 && (
              <section className="space-y-1">
                <h3 className="text-xs font-semibold text-white/60">保留的檔案</h3>
                <ul className="space-y-0.5 text-[11px] text-white/55">
                  {plan.kept.map((k) => (
                    <li key={k.key}>
                      {k.key.split('/').pop()} — {k.reason}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <section className="space-y-1 text-[11px] text-white/50">
              <h3 className="text-xs font-semibold text-white/60">一併清除</h3>
              <p>資料庫：Cue 清單、Hits、劇本、控制面板、觸發、Studio 與自動化、操作紀錄、Intercom 聊天、成員、邀請碼、大廳項目（{plan.dbPaths.length} 筆路徑）。</p>
              <p>Cloudflare R2：專案資料夾、Studio 音軌、Hit 音效、自動儲存與版本備份、發布的 MP3。</p>
              {(plan.audienceKept > 0 || plan.cloudinaryKept > 0) && (
                <p className="text-standby">
                  保留：{plan.audienceKept > 0 && `觀眾上傳 ${plan.audienceKept} 筆（依保存政策留在 Cloudinary，記錄移到觀眾封存）`}
                  {plan.cloudinaryKept > 0 && ` · ${plan.cloudinaryKept} 個較早存在 Cloudinary 的素材網址（無法從這裡刪除）`}
                </p>
              )}
            </section>
            <div className="space-y-2 rounded-xl border border-panic/40 bg-panic/[0.06] p-3">
              <label className="flex items-start gap-2 text-xs">
                <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[#ff453a]" data-purge-understood />
                我了解這些資料與檔案會被永久刪除，無法從回收桶還原。
              </label>
              <label className="block text-xs">
                請輸入「{CONFIRM_WORD}」確認：
                <input value={typed} onChange={(e) => setTyped(e.target.value)} className="mt-1 h-9 w-full rounded-lg border border-white/15 bg-black/40 px-2 text-sm text-white outline-none focus:border-panic" data-purge-confirm-input />
              </label>
            </div>
            {step && <p className="text-xs text-white/60" data-purge-step>{step}</p>}
          </>
        )}
      </div>
      <footer className="flex justify-end gap-2 border-t border-line px-5 py-3">
        <button type="button" onClick={onClose} disabled={!!step} className="min-h-10 rounded-xl px-4 text-sm text-white/60 hover:bg-white/10 disabled:opacity-40">
          取消
        </button>
        <button
          type="button"
          disabled={!plan || !understood || typed.trim() !== CONFIRM_WORD || !!step}
          onClick={async () => {
            if (!plan) return
            setStep('開始…')
            try {
              const r = await executePurge(plan, user, setStep)
              onDone(`✓ 已永久刪除 ${r.items} 個項目、${r.deleted} 個檔案${r.backups ? `，並備份 ${r.backups} 個共用素材` : ''}`)
              onClose()
            } catch (err) {
              setStep(null)
              setError((err as Error).message)
            }
          }}
          className="min-h-10 rounded-xl bg-panic px-4 text-sm font-bold text-white disabled:opacity-30"
          data-purge-go
        >
          {step ? '刪除中…' : '永久刪除'}
        </button>
      </footer>
    </>
  )
}
