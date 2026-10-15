import { ref, update } from 'firebase/database'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { moveFile, setFileLabel, type GlobalState, type ManagedFile } from '../../services/adminFiles'
import { CATEGORY_FOLDERS, studioFolderId } from '../../services/assetLibrary'
import { db } from '../../services/firebase'
import { ACTION_LABELS, fileTypeOf, logFileActivity, projectOfRecord, useFileActivity, type FileActivity, type FileType } from '../../services/fileActivity'
import { consoleUrl } from '../../services/navigation'
import { formatWhen } from '../../utils/formatFile'

/** One row: a logged change, or a file that existed before the log (one row per file). */
interface Row extends Omit<FileActivity, 'action'> {
  action: FileActivity['action'] | 'existing'
  /** The live file (for actions), when it still exists. */
  file: ManagedFile | null
}

const TYPE_LABEL: Record<FileType, string> = { audio: 'Audio', image: 'Image', video: 'Video', document: 'Script / 專案檔', other: '其他' }
const ACTION_STYLE: Record<Row['action'], string> = {
  upload: 'bg-go/15 text-go',
  link: 'bg-accent/15 text-accent',
  assign: 'bg-accent/15 text-accent',
  rename: 'bg-[#bf5af2]/15 text-[#d7a6ff]',
  move: 'bg-standby/15 text-standby',
  delete: 'bg-panic/15 text-panic',
  existing: 'bg-white/[0.07] text-white/50',
}
type Range = 'today' | 'week' | 'month' | 'all' | 'custom'
const DAY = 86_400_000
const btn = 'min-h-8 rounded-lg px-2.5 text-[11px] font-semibold disabled:opacity-40'
const field = 'h-8 rounded-lg border border-white/15 bg-black/40 px-2 text-xs text-white outline-none focus:border-accent'

/**
 * 📜 檔案流動紀錄 (global manager, admins): who uploaded, added, renamed, moved, assigned or deleted
 * which file, from which project — plus every file that existed before the log started. Filter by
 * time, project, type, action and keyword; act on a file right from its row: double-click the name
 * to rename, move it to another storage folder (e.g. Default) or a Studio folder (背景音樂, 錄音…),
 * preview, download, or open its project.
 */
export function FileActivityLog({ state, run }: { state: GlobalState; run: (job: () => Promise<string>) => void }) {
  const { entries, error } = useFileActivity()
  const [range, setRange] = useState<Range>('all')
  // The moment the time range is measured from (refreshed whenever a range is picked).
  const [now, setNow] = useState(() => Date.now())
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [project, setProject] = useState('all')
  const [type, setType] = useState<'all' | FileType>('all')
  const [action, setAction] = useState<'all' | Row['action']>('all')
  const [q, setQ] = useState('')
  const [limit, setLimit] = useState(200)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ row: Row; x: number; y: number } | null>(null)
  const [playing, setPlaying] = useState<string | null>(null)
  const audio = useRef<HTMLAudioElement | null>(null)
  useEffect(() => () => audio.current?.pause(), [])

  const files = useMemo(() => state.folders.flatMap((f) => f.files.map((file) => ({ file, folder: f }))), [state])
  const byAddress = useMemo(() => {
    const m = new Map<string, ManagedFile>()
    for (const { file } of files) {
      if (file.key) m.set(file.key, file)
      m.set(file.url, file)
    }
    return m
  }, [files])

  // A file's current name: its admin label, else the newest name the log knows (renames in a
  // project's 素材 panel), else its storage name.
  const latestName = useMemo(() => {
    const m = new Map<string, string>()
    for (const e of entries ?? []) for (const a of [e.key, e.url]) if (a && !m.has(a) && e.action !== 'delete') m.set(a, e.name)
    return m
  }, [entries])
  const nameOf = (f: ManagedFile) => f.label || (f.key && latestName.get(f.key)) || latestName.get(f.url) || f.name

  const rows = useMemo<Row[]>(() => {
    const logged = (entries ?? []).map((e) => ({ ...e, file: (e.key && byAddress.get(e.key)) || (e.url && byAddress.get(e.url)) || null }))
    // Files nobody has touched since the log started: one 「既有檔案」 row each.
    const seen = new Set(logged.flatMap((e) => [e.key, e.url].filter(Boolean) as string[]))
    const existing: Row[] = files
      .filter(({ file }) => !(file.key && seen.has(file.key)) && !seen.has(file.url))
      .map(({ file, folder }) => {
        const record = file.indexPaths.find((p) => projectOfRecord(p)) ?? file.indexPaths[0] ?? null
        const projectId = folder.project?.id ?? (record ? projectOfRecord(record) : null)
        return {
          id: `existing:${file.id}`,
          at: file.lastModified,
          action: 'existing' as const,
          name: file.label || file.name,
          fileType: fileTypeOf(file.name, file.kind),
          storage: file.storage,
          url: file.url,
          key: file.key,
          record,
          projectId,
          projectName: folder.project?.name ?? folder.label,
          studioId: null,
          studioName: null,
          editor: null,
          from: null,
          to: file.folder,
          file,
        }
      })
    return [...logged, ...existing].sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
  }, [entries, files, byAddress])

  const projects = useMemo(() => {
    const m = new Map<string, string>()
    for (const r of rows) m.set(r.projectId ?? `name:${r.projectName ?? ''}`, r.projectName ?? '（無）')
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1], 'zh-Hant'))
  }, [rows])

  const shown = useMemo(() => {
    const start = new Date(now)
    start.setHours(0, 0, 0, 0)
    const lo = range === 'today' ? start.getTime() : range === 'week' ? now - 7 * DAY : range === 'month' ? now - 30 * DAY : range === 'custom' && from ? new Date(`${from}T00:00`).getTime() : 0
    const hi = range === 'custom' && to ? new Date(`${to}T23:59:59.999`).getTime() : Infinity
    const needle = q.trim().toLowerCase()
    return rows.filter(
      (r) =>
        (r.at ?? 0) >= lo &&
        (r.at ?? 0) <= hi &&
        (project === 'all' || (r.projectId ?? `name:${r.projectName ?? ''}`) === project) &&
        (type === 'all' || r.fileType === type) &&
        (action === 'all' || r.action === action) &&
        (!needle || [r.name, r.editor?.name, r.editor?.email, r.from, r.to].some((s) => s?.toLowerCase().includes(needle))),
    )
  }, [rows, now, range, from, to, project, type, action, q])

  /* ---------- actions ---------- */

  const rename = (row: Row, name: string) => {
    const file = row.file
    if (!file || !name.trim() || name.trim() === nameOf(file)) return
    run(async () => {
      await setFileLabel(file, name, file.tags, nameOf(file))
      return `✓ 已重新命名為「${name.trim()}」`
    })
  }
  const preview = (row: Row) => {
    audio.current?.pause()
    if (playing === row.id || !row.url) return setPlaying(null)
    const el = new Audio(row.url)
    el.onended = () => setPlaying(null)
    el.play().catch(() => setPlaying(null))
    audio.current = el
    setPlaying(row.id)
  }
  const openProject = (row: Row) => {
    const p = state.projects.find((x) => x.id === row.projectId)
    const version = p?.versions[0]?.id
    if (!p || !version) return
    const url = row.studioId
      ? `${location.pathname}?role=studio&project=${encodeURIComponent(p.id)}&version=${encodeURIComponent(version)}&studio=${encodeURIComponent(row.studioId)}`
      : consoleUrl({ projectId: p.id, versionId: version })
    window.open(url, '_blank', 'noopener')
  }
  /** Storage folder (R2): the file moves, everything that uses it follows. */
  const moveStorage = (file: ManagedFile, prefix: string) =>
    run(async () => {
      const existing = new Set(files.map((f) => f.file.key).filter((k): k is string => !!k))
      const n = await moveFile(file, prefix, existing)
      return `✓ 已移到 ${prefix}（更新 ${n} 處引用）`
    })
  /** Studio folder (素材 panel): the project's library record is re-filed. */
  const moveFolder = (row: Row, record: string, folderId: string | null, label: string) =>
    run(async () => {
      await update(ref(db, record), { assetFolder: folderId })
      await logFileActivity({ action: 'move', name: row.name, fileType: row.fileType, storage: row.storage, url: row.url, key: row.key, record, projectId: projectOfRecord(record), studioId: folderId?.split(':')[1] ?? null, from: row.to, to: label })
      return `✓ 已移到「${label}」`
    })

  const editorOf = (r: Row) => (r.editor ? r.editor.name || r.editor.email : r.action === 'existing' ? '—（早於紀錄）' : '—')

  return (
    <div className="space-y-3" data-file-log>
      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-line bg-panel/80 p-3" data-file-log-filters>
        <div className="grid grid-cols-5 gap-1 rounded-lg bg-black/40 p-0.5 text-[11px]">
          {(
            [
              ['today', '今天'],
              ['week', '7 天'],
              ['month', '30 天'],
              ['all', '全部'],
              ['custom', '自訂'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => {
                setRange(id)
                setNow(Date.now())
              }} className={`min-h-7 rounded-md px-2 font-semibold ${range === id ? 'bg-white/15 text-white' : 'text-white/45'}`} data-log-range={id}>
              {label}
            </button>
          ))}
        </div>
        {range === 'custom' && (
          <>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={field} aria-label="開始日期" data-log-from />
            <span className="text-white/30">～</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={field} aria-label="結束日期" data-log-to />
          </>
        )}
        <select value={project} onChange={(e) => setProject(e.target.value)} className={field} aria-label="專案" data-log-project>
          <option value="all">所有專案</option>
          {projects.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
        <select value={type} onChange={(e) => setType(e.target.value as typeof type)} className={field} aria-label="檔案類型" data-log-type>
          <option value="all">所有類型</option>
          {(Object.keys(TYPE_LABEL) as FileType[]).map((t) => (
            <option key={t} value={t}>
              {TYPE_LABEL[t]}
            </option>
          ))}
        </select>
        <select value={action} onChange={(e) => setAction(e.target.value as typeof action)} className={field} aria-label="動作" data-log-action>
          <option value="all">所有動作</option>
          {(Object.keys(ACTION_LABELS) as Row['action'][]).map((a) => (
            <option key={a} value={a}>
              {ACTION_LABELS[a]}
            </option>
          ))}
        </select>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜尋檔名或編輯者" className={`${field} ml-auto w-48`} data-log-search />
        <span className="w-full text-[11px] text-white/40" data-log-count>
          {entries === null ? '載入紀錄中…' : `${shown.length} 筆（共 ${rows.length} 筆：${entries.length} 筆異動紀錄、${rows.length - entries.length} 個既有檔案）`}
        </span>
      </div>
      {error && <p className="text-xs text-panic">無法讀取紀錄：{error}</p>}

      <div className="overflow-x-auto rounded-2xl border border-line bg-panel/80">
        <table className="w-full min-w-[920px] text-left text-xs" data-log-table>
          <thead className="border-b border-line text-[11px] text-white/45">
            <tr>
              <th className="px-3 py-2 font-medium">時間・動作</th>
              <th className="px-3 py-2 font-medium">檔案名稱</th>
              <th className="px-3 py-2 font-medium">類型</th>
              <th className="px-3 py-2 font-medium">編輯者</th>
              <th className="px-3 py-2 font-medium">所屬專案</th>
              <th className="px-3 py-2 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {shown.slice(0, limit).map((r) => (
              <tr
                key={r.id}
                className="hover:bg-white/[0.03]"
                data-log-row={r.id}
                onContextMenu={(e) => {
                  if (!r.file) return
                  e.preventDefault()
                  setMenu({ row: r, x: e.clientX, y: e.clientY })
                }}
              >
                <td className="px-3 py-2 align-top whitespace-nowrap">
                  <div className="text-white/70">{r.at ? formatWhen(r.at) : '—'}</div>
                  <span className={`mt-0.5 inline-block rounded px-1.5 text-[10px] font-semibold ${ACTION_STYLE[r.action]}`} data-log-action-badge={r.action}>
                    {ACTION_LABELS[r.action]}
                  </span>
                </td>
                <td className="max-w-72 px-3 py-2 align-top">
                  {renaming === r.id && r.file ? (
                    <input
                      autoFocus
                      defaultValue={nameOf(r.file)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          setRenaming(null)
                          rename(r, e.currentTarget.value)
                        }
                        if (e.key === 'Escape') setRenaming(null)
                      }}
                      onBlur={(e) => {
                        setRenaming(null)
                        rename(r, e.currentTarget.value)
                      }}
                      className="w-full rounded border border-accent bg-black/60 px-1.5 py-0.5 text-xs text-white outline-none"
                      data-log-rename-input
                    />
                  ) : (
                    <div
                      className={`truncate text-white/90 ${r.file ? 'cursor-text' : 'text-white/45 line-through decoration-white/30'}`}
                      title={r.file ? `${r.name}（雙擊重新命名）` : `${r.name}（檔案已不存在）`}
                      onDoubleClick={() => r.file && setRenaming(r.id)}
                      data-log-name={r.id}
                    >
                      {r.file ? nameOf(r.file) : r.name}
                    </div>
                  )}
                  {(r.from || r.to) && r.action !== 'existing' && (
                    <div className="truncate text-[10px] text-white/40">
                      {r.from ?? '—'} → {r.to ?? '—'}
                    </div>
                  )}
                  {r.action === 'existing' && <div className="truncate font-mono text-[10px] text-white/30">{r.to}</div>}
                </td>
                <td className="px-3 py-2 align-top whitespace-nowrap">
                  <span className="text-white/75">{TYPE_LABEL[r.fileType] ?? r.fileType}</span>
                  {r.storage && (
                    <span className={`ml-1 rounded px-1 text-[10px] ${r.storage === 'r2' ? 'bg-[#f6821f]/20 text-[#f6a35c]' : 'bg-[#3448c5]/30 text-[#9aa8ff]'}`}>{r.storage === 'r2' ? 'R2' : 'Cloudinary'}</span>
                  )}
                </td>
                <td className="max-w-40 truncate px-3 py-2 align-top text-white/70" title={r.editor?.email}>
                  {editorOf(r)}
                </td>
                <td className="max-w-48 px-3 py-2 align-top">
                  <div className="truncate text-white/75">{r.projectName ?? '—'}</div>
                  {r.studioName && <div className="truncate text-[10px] text-[#d7a6ff]">🎛️ {r.studioName}</div>}
                </td>
                <td className="px-3 py-2 text-right align-top whitespace-nowrap">
                  {r.url && (r.fileType === 'audio' || r.fileType === 'video') && r.file && (
                    <button type="button" onClick={() => preview(r)} className={`${btn} ${playing === r.id ? 'bg-go text-black' : 'bg-white/[0.07] text-white/75'}`} aria-label="試聽" data-log-play={r.id}>
                      {playing === r.id ? '■' : '▶'}
                    </button>
                  )}
                  {r.file && (
                    <a href={r.file.url} download={nameOf(r.file)} className={`${btn} ml-1 inline-flex items-center bg-white/[0.07] text-white/75 hover:bg-white/15`} aria-label="下載" data-log-download={r.id}>
                      ⬇
                    </a>
                  )}
                  {r.projectId && state.projects.some((p) => p.id === r.projectId) && (
                    <button type="button" onClick={() => openProject(r)} className={`${btn} ml-1 bg-white/[0.07] text-white/75 hover:bg-white/15`} title="開啟所屬專案" data-log-open={r.id}>
                      ↗
                    </button>
                  )}
                  {r.file && (
                    <button
                      type="button"
                      onClick={(e) => {
                        const b = e.currentTarget.getBoundingClientRect()
                        setMenu({ row: r, x: b.right - 260, y: b.bottom + 4 })
                      }}
                      className={`${btn} ml-1 bg-white/[0.07] text-white/75 hover:bg-white/15`}
                      title="移動到其他資料夾"
                      data-log-move={r.id}
                    >
                      📁 移動
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length === 0 && <p className="p-6 text-center text-xs text-white/35">{entries === null ? '載入中…' : '沒有符合條件的紀錄'}</p>}
        {shown.length > limit && (
          <button type="button" onClick={() => setLimit((n) => n + 200)} className="w-full border-t border-line py-2 text-xs text-white/55 hover:bg-white/[0.04]" data-log-more>
            顯示更多（還有 {shown.length - limit} 筆）
          </button>
        )}
      </div>

      {menu && <MoveMenu {...menu} state={state} onClose={() => setMenu(null)} onStorage={moveStorage} onFolder={moveFolder} />}
    </div>
  )
}

/** Where a file can go: another storage folder of the same kind (R2), or a folder of its project's Studios. */
function MoveMenu({
  row,
  x,
  y,
  state,
  onClose,
  onStorage,
  onFolder,
}: {
  row: Row
  x: number
  y: number
  state: GlobalState
  onClose: () => void
  onStorage: (file: ManagedFile, prefix: string) => void
  onFolder: (row: Row, record: string, folderId: string | null, label: string) => void
}) {
  const box = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  useEffect(() => {
    close.current = onClose
  })
  useEffect(() => {
    const away = (e: Event) => !box.current?.contains(e.target as Node) && close.current()
    const key = (e: KeyboardEvent) => e.key === 'Escape' && close.current()
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('pointerdown', away, true)
      window.removeEventListener('keydown', key)
    }
  }, [])
  const file = row.file!
  const area = file.key ? file.key.split('/').slice(0, 2).join('/') : null
  const storage = area ? state.destinations.filter((d) => d.prefix.startsWith(`${area}/`) && d.prefix !== file.folder) : []
  // The file's library records in projects (each can be filed in its project's Studio folders).
  const records = file.indexPaths.filter((p) => projectOfRecord(p))
  const item = (label: string, run: () => void, id: string, indent = 0) => (
    <button
      key={id}
      type="button"
      onClick={() => {
        run()
        close.current()
      }}
      className="block w-full truncate rounded-md px-3 py-1.5 text-left text-xs text-white/85 hover:bg-white/10"
      style={{ paddingLeft: 12 + indent * 14 }}
      data-log-move-to={id}
    >
      {label}
    </button>
  )
  return createPortal(
    <div
      ref={box}
      className="fixed z-[95] max-h-[70dvh] w-64 overflow-y-auto rounded-xl border border-white/10 bg-[#202020]/95 p-1 text-white shadow-2xl backdrop-blur-xl"
      style={{ left: Math.max(8, Math.min(x, window.innerWidth - 264)), top: Math.max(8, Math.min(y, window.innerHeight - 320)) }}
      role="menu"
      aria-label={`移動「${row.name}」`}
      data-log-move-menu
    >
      <div className="truncate px-3 pt-1 pb-1.5 text-[11px] font-semibold text-white/45">移動「{file.label || file.name}」</div>
      {storage.length > 0 && <div className="px-3 pt-1 text-[10px] text-white/35">儲存資料夾（R2，引用會跟著更新）</div>}
      {storage.map((d) => item(`${/\/Default$/.test(d.prefix) ? '📌 ' : '📁 '}${d.label}`, () => onStorage(file, d.prefix), `storage:${d.prefix}`))}
      {records.map((rec) => {
        const pid = projectOfRecord(rec)!
        const folder = state.folders.find((f) => f.project?.id === pid)
        if (!folder) return null
        return (
          <div key={rec} className="border-t border-white/10 pt-1">
            <div className="px-3 pt-1 text-[10px] text-white/35">「{folder.project!.name}」素材資料夾</div>
            {item('（最上層，不放資料夾）', () => onFolder(row, rec, null, '最上層'), `folder:${rec}:root`)}
            {folder.studios.flatMap((st) => [
              <div key={`h-${st.id}`} className="px-3 pt-1 text-[11px] text-[#d7a6ff]">
                🎛️ {st.name}
              </div>,
              ...CATEGORY_FOLDERS.map((c) => item(c.name, () => onFolder(row, rec, studioFolderId(st.id, c.id), `${st.name} / ${c.name}`), `folder:${rec}:${st.id}:${c.id}`, 1)),
            ])}
          </div>
        )
      })}
      {storage.length === 0 && records.length === 0 && <p className="px-3 py-2 text-[11px] text-white/40">這個檔案沒有可移動的位置</p>}
    </div>,
    document.body,
  )
}
