import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import {
  createProject,
  deleteProject,
  renameProject,
  renameVersion,
  deleteVersion,
  hasLegacyShow,
  importLegacyShow,
  saveAsNewVersion,
  useLivePointer,
  useProjectIndex,
} from '../../services/projects'
import { parseProjectFile, uniqueName, type ProjectFile } from '../../services/projectTransfer'
import { ExportProjectDialog } from './ExportProjectDialog'
import type { ProjectSummary, ShowRef, VersionSummary } from '../../types/project'
import { ImportProjectDialog } from './ImportProjectDialog'
import { isAdmin, type AppUser } from '../../services/auth'
import { leaveProject, ownerOf } from '../../services/membership'
import { isReadOnlyProject, useTemplates } from '../../services/projectLock'
import { AdminProjectFlags, ForkButton, ProjectBadges } from '../hub/ProjectStatus'
import { SetCueCloudDialog } from './SetCueCloudDialog'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { PromptDialog } from '../ui/PromptDialog'

const formatDate = (ms: number) =>
  ms
    ? new Date(ms).toLocaleString('zh-TW', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
    : '—'

type Dialog =
  | { kind: 'create' }
  | { kind: 'saveAs'; project: ProjectSummary }
  | { kind: 'import' }
  | { kind: 'rename'; project: ProjectSummary }
  | { kind: 'delete'; project: ProjectSummary }
  | { kind: 'leave'; project: ProjectSummary }
  | { kind: 'renameVersion'; project: ProjectSummary; version: VersionSummary }
  | { kind: 'deleteVersion'; project: ProjectSummary; version: VersionSummary }
  | null

/**
 * The hub's Set Cue tab: create, open, version and delete shows — your own, the ones you joined
 * through a link, and (admins) every project.
 */
export function Lobby({ onOpen, user }: { onOpen: (show: ShowRef) => void; user: AppUser }) {
  const { projects: allProjects, error } = useProjectIndex()
  const admin = isAdmin(user)
  // Containers made for standalone Studio projects belong to the Studio tab.
  // Pinned (by an admin) first; the index is already newest first.
  const projects = allProjects ? [...allProjects.filter((p) => p.kind !== 'studio')].sort((a, b) => Number(!!b.isPinned) - Number(!!a.isPinned)) : null
  // Official templates are listed for everyone (signed in), apart from their own workspaces.
  const templates = useTemplates()?.filter((p) => p.kind !== 'studio') ?? []
  const working = projects?.filter((p) => !p.isMasterTemplate && !p.isArchived) ?? []
  const mine = working.filter((p) => p.owner?.uid === user.uid)
  const shared = working.filter((p) => p.owner?.uid !== user.uid && p.collaboratorIds.includes(user.uid))
  const others = admin ? working.filter((p) => p.owner?.uid !== user.uid && !p.collaboratorIds.includes(user.uid)) : []
  const archived = projects?.filter((p) => p.isArchived && !p.isMasterTemplate) ?? []
  const groups = [
    { id: 'templates', title: '🔒 官方範本', hint: '唯讀：請按「複製為我的專案」建立自己的副本再編輯', list: templates },
    { id: 'mine', title: '我的專案', hint: '你建立的', list: mine },
    { id: 'shared', title: '共編專案', hint: '透過專案網址加入的', list: shared },
    { id: 'all', title: '所有其他專案', hint: '管理員可見', list: others },
    { id: 'archived', title: '📦 已封存', hint: '唯讀', list: archived },
  ]
  const visibleCount = templates.length + mine.length + shared.length + others.length + archived.length
  const live = useLivePointer()
  const [dialog, setDialog] = useState<Dialog>(null)
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null)
  const [legacy, setLegacy] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  // Project file being imported (shown in the confirm dialog), and which project is exporting.
  const [importFile, setImportFile] = useState<ProjectFile | null>(null)
  const [exporting, setExporting] = useState<ProjectSummary | null>(null)
  const [cloudOpen, setCloudOpen] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  const readImport = async (file: File | undefined) => {
    if (!file) return
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error('檔案超過 20 MB')
      setImportFile(parseProjectFile(await file.text()))
    } catch (err) {
      setNotice({ text: `無法匯入：${(err as Error).message}`, ok: false })
    }
  }


  // The stage 1–3 global show is admin-only data.
  useEffect(() => {
    if (admin) hasLegacyShow().then(setLegacy, () => setLegacy(false))
  }, [admin])

  const card = (project: ProjectSummary) => {
            const latest = project.versions[0]
            const isLiveProject = live?.projectId === project.id
            // Read-only for this user (locked / template / archived; admins can still edit).
            const readOnlyHere = !admin && isReadOnlyProject(project)
            return (
              <motion.li
                key={project.id}
                data-project-card={project.id}
                layout
                className="overflow-hidden rounded-2xl border border-line bg-panel/80 backdrop-blur-xl"
              >
                <div className="space-y-4 p-5">
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <h2 className="truncate text-lg font-semibold">{project.name}</h2>
                      <div className="mt-1 mb-0.5">
                        <ProjectBadges project={project} />
                      </div>
                      <p className="text-xs text-white/40">
                        更新於 {formatDate(project.updatedAt)} · {project.versions.length} 個版本
                      </p>
                      <p className="truncate text-[11px] text-white/35" data-project-members>
                        {project.owner ? `建立者 ${project.owner.uid === user.uid ? '你' : project.owner.name}` : '建立者未記錄（登入功能之前的專案）'}
                        {project.collaboratorIds.length > 0 && ` · ${project.collaboratorIds.length} 位協作者`}
                      </p>
                    </div>
                    {isLiveProject && (
                      <span className="mt-1 rounded-full bg-panic px-2 py-0.5 text-[10px] font-bold tracking-wider">ON AIR</span>
                    )}
                    <div className="flex shrink-0 gap-1">
                      <button
                        onClick={() => setExporting(project)}
                        className="flex min-h-10 items-center gap-1 rounded-lg px-2.5 text-xs text-white/55 transition hover:bg-white/10 hover:text-white disabled:opacity-40"
                        aria-label={`匯出「${project.name}」`}
                        title="匯出：單獨 Set Cue 專案，或含 Studio 的完整專案包"
                        data-export-project={project.id}
                      >
                        ⇩ <span className="hidden sm:inline">匯出</span>
                      </button>
                      {!readOnlyHere && (
                        <button
                          onClick={() => setDialog({ kind: 'rename', project })}
                          className="flex min-h-10 items-center gap-1 rounded-lg px-2.5 text-xs text-white/55 transition hover:bg-white/10 hover:text-white"
                          aria-label={`重新命名「${project.name}」`}
                        >
                          ✎ <span className="hidden sm:inline">重新命名</span>
                        </button>
                      )}
                      {/* Collaborators can leave a project; only admins delete one (it goes to the trash). */}
                      {project.owner?.uid !== user.uid && project.collaboratorIds.includes(user.uid) && (
                        <button
                          onClick={() => setDialog({ kind: 'leave', project })}
                          className="flex min-h-10 items-center gap-1 rounded-lg px-2.5 text-xs text-white/55 transition hover:bg-standby/15 hover:text-standby"
                          aria-label={`退出「${project.name}」`}
                          title="退出專案：從你的大廳移除，不影響專案與其他人"
                          data-leave-project={project.id}
                        >
                          ⎋ <span className="hidden sm:inline">退出</span>
                        </button>
                      )}
                      {admin && (
                        <button
                          onClick={() => setDialog({ kind: 'delete', project })}
                          className="flex min-h-10 items-center gap-1 rounded-lg px-2.5 text-xs text-white/55 transition hover:bg-panic/15 hover:text-panic"
                          aria-label={`刪除「${project.name}」`}
                          title="移到回收桶（管理員可還原）"
                          data-delete-project={project.id}
                        >
                          🗑 <span className="hidden sm:inline">刪除</span>
                        </button>
                      )}
                    </div>
                  </div>

                  <AdminProjectFlags user={user} project={project} />

                  {latest && (
                    <div className="rounded-xl bg-black/30 px-3 py-2 text-xs">
                      <span className="text-white/40">最新版本　</span>
                      <span className="font-mono text-white/80">{latest.name}</span>
                    </div>
                  )}

                  <div className="flex flex-wrap gap-2">
                    {(project.isMasterTemplate || readOnlyHere) && <ForkButton user={user} project={project} />}
                    <button
                      disabled={!latest}
                      onClick={() => latest && onOpen({ projectId: project.id, versionId: latest.id })}
                      className={`min-h-11 flex-1 rounded-xl px-4 text-sm font-bold disabled:opacity-30 ${readOnlyHere ? 'bg-white/[0.1] text-white' : 'bg-go text-black'}`}
                      data-open-project={project.id}
                    >
                      {readOnlyHere ? '檢視（唯讀）' : '開啟'}
                    </button>
                    {!readOnlyHere && (
                      <button
                        disabled={!latest}
                        onClick={() => setDialog({ kind: 'saveAs', project })}
                        className="min-h-11 rounded-xl bg-white/[0.07] px-4 text-sm text-white/80 hover:bg-white/15"
                      >
                        另存新版本
                      </button>
                    )}
                    <button
                      onClick={() => setExpanded(expanded === project.id ? null : project.id)}
                      className="min-h-11 rounded-xl bg-white/[0.07] px-4 text-sm text-white/80 hover:bg-white/15"
                    >
                      版本 {expanded === project.id ? '▴' : '▾'}
                    </button>
                  </div>
                </div>

                <AnimatePresence initial={false}>
                  {expanded === project.id && (
                    <motion.div
                      initial={{ height: 0 }}
                      animate={{ height: 'auto' }}
                      exit={{ height: 0 }}
                      className="overflow-hidden border-t border-line"
                    >
                      <ul className="divide-y divide-line">
                        {project.versions.map((v) => {
                          const isLiveVersion = live?.projectId === project.id && live?.versionId === v.id
                          return (
                            <li key={v.id} className="flex min-h-14 items-center gap-3 px-5">
                              <div className="min-w-0 flex-1">
                                <div className="truncate font-mono text-sm">{v.name}</div>
                                <div className="text-[11px] text-white/35">
                                  {formatDate(v.createdAt)}
                                  {v.parentId && ` · 由 ${project.versions.find((p) => p.id === v.parentId)?.name ?? '舊版本'} 另存`}
                                </div>
                              </div>
                              {isLiveVersion && <span className="text-[10px] font-bold text-panic">● ON AIR</span>}
                              {/* Members rename versions; only admins delete them (regular users never see the button). */}
                              {!readOnlyHere && (
                                <button
                                  onClick={() => setDialog({ kind: 'renameVersion', project, version: v })}
                                  className="min-h-10 rounded-lg px-2.5 text-xs text-white/55 hover:bg-white/10 hover:text-white"
                                  aria-label={`重新命名版本「${v.name}」`}
                                  title="重新命名版本"
                                  data-rename-version={v.id}
                                >
                                  ✎<span className="hidden sm:inline"> 重新命名</span>
                                </button>
                              )}
                              {admin && (
                                <button
                                  onClick={() => setDialog({ kind: 'deleteVersion', project, version: v })}
                                  disabled={project.versions.length <= 1 || isLiveVersion}
                                  className="min-h-10 rounded-lg px-2.5 text-xs text-white/55 hover:bg-panic/15 hover:text-panic disabled:pointer-events-none disabled:opacity-30"
                                  aria-label={`刪除版本「${v.name}」`}
                                  title={project.versions.length <= 1 ? '專案唯一的版本無法刪除' : isLiveVersion ? '播出中的版本無法刪除' : '刪除版本（管理員）'}
                                  data-delete-version={v.id}
                                >
                                  🗑<span className="hidden sm:inline"> 刪除</span>
                                </button>
                              )}
                              <button
                                onClick={() => onOpen({ projectId: project.id, versionId: v.id })}
                                className="min-h-10 rounded-lg bg-white/[0.07] px-3 text-xs hover:bg-white/15"
                              >
                                開啟
                              </button>
                            </li>
                          )
                        })}
                      </ul>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.li>
            )
  }

  return (
    <div className="text-white">
      <header className="mx-auto flex max-w-5xl flex-wrap items-center gap-3 px-4 pt-6 sm:px-6">
        <span className="text-lg font-semibold">🎭 Set Cue 專案</span>
        <span className="ml-auto" />
        {admin && (
        <button
          onClick={() => setCloudOpen(true)}
          className="min-h-11 rounded-xl bg-white/[0.07] px-4 text-sm font-medium text-white/80 hover:bg-white/15 hover:text-white"
          title="自動儲存在 Cloudflare R2 的 Set Cue 專案：開啟、還原、刪除"
          data-setcue-cloud-open
        >
          ☁ R2 雲端專案
        </button>
        )}
        <button
          onClick={() => fileInput.current?.click()}
          className="min-h-11 rounded-xl bg-white/[0.07] px-4 text-sm font-medium text-white/80 hover:bg-white/15 hover:text-white"
          title="從匯出的 JSON 檔建立新專案"
          data-import-project
        >
          ⇧ 匯入專案
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            readImport(e.target.files?.[0])
            e.target.value = ''
          }}
          data-import-input
        />
        <button
          onClick={() => setDialog({ kind: 'create' })}
          className="min-h-11 rounded-xl bg-accent px-5 text-sm font-semibold text-white hover:brightness-110"
        >
          ＋ 新增專案
        </button>
      </header>

      <main className="mx-auto max-w-5xl space-y-6 px-4 py-8 sm:px-6">
        {live && (admin || projects?.some((p) => p.id === live.projectId)) && (
          <div className="flex items-center gap-3 rounded-2xl border border-panic/40 bg-panic/10 px-5 py-3 text-sm">
            <span className="h-2 w-2 animate-pulse rounded-full bg-panic" />
            <span className="text-white/60">觀眾端正在播出：</span>
            <span className="font-semibold">
              {live.projectName} · {live.versionName}
            </span>
            <button
              onClick={() => onOpen({ projectId: live.projectId, versionId: live.versionId })}
              className="ml-auto min-h-10 rounded-lg bg-white/10 px-3 text-xs hover:bg-white/20"
            >
              開啟控台
            </button>
          </div>
        )}

        {legacy && (
          <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-standby/30 bg-standby/[0.06] px-5 py-4 text-sm">
            <span className="text-standby">偵測到舊版（階段 1–3）的 Cue 清單資料。</span>
            <span className="text-white/40">匯入後舊資料仍會保留，不會被刪除。</span>
            <button
              onClick={() => setDialog({ kind: 'import' })}
              className="ml-auto min-h-10 rounded-lg bg-standby px-4 text-xs font-semibold text-black"
            >
              匯入為新專案
            </button>
          </div>
        )}

        {error && <p className="text-sm text-panic">無法讀取專案：{error.message}</p>}
        {projects === null && !error && <p className="text-sm text-white/30">載入專案…</p>}
        {projects !== null && visibleCount === 0 && (
          <div className="flex flex-col items-center gap-3 py-24 text-center">
            <div className="text-5xl text-white/10">🎭</div>
            <p className="text-white/50">還沒有你的 Set Cue 專案</p>
            <p className="max-w-sm text-xs text-white/35">建立新專案，或開啟別人分享的專案網址，它就會出現在「共編專案」。</p>
            <button
              onClick={() => setDialog({ kind: 'create' })}
              className="min-h-12 rounded-xl bg-accent px-6 text-sm font-semibold text-white"
            >
              建立第一個專案
            </button>
          </div>
        )}

        {groups.map((g) =>
          g.list.length === 0 ? null : (
            <section key={g.id} className="space-y-3" data-hub-group={g.id}>
              <h2 className="flex items-baseline gap-2 text-xs font-semibold tracking-wider text-white/50">
                {g.title}
                <span className="font-mono text-white/30">{g.list.length}</span>
                <span className="font-normal text-white/30">{g.hint}</span>
              </h2>
              <ul className="grid gap-4 md:grid-cols-2">{g.list.map(card)}</ul>
            </section>
          ),
        )}
      </main>

      <PromptDialog
        open={dialog?.kind === 'rename'}
        title="重新命名專案"
        initialValue={dialog?.kind === 'rename' ? dialog.project.name : ''}
        placeholder="專案名稱"
        confirmLabel="儲存"
        onClose={() => setDialog(null)}
        onConfirm={async (name) => {
          if (dialog?.kind !== 'rename') return
          await renameProject(dialog.project.id, name)
          setNotice({ text: `已重新命名為「${name.trim()}」`, ok: true })
        }}
      />
      <ConfirmDialog
        open={dialog?.kind === 'delete'}
        title={dialog?.kind === 'delete' ? `刪除「${dialog.project.name}」？` : ''}
        confirmLabel="移到回收桶"
        danger
        onClose={() => setDialog(null)}
        onConfirm={async () => {
          if (dialog?.kind !== 'delete') return
          await deleteProject(dialog.project.id, user)
          setNotice({ text: `已將「${dialog.project.name}」移到回收桶（可在「🗑 回收桶」還原）`, ok: true })
        }}
      >
        {dialog?.kind === 'delete' && (
          <>
            專案（<b className="text-white">{dialog.project.versions.length} 個版本</b>的 Cue 清單、Hits、控制面板、外部觸發、Studio 與觀眾上傳）會從所有人的大廳移除，
            並完整保存在<b className="text-white">管理員回收桶</b>，隨時可以一鍵還原。
            {live?.projectId === dialog.project.id && (
              <span className="mt-2 block text-standby">此專案目前正在對觀眾播出，刪除後觀眾端會回到「沒有上線中的演出」。</span>
            )}
            <span className="mt-2 block text-xs text-white/35">R2 / Cloudinary 上的檔案不會被刪除。</span>
          </>
        )}
      </ConfirmDialog>
      <PromptDialog
        open={dialog?.kind === 'renameVersion'}
        title={dialog?.kind === 'renameVersion' ? `重新命名版本 · ${dialog.project.name}` : ''}
        initialValue={dialog?.kind === 'renameVersion' ? dialog.version.name : ''}
        placeholder="版本名稱"
        confirmLabel="儲存"
        onClose={() => setDialog(null)}
        onConfirm={async (name) => {
          if (dialog?.kind !== 'renameVersion') return
          await renameVersion(dialog.project.id, dialog.version.id, name)
          setNotice({ text: `版本已重新命名為「${name.trim()}」`, ok: true })
        }}
      />
      <ConfirmDialog
        open={dialog?.kind === 'deleteVersion' && admin}
        title={dialog?.kind === 'deleteVersion' ? `刪除版本「${dialog.version.name}」？` : ''}
        confirmLabel="刪除版本"
        danger
        onClose={() => setDialog(null)}
        onConfirm={async () => {
          if (dialog?.kind !== 'deleteVersion') return
          await deleteVersion(dialog.project.id, dialog.version.id, user)
          setNotice({ text: `已刪除版本「${dialog.version.name}」`, ok: true })
        }}
      >
        {dialog?.kind === 'deleteVersion' && (
          <>
            「{dialog.project.name}」的這個版本（Cue 清單、Hits、劇本筆記）會被移除。
            專案的<b className="text-white">其他版本與 Studio 完全不受影響</b>，停在此版本的大廳項目會改指向最新版本。
            <span className="mt-2 block text-xs text-white/35">Set Cue 在 R2 的自動儲存版本紀錄仍保有此版本的內容，誤刪時可從「版本紀錄」還原。</span>
          </>
        )}
      </ConfirmDialog>
      <ConfirmDialog
        open={dialog?.kind === 'leave'}
        title={dialog?.kind === 'leave' ? `退出「${dialog.project.name}」？` : ''}
        confirmLabel="退出專案"
        onClose={() => setDialog(null)}
        onConfirm={async () => {
          if (dialog?.kind !== 'leave') return
          await leaveProject(user, dialog.project.id)
          setNotice({ text: `已退出「${dialog.project.name}」`, ok: true })
        }}
      >
        {dialog?.kind === 'leave' && (
          <>
            你會從協作者名單移除，專案也會從你的大廳消失。專案本身與其他協作者<b className="text-white">完全不受影響</b>。
            <span className="mt-2 block text-xs text-white/35">之後若要再加入，需要專案成員重新分享專案網址給你。</span>
          </>
        )}
      </ConfirmDialog>

      <AnimatePresence>
        {notice && (
          <motion.div
            key={notice.text}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 16 }}
            onAnimationComplete={() => setTimeout(() => setNotice((n) => (n?.text === notice.text ? null : n)), 3000)}
            className={`fixed bottom-6 left-1/2 z-40 -translate-x-1/2 rounded-full border bg-panel/95 px-5 py-2.5 text-sm shadow-2xl backdrop-blur-xl ${
              notice.ok ? 'border-go/40 text-go' : 'border-panic/40 text-panic'
            }`}
          >
            {notice.ok ? '✓' : '✕'} {notice.text}
          </motion.div>
        )}
      </AnimatePresence>

      <ExportProjectDialog project={exporting} onClose={() => setExporting(null)} onDone={(text) => setNotice({ text, ok: true })} />
      <SetCueCloudDialog open={cloudOpen} projects={projects} onOpen={onOpen} onClose={() => setCloudOpen(false)} />
      <ImportProjectDialog
        file={importFile}
        suggestedName={importFile ? uniqueName(importFile.project.name, (projects ?? []).map((p) => p.name)) : ''}
        onClose={() => setImportFile(null)}
        onImported={(show, name, open) => {
          setImportFile(null)
          setNotice({ text: `已匯入為新專案「${name}」`, ok: true })
          if (open) onOpen(show)
        }}
      />
      <PromptDialog
        open={dialog?.kind === 'create'}
        title="新增專案"
        placeholder="例如：2026 秋季公演"
        confirmLabel="建立並開啟"
        onClose={() => setDialog(null)}
        onConfirm={async (name) => onOpen(await createProject(name, { owner: ownerOf(user) }))}
      />
      <PromptDialog
        open={dialog?.kind === 'import'}
        title="匯入舊版資料"
        description="把階段 1–3 的全域 Cue 清單與 Hits 複製成一個新專案。"
        initialValue="匯入的演出"
        confirmLabel="匯入並開啟"
        onClose={() => setDialog(null)}
        onConfirm={async (name) => {
          const created = await importLegacyShow(name)
          setLegacy(false)
          onOpen(created)
        }}
      />
      <PromptDialog
        open={dialog?.kind === 'saveAs'}
        title={dialog?.kind === 'saveAs' ? `另存新版本 · ${dialog.project.name}` : ''}
        description="從最新版本複製 Cue 清單與 Hits，建立新版本。"
        placeholder="例如：彩排二 / 正式演出"
        confirmLabel="另存並開啟"
        onClose={() => setDialog(null)}
        onConfirm={async (name) => {
          if (dialog?.kind !== 'saveAs') return
          const latest = dialog.project.versions[0]
          onOpen(await saveAsNewVersion({ projectId: dialog.project.id, versionId: latest.id }, name))
        }}
      />
    </div>
  )
}
