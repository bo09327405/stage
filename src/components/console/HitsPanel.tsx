import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'
import { HITS_PER_PAGE } from '../../types/actions'
import type { Hit } from '../../types/cue'
import { hitMediaFolder } from '../../types/project'
import { Fader, Label, fieldClass } from '../ui/controls'
import { MediaUploadButton } from '../ui/MediaUploadButton'

const TILE_COLORS = ['#0a84ff', '#bf5af2', '#ff9f0a', '#64d2ff', '#ff375f', '#30d158', '#5e5ce6', '#ffd60a']

interface HitsPanelProps {
  hits: Hit[]
  /** For the Cloudinary folder (theatre/hits/{cleanProjectName}) and the media library. */
  projectId: string
  projectName: string
  /** Current page of 8 (shared through the show state, so "Play Hit n" triggers agree). */
  page: number
  onPage: (page: number) => void
  onStopAll: () => void
  onFire: (hit: Hit) => void
  onAdd: (hit: Omit<Hit, 'id' | 'order'>) => Promise<unknown>
  onUpdate: (id: string, changes: Partial<Omit<Hit, 'id'>>) => Promise<unknown>
  onRemove: (id: string) => Promise<unknown>
}

/** Pages of 8 one-shot sound buttons, independent of the cue list. Keys 1–8 fire the current page. */
export function HitsPanel({ hits, projectId, projectName, page, onPage, onStopAll, onFire, onAdd, onUpdate, onRemove }: HitsPanelProps) {
  const pages = Math.max(1, Math.ceil(hits.length / HITS_PER_PAGE))
  const current = Math.min(page, pages - 1)
  const pageHits = hits.slice(current * HITS_PER_PAGE, (current + 1) * HITS_PER_PAGE)
  const [editing, setEditing] = useState(false)
  // null = closed, 'new' = creating, otherwise the hit being edited.
  const [form, setForm] = useState<Hit | 'new' | null>(null)
  // `n` changes on every press so repeated presses of the same tile re-run the flash.
  const [flash, setFlash] = useState<{ id: string; n: number } | null>(null)

  const fire = (hit: Hit) => {
    onFire(hit)
    setFlash((f) => ({ id: hit.id, n: (f?.n ?? 0) + 1 }))
  }

  return (
    <section className="border-t border-line bg-panel/70 backdrop-blur-xl">
      <header className="flex items-center justify-between px-4 pt-3 pb-2">
        <h2 className="text-[11px] font-semibold tracking-widest text-white/50 uppercase">
          Hits <span className="ml-1 normal-case tracking-normal text-white/25">鍵盤 1–8 觸發</span>
        </h2>
        <div className="ml-auto mr-2 flex items-center gap-1">
          <button
            onClick={() => onPage(current - 1)}
            disabled={current === 0}
            className="h-8 w-8 rounded-md text-white/60 hover:bg-white/10 disabled:opacity-25"
            aria-label="上一頁"
          >
            ‹
          </button>
          <span className="min-w-12 text-center font-mono text-[11px] text-white/50 tabular">
            {current + 1} / {pages}
          </span>
          <button
            onClick={() => onPage(current + 1)}
            disabled={current >= pages - 1}
            className="h-8 w-8 rounded-md text-white/60 hover:bg-white/10 disabled:opacity-25"
            aria-label="下一頁"
          >
            ›
          </button>
          <button data-haptic="tap" onClick={onStopAll} className="ml-1 h-8 pointer-coarse:h-11 rounded-md px-2 text-[11px] text-white/50 hover:bg-panic/20 hover:text-panic">
            ■ Stop Hits
          </button>
        </div>
        <button
          onClick={() => {
            setEditing((e) => !e)
            setForm(null)
          }}
          className={`rounded-md px-2.5 py-1 text-xs transition ${editing ? 'bg-accent text-white' : 'text-white/50 hover:bg-white/10'}`}
        >
          {editing ? '完成' : '編輯'}
        </button>
      </header>

      <AnimatePresence>
        {form && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <HitForm
              key={form === 'new' ? 'new' : form.id}
              projectId={projectId}
              folder={hitMediaFolder(projectName, projectId)}
              hit={form === 'new' ? null : form}
              onCancel={() => setForm(null)}
              onSave={async (values) => {
                if (form === 'new') await onAdd(values)
                else await onUpdate(form.id, values)
                setForm(null)
              }}
              onDelete={
                form === 'new'
                  ? undefined
                  : async () => {
                      await onRemove(form.id)
                      setForm(null)
                    }
              }
            />
          </motion.div>
        )}
      </AnimatePresence>

      <div className="grid grid-cols-3 gap-2 px-4 pb-4 sm:grid-cols-4 xl:grid-cols-6">
        {pageHits.map((hit, i) => {
          const color = TILE_COLORS[i % TILE_COLORS.length]
          return (
            <motion.button
              key={hit.id}
              whileTap={{ scale: 0.94 }}
              onClick={() => (editing ? setForm(hit) : fire(hit))}
              className="relative flex h-16 flex-col justify-between overflow-hidden rounded-xl border border-white/10 p-2.5 text-left"
              style={{ background: `linear-gradient(160deg, ${color}40, ${color}14)` }}
            >
              <AnimatePresence>
                {flash?.id === hit.id && (
                  <motion.span
                    key={flash.n}
                    initial={{ opacity: 0.8 }}
                    animate={{ opacity: 0 }}
                    transition={{ duration: 0.6 }}
                    onAnimationComplete={() => setFlash(null)}
                    className="absolute inset-0"
                    style={{ background: color }}
                  />
                )}
              </AnimatePresence>
              <span className="relative truncate text-sm font-semibold text-white">{hit.title}</span>
              <span className="relative flex items-center justify-between font-mono text-[10px] text-white/50">
                <span>{i + 1}</span>
                <span>{editing ? '✎ 編輯' : `${hit.volume}%`}</span>
              </span>
            </motion.button>
          )
        })}
        {editing && (current === pages - 1 || pageHits.length === 0) && (
          <button
            onClick={() => setForm('new')}
            className="flex h-16 items-center justify-center rounded-xl border border-dashed border-white/20 text-sm text-white/50 hover:border-accent hover:text-white"
          >
            ＋ 新增 Hit
          </button>
        )}
        {!editing && hits.length === 0 && (
          <p className="col-span-full py-3 text-center text-xs text-white/30">還沒有 Hit。點「編輯」新增快捷音效。</p>
        )}
      </div>
    </section>
  )
}

function HitForm({
  hit,
  projectId,
  folder,
  onSave,
  onCancel,
  onDelete,
}: {
  hit: Hit | null
  projectId: string
  folder: string
  onSave: (values: Omit<Hit, 'id' | 'order'>) => Promise<void>
  onCancel: () => void
  onDelete?: () => Promise<void>
}) {
  const [title, setTitle] = useState(hit?.title ?? '')
  const [targetUrl, setTargetUrl] = useState(hit?.targetUrl ?? '')
  const [volume, setVolume] = useState(hit?.volume ?? 100)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    if (!title.trim() || !targetUrl.trim()) return setError('請輸入名稱並上傳音檔或填入 URL')
    try {
      await onSave({ title: title.trim(), targetUrl: targetUrl.trim(), volume })
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <div className="mx-4 mb-3 grid gap-3 rounded-xl border border-line bg-black/40 p-3 md:grid-cols-[1fr_1.4fr_10rem_auto] md:items-end">
      <label className="block">
        <Label>名稱</Label>
        <input className={fieldClass} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="門鈴" />
      </label>
      <div className="space-y-1.5">
        <Label>音檔</Label>
        <div className="flex gap-2">
          <input
            className={`${fieldClass} font-mono text-xs`}
            value={targetUrl}
            onChange={(e) => setTargetUrl(e.target.value)}
            placeholder="https://"
          />
          <div className="w-28 shrink-0">
            <MediaUploadButton
              accept="audio/*"
              folder={folder}
              library={{ projectId, source: 'hit' }}
              label="上傳"
              onUploaded={(result, file) => {
                setTargetUrl(result.secure_url)
                setTitle((t) => t || file.name.replace(/\.[^.]+$/, ''))
              }}
            />
          </div>
        </div>
      </div>
      <div>
        <Label hint={`${volume}%`}>音量</Label>
        <Fader label="Hit volume" value={volume} onChange={setVolume} fill="#30d158" />
      </div>
      <div className="flex gap-2">
        {onDelete && (
          <button onClick={onDelete} className="rounded-lg px-3 py-2 text-xs text-white/40 hover:bg-panic/20 hover:text-panic">
            刪除
          </button>
        )}
        <button onClick={onCancel} className="rounded-lg px-3 py-2 text-xs text-white/50 hover:bg-white/10">
          取消
        </button>
        <button onClick={submit} className="rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-white">
          儲存
        </button>
      </div>
      {error && <p className="text-xs text-panic md:col-span-4">{error}</p>}
    </div>
  )
}
