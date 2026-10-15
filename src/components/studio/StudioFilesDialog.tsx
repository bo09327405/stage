import { isAdmin, useAuth } from '../../services/auth'
import { AnimatePresence, motion } from 'motion/react'
import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { timecode } from '../../studio/format'
import { formatWhen } from '../../utils/formatFile'
import type { AutoSaveStatus } from '../../hooks/useR2AutoSave'
import type { StudioSummary } from '../../services/studio'
import {
  fetchStudioFile,
  parseStudioFile,
  publishToDefault,
  unlistDefaultFile,
  uniqueStudioName,
  useDefaultStudioFiles,
  type StudioFile,
} from '../../studio/projectFile'
import type { StudioProject } from '../../types/studio'
import { ShowCloudPanel } from './ShowCloudPanel'

/** 本機檔案 / Default 共用 (shared by all shows) / 此演出雲端 (this show's R2: open, import, delete). */
export type FilesTab = 'local' | 'default' | 'show'

/**
 * Open a DAW project file: from this computer (file picker or drag-and-drop), from the shared
 * Default folder on Cloudflare R2, or from this show's R2 folder. A chosen file is previewed,
 * then imported as a new studio in this show and opened in a tab.
 */
export function StudioFilesDialog({
  open,
  initialTab,
  projectId,
  projectName,
  current,
  takenNames,
  onImport,
  onOpenStudio,
  studios,
  currentStudioId,
  autoSave,
  onClose,
}: {
  open: boolean
  initialTab: FilesTab
  projectId: string
  projectName: string
  /** The open studio, for "publish here". */
  current: StudioProject | null
  takenNames: string[]
  onImport: (file: StudioFile, name: string) => Promise<void>
  onOpenStudio: (studioId: string) => void
  studios: StudioSummary[] | null
  currentStudioId: string | null
  autoSave: AutoSaveStatus | null
  onClose: () => void
}) {
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
            aria-label="匯入 DAW 專案"
            data-studio-files
          >
            <Body initialTab={initialTab} projectId={projectId} projectName={projectName} current={current} takenNames={takenNames} onImport={onImport} onOpenStudio={onOpenStudio} studios={studios} currentStudioId={currentStudioId} autoSave={autoSave} onClose={onClose} />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}

function Body({
  initialTab,
  projectId,
  projectName,
  current,
  takenNames,
  onImport,
  onOpenStudio,
  studios,
  currentStudioId,
  autoSave,
  onClose,
}: {
  initialTab: FilesTab
  projectId: string
  projectName: string
  current: StudioProject | null
  takenNames: string[]
  onImport: (file: StudioFile, name: string) => Promise<void>
  onOpenStudio: (studioId: string) => void
  studios: StudioSummary[] | null
  currentStudioId: string | null
  autoSave: AutoSaveStatus | null
  onClose: () => void
}) {
  const [tab, setTab] = useState<FilesTab>(initialTab)
  const [chosen, setChosen] = useState<{ file: StudioFile; source: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const choose = async (load: () => Promise<StudioFile>, source: string, key: string) => {
    setBusy(key)
    setError(null)
    try {
      setChosen({ file: await load(), source })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <header className="flex items-start justify-between border-b border-line px-5 py-4">
        <div>
          <h2 className="text-lg font-semibold">{tab === 'show' ? '此演出雲端（Cloudflare R2）' : '匯入 DAW 專案'}</h2>
          <p className="text-xs text-white/40">{tab === 'show' ? `「${projectName}」的所有 DAW 專案與音檔：自動儲存狀態、開啟 / 匯入、刪除` : `匯入後會在「${projectName}」建立一個新的 Studio 專案，原檔不受影響`}</p>
        </div>
        <button type="button" onClick={onClose} className="h-9 w-9 rounded-lg text-white/50 hover:bg-white/10" aria-label="關閉">
          ✕
        </button>
      </header>
      {chosen ? (
        <Preview chosen={chosen} takenNames={takenNames} onBack={() => setChosen(null)} onImport={onImport} />
      ) : (
        <>
          <div className="grid grid-cols-3 gap-1 border-b border-line p-2" role="tablist">
            {(
              [
                ['local', '💻 本機檔案'],
                ['default', '☁ Default 共用'],
                ['show', '☁ 此演出雲端（R2）'],
              ] as const
            ).map(([id, label]) => (
              <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={`min-h-9 rounded-lg text-xs font-semibold ${tab === id ? 'bg-white/15 text-white' : 'text-white/50 hover:text-white/80'}`} data-files-tab={id}>
                {label}
              </button>
            ))}
          </div>
          {error && <p className="border-b border-line bg-panic/10 px-5 py-2 text-xs text-panic" data-files-error>{error}</p>}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {tab === 'show' ? (
              <ShowCloudPanel
                projectId={projectId}
                projectName={projectName}
                studios={studios}
                currentStudioId={currentStudioId}
                autoSave={autoSave}
                onOpenStudio={(id) => {
                  onOpenStudio(id)
                  onClose()
                }}
                onImportFile={(load, source, key) => choose(load, `此演出雲端 · ${source}`, key)}
              />
            ) : tab === 'local' ? (
              <LocalPicker busy={busy === 'local'} onFile={(f) => choose(async () => parseStudioFile(await f.text()), `本機檔案 ${f.name}`, 'local')} />
            ) : (
              <DefaultList projectName={projectName} current={current} busy={busy} onPick={(f) => choose(() => fetchStudioFile(f.url), `Default 共用 · ${f.name}`, f.id)} />
            )}
          </div>
        </>
      )}
    </>
  )
}

function LocalPicker({ busy, onFile }: { busy: boolean; onFile: (f: File) => void }) {
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  return (
    <div className="p-5">
      <div
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setOver(false)
          const f = e.dataTransfer.files[0]
          if (f) onFile(f)
        }}
        className={`flex h-56 flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed text-center transition ${over ? 'border-accent bg-accent/10' : 'border-white/15'}`}
        data-files-drop
      >
        <span className="text-4xl">📁</span>
        <p className="text-sm text-white/60">把 .daw.json 專案檔拖到這裡</p>
        <button type="button" onClick={() => input.current?.click()} disabled={busy} className="min-h-10 rounded-xl bg-accent px-5 text-sm font-semibold disabled:opacity-40">
          {busy ? '讀取中…' : '選擇檔案…'}
        </button>
        <input
          ref={input}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) onFile(f)
            e.target.value = ''
          }}
          data-files-input
        />
      </div>
      <p className="mt-3 text-xs text-white/35">專案檔包含音軌、片段、自動化曲線、區段與混音設定；音檔仍在 Cloudflare R2 上，匯入後可直接播放。</p>
    </div>
  )
}

/** The Default shared library: published copies any show can import, and "publish here". */
function DefaultList({ projectName, current, busy, onPick }: { projectName: string; current: StudioProject | null; busy: string | null; onPick: (f: { id: string; url: string; name: string }) => void }) {
  const { files, r2, folder, reload } = useDefaultStudioFiles()
  const [publishing, setPublishing] = useState<string | null>(null)

  const admin = isAdmin(useAuth().user)
  const publish = async () => {
    if (!current) return
    setPublishing('上傳中…')
    try {
      await publishToDefault({ projectName, studio: current })
      setPublishing(`✓ 已發佈「${current.name}」到 Default 共用`)
      reload()
    } catch (err) {
      setPublishing(`發佈失敗：${(err as Error).message}`)
    }
  }

  return (
    <div className="flex h-full flex-col" data-cloud-files="default">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3">
        <span className="mr-auto font-mono text-xs text-white/55">☁ {folder}/ · 所有演出共用</span>
        {current && admin && (
          <button type="button" onClick={publish} disabled={publishing === '上傳中…'} className="min-h-8 rounded-lg bg-accent/20 px-3 text-xs font-semibold text-accent hover:bg-accent hover:text-white disabled:opacity-40" data-publish-here>
            ☁ 發佈「{current.name}」到這裡
          </button>
        )}
        {publishing && <span className={`w-full text-xs ${publishing.startsWith('發佈失敗') ? 'text-panic' : 'text-white/60'}`} data-publish-status>{publishing}</span>}
        {r2.status !== 'ok' && (
          <p className="w-full text-[11px] text-[#f6a35c]/80" data-r2-listing={r2.status}>
            {r2.status === 'error' ? (
              <>
                ⚠ R2：{r2.message}{' '}
                <button type="button" onClick={reload} className="text-accent underline">
                  重試
                </button>
              </>
            ) : r2.status === 'off' ? (
              '⚠ 伺服器尚未設定 Cloudflare R2（.env.local 的 R2_* 變數），無法使用雲端專案檔'
            ) : (
              'R2：讀取中…'
            )}
          </p>
        )}
      </div>
      <ul className="space-y-1 p-3">
        {files === null && <li className="p-6 text-center text-sm text-white/35">載入中…</li>}
        {files?.length === 0 && <li className="p-10 text-center text-sm text-white/35">Default 共用資料夾還沒有專案檔</li>}
        {files?.map((f) => (
          <li key={f.id} className="group flex items-center gap-3 rounded-xl px-3 py-2 hover:bg-white/[0.05]" data-cloud-file={f.publicId}>
            <span className="text-xl">🎚</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-white/90">{f.name}</span>
              <span className="block truncate text-[11px] text-white/40">
                {f.fromListing ? 'R2 檔案' : `${f.tracks} 軌 · ${f.regions} 片段 · ${timecode(f.length, false)}`}
                {f.fromShow ? ` · 來自「${f.fromShow}」` : ''}
                {f.createdAt ? ` · ${formatWhen(f.createdAt)}` : ''}
              </span>
            </span>
            {!f.fromListing && (
              <button
                type="button"
                onClick={() => confirm(`從 Default 清單移除「${f.name}」？（R2 上的檔案不會被刪除）`) && unlistDefaultFile(f.id)}
                className="h-8 rounded-lg px-2 text-xs text-white/30 opacity-0 group-hover:opacity-100 hover:bg-white/10 hover:text-white"
                aria-label={`從清單移除 ${f.name}`}
              >
                ✕
              </button>
            )}
            <button type="button" onClick={() => onPick(f)} disabled={busy === f.id} className="h-8 rounded-lg bg-white/[0.08] px-3 text-xs font-semibold text-white hover:bg-accent disabled:opacity-40" data-cloud-open={f.publicId}>
              {busy === f.id ? '讀取中…' : '匯入'}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Preview({ chosen, takenNames, onBack, onImport }: { chosen: { file: StudioFile; source: string }; takenNames: string[]; onBack: () => void; onImport: (file: StudioFile, name: string) => Promise<void> }) {
  const { file } = chosen
  const [name, setName] = useState(() => uniqueStudioName(file.name, takenNames))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const counts: [string, number | string][] = [
    ['音軌', Object.keys(file.studio.tracks).length],
    ['片段', Object.keys(file.studio.regions).length],
    ['區段', Object.keys(file.studio.sections).length],
    ['長度', timecode(file.length)],
  ]
  return (
    <div className="flex-1 space-y-4 overflow-y-auto p-5" data-files-preview>
      <p className="text-xs text-white/45">
        來源：{chosen.source} · 匯出於 {new Date(file.exportedAt).toLocaleString('zh-TW', { hour12: false })}
      </p>
      <dl className="grid grid-cols-4 gap-2">
        {counts.map(([k, v]) => (
          <div key={k} className="rounded-xl border border-line bg-black/30 p-3 text-center">
            <dd className="font-mono text-lg font-semibold text-white">{v}</dd>
            <dt className="text-[11px] text-white/45">{k}</dt>
          </div>
        ))}
      </dl>
      <label className="block">
        <span className="mb-1 block text-xs text-white/55">新 Studio 名稱</span>
        <input value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm outline-none focus:border-accent" data-files-name />
      </label>
      {error && <p className="text-sm text-panic">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onBack} className="min-h-10 rounded-lg px-4 text-sm text-white/60 hover:bg-white/10">
          ← 返回
        </button>
        <button
          type="button"
          disabled={busy || !name.trim()}
          onClick={async () => {
            setBusy(true)
            try {
              await onImport(file, name.trim())
            } catch (err) {
              setError((err as Error).message)
              setBusy(false)
            }
          }}
          className="min-h-10 rounded-lg bg-accent px-5 text-sm font-semibold disabled:opacity-40"
          data-files-import
        >
          {busy ? '匯入中…' : '匯入並開啟'}
        </button>
      </div>
    </div>
  )
}
