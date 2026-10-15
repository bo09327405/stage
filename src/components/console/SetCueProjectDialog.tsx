import { AnimatePresence, motion } from 'motion/react'
import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AutoSaveStatus } from '../../hooks/useR2AutoSave'
import { useInvite, useMembers } from '../../services/membership'
import { InviteReset } from '../hub/InviteReset'
import { useProjectIndex } from '../../services/projects'
import { parseProjectFile, uniqueName, type ProjectFile } from '../../services/projectTransfer'
import { ExportProjectDialog } from '../lobby/ExportProjectDialog'
import { setCueProjectKey } from '../../services/storage'
import { isPrivateBase, readShareBase, writeShareBase } from '../../studio/publish'
import type { ShowRef } from '../../types/project'
import { formatWhen } from '../../utils/formatFile'
import { Avatar } from '../hub/Hub'
import { ImportProjectDialog } from '../lobby/ImportProjectDialog'

/**
 * Set Cue project: export / import (JSON), publish to Cloudflare R2 with a project link others
 * can open and edit (signing in joins them as collaborators), and who's on the project.
 */
export function SetCueProjectDialog({
  open,
  onClose,
  show,
  projectName,
  autoSave,
  saveNow,
  onOpenShow,
}: {
  open: boolean
  onClose: () => void
  show: ShowRef
  projectName: string
  autoSave: AutoSaveStatus
  saveNow: () => Promise<void>
  onOpenShow: (show: ShowRef) => void
}) {
  const { projects } = useProjectIndex()
  const [importFile, setImportFile] = useState<ProjectFile | null>(null)
  return (
    <>
      {createPortal(
        <AnimatePresence>
          {open && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} className="fixed inset-0 z-[85] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
              <motion.div
                initial={{ scale: 0.96 }}
                animate={{ scale: 1 }}
                onClick={(e) => e.stopPropagation()}
                className="flex max-h-[90dvh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-line bg-panel text-white shadow-2xl"
                role="dialog"
                aria-label="Set Cue 專案"
                data-setcue-project-dialog
              >
                <Body show={show} projectName={projectName} autoSave={autoSave} saveNow={saveNow} onClose={onClose} onImport={setImportFile} />
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
      <ImportProjectDialog
        file={importFile}
        suggestedName={importFile ? uniqueName(importFile.project.name, (projects ?? []).map((p) => p.name)) : ''}
        onClose={() => setImportFile(null)}
        onImported={(next, _name, openIt) => {
          setImportFile(null)
          onClose()
          if (openIt) onOpenShow(next)
        }}
      />
    </>
  )
}

function Body({
  show,
  projectName,
  autoSave,
  saveNow,
  onClose,
  onImport,
}: {
  show: ShowRef
  projectName: string
  autoSave: AutoSaveStatus
  saveNow: () => Promise<void>
  onClose: () => void
  onImport: (file: ProjectFile) => void
}) {
  const [base, setBase] = useState(readShareBase)
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const members = useMembers(`projectIndex/${show.projectId}`)
  const invite = useInvite(show.projectId)
  const link = `${base.replace(/\/+$/, '')}/?role=console&project=${encodeURIComponent(show.projectId)}&version=${encodeURIComponent(show.versionId)}${invite ? `&invite=${encodeURIComponent(invite)}` : ''}`

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

  const field = 'w-full rounded-lg border border-white/15 bg-black/40 px-2.5 py-2 text-sm text-white outline-none focus:border-accent'
  const btn = 'min-h-9 shrink-0 rounded-lg px-3 text-xs font-semibold disabled:opacity-40'

  return (
    <>
      <header className="flex items-start justify-between border-b border-line px-5 py-4">
        <div>
          <h2 className="text-lg font-semibold">📦 Set Cue 專案</h2>
          <p className="text-xs text-white/40">「{projectName}」· 匯入／匯出 · 發布專案網址 · 成員</p>
        </div>
        <button type="button" onClick={onClose} className="h-9 w-9 rounded-lg text-white/50 hover:bg-white/10" aria-label="關閉">
          ✕
        </button>
      </header>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
        {note && <p className={`rounded-lg px-3 py-2 text-xs ${note.error ? 'bg-panic/10 text-panic' : 'bg-go/10 text-go'}`} data-setcue-project-note>{note.text}</p>}

        <section className="space-y-2">
          <h3 className="text-sm font-semibold">匯入 / 匯出（JSON）</h3>
          <p className="text-[11px] text-white/45">匯出可選「單獨 Set Cue 專案」或「含所有 Studio 的完整專案包」。匯入兩種檔案都可以，會建立一個新專案（你是建立者）；專案包會一併還原底下的 Studio。</p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={!!busy}
              onClick={() => setExportOpen(true)}
              className={`${btn} flex-1 bg-white/10 text-white/85 hover:bg-white/15`}
              data-setcue-export
            >
              ⇩ 匯出…
            </button>
            <button type="button" onClick={() => input.current?.click()} className={`${btn} flex-1 bg-white/10 text-white/85 hover:bg-white/15`} data-setcue-import>
              ⇧ 匯入專案 / 專案包…
            </button>
            <input
              ref={input}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                if (!file) return
                try {
                  if (file.size > 20 * 1024 * 1024) throw new Error('檔案超過 20 MB')
                  onImport(parseProjectFile(await file.text()))
                } catch (err) {
                  setNote({ text: `無法匯入：${(err as Error).message}`, error: true })
                }
              }}
              data-setcue-import-input
            />
          </div>
        </section>

        <ExportProjectDialog project={exportOpen ? { id: show.projectId, name: projectName } : null} onClose={() => setExportOpen(false)} onDone={(text) => setNote({ text: `✓ ${text}` })} />

        <section className="space-y-2">
          <h3 className="text-sm font-semibold">發布專案網址</h3>
          <p className="text-[11px] text-white/45">
            把專案目前的設定與狀態存到 Cloudflare R2（{setCueProjectKey(show.projectId)}，含版本歷史），並產生專案網址。別人用 Google 帳號登入後開啟網址（含邀請碼），就能直接編輯，並自動加入協作者、出現在他的大廳。
          </p>
          <label className="block">
            <span className="mb-1 block text-xs text-white/55">對外網址（例如 ngrok 網址）</span>
            <input value={base} onChange={(e) => setBase(e.target.value)} onBlur={() => writeShareBase(base.trim() || location.origin)} className={`${field} font-mono text-xs`} data-setcue-share-base />
            {isPrivateBase(base) && <span className="mt-1 block text-[11px] text-standby">⚠ 本機 / 區域網路位址：只有這台電腦或同一個網路打得開。</span>}
          </label>
          <div className="flex gap-1.5">
            <input readOnly value={link} onFocus={(e) => e.currentTarget.select()} className={`${field} font-mono text-[11px]`} data-setcue-share-link />
            <button
              type="button"
              onClick={() =>
                navigator.clipboard?.writeText(link).then(() => {
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1500)
                })
              }
              className={`${btn} bg-accent text-white`}
            >
              {copied ? '✓ 已複製' : '複製'}
            </button>
          </div>
          <InviteReset projectId={show.projectId} token={invite} />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={!!busy}
              onClick={() =>
                run('publish', async () => {
                  await saveNow()
                  return `✓ 已發布到 R2（${new Date().toLocaleTimeString('zh-TW', { hour12: false })}），專案網址可以分享了`
                })
              }
              className={`${btn} bg-go text-black`}
              data-setcue-publish
            >
              {busy === 'publish' ? '發布中…' : '☁ 發布到 R2'}
            </button>
            <span className="text-[11px] text-white/45" data-setcue-publish-status>
              {autoSave.phase === 'saved' ? `R2 最後儲存 ${formatWhen(autoSave.at)}（之後的編輯也會自動儲存）` : autoSave.phase === 'off' ? 'R2 未設定' : autoSave.phase === 'error' ? `⚠ ${autoSave.message}` : '…'}
            </span>
          </div>
        </section>

        <section className="space-y-2" data-setcue-members>
          <h3 className="text-sm font-semibold">成員</h3>
          {members === null ? (
            <p className="text-xs text-white/35">載入中…</p>
          ) : (
            <ul className="space-y-1.5">
              <li className="flex items-center gap-2 text-xs">
                <Avatar user={{ name: members.owner?.name ?? '?' }} size={24} />
                <span className="min-w-0 flex-1 truncate text-white/85">{members.owner ? `${members.owner.name} · ${members.owner.email}` : '建立者未記錄（登入功能之前的專案）'}</span>
                <span className="rounded bg-white/10 px-1.5 text-[10px] text-white/55">建立者</span>
              </li>
              {members.collaborators.map((m) => (
                <li key={m.uid} className="flex items-center gap-2 text-xs" data-member={m.email}>
                  <Avatar user={m} size={24} />
                  <span className="min-w-0 flex-1 truncate text-white/85">
                    {m.name} · {m.email}
                  </span>
                  <span className="text-[10px] text-white/35">{m.lastOpenedAt ? `最近開啟 ${formatWhen(m.lastOpenedAt)}` : ''}</span>
                </li>
              ))}
              {members.collaborators.length === 0 && <li className="text-[11px] text-white/35">還沒有協作者：分享上方的專案網址即可邀請</li>}
            </ul>
          )}
        </section>
      </div>
    </>
  )
}
