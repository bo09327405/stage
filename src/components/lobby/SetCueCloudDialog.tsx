import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { deleteSetCueCloud, loadSetCueCloud, restoreSetCueProject, type SetCueCloudProject } from '../../services/r2Manage'
import type { ProjectSummary, ShowRef } from '../../types/project'
import { formatBytes as size, formatWhen as when } from '../../utils/formatFile'


/**
 * Set Cue projects auto-saved on Cloudflare R2 (theatre/setcue-projects/{pid}.json): open one,
 * restore one that only exists in the cloud, download it, or delete it from R2 for good.
 */
export function SetCueCloudDialog({ open, projects, onOpen, onClose }: { open: boolean; projects: ProjectSummary[] | null; onOpen: (show: ShowRef) => void; onClose: () => void }) {
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <motion.div
            initial={{ scale: 0.96 }}
            animate={{ scale: 1 }}
            onClick={(e) => e.stopPropagation()}
            className="flex h-[min(640px,88dvh)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-line bg-panel text-white shadow-2xl"
            role="dialog"
            aria-label="R2 雲端專案"
            data-setcue-cloud
          >
            <Body projects={projects} onOpen={onOpen} onClose={onClose} />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}

function Body({ projects, onOpen, onClose }: { projects: ProjectSummary[] | null; onOpen: (show: ShowRef) => void; onClose: () => void }) {
  const [items, setItems] = useState<SetCueCloudProject[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [alsoProject, setAlsoProject] = useState(false)

  const reload = useCallback(() => {
    loadSetCueCloud()
      .then(setItems)
      .catch((err: Error) => setError(err.message))
  }, [])
  useEffect(reload, [reload])

  const run = async (key: string, job: () => Promise<string | void>) => {
    setBusy(key)
    setError(null)
    try {
      const text = await job()
      if (text) setNote(text)
      setConfirming(null)
      reload()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const open = (item: SetCueCloudProject) => {
    const newest = projects?.find((p) => p.id === item.projectId)?.versions[0]
    if (newest) {
      onOpen({ projectId: item.projectId, versionId: newest.id })
      onClose()
    }
  }

  return (
    <>
      <header className="flex items-start justify-between border-b border-line px-5 py-4">
        <div>
          <h2 className="text-lg font-semibold">☁ R2 雲端專案</h2>
          <p className="text-xs text-white/40">Set Cue 編輯後會自動儲存到 Cloudflare R2：theatre/setcue-projects/{'{專案}'}.json</p>
        </div>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => {
              setError(null)
              setNote(null)
              reload()
            }}
            className="h-9 rounded-lg px-2 text-xs text-white/55 hover:bg-white/10"
            data-setcue-reload
          >
            ↻ 重新整理
          </button>
          <button type="button" onClick={onClose} className="h-9 w-9 rounded-lg text-white/50 hover:bg-white/10" aria-label="關閉">
            ✕
          </button>
        </div>
      </header>
      {(note || error) && <p className={`border-b border-line px-5 py-2 text-xs ${error ? 'bg-panic/10 text-panic' : 'text-go'}`} data-setcue-note>{error ?? note}</p>}
      <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto p-3">
        {items === null && !error && <li className="p-6 text-center text-sm text-white/35">讀取 R2…</li>}
        {items?.length === 0 && <li className="p-10 text-center text-sm text-white/35">R2 上還沒有 Set Cue 專案（在控台編輯後會自動儲存）</li>}
        {items?.map((item) => (
          <li key={item.key} className="rounded-xl px-3 py-2 hover:bg-white/[0.04]" data-setcue-item={item.projectId}>
            <div className="flex items-center gap-3">
              <span className="text-xl">🎭</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-white/90">
                  {item.name}
                  <span className={`ml-2 rounded px-1 text-[10px] ${item.inSystem ? 'bg-go/15 text-go' : 'bg-white/10 text-white/50'}`}>{item.inSystem ? '系統中' : '僅雲端'}</span>
                </span>
                <span className="block truncate text-[11px] text-white/40">
                  自動儲存 {when(item.lastModified)} · {size(item.size)}
                </span>
              </span>
              <a href={`/api/r2/o/${item.key.split('/').map(encodeURIComponent).join('/')}`} download={`${item.name}.json`} className="flex h-8 items-center rounded-lg px-2 text-xs text-white/50 hover:bg-white/10" title="下載 JSON">
                ⇩
              </a>
              <button
                type="button"
                disabled={!!busy}
                onClick={() =>
                  item.inSystem
                    ? open(item)
                    : run(item.key, async () => {
                        const show = await restoreSetCueProject(item)
                        onOpen(show)
                        onClose()
                      })
                }
                className="h-8 rounded-lg bg-white/[0.08] px-3 text-xs font-semibold text-white hover:bg-accent disabled:opacity-40"
                data-setcue-open={item.projectId}
              >
                {busy === item.key ? '…' : item.inSystem ? '開啟編輯' : '還原並開啟'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setAlsoProject(false)
                  setConfirming(confirming === item.key ? null : item.key)
                }}
                className="h-8 rounded-lg px-2 text-xs text-white/40 hover:bg-panic/15 hover:text-panic"
                aria-label={`刪除 ${item.name}`}
                data-setcue-delete={item.projectId}
              >
                🗑
              </button>
            </div>
            {confirming === item.key && (
              <div className="mt-2 space-y-2 rounded-lg border border-panic/30 bg-panic/10 p-3 text-xs" data-setcue-confirm>
                <p className="text-white/85">從 R2 永久刪除「{item.name}」的雲端專案檔？無法復原。</p>
                {item.inSystem && (
                  <>
                    <label className="flex items-center gap-2 text-white/70">
                      <input type="checkbox" checked={alsoProject} onChange={(e) => setAlsoProject(e.target.checked)} className="h-4 w-4 accent-[#ff453a]" data-setcue-also />
                      同時從系統刪除這個專案（所有版本與 Cue；觀眾上傳記錄會封存保留）
                    </label>
                    {!alsoProject && <p className="text-standby">專案仍在系統中：下次在控台編輯時會再自動儲存一份新的雲端檔。</p>}
                  </>
                )}
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={!!busy}
                    onClick={() =>
                      run(item.key, async () => {
                        await deleteSetCueCloud(item, alsoProject)
                        return `✓ 已從 R2 刪除「${item.name}」${alsoProject && item.inSystem ? '，並從系統刪除專案' : ''}`
                      })
                    }
                    className="min-h-8 rounded-lg bg-panic px-3 font-semibold text-white disabled:opacity-40"
                    data-setcue-confirm-delete
                  >
                    {busy === item.key ? '刪除中…' : '永久刪除'}
                  </button>
                  <button type="button" onClick={() => setConfirming(null)} className="min-h-8 rounded-lg px-3 text-white/60 hover:bg-white/10">
                    取消
                  </button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </>
  )
}
