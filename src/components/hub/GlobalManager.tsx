import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { assignFile, deleteFile, loadGlobal, migrateDefaultToR2, moveFile, setFileLabel, type FolderNode, type GlobalState, type ManagedFile } from '../../services/adminFiles'
import { syncAudiencePool } from '../../services/uploads'
import type { AppUser } from '../../services/auth'
import { setProjectFlags } from '../../services/projectLock'
import { deleteProject, renameProject } from '../../services/projects'
import type { ProjectSummary } from '../../types/project'
import { formatBytes, formatWhen } from '../../utils/formatFile'
import { ProjectBadges } from './ProjectStatus'
import { MoveStudioDialog } from './StudioManage'
import { renameStudio } from '../../services/studio'
import { softDeleteStudio } from '../../services/studioAdmin'
import type { StudioSummaryRow } from '../../services/adminFiles'
import { FileActivityLog } from './FileActivityLog'

const GROUPS: { id: FolderNode['group']; title: string; icon: string }[] = [
  { id: 'default', title: 'Default 共用', icon: '📌' },
  { id: 'template', title: '官方範本', icon: '⭐' },
  { id: 'project', title: 'Set Cue 專案', icon: '📁' },
  { id: 'standalone', title: '未指定母專案的 Studio', icon: '🎛️' },
  { id: 'archived', title: '已封存', icon: '📦' },
  { id: 'audience', title: '觀眾互動（Cloudinary）', icon: '👥' },
  { id: 'orphan', title: '未歸屬的資料夾', icon: '❓' },
]
const KIND_ICON: Record<ManagedFile['kind'], string> = { audio: '🎵', video: '🎬', image: '🖼', project: '🗂', config: '⚙️' }
const btn = 'min-h-8 rounded-lg px-2.5 text-[11px] font-semibold disabled:opacity-40'

/**
 * Admins: every folder and file in one place — the shared Default folder, each project's folders
 * (official templates and archived ones apart), and storage folders no project owns. Projects can
 * be renamed, locked, pinned, archived or moved to the trash (one or many at a time); files
 * previewed, labelled and tagged, moved between folders (everything that uses them follows),
 * assigned to a project, or deleted.
 */
export function GlobalManager({ user }: { user: AppUser }) {
  const [state, setState] = useState<GlobalState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string>('default')
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  // 📁 folders, or 📜 the file activity log.
  const [view, setView] = useState<'folders' | 'log'>(() => {
    try {
      return localStorage.getItem('theatre.gm.view') === 'log' ? 'log' : 'folders'
    } catch {
      return 'folders'
    }
  })
  const pickView = (v: 'folders' | 'log') => {
    setView(v)
    try {
      localStorage.setItem('theatre.gm.view', v)
    } catch {
      // Not remembered; harmless.
    }
  }
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ default: true, template: true, project: true, archived: false, orphan: false })

  const reload = useCallback(() => {
    loadGlobal(user).then(
      (next) => {
        setError(null)
        setState(next)
      },
      (err: Error) => setError(err.message),
    )
  }, [user])
  useEffect(reload, [reload])

  const run = async (job: () => Promise<string>) => {
    setBusy(true)
    setNote(null)
    try {
      setNote({ text: await job(), ok: true })
      reload()
    } catch (err) {
      setNote({ text: (err as Error).message, ok: false })
    } finally {
      setBusy(false)
    }
  }

  const studioMatch = /^studio:([^:]+):(.+)$/.exec(openId)
  const studioFolder = studioMatch ? (state?.folders.find((f) => f.project?.id === studioMatch[1]) ?? null) : null
  const studioOpen = studioMatch ? (studioFolder?.studios.find((st) => st.id === studioMatch[2]) ?? null) : null
  const folder = state?.folders.find((f) => f.id === openId) ?? state?.folders[0] ?? null
  const totals = useMemo(() => {
    const all = state?.folders.flatMap((f) => f.files) ?? []
    return { files: all.length, bytes: all.reduce((n, f) => n + f.size, 0) }
  }, [state])

  return (
    <div className="mx-auto max-w-7xl space-y-4 px-4 py-6 sm:px-6" data-global-manager>
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <div className="text-lg font-semibold">📁 全域資源與資料夾管理</div>
          <p className="text-xs text-white/45">
            所有專案、共用資料夾與檔案（Cloudflare R2 與素材庫）。{state ? `${state.projects.length} 個專案 · ${totals.files} 個檔案 · ${formatBytes(totals.bytes)}` : ''}
          </p>
        </div>
        <div className="ml-auto grid grid-cols-2 gap-1 rounded-lg bg-black/40 p-0.5 text-xs" role="tablist">
          {(
            [
              ['folders', '📁 資料夾'],
              ['log', '📜 檔案流動紀錄'],
            ] as const
          ).map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={view === id} onClick={() => pickView(id)} className={`min-h-8 rounded-md px-3 font-semibold ${view === id ? 'bg-white/15 text-white' : 'text-white/45'}`} data-gm-view={id}>
              {label}
            </button>
          ))}
        </div>
        <button type="button" onClick={reload} className={`${btn} bg-white/[0.07] text-white/75 hover:bg-white/15`} data-gm-reload>
          ↻ 重新整理
        </button>
      </div>
      {note && (
        <p className={`rounded-lg px-3 py-2 text-xs ${note.ok ? 'bg-go/10 text-go' : 'bg-panic/10 text-panic'}`} data-gm-note>
          {note.text}
        </p>
      )}
      {error && <p className="text-sm text-panic">{error}</p>}
      {!state && !error && <p className="text-sm text-white/30">載入所有資料夾與檔案…</p>}
      {state && view === 'log' && <FileActivityLog state={state} run={run} />}
      {state && view === 'folders' && (
        <div className="grid gap-4 md:grid-cols-[260px_1fr]">
          {/* Tree */}
          <nav className="space-y-1 self-start rounded-2xl border border-line bg-panel/80 p-2 md:sticky md:top-20 md:max-h-[calc(100dvh-7rem)] md:overflow-y-auto" data-gm-tree>
            {GROUPS.map((g) => {
              const list = state.folders.filter((f) => f.group === g.id)
              if (list.length === 0) return null
              const single = g.id === 'default' || g.id === 'audience'
              return (
                <div key={g.id}>
                  <button
                    type="button"
                    onClick={() => (single ? setOpenId(list[0].id) : setExpanded((e) => ({ ...e, [g.id]: !e[g.id] })))}
                    className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs font-semibold ${single && openId === list[0].id ? 'bg-white/15 text-white' : 'text-white/70 hover:bg-white/[0.06]'}`}
                    data-gm-group={g.id}
                  >
                    {!single && <span className="w-3 text-white/40">{expanded[g.id] ? '▾' : '▸'}</span>}
                    <span>{g.icon}</span>
                    <span className="flex-1 truncate">{g.title}</span>
                    <span className="font-mono text-[10px] text-white/35">{single ? list[0].files.length : list.length}</span>
                  </button>
                  {!single && expanded[g.id] && (
                    <ul className="ml-4 border-l border-white/10 pl-1">
                      {list.map((f) => (
                        <li key={f.id}>
                          <button
                            type="button"
                            onClick={() => setOpenId(f.id)}
                            className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[11px] ${openId === f.id ? 'bg-white/15 text-white' : 'text-white/60 hover:bg-white/[0.06]'}`}
                            data-gm-folder={f.id}
                          >
                            {f.project?.isPinned && <span>📌</span>}
                            {f.project?.isLocked && <span>🔒</span>}
                            <span className="min-w-0 flex-1 truncate">{f.group === 'standalone' ? `🎛️ ${f.label}` : `📁 ${f.label}`}</span>
                            <span className="font-mono text-[10px] text-white/30">{f.files.length}</span>
                          </button>
                          {/* Set Cue parent → its Studio projects and its media */}
                          {f.project && f.group !== 'standalone' && (openId === f.id || openId.startsWith(`studio:${f.project.id}:`)) && (
                            <ul className="ml-3 border-l border-white/10 pl-1">
                              {f.studios.map((st) => (
                                <li key={st.id}>
                                  <button
                                    type="button"
                                    onClick={() => setOpenId(`studio:${f.project!.id}:${st.id}`)}
                                    className={`flex w-full items-center gap-1 rounded-md px-2 py-0.5 text-left text-[11px] ${openId === `studio:${f.project!.id}:${st.id}` ? 'bg-white/15 text-white' : 'text-white/55 hover:bg-white/[0.06]'}`}
                                    data-gm-studio={st.id}
                                  >
                                    <span className="text-white/30">├</span> 🎛️ <span className="truncate">{st.name}</span>
                                  </button>
                                </li>
                              ))}
                              <li>
                                <button type="button" onClick={() => setOpenId(f.id)} className="flex w-full items-center gap-1 rounded-md px-2 py-0.5 text-left text-[11px] text-white/45 hover:bg-white/[0.06]">
                                  <span className="text-white/30">└</span> 🎵 音檔與媒體素材 <span className="font-mono text-white/30">{f.files.length}</span>
                                </button>
                              </li>
                            </ul>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )
            })}
          </nav>

          {/* Folder, or one studio of a project */}
          {studioOpen && studioFolder ? (
            <StudioPanel key={openId} folder={studioFolder} studio={studioOpen} state={state} user={user} busy={busy} run={run} onGone={() => setOpenId(studioFolder.id)} />
          ) : (
            folder && <FolderView key={folder.id} folder={folder} state={state} user={user} busy={busy} run={run} openStudio={(sid) => setOpenId(`studio:${folder.project!.id}:${sid}`)} />
          )}
        </div>
      )}
    </div>
  )
}

function FolderView({
  folder,
  state,
  user,
  busy,
  run,
  openStudio,
}: {
  folder: FolderNode
  state: GlobalState
  user: AppUser
  busy: boolean
  run: (job: () => Promise<string>) => void
  openStudio: (studioId: string) => void
}) {
  const projects: ProjectSummary[] = folder.project ? [folder.project] : []
  return (
    <section className="min-w-0 space-y-4" data-gm-folder-view={folder.id}>
      <div className="rounded-2xl border border-line bg-panel/80 p-4">
        <div className="flex flex-wrap items-baseline gap-2">
          <h2 className="text-base font-semibold">{folder.group === 'default' ? '📌 Default 共用資料夾' : folder.group === 'audience' ? '👥 觀眾互動空間（Cloudinary）' : folder.group === 'orphan' ? `❓ ${folder.label}` : `📂 ${folder.label}`}</h2>
          <span className="text-[11px] text-white/40">{folder.files.length} 個檔案 · {formatBytes(folder.files.reduce((n, f) => n + f.size, 0))}</span>
        </div>
        {folder.prefixes.length > 0 && <p className="mt-1 truncate font-mono text-[10px] text-white/30">{folder.prefixes.join('  ·  ')}</p>}
        {folder.group === 'default' && (
          <>
            <p className="mt-1 text-[11px] text-white/45">
              <span className="mr-1 rounded bg-[#f6821f]/20 px-1 text-[#f6a35c]">R2</span>所有專案共用的音效、音樂與 Studio 專案檔，存在 Cloudflare R2。每個 Set Cue / Studio 專案都可以選用；只有管理員能上傳、重新命名、加標籤、移動或刪除。
            </p>
            {state.defaultOnCloudinary > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-standby/10 px-3 py-2 text-[11px] text-standby" data-gm-migrate-banner>
                還有 {state.defaultOnCloudinary} 個 Default 檔案在 Cloudinary（已不顯示）。
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      const r = await migrateDefaultToR2(user)
                      if (r.failed.length) throw new Error(`遷移了 ${r.moved} 個，失敗：${r.failed.join('；')}`)
                      return `✓ 已把 ${r.moved} 個檔案從 Cloudinary 複製到 R2 的 Default 資料夾（更新 ${r.refs} 個引用；Cloudinary 原檔保留）`
                    })
                  }
                  className={`${btn} bg-standby text-black`}
                  data-gm-migrate
                >
                  遷移到 R2
                </button>
              </div>
            )}
          </>
        )}
        {folder.group === 'audience' && (
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-white/45">
            <span>Cloudinary 只用於觀眾互動：觀眾在現場上傳的照片、錄音與影片。每個 Set Cue / Studio 專案都能在「選取檔案 → 觀眾上傳 → 所有專案」與 Studio 素材「👥 觀眾」使用審查通過的作品。</span>
            <button type="button" disabled={busy} onClick={() => run(async () => `✓ 已同步 ${await syncAudiencePool()} 筆較早的觀眾上傳到共用索引`)} className={`${btn} bg-white/[0.07] text-white/75 hover:bg-white/15`} data-gm-sync-audience>
              ↻ 同步較早的觀眾上傳
            </button>
          </div>
        )}
        {folder.group === 'orphan' && <p className="mt-1 text-[11px] text-standby">這個資料夾不屬於任何現有專案（專案已刪除或改名）。可以把檔案移到其他資料夾，或刪除。</p>}
      </div>
      {projects.length > 0 && <ProjectsPanel projects={projects} user={user} busy={busy} run={run} />}
      {folder.project && (folder.studios.length > 0 || folder.group !== 'standalone') && (
        <div className="space-y-2 rounded-2xl border border-line bg-panel/80 p-4" data-gm-studios>
          <h3 className="text-sm font-semibold">{folder.group === 'standalone' ? '🎛️ Studio' : `🎛️ 依附的 Studio 專案（${folder.studios.length}）`}</h3>
          {folder.studios.length === 0 && <p className="text-xs text-white/35">這個 Set Cue 專案還沒有 Studio</p>}
          <ul className="divide-y divide-white/[0.06]">
            {folder.studios.map((st) => (
              <li key={st.id} className="flex items-center gap-2 py-2 text-xs" data-gm-studio-row={st.id}>
                <span>🎛️</span>
                <button type="button" onClick={() => openStudio(st.id)} className="min-w-0 flex-1 truncate text-left font-medium text-white/90 hover:underline">
                  {st.name}
                </button>
                <span className="shrink-0 text-[10px] text-white/35">
                  {st.tracks} 軌 · {st.regions} 片段 · {formatWhen(st.updatedAt)}
                </span>
                <button type="button" onClick={() => openStudio(st.id)} className={`${btn} bg-white/[0.07] text-white/70 hover:bg-white/15`}>
                  管理 ›
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <FilesPanel folder={folder} state={state} busy={busy} run={run} />
    </section>
  )
}

function ProjectsPanel({ projects, user, busy, run }: { projects: ProjectSummary[]; user: AppUser; busy: boolean; run: (job: () => Promise<string>) => void }) {
  const p = projects[0]
  const flag = (key: 'isLocked' | 'isPinned' | 'isArchived' | 'isMasterTemplate', on: string, off: string) => (
    <button
      type="button"
      disabled={busy}
      onClick={() => run(async () => (await setProjectFlags(p.id, { [key]: !p[key] }, user), `✓ 「${p.name}」${p[key] ? on : off}`))}
      aria-pressed={!!p[key]}
      className={`${btn} ${p[key] ? 'bg-white/20 text-white' : 'bg-white/[0.07] text-white/65 hover:bg-white/15'}`}
      data-gm-flag={key}
    >
      {p[key] ? on : off}
    </button>
  )
  return (
    <div className="space-y-3 rounded-2xl border border-line bg-panel/80 p-4" data-gm-project={p.id}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">{p.kind === 'studio' ? '🎚' : '🎭'} {p.name}</span>
        <ProjectBadges project={p} />
      </div>
      <p className="text-[11px] text-white/40">
        {p.owner ? `建立者 ${p.owner.name} · ${p.owner.email}` : '建立者未記錄'} · {p.collaboratorIds.length} 位協作者 · {p.versions.length} 個版本 · 更新於 {formatWhen(p.updatedAt)}
      </p>
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            const name = prompt('新的專案名稱', p.name)
            if (name && name.trim() && name.trim() !== p.name) run(async () => (await renameProject(p.id, name), `✓ 已重新命名為「${name.trim()}」`))
          }}
          className={`${btn} bg-white/[0.07] text-white/75 hover:bg-white/15`}
          data-gm-rename
        >
          ✎ 重新命名
        </button>
        {flag('isPinned', '📌 取消置頂', '📌 置頂')}
        {flag('isLocked', '🔓 解除鎖定', '🔒 唯讀鎖定')}
        {flag('isMasterTemplate', '✖ 取消官方範本', '⭐ 移到官方範本')}
        {flag('isArchived', '↩ 移回專案資料夾', '📦 移到已封存')}
        <button
          type="button"
          disabled={busy}
          onClick={() => confirm(`把「${p.name}」移到回收桶？（可在「🗑 回收桶」還原）`) && run(async () => (await deleteProject(p.id, user), `✓ 已將「${p.name}」移到回收桶`))}
          className={`${btn} ml-auto text-white/45 hover:bg-panic/15 hover:text-panic`}
          data-gm-trash
        >
          🗑 移到回收桶
        </button>
      </div>
      <p className="text-[10px] text-white/30">專案的檔案資料夾以專案名稱命名；重新命名專案後，新上傳的檔案會放進新名稱的資料夾，既有檔案留在原處（可在下方移動）。</p>
    </div>
  )
}

function FilesPanel({ folder, state, busy, run }: { folder: FolderNode; state: GlobalState; busy: boolean; run: (job: () => Promise<string>) => void }) {
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<'all' | 'audio' | 'project'>('all')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<ManagedFile | null>(null)
  const [moving, setMoving] = useState<ManagedFile[] | null>(null)
  const [assigning, setAssigning] = useState<ManagedFile | null>(null)
  const [playing, setPlaying] = useState<string | null>(null)
  const audio = useRef<HTMLAudioElement | null>(null)
  useEffect(() => () => audio.current?.pause(), [])

  const q = query.trim().toLowerCase()
  const files = folder.files.filter(
    (f) =>
      (kind === 'all' || (kind === 'audio' ? f.kind === 'audio' || f.kind === 'video' : f.kind === 'project' || f.kind === 'config')) &&
      (!q || f.name.toLowerCase().includes(q) || f.label.toLowerCase().includes(q) || f.tags.some((t) => t.toLowerCase().includes(q))),
  )
  const chosen = files.filter((f) => selected.has(f.id))
  const allKeys = useMemo(() => new Set(state.folders.flatMap((n) => n.files.map((f) => f.id))), [state])

  const play = (f: ManagedFile) => {
    audio.current?.pause()
    if (playing === f.id) return setPlaying(null)
    const el = new Audio(f.url)
    el.onended = () => setPlaying(null)
    el.play().catch(() => setPlaying(null))
    audio.current = el
    setPlaying(f.id)
  }
  const toggle = (id: string) => setSelected((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])))
  const remove = (list: ManagedFile[]) => {
    const used = list.filter((f) => f.usedBy.length)
    const warn = used.length ? `\n\n⚠ 其中 ${used.length} 個檔案正被專案使用（${[...new Set(used.flatMap((f) => f.usedBy))].join('、')}），刪除後這些 Cue / 片段會無法播放。` : ''
    if (!confirm(`永久刪除 ${list.length} 個檔案？${warn}`)) return
    run(async () => {
      for (const f of list) await deleteFile(f)
      setSelected(new Set())
      return `✓ 已刪除 ${list.length} 個檔案`
    })
  }

  return (
    <div className="space-y-2 rounded-2xl border border-line bg-panel/80 p-4" data-gm-files>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">檔案</h3>
        <div className="grid grid-cols-3 gap-0.5 rounded-lg bg-black/40 p-0.5 text-[11px]">
          {(
            [
              ['all', '全部'],
              ['audio', '音檔 / 影片'],
              ['project', '專案 / 設定檔'],
            ] as const
          ).map(([id, label]) => (
            <button key={id} type="button" onClick={() => setKind(id)} className={`min-h-7 rounded-md px-2 font-semibold ${kind === id ? 'bg-white/15 text-white' : 'text-white/45'}`} data-gm-kind={id}>
              {label}
            </button>
          ))}
        </div>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜尋名稱或標籤" className="ml-auto h-8 w-48 rounded-lg border border-white/15 bg-black/40 px-2 text-xs text-white outline-none focus:border-accent" data-gm-search />
      </div>
      {chosen.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-accent/15 px-3 py-2 text-xs" data-gm-batch>
          <span className="font-semibold">已選 {chosen.length} 個</span>
          <button type="button" disabled={busy || chosen.some((f) => !f.key)} onClick={() => setMoving(chosen)} className={`${btn} bg-white/15 text-white`} data-gm-batch-move>
            ↪ 移動到…
          </button>
          <button type="button" disabled={busy} onClick={() => remove(chosen)} className={`${btn} bg-panic/70 text-white`} data-gm-batch-delete>
            🗑 刪除
          </button>
          <button type="button" onClick={() => setSelected(new Set())} className={`${btn} text-white/55`}>
            取消選取
          </button>
        </div>
      )}
      {files.length === 0 ? (
        <p className="py-8 text-center text-xs text-white/35">{folder.files.length ? '沒有符合的檔案' : '這個資料夾還沒有檔案'}</p>
      ) : (
        <ul className="divide-y divide-white/[0.06]">
          {files.map((f) => (
            <li key={f.id} className="flex flex-wrap items-center gap-2 py-2 text-xs" data-gm-file={f.name}>
              <input type="checkbox" checked={selected.has(f.id)} onChange={() => toggle(f.id)} className="h-4 w-4 accent-[#0a84ff]" aria-label={`選取 ${f.name}`} />
              {f.kind === 'audio' || f.kind === 'video' ? (
                <button type="button" onClick={() => play(f)} className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${playing === f.id ? 'bg-go text-black' : 'bg-white/10 text-white/80 hover:bg-white/20'}`} aria-label={`試聽 ${f.name}`} data-gm-play>
                  {playing === f.id ? '■' : '▶'}
                </button>
              ) : (
                <span className="flex h-8 w-8 shrink-0 items-center justify-center text-base">{KIND_ICON[f.kind]}</span>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1">
                  <span className="truncate font-medium text-white/90" title={f.name}>
                    {f.label || f.name}
                  </span>
                  {f.label && <span className="truncate text-[10px] text-white/35">（{f.name}）</span>}
                  {f.tags.map((t) => (
                    <span key={t} className="rounded-full bg-[#bf5af2]/20 px-1.5 text-[10px] text-[#d29bf5]" data-gm-tag={t}>
                      #{t}
                    </span>
                  ))}
                </div>
                <div className="truncate font-mono text-[10px] text-white/35">
                  {f.storage === 'r2' ? <span className="mr-1 rounded bg-[#f6821f]/20 px-1 text-[#f6a35c]">R2</span> : <span className="mr-1">☁</span>}
                  {f.folder}/ · {formatBytes(f.size)}
                  {f.lastModified ? ` · ${formatWhen(f.lastModified)}` : ''}
                </div>
                <div className={`truncate text-[10px] ${f.usedBy.length ? 'text-go/80' : 'text-white/30'}`} data-gm-used>
                  {f.usedBy.length ? `使用中：${[...new Set(f.usedBy)].join('、')}` : '沒有專案使用'}
                </div>
              </div>
              <div className="flex shrink-0 gap-1">
                <button type="button" onClick={() => setEditing(f)} className={`${btn} bg-white/[0.07] text-white/70 hover:bg-white/15`} data-gm-edit>
                  ✎ 名稱 / 標籤
                </button>
                <button type="button" disabled={!f.key || busy} onClick={() => setMoving([f])} className={`${btn} bg-white/[0.07] text-white/70 hover:bg-white/15`} data-gm-move title={f.key ? '' : 'Cloudinary 檔案無法移動'}>
                  ↪ 移動
                </button>
                <button type="button" disabled={busy} onClick={() => setAssigning(f)} className={`${btn} bg-white/[0.07] text-white/70 hover:bg-white/15`} data-gm-assign>
                  ⧉ 指派
                </button>
                <button type="button" disabled={busy || !f.key} onClick={() => remove([f])} className={`${btn} text-white/40 hover:bg-panic/15 hover:text-panic`} data-gm-delete>
                  🗑
                </button>
              </div>
              {editing?.id === f.id && <LabelEditor file={f} onClose={() => setEditing(null)} run={run} />}
              {moving?.length === 1 && moving[0].id === f.id && <MovePicker files={moving} state={state} existing={allKeys} onClose={() => setMoving(null)} run={run} />}
              {assigning?.id === f.id && <AssignPicker file={f} state={state} onClose={() => setAssigning(null)} run={run} />}
            </li>
          ))}
        </ul>
      )}
      {moving && moving.length > 1 && <MovePicker files={moving} state={state} existing={allKeys} onClose={() => (setMoving(null), setSelected(new Set()))} run={run} />}
    </div>
  )
}

const panel = 'basis-full space-y-2 rounded-xl border border-white/10 bg-black/40 p-3'

function LabelEditor({ file, onClose, run }: { file: ManagedFile; onClose: () => void; run: (job: () => Promise<string>) => void }) {
  const [label, setLabel] = useState(file.label || file.name)
  const [tags, setTags] = useState(file.tags.join(', '))
  return (
    <div className={panel} data-gm-label-editor>
      <p className="text-[11px] text-white/45">名稱只改顯示（素材庫與選取檔案時看到的名稱），檔案位址不變，使用中的 Cue / 片段不受影響。</p>
      <div className="flex flex-wrap gap-2">
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="顯示名稱" className="h-9 min-w-48 flex-1 rounded-lg border border-white/15 bg-black/40 px-2 text-xs text-white outline-none focus:border-accent" data-gm-label-input />
        <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="標籤（以逗號分隔，例如：音效, 第一幕）" className="h-9 min-w-48 flex-1 rounded-lg border border-white/15 bg-black/40 px-2 text-xs text-white outline-none focus:border-accent" data-gm-tags-input />
        <button
          type="button"
          onClick={() => {
            onClose()
            run(async () => (await setFileLabel(file, label === file.name ? '' : label, tags.split(/[,，]/)), `✓ 已更新「${label || file.name}」`))
          }}
          className={`${btn} bg-accent text-white`}
          data-gm-label-save
        >
          儲存
        </button>
        <button type="button" onClick={onClose} className={`${btn} text-white/50`}>
          取消
        </button>
      </div>
    </div>
  )
}

function MovePicker({ files, state, existing, onClose, run }: { files: ManagedFile[]; state: GlobalState; existing: Set<string>; onClose: () => void; run: (job: () => Promise<string>) => void }) {
  // Same kind of folder (cues / hits / daw) as the files.
  const area = files[0].folder.split('/').slice(0, 2).join('/')
  const options = state.destinations.filter((d) => d.prefix.startsWith(`${area}/`) && !files.every((f) => f.folder === d.prefix))
  const [dest, setDest] = useState(options[0]?.prefix ?? '')
  return (
    <div className={panel} data-gm-move-picker>
      <p className="text-[11px] text-white/45">移動 {files.length} 個檔案：檔案會複製到新資料夾，所有使用它的 Cue、Hits、Studio 片段與素材庫會自動改用新位址，再刪除舊檔。</p>
      <div className="flex flex-wrap gap-2">
        <select value={dest} onChange={(e) => setDest(e.target.value)} className="h-9 min-w-56 flex-1 rounded-lg border border-white/15 bg-black/40 px-2 text-xs text-white" data-gm-move-dest>
          {options.map((o) => (
            <option key={o.prefix} value={o.prefix}>
              {o.label} — {o.prefix}/
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={!dest}
          onClick={() => {
            onClose()
            run(async () => {
              let refs = 0
              for (const f of files) refs += await moveFile(f, dest, existing)
              return `✓ 已移動 ${files.length} 個檔案到 ${dest}/（更新了 ${refs} 個引用）`
            })
          }}
          className={`${btn} bg-accent text-white`}
          data-gm-move-go
        >
          移動
        </button>
        <button type="button" onClick={onClose} className={`${btn} text-white/50`}>
          取消
        </button>
      </div>
    </div>
  )
}

function AssignPicker({ file, state, onClose, run }: { file: ManagedFile; state: GlobalState; onClose: () => void; run: (job: () => Promise<string>) => void }) {
  const targets = [...state.projects].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'))
  const [pid, setPid] = useState(targets[0]?.id ?? '')
  const project = targets.find((p) => p.id === pid)
  return (
    <div className={panel} data-gm-assign-picker>
      <p className="text-[11px] text-white/45">「加入素材庫」：專案的選取檔案清單會出現這個檔案（同一個檔案）。「複製一份」：複製到專案自己的資料夾，原檔刪除也不受影響。</p>
      <div className="flex flex-wrap gap-2">
        <select value={pid} onChange={(e) => setPid(e.target.value)} className="h-9 min-w-56 flex-1 rounded-lg border border-white/15 bg-black/40 px-2 text-xs text-white" data-gm-assign-project>
          {targets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.kind === 'studio' ? '🎚' : '🎭'} {p.name}
            </option>
          ))}
        </select>
        <button type="button" disabled={!project} onClick={() => (onClose(), run(async () => (await assignFile(file, project!, 'link'), `✓ 已加入「${project!.name}」的素材庫`)))} className={`${btn} bg-accent text-white`} data-gm-assign-link>
          加入素材庫
        </button>
        <button type="button" disabled={!project || !file.key} onClick={() => (onClose(), run(async () => (await assignFile(file, project!, 'copy'), `✓ 已複製到「${project!.name}」的資料夾並加入素材庫`)))} className={`${btn} bg-white/15 text-white`} data-gm-assign-copy>
          複製一份
        </button>
        <button type="button" onClick={onClose} className={`${btn} text-white/50`}>
          取消
        </button>
      </div>
    </div>
  )
}

/** One Studio project inside its Set Cue parent: open, rename, re-assign the parent, trash. */
function StudioPanel({
  folder,
  studio,
  state,
  user,
  busy,
  run,
  onGone,
}: {
  folder: FolderNode
  studio: StudioSummaryRow
  state: GlobalState
  user: AppUser
  busy: boolean
  run: (job: () => Promise<string>) => void
  onGone: () => void
}) {
  const [moving, setMoving] = useState(false)
  const project = folder.project!
  const standalone = project.kind === 'studio'
  const file = folder.files.find((f) => f.key === `theatre/projects/${project.id}/${studio.id}.json`)
  const version = project.versions[0]?.id ?? ''
  return (
    <section className="min-w-0 space-y-4" data-gm-studio-view={studio.id}>
      <div className="space-y-3 rounded-2xl border border-line bg-panel/80 p-4">
        <div className="text-[11px] text-white/40">{standalone ? '🎛️ 未指定母專案的 Studio' : `📁 ${project.name}`} ›</div>
        <h2 className="text-base font-semibold">🎛️ {studio.name}</h2>
        <p className="text-[11px] text-white/45">
          {studio.tracks} 軌 · {studio.regions} 片段 · 更新於 {formatWhen(studio.updatedAt)}
          {file ? ` · R2 存檔 ${formatBytes(file.size)}` : ' · 尚未自動存到 R2'}
        </p>
        <div className="flex flex-wrap gap-1.5">
          <a href={`?role=studio&project=${project.id}&version=${version}&studio=${studio.id}`} target="_blank" rel="noreferrer" className={`${btn} flex items-center bg-go text-black`} data-gm-studio-open>
            開啟 Studio ↗
          </a>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              const name = prompt('Studio 新名稱', studio.name)?.trim()
              if (name && name !== studio.name) run(async () => (await renameStudio(project.id, studio.id, name), `✓ 已重新命名為「${name}」`))
            }}
            className={`${btn} bg-white/[0.07] text-white/75 hover:bg-white/15`}
            data-gm-studio-rename
          >
            ✎ 重新命名
          </button>
          <button type="button" disabled={busy} onClick={() => setMoving(true)} className={`${btn} bg-white/[0.07] text-white/75 hover:bg-white/15`} data-gm-studio-move>
            ↪ {standalone ? '指定 Set Cue 母專案' : '移到其他 Set Cue 專案'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (!confirm(`把 Studio「${studio.name}」移到回收桶？（可在「🗑 回收桶」還原）`)) return
              onGone()
              run(async () => (await softDeleteStudio(project.id, studio.id, user), `✓ 已將 Studio「${studio.name}」移到回收桶`))
            }}
            className={`${btn} ml-auto text-white/45 hover:bg-panic/15 hover:text-panic`}
            data-gm-studio-trash
          >
            🗑 移至回收桶
          </button>
        </div>
      </div>
      <MoveStudioDialog
        open={moving}
        onClose={() => setMoving(false)}
        studio={{ projectId: project.id, studioId: studio.id, name: studio.name, project }}
        user={user}
        projects={state.projects}
        onDone={(text, ok = true) => {
          if (ok) onGone()
          run(async () => {
            if (!ok) throw new Error(text)
            return text
          })
        }}
      />
    </section>
  )
}
