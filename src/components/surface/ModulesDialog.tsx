import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAuth } from '../../services/auth'
import { useProject } from '../../services/projects'
import { canDeleteModule, deleteSurfaceModule, loadBuiltinModule, loadSurfaceModule, saveSurfaceModule, useSurfaceModules, type SurfaceModule } from '../../services/surfaceModules'
import { BUILTIN_MODULES, type BuiltinModule } from '../../utils/builtinModules'
import type { Cue, Hit } from '../../types/cue'
import type { Surface } from '../../types/surface'
import { formatWhen } from '../../utils/formatFile'
import { Avatar } from '../hub/Hub'

/**
 * 📦 面板模組: save the current control-panel layout as a module (Cloudflare R2 + a global index)
 * and load any module — the built-in Theatre / Live Music ones, or one saved from this or any
 * other project — into this panel.
 */
export function ModulesDialog({
  open,
  onClose,
  projectId,
  surface,
  cues,
  hits,
  newId,
  onLoaded,
}: {
  open: boolean
  onClose: () => void
  projectId: string
  surface: Surface
  cues: Cue[]
  hits: Hit[]
  newId: () => string
  onLoaded: (message: string) => void
}) {
  // Esc closes the dialog only; it must not reach the console's "Fade All".
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
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} className="fixed inset-0 z-[85] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <motion.div
            initial={{ scale: 0.96 }}
            animate={{ scale: 1 }}
            onClick={(e) => e.stopPropagation()}
            className="flex max-h-[90dvh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-line bg-panel text-white shadow-2xl"
            role="dialog"
            aria-label="面板模組"
            data-modules-dialog
          >
            <Body onClose={onClose} projectId={projectId} surface={surface} cues={cues} hits={hits} newId={newId} onLoaded={onLoaded} />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}

function Body({
  onClose,
  projectId,
  surface,
  cues,
  hits,
  newId,
  onLoaded,
}: {
  onClose: () => void
  projectId: string
  surface: Surface
  cues: Cue[]
  hits: Hit[]
  newId: () => string
  onLoaded: (message: string) => void
}) {
  const { user } = useAuth()
  const project = useProject(projectId)
  const { modules, error } = useSurfaceModules()
  const [name, setName] = useState(surface.name)
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null)
  const [filter, setFilter] = useState<'all' | 'mine' | 'here'>('all')
  const [confirmLoad, setConfirmLoad] = useState<SurfaceModule | null>(null)
  const [confirmBuiltin, setConfirmBuiltin] = useState<BuiltinModule | null>(null)
  const projectName = project?.name ?? ''
  const count = Object.keys(surface.widgets).length

  const run = async (id: string, job: () => Promise<string>) => {
    setBusy(id)
    setNote(null)
    try {
      setNote({ text: await job() })
    } catch (err) {
      setNote({ text: (err as Error).message, error: true })
    } finally {
      setBusy(null)
    }
  }

  const load = (m: SurfaceModule, mode: 'replace' | 'append') =>
    run(`load:${m.id}`, async () => {
      const r = await loadSurfaceModule({ module: m, mode, projectId, surface, cues, hits, newId })
      const warn = [r.unmatchedCues ? `${r.unmatchedCues} 個 Cue 動作` : '', r.unmatchedHits ? `${r.unmatchedHits} 個 Hit 動作` : ''].filter(Boolean).join('、')
      const msg = `✓ 已${mode === 'replace' ? '載入' : '加入'}「${m.name}」的 ${r.widgets} 個元件${warn ? `；${warn}在此專案找不到對應，請重新指定` : ''}`
      setConfirmLoad(null)
      onLoaded(msg)
      onClose()
      return msg
    })

  const applyBuiltin = (m: BuiltinModule, mode: 'replace' | 'append') =>
    run(`builtin:${m.id}`, async () => {
      const n = await loadBuiltinModule({ module: m, mode, projectId, surface, newId })
      const msg = `✓ 已${mode === 'replace' ? '套用' : '加入'}內建模組「${m.name}」的 ${n} 個元件`
      setConfirmBuiltin(null)
      onLoaded(msg)
      onClose()
      return msg
    })

  const shown = (modules ?? []).filter((m) => (filter === 'mine' ? m.by?.uid === user?.uid : filter === 'here' ? m.source?.projectId === projectId : true))
  const field = 'w-full rounded-lg border border-white/15 bg-black/40 px-2.5 py-2 text-sm text-white outline-none focus:border-accent'
  const btn = 'min-h-9 shrink-0 rounded-lg px-3 text-xs font-semibold disabled:opacity-40'

  return (
    <>
      <header className="flex items-start justify-between border-b border-line px-5 py-4">
        <div>
          <h2 className="text-lg font-semibold">📦 面板模組</h2>
          <p className="text-xs text-white/40">儲存控制面板佈局到雲端（Cloudflare R2），在任何專案載入使用</p>
        </div>
        <button type="button" onClick={onClose} className="h-9 w-9 rounded-lg text-white/50 hover:bg-white/10" aria-label="關閉">
          ✕
        </button>
      </header>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
        {note && (
          <p className={`rounded-lg px-3 py-2 text-xs ${note.error ? 'bg-panic/10 text-panic' : 'bg-go/10 text-go'}`} data-modules-note>
            {note.text}
          </p>
        )}

        <section className="space-y-2 rounded-xl border border-line bg-black/20 p-3">
          <h3 className="text-sm font-semibold">儲存目前佈局為模組</h3>
          <p className="text-[11px] text-white/45">
            「{surface.name}」的 {count} 個元件（按鈕、推桿、旋鈕、Cue Monitor / Note / Stage / Intercom 視窗與其設定）。Cue 綁定以 Cue 編號 / 名稱、Hit 綁定以名稱在其他專案重新對應。
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="模組名稱" className={field} maxLength={60} data-module-name />
            <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="說明（選填）" className={field} maxLength={200} data-module-description />
            <button
              type="button"
              disabled={!!busy || !user || !name.trim() || count === 0}
              onClick={() =>
                run('save', async () => {
                  const m = await saveSurfaceModule({ user: user!, name, description, surface, cues, hits, projectId, projectName })
                  setDescription('')
                  return `✓ 已儲存模組「${m.name}」（${m.key}）`
                })
              }
              className={`${btn} bg-go text-black`}
              data-module-save
            >
              {busy === 'save' ? '儲存中…' : '☁ 儲存模組'}
            </button>
          </div>
        </section>

        <section className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">模組庫</h3>
            <span className="font-mono text-xs text-white/30">{modules ? modules.length + BUILTIN_MODULES.length : '…'}</span>
            <div className="ml-auto grid grid-cols-3 gap-1 rounded-lg bg-black/40 p-0.5 text-[11px]">
              {(
                [
                  ['all', '全部'],
                  ['mine', '我的'],
                  ['here', '此專案'],
                ] as const
              ).map(([id, label]) => (
                <button key={id} type="button" onClick={() => setFilter(id)} className={`min-h-7 rounded-md px-2 font-semibold ${filter === id ? 'bg-white/15 text-white' : 'text-white/45'}`}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          {filter === 'all' && (
            <ul className="space-y-2" data-builtin-list>
              {BUILTIN_MODULES.map((m) => (
                <li key={m.id} className="space-y-2 rounded-xl border border-accent/30 bg-accent/[0.06] p-3" data-builtin-module={m.name}>
                  <div className="flex items-start gap-3">
                    <span className="text-2xl leading-none">{m.icon}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold">{m.name}</span>
                        <span className="rounded bg-accent/25 px-1.5 text-[10px] font-semibold text-accent">內建</span>
                      </div>
                      <div className="text-[11px] text-white/55">{m.description}</div>
                      <div className="mt-1 flex flex-wrap gap-1 text-[10px]">
                        {m.contents.map((c) => (
                          <span key={c} className="rounded bg-white/[0.07] px-1.5 text-white/60">
                            {c}
                          </span>
                        ))}
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={!!busy}
                      onClick={() => (count === 0 ? applyBuiltin(m, 'replace') : setConfirmBuiltin(m))}
                      className={`${btn} bg-accent text-white`}
                      data-builtin-load={m.name}
                    >
                      {busy === `builtin:${m.id}` ? '套用中…' : '套用'}
                    </button>
                  </div>
                  {confirmBuiltin?.id === m.id && (
                    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-white/[0.05] p-2 text-xs" data-builtin-confirm>
                      <span className="text-white/60">目前控台有 {count} 個元件：</span>
                      <button type="button" disabled={!!busy} onClick={() => applyBuiltin(m, 'replace')} className={`${btn} bg-panic/80 text-white`} data-builtin-replace>
                        覆蓋目前佈局
                      </button>
                      <button type="button" disabled={!!busy} onClick={() => applyBuiltin(m, 'append')} className={`${btn} bg-white/15 text-white`} data-builtin-append>
                        加到下方
                      </button>
                      <button type="button" onClick={() => setConfirmBuiltin(null)} className={`${btn} text-white/45`}>
                        取消
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          {error && <p className="text-xs text-panic">無法讀取模組庫：{error}</p>}
          {modules === null && <p className="text-xs text-white/35">載入中…</p>}
          {modules && shown.length === 0 && <p className="py-6 text-center text-xs text-white/35">{filter === 'all' ? '還沒有自己儲存的模組' : '還沒有模組'}</p>}
          <ul className="space-y-2" data-module-list>
            {shown.map((m) => (
              <li key={m.id} className="space-y-2 rounded-xl border border-line bg-black/30 p-3" data-module={m.name}>
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-semibold">{m.name}</div>
                    {m.description && <div className="truncate text-[11px] text-white/55">{m.description}</div>}
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-white/40">
                      <span className="flex items-center gap-1">
                        <Avatar user={{ name: m.by?.name ?? '?' }} size={14} />
                        {m.by?.uid === user?.uid ? '你' : m.by?.name}
                      </span>
                      <span>{formatWhen(m.createdAt)}</span>
                      <span>來自「{m.source?.projectName || '—'}」</span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1 text-[10px]">
                      {m.counts?.buttons > 0 && <span className="rounded bg-go/15 px-1.5 text-go">按鈕 {m.counts.buttons}</span>}
                      {m.counts?.faders > 0 && <span className="rounded bg-accent/20 px-1.5 text-accent">推桿 {m.counts.faders}</span>}
                      {m.counts?.knobs > 0 && <span className="rounded bg-[#ff9f0a]/15 px-1.5 text-[#ff9f0a]">旋鈕 {m.counts.knobs}</span>}
                      {m.counts?.windows > 0 && <span className="rounded bg-[#64d2ff]/15 px-1.5 text-[#64d2ff]">視窗 {m.counts.windows}</span>}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col gap-1.5">
                    <button type="button" disabled={!!busy} onClick={() => (count === 0 ? load(m, 'replace') : setConfirmLoad(m))} className={`${btn} bg-accent text-white`} data-module-load={m.name}>
                      {busy === `load:${m.id}` ? '載入中…' : '載入'}
                    </button>
                    {canDeleteModule(m, user) && (
                      <button
                        type="button"
                        disabled={!!busy}
                        onClick={() =>
                          confirm(`刪除模組「${m.name}」？（雲端檔案會一併刪除，已載入到控台的元件不受影響）`) &&
                          run(`del:${m.id}`, async () => {
                            await deleteSurfaceModule(m)
                            return `已刪除模組「${m.name}」`
                          })
                        }
                        className={`${btn} text-white/40 hover:bg-panic/15 hover:text-panic`}
                        data-module-delete={m.name}
                      >
                        刪除
                      </button>
                    )}
                  </div>
                </div>
                {confirmLoad?.id === m.id && (
                  <div className="flex flex-wrap items-center gap-2 rounded-lg bg-white/[0.05] p-2 text-xs" data-module-confirm>
                    <span className="text-white/60">目前控台有 {count} 個元件：</span>
                    <button type="button" disabled={!!busy} onClick={() => load(m, 'replace')} className={`${btn} bg-panic/80 text-white`} data-module-replace>
                      取代整個佈局
                    </button>
                    <button type="button" disabled={!!busy} onClick={() => load(m, 'append')} className={`${btn} bg-white/15 text-white`} data-module-append>
                      加到下方
                    </button>
                    <button type="button" onClick={() => setConfirmLoad(null)} className={`${btn} text-white/45`}>
                      取消
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </>
  )
}
