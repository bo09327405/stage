import { get, ref } from 'firebase/database'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { db } from '../../services/firebase'
import { exportProject, type ExportMode, type ProjectFileSummary } from '../../services/projectTransfer'

type StudioRow = { id: string; name: string; tracks: number; regions: number }

/**
 * Export a Set Cue project: Set Cue only (cues, hits, script, surfaces, triggers, media index), or
 * the full bundle with every Studio of the project (tracks, regions, automation, FX).
 */
export function ExportProjectDialog({
  project,
  onClose,
  onDone,
}: {
  project: { id: string; name: string } | null
  onClose: () => void
  onDone: (message: string) => void
}) {
  return createPortal(
    <AnimatePresence>
      {project && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} className="fixed inset-0 z-[90] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <motion.div
            initial={{ scale: 0.96 }}
            animate={{ scale: 1 }}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-lg rounded-2xl border border-line bg-panel p-6 text-white shadow-2xl"
            role="dialog"
            aria-label="匯出專案"
            data-export-dialog
          >
            <Body project={project} onClose={onClose} onDone={onDone} />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}

function Body({ project, onClose, onDone }: { project: { id: string; name: string }; onClose: () => void; onDone: (message: string) => void }) {
  const [studios, setStudios] = useState<StudioRow[] | null>(null)
  const [mode, setMode] = useState<ExportMode>('setcue')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    get(ref(db, `projects/${project.id}/studio`))
      .then((snap) => {
        const all = (snap.val() ?? {}) as Record<string, { name?: string; tracks?: object; regions?: object }>
        if (alive) setStudios(Object.entries(all).map(([id, s]) => ({ id, name: s.name ?? 'Studio', tracks: Object.keys(s.tracks ?? {}).length, regions: Object.keys(s.regions ?? {}).length })))
      })
      .catch(() => alive && setStudios([]))
    return () => {
      alive = false
    }
  }, [project.id])

  const run = async () => {
    setBusy(true)
    setError(null)
    try {
      const s: ProjectFileSummary = await exportProject(project.id, mode)
      onDone(
        mode === 'bundle'
          ? `已匯出完整專案包「${project.name}」：${s.versions} 個版本、${s.cues} 個 Cue、${s.studios.length} 個 Studio`
          : `已匯出 Set Cue「${project.name}」：${s.versions} 個版本、${s.cues} 個 Cue`,
      )
      onClose()
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  const option = (value: ExportMode, title: string, file: string, children: React.ReactNode) => (
    <label
      className={`block cursor-pointer rounded-xl border p-3.5 transition ${mode === value ? 'border-accent bg-accent/10' : 'border-line bg-black/20 hover:bg-white/[0.04]'}`}
      data-export-mode={value}
    >
      <div className="flex items-start gap-2.5">
        <input type="radio" name="export-mode" checked={mode === value} onChange={() => setMode(value)} className="mt-1 h-4 w-4 accent-[#0a84ff]" />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="text-sm font-semibold">{title}</div>
          <div className="text-[11px] text-white/55">{children}</div>
          <div className="font-mono text-[10px] text-white/30">{file}</div>
        </div>
      </div>
    </label>
  )

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">⇩ 匯出專案</h2>
        <p className="mt-1 truncate text-xs text-white/45">「{project.name}」</p>
      </div>
      <div className="space-y-2.5">
        {option(
          'setcue',
          '單獨匯出 Set Cue 專案',
          'theatre-setcue_….json',
          <>所有版本的 Cue、Hits、劇本筆記、控制面板、觸發規則與素材清單。不含 Studio。</>,
        )}
        {option(
          'bundle',
          '打包匯出完整專案包（含 Studio）',
          'theatre-bundle_….json',
          <>
            Set Cue 專案，加上底下所有 Studio 的音軌、片段、自動化曲線、FX 與處理參數、區段與 Master。匯入時會一起還原並重新連結。
            <span className="mt-1.5 block text-white/70" data-export-studios>
              {studios === null
                ? '正在讀取 Studio…'
                : studios.length === 0
                  ? '這個專案目前沒有 Studio。'
                  : studios.map((s) => `🎛️ ${s.name}（${s.tracks} 軌・${s.regions} 片段）`).join('　')}
            </span>
          </>,
        )}
      </div>
      <p className="text-[11px] text-white/35">音檔仍在 R2 / Cloudinary 原位置，檔案只保存連結；播放狀態、Intercom 與 Studio 發布的 MP3 網址不會匯出。</p>
      {error && <p className="rounded-lg bg-panic/10 px-3 py-2 text-xs text-panic">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} disabled={busy} className="min-h-11 rounded-xl px-4 text-sm text-white/60 hover:bg-white/10">
          取消
        </button>
        <button type="button" onClick={run} disabled={busy} className="min-h-11 rounded-xl bg-accent px-5 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-40" data-export-go>
          {busy ? '匯出中…' : '匯出'}
        </button>
      </div>
    </div>
  )
}
