import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'
import { importProject, summarize, type ProjectFile } from '../../services/projectTransfer'
import type { ShowRef } from '../../types/project'
import { fieldClass } from '../ui/controls'

/**
 * Confirm an import: what the file contains (Set Cue only, or a bundle with its Studios), and the
 * name the new project will get (made unique against the lobby). Importing always creates a new
 * project — nothing existing is touched.
 */
export function ImportProjectDialog({
  file,
  suggestedName,
  onClose,
  onImported,
}: {
  file: ProjectFile | null
  suggestedName: string
  onClose: () => void
  onImported: (show: ShowRef, name: string, open: boolean) => void
}) {
  return (
    <AnimatePresence>
      {file && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
          onClick={onClose}
        >
          <motion.div
            initial={{ scale: 0.96, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.96, opacity: 0 }}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-2xl border border-line bg-panel p-6 shadow-2xl"
            role="dialog"
            aria-label="匯入專案"
            data-import-dialog
          >
            <Body key={suggestedName} file={file} suggestedName={suggestedName} onClose={onClose} onImported={onImported} />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function Body({
  file,
  suggestedName,
  onClose,
  onImported,
}: {
  file: ProjectFile
  suggestedName: string
  onClose: () => void
  onImported: (show: ShowRef, name: string, open: boolean) => void
}) {
  const [name, setName] = useState(suggestedName)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const s = summarize(file)
  const rows: [string, number][] = [
    ['版本', s.versions],
    ['Cue', s.cues],
    ['Hits', s.hits],
    ['控台面板', s.surfaces],
    ['Global Trigger', s.triggers],
    ['素材庫檔案', s.media],
    ['觀眾上傳', s.uploads],
  ]

  const run = async (open: boolean) => {
    setBusy(true)
    setError(null)
    try {
      const { projectId, versionId } = await importProject(file, name)
      onImported({ projectId, versionId }, name.trim() || file.project.name, open)
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">匯入專案</h2>
        <p className="mt-1 text-xs text-white/45">
        「{s.name}」· 匯出於 {new Date(s.exportedAt).toLocaleString('zh-TW', { hour12: false })}
        </p>
      </div>
      <p className={`rounded-lg px-3 py-2 text-xs ${s.kind === 'bundle' ? 'bg-accent/15 text-accent' : 'bg-white/[0.06] text-white/70'}`} data-import-kind={s.kind}>
        {s.kind === 'bundle'
          ? `📦 完整專案包：Set Cue 專案＋${s.studios.length} 個 Studio，會一起還原並重新連結到新專案`
          : '🎭 單獨 Set Cue 專案：只建立 Set Cue 資料（不含 Studio）'}
      </p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-xl border border-line bg-black/30 p-3 text-sm" data-import-summary>
        {rows.map(([label, n]) => (
          <div key={label} className="flex justify-between gap-2">
            <dt className="text-white/50">{label}</dt>
            <dd className="font-mono text-white tabular">{n}</dd>
          </div>
        ))}
      </dl>
      {s.studios.length > 0 && (
        <ul className="space-y-1 rounded-xl border border-line bg-black/30 p-3 text-xs" data-import-studios>
          {s.studios.map((st) => (
            <li key={st.id} className="flex justify-between gap-2">
              <span className="truncate">🎛️ {st.name}</span>
              <span className="shrink-0 font-mono text-white/50">
                {st.tracks} 軌・{st.regions} 片段
              </span>
            </li>
          ))}
        </ul>
      )}
      <label className="block">
        <span className="mb-1.5 block text-[11px] font-medium tracking-wide text-white/50 uppercase">新專案名稱</span>
        <input className={fieldClass} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} data-import-name />
      </label>
      <p className="text-[11px] text-white/35">會建立為一個新專案，不會覆蓋任何現有專案。音檔仍在 R2 / Cloudinary 原位置，連結保持不變；播放狀態會重設為停止。</p>
      {error && <p className="text-sm text-panic">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} disabled={busy} className="min-h-11 rounded-xl px-4 text-sm text-white/60 hover:bg-white/10">
          取消
        </button>
        <button type="button" onClick={() => run(false)} disabled={busy || !name.trim()} className="min-h-11 rounded-xl bg-white/10 px-4 text-sm font-semibold hover:bg-white/15 disabled:opacity-40">
          匯入
        </button>
        <button
          type="button"
          onClick={() => run(true)}
          disabled={busy || !name.trim()}
          className="min-h-11 rounded-xl bg-accent px-4 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-40"
          data-import-open
        >
          {busy ? '匯入中…' : '匯入並開啟'}
        </button>
      </div>
    </div>
  )
}
