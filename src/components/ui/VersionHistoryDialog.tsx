import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Avatar } from '../hub/Hub'
import {
  HISTORY_LIMIT,
  contentOf,
  dismissRestore,
  formatVersionTime,
  jumpToLatest,
  loadVersions,
  restoreVersion,
  type HistoryEntry,
  type Summarize,
  type VersionKind,
  type VersionedFile,
} from '../../services/versionHistory'

type Json = Record<string, unknown>

const KIND: Record<VersionKind, [string, string]> = {
  auto: ['自動', 'bg-white/10 text-white/55'],
  manual: ['手動存檔', 'bg-accent/20 text-accent'],
  beforeRestore: ['還原前', 'bg-standby/20 text-standby'],
  restore: ['還原', 'bg-[#bf5af2]/20 text-[#d7a6ff]'],
}

function SavedByTag({ by }: { by: { name: string; email: string; photo: string } }) {
  return (
    <span className="flex min-w-0 items-center gap-1 text-[10px] text-white/45" title={by.email} data-version-by>
      <Avatar user={by} size={14} />
      <span className="truncate">{by.name}</span>
    </span>
  )
}

const ago = (ms: number) => {
  const s = (Date.now() - ms) / 1000
  if (s < 60) return '剛剛'
  if (s < 3600) return `${Math.floor(s / 60)} 分鐘前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小時前`
  return `${Math.floor(s / 86400)} 天前`
}

/**
 * Version history of an auto-saved project (DAW Studio or Set Cue): the current version and up to
 * 15 earlier ones from the file's embedded history, each with its time and change summary.
 * Expand a version to preview it, restore it, and — after restoring — jump back to the latest.
 */
export function VersionHistoryDialog(props: {
  open: boolean
  onClose: () => void
  title: string
  fileKey: string
  /** Changes after every save, to refresh the list. */
  revision: number
  saveNow: () => Promise<void>
  /** The live project content right now (same shape as a saved version). */
  live: () => Promise<Json>
  /** Write a version's content to the live project. */
  apply: (state: Json) => Promise<void>
  summarize: Summarize
  preview: (state: Json) => ReactNode
}) {
  return createPortal(
    <AnimatePresence>
      {props.open && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={props.onClose} className="fixed inset-0 z-[85] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <motion.div
            initial={{ scale: 0.96 }}
            animate={{ scale: 1 }}
            onClick={(e) => e.stopPropagation()}
            className="flex h-[min(680px,90dvh)] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-line bg-panel text-white shadow-2xl"
            role="dialog"
            aria-label="版本歷史"
            data-version-history
          >
            <Body {...props} />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}

function Body({ onClose, title, fileKey, revision, saveNow, live, apply, summarize, preview }: Parameters<typeof VersionHistoryDialog>[0]) {
  const [file, setFile] = useState<(Json & VersionedFile) | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [openAt, setOpenAt] = useState<number | null>(null)

  const reload = useCallback(() => {
    loadVersions(fileKey)
      .then(setFile)
      .catch((err: Error) => setError(err.message))
  }, [fileKey])
  useEffect(reload, [reload, revision])

  const run = async (id: string, job: () => Promise<string>) => {
    setBusy(id)
    setError(null)
    try {
      setNote(await job())
      reload()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const history = file?.history ?? []
  const marker = file?.restore ?? null
  const restore = (entry: HistoryEntry) =>
    run(`r${entry.at}`, async () => {
      await restoreVersion(fileKey, entry, { live: contentOf(await live()), apply, summarize })
      setOpenAt(null)
      return `✓ 已還原為 ${formatVersionTime(entry.at)} 的版本 · 後悔可按「返回最新版本」`
    })

  return (
    <>
      <header className="flex items-start gap-3 border-b border-line px-5 py-4">
        <div className="mr-auto min-w-0">
          <h2 className="text-lg font-semibold">🕘 版本歷史</h2>
          <p className="truncate text-xs text-white/40">
            {title} · 自動儲存時保留最近 {HISTORY_LIMIT} 個版本（存在同一個 R2 檔案裡）
          </p>
        </div>
        <button
          type="button"
          disabled={!!busy}
          onClick={() =>
            run('save', async () => {
              await saveNow()
              return '✓ 已建立手動存檔版本'
            })
          }
          className="min-h-9 shrink-0 rounded-lg bg-accent/20 px-3 text-xs font-semibold text-accent hover:bg-accent hover:text-white disabled:opacity-40"
          data-version-save
        >
          {busy === 'save' ? '儲存中…' : '💾 立即存檔'}
        </button>
        <button type="button" onClick={onClose} className="h-9 w-9 shrink-0 rounded-lg text-white/50 hover:bg-white/10" aria-label="關閉">
          ✕
        </button>
      </header>

      {marker && (
        <div className="flex flex-wrap items-center gap-2 border-b border-[#bf5af2]/30 bg-[#bf5af2]/10 px-5 py-3 text-xs" data-version-restored>
          <span className="mr-auto text-white/80">
            目前套用的是 <b>{formatVersionTime(marker.toAt)}</b> 的版本（{formatVersionTime(marker.restoredAt)} 還原）
          </span>
          <button
            type="button"
            disabled={!!busy}
            onClick={() =>
              run('latest', async () => {
                await jumpToLatest(fileKey, { apply })
                return '✓ 已返回還原前的最新版本'
              })
            }
            className="min-h-8 rounded-lg bg-[#bf5af2] px-3 font-semibold text-white disabled:opacity-40"
            data-version-latest
          >
            {busy === 'latest' ? '…' : '↩ 返回最新版本'}
          </button>
          <button type="button" disabled={!!busy} onClick={() => run('keep', async () => (await dismissRestore(fileKey), '已保留這個版本'))} className="min-h-8 rounded-lg px-2 text-white/55 hover:bg-white/10">
            保留此版本
          </button>
        </div>
      )}
      {(note || error) && <p className={`border-b border-line px-5 py-2 text-xs ${error ? 'bg-panic/10 text-panic' : 'text-go'}`} data-version-note>{error ?? note}</p>}

      <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto p-3">
        {file === undefined && !error && <li className="p-6 text-center text-sm text-white/35">讀取版本…</li>}
        {file === null && <li className="p-10 text-center text-sm text-white/35">還沒有雲端版本（編輯後會自動儲存）</li>}
        {file && (
          <li className="rounded-xl border border-go/25 bg-go/[0.06] px-3 py-2" data-version-current>
            <div className="flex items-center gap-2 text-xs">
              <span className="rounded bg-go/20 px-1.5 py-px text-[10px] font-bold text-go">目前</span>
              <span className={`rounded px-1.5 py-px text-[10px] ${KIND[file.currentKind ?? 'auto'][1]}`}>{KIND[file.currentKind ?? 'auto'][0]}</span>
              <span className="text-white/80">{file.savedAt ? formatVersionTime(file.savedAt) : '—'}</span>
              {file.savedBy && <SavedByTag by={file.savedBy} />}
              <span className="ml-auto text-white/35">{file.savedAt ? ago(file.savedAt) : ''}</span>
            </div>
            <p className="mt-1 text-xs text-white/55">{file.summary ?? '（舊版檔案，沒有異動摘要）'}</p>
          </li>
        )}
        {file && history.length === 0 && <li className="p-6 text-center text-xs text-white/35">還沒有較早的版本：下一次儲存時，目前的內容會成為第一個歷史版本</li>}
        {history.map((entry, i) => {
          const expanded = openAt === entry.at
          return (
            <li key={`${entry.at}-${i}`} className={`rounded-xl px-3 py-2 ${expanded ? 'bg-white/[0.06]' : 'hover:bg-white/[0.04]'}`} data-version-entry={entry.at}>
              <button type="button" onClick={() => setOpenAt(expanded ? null : entry.at)} className="block w-full text-left" aria-expanded={expanded} data-version-toggle={entry.at}>
                <div className="flex items-center gap-2 text-xs">
                  <span className="w-5 text-right font-mono text-[10px] text-white/30">{i + 1}</span>
                  <span className={`rounded px-1.5 py-px text-[10px] ${KIND[entry.kind][1]}`}>{KIND[entry.kind][0]}</span>
                  <span className="text-white/80">{formatVersionTime(entry.at)}</span>
                  {entry.by && <SavedByTag by={entry.by} />}
                  {marker?.toAt === entry.at && <span className="rounded bg-[#bf5af2]/25 px-1.5 py-px text-[10px] text-[#d7a6ff]">已套用</span>}
                  <span className="ml-auto text-white/35">{ago(entry.at)}</span>
                </div>
                <p className="mt-1 pl-7 text-xs text-white/55">{entry.summary}</p>
              </button>
              {expanded && (
                <div className="mt-2 space-y-2 pl-7">
                  <div className="max-h-48 overflow-y-auto rounded-lg border border-white/10 bg-black/30 p-2 text-[11px] text-white/65" data-version-preview>
                    {preview(entry.state)}
                  </div>
                  <button
                    type="button"
                    disabled={!!busy}
                    onClick={() => confirm(`還原為 ${formatVersionTime(entry.at)} 的版本？\n目前的內容會先保留成「還原前」版本，之後可按「返回最新版本」回來。`) && restore(entry)}
                    className="min-h-8 rounded-lg bg-[#bf5af2] px-3 text-xs font-semibold text-white disabled:opacity-40"
                    data-version-restore={entry.at}
                  >
                    {busy === `r${entry.at}` ? '還原中…' : '↺ 還原此版本'}
                  </button>
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </>
  )
}
