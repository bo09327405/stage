import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { isAdmin, type AppUser } from '../../services/auth'
import { claimStudio, ownerOf } from '../../services/membership'
import { createProject } from '../../services/projects'
import { createStudio, renameStudio } from '../../services/studio'
import { moveStudio, parentChoices, softDeleteStudio, type StudioRef } from '../../services/studioAdmin'
import type { ProjectSummary } from '../../types/project'

const field = 'h-10 w-full rounded-lg border border-white/15 bg-black/40 px-3 text-sm text-white outline-none focus:border-accent'
const btn = 'min-h-10 rounded-xl px-4 text-sm font-semibold disabled:opacity-40'

function Modal({ open, onClose, title, children, id }: { open: boolean; onClose: () => void; title: string; children: React.ReactNode; id: string }) {
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} className="fixed inset-0 z-[90] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <motion.div initial={{ scale: 0.96 }} animate={{ scale: 1 }} onClick={(e) => e.stopPropagation()} className="w-full max-w-md space-y-4 rounded-2xl border border-line bg-panel p-5 text-white shadow-2xl" role="dialog" aria-label={title} data-dialog={id}>
            <h2 className="text-lg font-semibold">{title}</h2>
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}

/**
 * "＋ 新增 Studio 專案": a studio always belongs to a Set Cue project — pick one of yours, or
 * create a new Set Cue project for it.
 */
export function NewStudioDialog({ open, onClose, user, projects }: { open: boolean; onClose: () => void; user: AppUser; projects: ProjectSummary[] | null }) {
  const choices = parentChoices(projects, user)
  const [name, setName] = useState('')
  const [parent, setParent] = useState<string>('__new')
  const [newParent, setNewParent] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <Modal open={open} onClose={onClose} title="新增 Studio 專案" id="new-studio">
      <p className="text-xs text-white/50">每個 Studio 都屬於一個 Set Cue 母專案：在 Set Cue 裡可以直接切換到它、把 Cue 綁定它的混音；刪除母專案時會一起移到回收桶。</p>
      <label className="block space-y-1">
        <span className="text-xs text-white/55">Studio 名稱</span>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：第三幕配樂" className={field} data-new-studio-name />
      </label>
      <label className="block space-y-1">
        <span className="text-xs text-white/55">Set Cue 母專案</span>
        <select value={parent} onChange={(e) => setParent(e.target.value)} className={field} data-new-studio-parent>
          <option value="__new">＋ 建立新的 Set Cue 專案</option>
          {choices.map((p) => (
            <option key={p.id} value={p.id}>
              🎭 {p.name}
            </option>
          ))}
        </select>
      </label>
      {parent === '__new' && (
        <label className="block space-y-1">
          <span className="text-xs text-white/55">新 Set Cue 專案名稱</span>
          <input value={newParent} onChange={(e) => setNewParent(e.target.value)} placeholder={name.trim() || '例如：2026 秋季公演'} className={field} data-new-studio-parent-name />
        </label>
      )}
      {error && <p className="text-xs text-panic">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className={`${btn} text-white/55 hover:bg-white/10`}>
          取消
        </button>
        <button
          type="button"
          disabled={busy || !name.trim()}
          onClick={async () => {
            setBusy(true)
            setError(null)
            try {
              const studioName = name.trim()
              const show =
                parent === '__new'
                  ? await createProject((newParent.trim() || studioName).slice(0, 80), { owner: ownerOf(user) })
                  : { projectId: parent, versionId: choices.find((p) => p.id === parent)?.versions[0]?.id ?? '' }
              const sid = await createStudio(show.projectId, studioName, { parentProjectId: show.projectId })
              await claimStudio(user, show.projectId, show.versionId, sid, studioName)
              location.href = `${location.pathname.replace(/\/(surface|control-panel)\/?$/, '/')}?role=studio&project=${show.projectId}&version=${show.versionId}&studio=${sid}`
            } catch (err) {
              setError((err as Error).message)
              setBusy(false)
            }
          }}
          className={`${btn} bg-accent text-white`}
          data-new-studio-create
        >
          {busy ? '建立中…' : '建立並開啟'}
        </button>
      </div>
    </Modal>
  )
}

/** Admins: rename / move to another Set Cue project / move to the trash. */
export function StudioAdminMenu({ studio, user, projects, onDone }: { studio: StudioRef; user: AppUser; projects: ProjectSummary[] | null; onDone: (message: string, ok?: boolean) => void }) {
  const [open, setOpen] = useState(false)
  const [moving, setMoving] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false)
    window.addEventListener('pointerdown', close, true)
    return () => window.removeEventListener('pointerdown', close, true)
  }, [open])
  if (!isAdmin(user)) return null
  const standalone = studio.project.kind === 'studio'
  const act = async (job: () => Promise<string>) => {
    setOpen(false)
    try {
      onDone(await job())
    } catch (err) {
      onDone((err as Error).message, false)
    }
  }
  const item = 'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs hover:bg-white/10'
  return (
    <div ref={box} className="relative" data-studio-admin={studio.studioId}>
      <button type="button" onClick={() => setOpen(!open)} className="flex h-10 w-10 items-center justify-center rounded-xl text-lg text-white/55 hover:bg-white/10 hover:text-white" aria-label="管理 Studio" title="管理（管理員）" data-studio-menu>
        ⋯
      </button>
      {open && (
        <div className="absolute top-full right-0 z-40 mt-1 w-60 rounded-xl border border-white/10 bg-[#202020]/95 p-1 shadow-2xl backdrop-blur-xl" role="menu">
          <button
            type="button"
            className={item}
            onClick={() => {
              const name = prompt('Studio 新名稱', studio.name)
              if (name?.trim() && name.trim() !== studio.name) act(async () => (await renameStudio(studio.projectId, studio.studioId, name.trim()), `✓ 已重新命名為「${name.trim()}」`))
              else setOpen(false)
            }}
            data-studio-rename
          >
            ✎ 重新命名
          </button>
          <button type="button" className={item} onClick={() => (setOpen(false), setMoving(true))} data-studio-move>
            ↪ {standalone ? '指定 Set Cue 母專案…' : '移到其他 Set Cue 專案…'}
          </button>
          <button
            type="button"
            className={`${item} text-panic`}
            onClick={() =>
              confirm(standalone ? `把獨立 Studio 專案「${studio.name}」移到回收桶？` : `把「${studio.project.name}」裡的 Studio「${studio.name}」移到回收桶？（綁定它的 Cue 會暫時無法播放；可在回收桶還原）`)
                ? act(async () => (await softDeleteStudio(studio.projectId, studio.studioId, user), `✓ 已將 Studio「${studio.name}」移到回收桶`))
                : setOpen(false)
            }
            data-studio-trash
          >
            🗑 移至回收桶
          </button>
        </div>
      )}
      <MoveStudioDialog open={moving} onClose={() => setMoving(false)} studio={studio} user={user} projects={projects} onDone={onDone} />
    </div>
  )
}

/** Re-assign a studio's Set Cue parent (admins). */
export function MoveStudioDialog({ open, onClose, studio, user, projects, onDone }: { open: boolean; onClose: () => void; studio: StudioRef; user: AppUser; projects: ProjectSummary[] | null; onDone: (message: string, ok?: boolean) => void }) {
  const choices = parentChoices(projects, user).filter((p) => p.id !== studio.projectId)
  const [target, setTarget] = useState('')
  const [busy, setBusy] = useState(false)
  const chosen = target || choices[0]?.id || ''
  return (
    <Modal open={open} onClose={onClose} title={`移動 Studio「${studio.name}」`} id="move-studio">
      <p className="text-xs text-white/50">
        目前屬於：{studio.project.kind === 'studio' ? '（獨立 Studio，未指定母專案）' : `🎭 ${studio.project.name}`}。移動後，Studio 的內容、成員、發布設定與雲端存檔會一起搬過去；它的建立者與協作者會成為新母專案的協作者。
        舊母專案裡綁定它的 Cue 需要重新指定。固定網址 MP3 會換新網址（舊網址保留最後一版）。
      </p>
      <select value={chosen} onChange={(e) => setTarget(e.target.value)} className={field} data-move-studio-target>
        {choices.map((p) => (
          <option key={p.id} value={p.id}>
            🎭 {p.name}
          </option>
        ))}
      </select>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className={`${btn} text-white/55 hover:bg-white/10`}>
          取消
        </button>
        <button
          type="button"
          disabled={busy || !chosen}
          onClick={async () => {
            setBusy(true)
            try {
              const r = await moveStudio(studio.projectId, studio.studioId, chosen, user)
              const to = choices.find((p) => p.id === chosen)?.name ?? ''
              onDone(
                `✓ 已將「${studio.name}」移到「${to}」` +
                  (r.addedMembers ? `，${r.addedMembers} 位成員加入新母專案` : '') +
                  (r.unboundCues ? `；舊母專案有 ${r.unboundCues} 個 Cue 綁定它，請重新指定` : '') +
                  (r.containerTrashed ? '；原本的獨立 Studio 容器已移到回收桶' : ''),
              )
              onClose()
            } catch (err) {
              onDone((err as Error).message, false)
            } finally {
              setBusy(false)
            }
          }}
          className={`${btn} bg-accent text-white`}
          data-move-studio-go
        >
          {busy ? '移動中…' : '移動'}
        </button>
      </div>
    </Modal>
  )
}
