import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { isAdmin, type AppUser } from '../../services/auth'
import { READ_ONLY_EVENT, forkProject, forkUrl, setProjectFlags, useProjectLock } from '../../services/projectLock'
import type { ProjectSummary } from '../../types/project'
import { PromptDialog } from '../ui/PromptDialog'

/** Status badge of a project card: official template, archived, locked, or a workspace. */
export function ProjectBadges({ project }: { project: ProjectSummary }) {
  const badge = (text: string, cls: string, id: string) => (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold whitespace-nowrap ${cls}`} data-project-badge={id}>
      {text}
    </span>
  )
  return (
    <span className="flex flex-wrap items-center gap-1">
      {project.isMasterTemplate
        ? badge('🔒 官方範本 Master Template', 'bg-standby text-black', 'template')
        : project.isArchived
          ? badge('📦 已封存 Archived', 'bg-white/15 text-white/70', 'archived')
          : project.isLocked
            ? badge('🔒 唯讀鎖定 Read-only', 'bg-panic/20 text-panic', 'locked')
            : badge('✏️ 學生共編專案 Workspace', 'bg-go/15 text-go', 'workspace')}
      {project.isPinned && badge('📌 置頂', 'bg-accent/25 text-[#64a8ff]', 'pinned')}
      {project.forkedFrom && <span className="text-[10px] text-white/40">複製自「{project.forkedFrom.name}」</span>}
    </span>
  )
}

/** "複製為我的專案": name the copy, fork it, open it. */
export function ForkButton({ user, project, className, label = '📋 複製為我的專案' }: { user: AppUser; project: { id: string; name: string }; className?: string; label?: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={className ?? 'min-h-11 rounded-xl bg-standby px-4 text-sm font-bold text-black hover:brightness-110'}
        title="以這個專案為基礎，建立一份你自己的獨立專案（不影響原本的專案）"
        data-fork-project={project.id}
      >
        {label}
      </button>
      <PromptDialog
        open={open}
        title={`複製「${project.name}」`}
        description="建立一份完全獨立、屬於你的專案（所有版本、Cue、控台、Studio 都會複製）。你可以自由編輯，也能分享給同學共編；原本的專案不會受到任何影響。"
        initialValue={`${project.name}（${user.name} 的專案）`}
        placeholder="新專案名稱"
        confirmLabel="建立並開啟"
        onClose={() => setOpen(false)}
        onConfirm={async (name) => {
          const result = await forkProject(project.id, user, name)
          location.href = forkUrl(result)
        }}
      />
    </>
  )
}

/** Admin switches on a project card: lock, official template, archive. */
export function AdminProjectFlags({ user, project }: { user: AppUser; project: ProjectSummary }) {
  const [busy, setBusy] = useState<string | null>(null)
  if (!isAdmin(user)) return null
  const toggle = async (key: 'isLocked' | 'isMasterTemplate' | 'isArchived') => {
    setBusy(key)
    try {
      await setProjectFlags(project.id, { [key]: !project[key] }, user)
    } catch (err) {
      alert((err as Error).message)
    } finally {
      setBusy(null)
    }
  }
  const btn = (key: 'isLocked' | 'isMasterTemplate' | 'isArchived', on: string, off: string) => (
    <button
      type="button"
      disabled={!!busy}
      onClick={() => toggle(key)}
      aria-pressed={!!project[key]}
      className={`min-h-8 rounded-lg px-2.5 text-[11px] font-semibold disabled:opacity-40 ${project[key] ? 'bg-white/20 text-white' : 'bg-white/[0.06] text-white/55 hover:bg-white/10'}`}
      data-admin-flag={key}
    >
      {busy === key ? '…' : project[key] ? on : off}
    </button>
  )
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-xl bg-black/30 px-2 py-1.5" data-admin-flags>
      <span className="text-[10px] font-semibold tracking-wider text-white/35">管理員</span>
      {btn('isLocked', '🔓 解除鎖定', '🔒 唯讀鎖定')}
      {btn('isMasterTemplate', '✖ 取消官方範本', '⭐ 設為官方範本')}
      {btn('isArchived', '↩ 取消封存', '📦 封存')}
    </div>
  )
}

/**
 * On every project page: when the project is read-only for this user (locked, official template,
 * archived) a bar says so and offers a fork; refused edits pop a toast. Admins see a reminder.
 */
export function ReadOnlyBar({ user, projectId, projectName }: { user: AppUser; projectId: string; projectName: string }) {
  const lock = useProjectLock(projectId, user)
  const [toast, setToast] = useState<string | null>(null)
  useEffect(() => {
    const on = (e: Event) => setToast((e as CustomEvent<string>).detail)
    window.addEventListener(READ_ONLY_EVENT, on)
    return () => window.removeEventListener(READ_ONLY_EVENT, on)
  }, [])
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 4500)
    return () => clearTimeout(t)
  }, [toast])
  const adminView = isAdmin(user) && !!lock.label
  return (
    <>
      {(lock.readOnly || adminView) && (
        <div className="pointer-events-none fixed bottom-3 left-1/2 z-[90] -translate-x-1/2" data-read-only-bar={lock.readOnly ? 'locked' : 'admin'}>
          <div className={`pointer-events-auto flex items-center gap-3 rounded-full border px-4 py-2 text-sm shadow-2xl backdrop-blur-xl ${lock.readOnly ? 'border-standby/50 bg-[#2a2210]/95' : 'border-white/15 bg-black/80'}`}>
            <span className="font-semibold text-standby">🔒 {lock.label}</span>
            <span className="hidden text-xs text-white/60 sm:inline">{lock.readOnly ? '只能檢視與播放，不能修改' : '你是管理員：仍可完整編輯'}</span>
            {lock.readOnly && <ForkButton user={user} project={{ id: projectId, name: projectName }} className="min-h-8 rounded-full bg-standby px-3 text-xs font-bold text-black" />}
          </div>
        </div>
      )}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="fixed top-16 left-1/2 z-[95] max-w-lg -translate-x-1/2 rounded-xl border border-panic/40 bg-[#2a1414]/95 px-4 py-3 text-sm text-white shadow-2xl"
            role="alert"
            data-read-only-toast
          >
            {toast}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
