import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { createXrScene, removeXrScene, renameXrScene, saveXrScene, useXrScenes, type XrSceneDoc } from '../../services/xrScenes'
import type { AudienceUpload, Cue } from '../../types/cue'
import { cueMediaFolder } from '../../types/project'
import { XR_MODES, XR_MODE_LABELS, xrProblem, type XrMode, type XrScene } from '../../types/xr'
import XrEditor from './XrEditor'

type SaveState = 'saved' | 'dirty' | 'saving' | 'error'

/** Firebase returns keys in its own order: compare scenes by content, not by key order. */
const stable = (value: unknown): string =>
  JSON.stringify(value, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v))

/**
 * XR 工作區: the project's XR scenes as assets of their own — a list on the left (new / rename / duplicate /
 * delete), the full editor (viewport + inspector) on the right. Edits save themselves; every AUDIENCE_XR cue
 * bound to a scene plays its latest version.
 */
export default function XrWorkspace({
  projectId,
  projectName,
  inbox,
  cues,
  readOnly,
  initialSceneId,
  onClose,
}: {
  projectId: string
  projectName: string
  inbox: AudienceUpload[] | null
  cues: Cue[]
  readOnly: boolean
  /** Open on this scene (e.g. from a cue bound to it). */
  initialSceneId?: string | null
  onClose: () => void
}) {
  const { scenes, error } = useXrScenes(projectId)
  const [selectedId, setSelectedId] = useState<string | null>(initialSceneId ?? null)
  const selected = scenes?.find((s) => s.id === selectedId) ?? null
  // Nothing chosen (or the chosen one was deleted): fall back to the first scene.
  if (scenes && !selected && scenes.length > 0 && selectedId !== scenes[0].id) setSelectedId(scenes[0].id)

  // The scene being edited lives here; it is written back a moment after the last change.
  const [draft, setDraft] = useState<{ id: string; scene: XrScene } | null>(null)
  const [save, setSave] = useState<SaveState>('saved')
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const pending = useRef<{ id: string; scene: XrScene } | null>(null)
  const timer = useRef<number | null>(null)

  if (selected && draft?.id !== selected.id) {
    setDraft({ id: selected.id, scene: selected.scene })
    setSave('saved')
  } else if (selected && draft && save === 'saved' && stable(draft.scene) !== stable(selected.scene)) {
    // Changed elsewhere (another editor, undo) while nothing is unsaved here: follow it.
    setDraft({ id: selected.id, scene: selected.scene })
  }

  const flush = () => {
    if (timer.current != null) window.clearTimeout(timer.current)
    timer.current = null
    const job = pending.current
    pending.current = null
    if (!job) return Promise.resolve()
    setSave('saving')
    return saveXrScene(projectId, job.id, job.scene).then(
      () => setSave((s) => (pending.current ? s : 'saved')),
      (err: Error) => {
        setSave('error')
        setMessage(`儲存失敗：${err.message}`)
      },
    )
  }
  const flushRef = useRef(flush)
  useEffect(() => {
    flushRef.current = flush
  })
  // Leaving the workspace (or the page) writes what is still waiting.
  useEffect(() => () => void flushRef.current(), [])

  const edit = (scene: XrScene) => {
    if (!draft || readOnly) return
    setDraft({ id: draft.id, scene })
    pending.current = { id: draft.id, scene }
    setSave('dirty')
    if (timer.current != null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => void flush(), 800)
  }

  const run = async (job: () => Promise<unknown>) => {
    setBusy(true)
    setMessage(null)
    try {
      await flush()
      await job()
    } catch (err) {
      setMessage((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const create = (mode: XrMode) => run(async () => setSelectedId(await createXrScene(projectId, `${XR_MODE_LABELS[mode]} ${(scenes?.length ?? 0) + 1}`, mode)))
  const duplicate = (doc: XrSceneDoc) => run(async () => setSelectedId(await createXrScene(projectId, `${doc.name} 副本`, structuredClone(doc.id === draft?.id ? draft.scene : doc.scene))))
  const rename = (doc: XrSceneDoc) => {
    const name = window.prompt('場景名稱', doc.name)
    if (name != null && name.trim() && name.trim() !== doc.name) void run(() => renameXrScene(projectId, doc.id, name))
  }
  const usedBy = (id: string) => cues.filter((c) => c.type === 'AUDIENCE_XR' && c.xrSceneId === id)
  const remove = (doc: XrSceneDoc) => {
    const users = usedBy(doc.id)
    const note = users.length ? `\n\n有 ${users.length} 個 Cue 綁定這個場景（${users.map((c) => `Q${c.cueNumber}`).join('、')}）；刪除後它們會保留最後一次的內容，變成各自獨立的場景。` : ''
    if (!window.confirm(`刪除 XR 場景「${doc.name}」？${note}`)) return
    pending.current = null
    void run(() => removeXrScene(projectId, doc.id))
  }

  const problem = draft ? xrProblem(draft.scene) : null
  const users = draft ? usedBy(draft.id) : []
  const smallButton = 'flex h-7 w-7 shrink-0 items-center justify-center rounded text-xs text-white/40 hover:bg-white/10 hover:text-white disabled:opacity-30'

  return createPortal(
    <div className="fixed inset-0 z-40 flex flex-col bg-[#101114] text-white" role="dialog" aria-label="XR 工作區" data-xr-workspace>
      <header className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2.5">
        <span className="text-sm font-semibold">🥽 XR 工作區</span>
        <span className="truncate text-xs text-white/40">{projectName}</span>
        <span
          className={`ml-auto rounded-full px-2.5 py-1 text-[11px] ${save === 'saved' ? 'bg-go/15 text-go' : save === 'error' ? 'bg-panic/20 text-panic' : 'bg-standby/15 text-standby'}`}
          aria-live="polite"
          data-xr-save={save}
        >
          {readOnly ? '唯讀' : { saved: '✓ 已自動儲存', dirty: '● 未儲存的變更…', saving: '儲存中…', error: '⚠ 儲存失敗' }[save]}
        </span>
        <button type="button" onClick={() => void flush().then(onClose)} className="flex min-h-9 items-center rounded-lg bg-white/[0.07] px-3 text-xs text-white/80 hover:bg-white/15" data-xr-workspace-close>
          ✕ 回到 Set Cue
        </button>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[15rem_minmax(0,1fr)]">
        <aside className="flex min-h-0 flex-col gap-2 border-b border-line p-3 md:border-r md:border-b-0" data-xr-scene-list>
          <div className="flex items-baseline justify-between">
            <h3 className="text-xs font-semibold tracking-wide text-white/60">XR 場景</h3>
            <span className="text-[10px] text-white/30">{scenes ? `${scenes.length} 個` : '載入中…'}</span>
          </div>
          <ul className="max-h-40 min-h-0 space-y-1 overflow-y-auto md:max-h-none md:flex-1">
            {scenes?.map((doc) => (
              <li key={doc.id} className={`flex items-center gap-0.5 rounded-lg border pr-1 ${doc.id === selectedId ? 'border-accent bg-accent/10' : 'border-transparent bg-white/[0.03] hover:bg-white/[0.07]'}`} data-xr-scene={doc.id}>
                <button type="button" onClick={() => void flush().then(() => setSelectedId(doc.id))} className="min-w-0 flex-1 px-2.5 py-2 text-left">
                  <span className="block truncate text-xs font-medium text-white/90">{doc.name}</span>
                  <span className="block truncate text-[10px] text-white/35">
                    {XR_MODE_LABELS[doc.scene.mode]} · {doc.scene.objects.length} 個物件{usedBy(doc.id).length ? ` · ${usedBy(doc.id).length} 個 Cue 使用中` : ''}
                  </span>
                </button>
                <button type="button" onClick={() => rename(doc)} disabled={readOnly || busy} className={smallButton} aria-label={`重新命名 ${doc.name}`} title="重新命名">
                  ✎
                </button>
                <button type="button" onClick={() => void duplicate(doc)} disabled={readOnly || busy} className={smallButton} aria-label={`複製 ${doc.name}`} title="複製場景">
                  ⧉
                </button>
                <button type="button" onClick={() => remove(doc)} disabled={readOnly || busy} className={`${smallButton} hover:!text-panic`} aria-label={`刪除 ${doc.name}`} title="刪除場景">
                  ✕
                </button>
              </li>
            ))}
            {scenes?.length === 0 && <li className="rounded-lg bg-white/[0.03] p-3 text-center text-[11px] leading-relaxed text-white/40">還沒有 XR 場景。選一種體驗模式開始。</li>}
          </ul>
          <div className="space-y-1">
            <span className="block text-[10px] text-white/35">＋ 新增場景</span>
            <div className="grid grid-cols-3 gap-1 md:grid-cols-1">
              {XR_MODES.map((mode) => (
                <button key={mode} type="button" onClick={() => void create(mode)} disabled={readOnly || busy || !scenes} className="min-h-8 rounded-md border border-dashed border-white/20 px-2 text-[11px] text-white/65 hover:border-accent hover:text-white disabled:opacity-40" data-xr-new={mode}>
                  {XR_MODE_LABELS[mode]}
                </button>
              ))}
            </div>
          </div>
          {(message || error) && <p className="text-[11px] text-panic">{message ?? `無法讀取場景：${error}`}</p>}
        </aside>

        <main className="flex min-h-0 flex-col gap-2 overflow-hidden p-3">
          {draft && selected ? (
            <>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
                <span className="text-sm font-semibold text-white/90">{selected.name}</span>
                <span className="text-white/40">{users.length ? `綁定的 Cue：${users.map((c) => `Q${c.cueNumber} ${c.title}`).join('、')}` : '還沒有 Cue 使用這個場景：在 Cue 的「XR 場景」分頁選它'}</span>
                {problem && <span className="rounded bg-standby/15 px-2 py-0.5 text-standby">⚠ {problem}</span>}
              </div>
              <div className="min-h-0 flex-1">
                {/* Re-mounted per scene, so selection and viewport never leak from one scene to the next. */}
                <XrEditor key={draft.id} layout="workspace" value={draft.scene} onChange={edit} projectId={projectId} projectName={projectName} inbox={inbox} allCues={cues} uploadFolder={cueMediaFolder(projectName, projectId)} uploadShared={false} />
              </div>
            </>
          ) : (
            <p className="flex flex-1 items-center justify-center text-sm text-white/35">{scenes === null ? '載入 XR 場景…' : '從左側新增一個 XR 場景'}</p>
          )}
        </main>
      </div>
    </div>,
    document.body,
  )
}
