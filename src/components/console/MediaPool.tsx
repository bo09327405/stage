import { AnimatePresence, motion } from 'motion/react'
import { useMemo, useState } from 'react'
import { formatTime } from '../../hooks/useServerNow'
import { playableUrl, thumbnailUrl } from '../../services/uploads'
import { isApproved, type AudienceUpload, type Cue, type ModerationStatus } from '../../types/cue'
import { Segmented } from '../ui/controls'

type KindFilter = 'all' | 'image' | 'audio' | 'video'
/** Review state shown in manage mode. Pick mode only ever offers approved, visible uploads. */
type ReviewFilter = 'usable' | 'pending' | 'rejected' | 'hidden'

interface MediaPoolProps {
  uploads: AudienceUpload[] | null
  cues: Cue[]
  /** "manage": console sidebar with review / Create Cue / hide. "pick": choose one file for a cue. */
  mode: 'manage' | 'pick'
  /** Restrict to one kind (pick mode for an IMAGE, AUDIO or VIDEO cue). */
  lockKind?: 'image' | 'audio' | 'video'
  /** Pre-select a cue filter, e.g. the interactive cue that's running. */
  initialCueId?: string | null
  onCreateCue?: (upload: AudienceUpload) => Promise<Cue>
  onPick?: (upload: AudienceUpload) => void
  /** Operator review: approve or reject an upload. */
  onModerate?: (upload: AudienceUpload, status: ModerationStatus) => void
  /** Hide from / restore to the inbox. Uploads are never deleted. */
  onHide?: (upload: AudienceUpload, hidden: boolean) => void
  /** Ask Cloudinary again for an AI moderation result that was still queued. */
  onRecheck?: (upload: AudienceUpload) => Promise<void>
}

function timeLabel(ms: number) {
  if (!ms) return '—'
  const diff = (Date.now() - ms) / 1000
  if (diff < 60) return '剛剛'
  if (diff < 3600) return `${Math.floor(diff / 60)} 分鐘前`
  return new Date(ms).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
}

/** Audience media pool: live grid of everything the audience has uploaded to this project. */
const reviewOf = (u: AudienceUpload): ReviewFilter => (u.hidden ? 'hidden' : u.moderation === 'rejected' ? 'rejected' : isApproved(u) ? 'usable' : 'pending')

export function MediaPool({
  uploads: all,
  cues,
  mode,
  lockKind,
  initialCueId = null,
  onCreateCue,
  onPick,
  onModerate,
  onHide,
  onRecheck,
}: MediaPoolProps) {
  const [kind, setKind] = useState<KindFilter>(lockKind ?? 'all')
  const [review, setReview] = useState<ReviewFilter>('usable')
  // Pick mode: only what may go on stage. Manage mode: the chosen review state.
  const uploads = useMemo(() => all && all.filter((u) => reviewOf(u) === (mode === 'pick' ? 'usable' : review)), [all, mode, review])
  // "all" | "folder:<path>" | "cue:<cueId>"
  const [source, setSource] = useState<string>(initialCueId ? `cue:${initialCueId}` : 'all')
  const [toast, setToast] = useState<{ text: string; n: number } | null>(null)
  const [creating, setCreating] = useState<string | null>(null)

  const cueById = useMemo(() => new Map(cues.map((c) => [c.id, c])), [cues])
  // Cues that actually have uploads, for the source filter.
  // Folders and source cues that actually have uploads, for the dropdown.
  const { folders, sourceCues } = useMemo(() => {
    const folderCounts = new Map<string, number>()
    const cueCounts = new Map<string, number>()
    for (const u of uploads ?? []) {
      folderCounts.set(u.folder, (folderCounts.get(u.folder) ?? 0) + 1)
      cueCounts.set(u.cueId, (cueCounts.get(u.cueId) ?? 0) + 1)
    }
    return {
      folders: [...folderCounts].sort(([a], [b]) => a.localeCompare(b)),
      sourceCues: [...cueCounts].map(([id, count]) => ({ id, count, cue: cueById.get(id) ?? null })),
    }
  }, [uploads, cueById])

  const matchesSource = (u: AudienceUpload) =>
    source === 'all' ||
    (source.startsWith('folder:') && u.folder === source.slice(7)) ||
    (source.startsWith('cue:') && u.cueId === source.slice(4))
  const visible = (uploads ?? []).filter((u) => (kind === 'all' || u.kind === kind) && matchesSource(u))
  const counts = {
    all: uploads?.length ?? 0,
    image: uploads?.filter((u) => u.kind === 'image').length ?? 0,
    audio: uploads?.filter((u) => u.kind === 'audio').length ?? 0,
    video: uploads?.filter((u) => u.kind === 'video').length ?? 0,
  }
  const reviewCounts = (state: ReviewFilter) => all?.filter((u) => reviewOf(u) === state).length ?? 0

  async function createCue(upload: AudienceUpload) {
    if (!onCreateCue) return
    setCreating(upload.id)
    try {
      const cue = await onCreateCue(upload)
      setToast((t) => ({ text: `已建立 Q${cue.cueNumber}「${cue.title}」`, n: (t?.n ?? 0) + 1 }))
    } catch (err) {
      setToast((t) => ({ text: `建立失敗：${(err as Error).message}`, n: (t?.n ?? 0) + 1 }))
    } finally {
      setCreating(null)
    }
  }

  const showSourceFilter = folders.length > 1 || sourceCues.length > 1
  const showFilters = !lockKind || showSourceFilter || mode === 'manage'
  const pendingCount = reviewCounts('pending')

  return (
    <div className="flex h-full flex-col">
      {showFilters && (
      <div className="space-y-3 border-b border-line px-4 py-3">
        {mode === 'manage' && (
          <div className="grid grid-cols-4 gap-1 rounded-lg bg-black/40 p-1 text-[11px]" role="tablist" aria-label="審查狀態" data-review-filter>
            {(
              [
                ['usable', '✓ 可用'],
                ['pending', '⏳ 待審'],
                ['rejected', '⛔ 已拒絕'],
                ['hidden', '🙈 隱藏'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setReview(id)}
                aria-pressed={review === id}
                className={`min-h-8 rounded-md ${review === id ? 'bg-white/15 text-white' : 'text-white/50'} ${id === 'pending' && pendingCount > 0 && review !== id ? 'text-standby' : ''}`}
                data-review={id}
              >
                {label} {reviewCounts(id)}
              </button>
            ))}
          </div>
        )}
        {!lockKind && (
          <Segmented<KindFilter>
            columns={4}
            value={kind}
            onChange={setKind}
            options={[
              { id: 'all', label: `全部 ${counts.all}` },
              { id: 'image', label: `📷 ${counts.image}` },
              { id: 'audio', label: `🎙 ${counts.audio}` },
              { id: 'video', label: `🎬 ${counts.video}` },
            ]}
          />
        )}
        {showSourceFilter && (
          <label className="relative block">
            <span className="sr-only">資料夾 / Cue</span>
            <select
              value={source}
              onChange={(e) => setSource(e.target.value)}
              className="min-h-11 w-full appearance-none rounded-lg border border-line bg-black/40 py-2 pr-9 pl-3 text-sm text-white outline-none focus:border-accent/80"
            >
              <option value="all">📂 所有資料夾與 Cue（{uploads?.length ?? 0}）</option>
              <optgroup label="Cloudinary 資料夾">
                {folders.map(([folder, count]) => (
                  <option key={folder} value={`folder:${folder}`}>
                    {folder}/（{count}）
                  </option>
                ))}
              </optgroup>
              <optgroup label="來源 Cue">
                {sourceCues.map(({ id, count, cue }) => (
                  <option key={id} value={`cue:${id}`}>
                    {cue ? `Q${cue.cueNumber} ${cue.title}` : '已刪除的 Cue'}（{count}）
                  </option>
                ))}
              </optgroup>
            </select>
            <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-xs text-white/40">▾</span>
          </label>
        )}
      </div>
      )}

      <div className="relative min-h-0 flex-1 overflow-y-auto p-3">
        {uploads === null ? (
          <p className="p-6 text-center text-sm text-white/30">載入收件匣…</p>
        ) : visible.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-16 text-center">
            <div className="text-4xl text-white/10">📥</div>
            <p className="text-sm text-white/40">
              {all?.length === 0 ? '還沒有觀眾上傳' : uploads.length === 0 ? { usable: '還沒有審查通過的檔案', pending: '沒有待審檔案', rejected: '沒有被拒絕的檔案', hidden: '沒有隱藏的檔案' }[mode === 'pick' ? 'usable' : review] : '沒有符合篩選的檔案'}
            </p>
            {all?.length === 0 && (
              <p className="text-xs text-white/25">執行「互動上傳」Cue 後，觀眾的照片、錄音與影片會即時出現在這裡</p>
            )}
            {mode === 'pick' && pendingCount > 0 && <p className="text-xs text-standby">另有 {pendingCount} 個檔案等待審查（到收件匣核准後才能使用）</p>}
          </div>
        ) : (
          <ul className={`grid gap-2.5 ${mode === 'pick' ? 'grid-cols-2 sm:grid-cols-3' : 'grid-cols-2'}`}>
            <AnimatePresence initial={false}>
              {visible.map((upload) => (
                <UploadCard
                  key={upload.id}
                  upload={upload}
                  sourceCue={cueById.get(upload.cueId) ?? null}
                  mode={mode}
                  creating={creating === upload.id}
                  onCreate={() => createCue(upload)}
                  onPick={() => onPick?.(upload)}
                  onModerate={onModerate ? (status) => onModerate(upload, status) : undefined}
                  onHide={onHide ? (hidden) => onHide(upload, hidden) : undefined}
                  onRecheck={onRecheck ? () => onRecheck(upload) : undefined}
                />
              ))}
            </AnimatePresence>
          </ul>
        )}

        <AnimatePresence>
          {toast && (
            <motion.div
              key={toast.n}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 12 }}
              onAnimationComplete={() => setTimeout(() => setToast((t) => (t?.n === toast.n ? null : t)), 2200)}
              className="sticky bottom-1 mx-auto mt-3 w-fit rounded-full border border-go/40 bg-panel/90 px-4 py-2 text-xs text-go shadow-xl backdrop-blur-xl"
            >
              ✓ {toast.text}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}

function UploadCard({
  upload,
  sourceCue,
  mode,
  creating,
  onCreate,
  onPick,
  onModerate,
  onHide,
  onRecheck,
}: {
  upload: AudienceUpload
  sourceCue: Cue | null
  mode: 'manage' | 'pick'
  creating: boolean
  onCreate: () => void
  onPick: () => void
  onModerate?: (status: ModerationStatus) => void
  onHide?: (hidden: boolean) => void
  onRecheck?: () => Promise<void>
}) {
  const isImage = upload.kind === 'image'
  const Wrapper = mode === 'pick' ? 'button' : 'div'
  const approved = isApproved(upload)
  const rejected = upload.moderation === 'rejected'
  const [checking, setChecking] = useState(false)

  return (
    <motion.li
      layout
      initial={{ opacity: 0, scale: 0.92 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.92 }}
      transition={{ type: 'spring', stiffness: 450, damping: 35 }}
      className="group overflow-hidden rounded-xl border border-line bg-white/[0.03] backdrop-blur-xl"
      data-upload-card={upload.id}
      data-moderation={upload.moderation ?? 'approved'}
    >
      <Wrapper
        {...(mode === 'pick' ? { type: 'button' as const, onClick: onPick } : {})}
        className={`block w-full text-left ${mode === 'pick' ? 'transition hover:ring-2 hover:ring-accent' : ''}`}
      >
        {isImage ? (
          <div className="relative aspect-square overflow-hidden bg-black">
            {/* Unchecked or rejected images stay blurred so nothing unsafe flashes on the console. */}
            <img src={thumbnailUrl(upload)} alt="" loading="lazy" className={`h-full w-full object-cover ${approved ? '' : 'scale-110 blur-xl'}`} />
            {mode === 'manage' && (
              <a
                href={upload.url}
                target="_blank"
                rel="noreferrer"
                className="absolute top-1.5 right-1.5 rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] text-white/70 opacity-0 backdrop-blur transition group-hover:opacity-100"
              >
                原圖 ↗
              </a>
            )}
          </div>
        ) : upload.kind === 'video' ? (
          <div className="relative aspect-square overflow-hidden bg-black">
            {mode === 'manage' && approved ? (
              <video src={playableUrl(upload)} poster={thumbnailUrl(upload)} controls preload="none" playsInline className="h-full w-full object-cover" />
            ) : (
              <img src={thumbnailUrl(upload)} alt="" loading="lazy" className={`h-full w-full object-cover ${approved ? '' : 'scale-110 blur-xl'}`} />
            )}
            <span className="pointer-events-none absolute bottom-1.5 left-1.5 rounded bg-black/60 px-1.5 py-0.5 font-mono text-[10px] text-white/80">
              🎬 {upload.duration ? formatTime(upload.duration) : ''}
            </span>
          </div>
        ) : (
          <div className="flex aspect-square flex-col items-center justify-center gap-3 bg-gradient-to-b from-accent/15 to-transparent p-3">
            <span className="text-3xl">🎙</span>
            <span className="font-mono text-xs text-white/60 tabular">{upload.duration ? formatTime(upload.duration) : '錄音'}</span>
            {mode === 'manage' && (
              // Transcoded MP3 so recordings from any phone preview in any browser.
              <audio src={playableUrl(upload)} controls preload="none" className="h-8 w-full" />
            )}
          </div>
        )}

        <div className="space-y-1 px-2.5 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[11px] font-semibold tracking-widest text-white/80">
              {upload.audienceId}
            </span>
            <span className="text-[10px] text-white/35">{timeLabel(upload.createdAt)}</span>
          </div>
          <div className="truncate text-[10px] text-white/30">
            {sourceCue ? `來自 Q${sourceCue.cueNumber} ${sourceCue.title}` : '來自已刪除的 Cue'}
          </div>
          <div className="truncate font-mono text-[10px] text-white/25" title={upload.folder}>
            📁 {upload.folder}/
          </div>
          {upload.moderation && (
            <div className="text-[10px]" data-moderation-badge>
              {upload.moderation === 'approved' ? (
                <span className="text-go">✓ {upload.moderatedBy === 'ai' ? 'AI 審查通過' : '已核准'}</span>
              ) : rejected ? (
                <span className="text-panic">⛔ {upload.moderatedBy === 'ai' ? 'AI 審查拒絕' : '已拒絕'}</span>
              ) : (
                <span className="text-standby">⏳ {upload.moderationKind ? `AI 審查中（${upload.moderationKind}）` : '等待人工審查'}</span>
              )}
            </div>
          )}
        </div>
      </Wrapper>

      {mode === 'manage' && (
        <div className="flex flex-wrap gap-1 border-t border-line p-1.5">
          {upload.hidden ? (
            onHide && (
              <button type="button" onClick={() => onHide(false)} className="min-h-9 flex-1 rounded-lg bg-white/10 text-xs text-white/70 hover:bg-white/15" data-upload-unhide>
                ↺ 取消隱藏
              </button>
            )
          ) : approved ? (
            <>
              <button
                type="button"
                onClick={onCreate}
                disabled={creating}
                className="min-h-9 flex-1 rounded-lg bg-go/15 text-xs font-semibold text-go transition hover:bg-go hover:text-black disabled:opacity-40 pointer-coarse:min-h-11"
                data-upload-create
              >
                {creating ? '建立中…' : '＋ 建立 Cue'}
              </button>
              {onModerate && (
                <button type="button" onClick={() => onModerate('rejected')} className="min-h-9 rounded-lg px-2 text-xs text-white/30 hover:bg-panic/20 hover:text-panic" title="改為拒絕（不能再用於 Cue）">
                  ⛔
                </button>
              )}
            </>
          ) : (
            onModerate && (
              <>
                <button type="button" onClick={() => onModerate('approved')} className="min-h-9 flex-1 rounded-lg bg-go/15 text-xs font-semibold text-go hover:bg-go hover:text-black pointer-coarse:min-h-11" data-upload-approve>
                  ✓ 核准
                </button>
                {!rejected && (
                  <button type="button" onClick={() => onModerate('rejected')} className="min-h-9 flex-1 rounded-lg bg-panic/15 text-xs font-semibold text-panic hover:bg-panic hover:text-white pointer-coarse:min-h-11" data-upload-reject>
                    ⛔ 拒絕
                  </button>
                )}
                {!rejected && upload.moderationKind && onRecheck && (
                  <button
                    type="button"
                    disabled={checking}
                    onClick={() => {
                      setChecking(true)
                      onRecheck().finally(() => setChecking(false))
                    }}
                    className="min-h-9 rounded-lg px-2 text-xs text-white/50 hover:bg-white/10"
                    title="向 Cloudinary 查詢 AI 審查結果"
                  >
                    {checking ? '…' : '↻'}
                  </button>
                )}
              </>
            )
          )}
          {!upload.hidden && onHide && (
            <button
              type="button"
              onClick={() => onHide(true)}
              className="min-h-9 rounded-lg px-2.5 text-xs text-white/30 transition hover:bg-white/10 hover:text-white pointer-coarse:min-h-11"
              title="從收件匣隱藏（檔案永久保留在 Cloudinary，可隨時取消隱藏）"
              data-upload-hide
            >
              🙈
            </button>
          )}
        </div>
      )}
    </motion.li>
  )
}
