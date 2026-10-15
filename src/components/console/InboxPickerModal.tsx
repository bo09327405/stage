import { isAdmin, useAuth } from '../../services/auth'
import { deleteR2 } from '../../services/storage'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { formatTime } from '../../hooks/useServerNow'
import {
  migrateMediaToR2,
  useDefaultMedia,
  useProjectMedia,
  type R2Listing,
  type MediaKind,
  type ProjectMedia,
} from '../../services/mediaLibrary'
import { forgetDeletedKeys, forgetMissing, useLiveMedia } from '../../services/mediaValidation'
import { isApproved, type AudienceUpload, type Cue } from '../../types/cue'
import { DEFAULT_MEDIA_FOLDER, SHARED_MEDIA_PATH, cueMediaFolder } from '../../types/project'
import { R2_INPUT_PLACEHOLDER, lookupR2Input } from '../../services/r2Input'
import { fileTypeOf, logFileActivity } from '../../services/fileActivity'
import { Segmented, fieldClass } from '../ui/controls'
import { MediaUploadButton } from '../ui/MediaUploadButton'
import { MediaPool } from './MediaPool'
import { AudiencePoolGrid } from './AudiencePoolGrid'

interface InboxPickerModalProps {
  open: boolean
  projectId: string
  /** For the project's R2 upload folder (theatre/cues/{name}). */
  projectName: string
  uploads: AudienceUpload[] | null
  cues: Cue[]
  /** Only offer files that fit the cue being edited. */
  lockKind?: MediaKind
  onPick: (upload: AudienceUpload) => void
  onPickMedia: (media: ProjectMedia) => void
  onClose: () => void
}

type Source = 'project' | 'default' | 'audience'

const ACCEPT: Record<MediaKind, string> = { image: 'image/*', audio: 'audio/*', video: 'video/*' }

const KIND_ICON: Record<MediaKind, string> = { image: '🖼', audio: '♪', video: '▶' }

/**
 * Pick a file for a cue: the project's own media and the shared Default folder (theatre/cues/Default,
 * the same in every project) — both on Cloudflare R2 — or audience uploads (Cloudinary, the only
 * place it's still used). An R2 path or URL can also be typed in.
 */
export function InboxPickerModal(props: InboxPickerModalProps) {
  // Rendered into <body>: the editor it opens from is animated (transformed), which would trap a
  // fixed-position dialog inside the editor column.
  return createPortal(
    <AnimatePresence>
      {props.open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={props.onClose}
        >
          <motion.div
            initial={{ scale: 0.96, y: 12 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.96, y: 12 }}
            transition={{ type: 'spring', stiffness: 450, damping: 35 }}
            onClick={(e) => e.stopPropagation()}
            className="flex h-[min(80dvh,720px)] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-line bg-panel/95 shadow-2xl backdrop-blur-2xl"
            role="dialog"
            aria-label="選取檔案"
            data-media-picker
          >
            <PickerBody {...props} />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}

function PickerBody({ projectId, projectName, uploads, cues, lockKind, onPick, onPickMedia, onClose }: InboxPickerModalProps) {
  const admin = isAdmin(useAuth().user)
  const [nonce, setNonce] = useState(0)
  const { media } = useProjectMedia(projectId)
  const shared = useDefaultMedia()
  // Project and Default files live on R2. Records still pointing at Cloudinary (from before the
  // move) aren't offered; the project tab can copy them over (`legacy`).
  const legacy = (media ?? []).filter((m) => m.storage !== 'r2')
  // Records whose cloud file is gone (deleted from R2) are hidden at once and their
  // records cleaned up in the background: this project's for everyone, the Default index by admins.
  const liveProject = useLiveMedia(media && media.filter((m) => m.storage === 'r2'), { projectId, cleanup: true, nonce })
  const liveDefault = useLiveMedia(shared.media, { projectId: null, cleanup: admin, nonce })
  const projectFiles = (liveProject.files ?? []).filter((m) => !lockKind || m.kind === lockKind)
  const defaultFiles = (liveDefault.files ?? []).filter((m) => !lockKind || m.kind === lockKind)
  // Default index entries the R2 listing no longer has (deleted outside this app).
  const ghostsCleaned = useRef(new Set<string>())
  const [ghostsRemoved, setGhostsRemoved] = useState(0)
  useEffect(() => {
    const fresh = shared.ghosts.filter((m) => !ghostsCleaned.current.has(m.id))
    if (!admin || !fresh.length) return
    fresh.forEach((m) => ghostsCleaned.current.add(m.id))
    void forgetMissing(null, fresh).then((n) => n && setGhostsRemoved((r) => r + n)).catch(() => {})
  }, [shared.ghosts, admin])
  const syncing = liveProject.checking || liveDefault.checking || shared.r2.status === 'loading'
  const dropped = liveProject.hidden + liveDefault.hidden + shared.ghosts.length
  const cleaned = liveProject.removed + liveDefault.removed + ghostsRemoved
  const [synced, setSynced] = useState(false)
  const sync = () => {
    setSynced(true)
    setNonce((n) => n + 1)
    shared.reload()
  }
  // Audience uploads: only approved, visible ones can go into a cue.
  const audienceKind = lockKind
  const audienceCount = (uploads ?? []).filter((u) => (!audienceKind || u.kind === audienceKind) && isApproved(u) && !u.hidden).length
  const [source, setSource] = useState<Source>(projectFiles.length === 0 && audienceCount > 0 ? 'audience' : 'project')
  const [audienceScope, setAudienceScope] = useState<'project' | 'all'>('project')

  return (
    <>
      <header className="space-y-3 border-b border-line px-5 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">選取檔案</h2>
            <p className="text-xs text-white/40">
              此專案的檔案與 Default 共用素材{lockKind ? ` · 僅${{ image: '圖片', audio: '音訊', video: '影片' }[lockKind]}` : ''}
            </p>
          </div>
          <div className="flex items-center gap-1">
            <span className="mr-1 hidden text-right text-[11px] leading-tight text-white/40 sm:block" aria-live="polite" data-sync-status>
              {syncing ? '比對雲端中…' : synced || dropped ? `已與雲端同步${dropped ? ` · 隱藏 ${dropped} 個已刪除的檔案` : ''}${cleaned ? `（已清除 ${cleaned} 筆失效紀錄）` : ''}` : ''}
            </span>
            <button
              type="button"
              onClick={sync}
              disabled={syncing}
              className="flex h-9 items-center gap-1.5 rounded-lg bg-white/[0.07] px-3 text-xs text-white/75 hover:bg-white/15 disabled:opacity-60"
              title="重新讀取 R2，移除已不存在的檔案"
              data-sync-cloud
            >
              <span className={syncing ? 'inline-block animate-spin' : ''}>↻</span> 同步雲端
            </button>
            <button
              onClick={onClose}
              className="flex h-11 w-11 items-center justify-center rounded-lg text-white/40 hover:bg-white/10 hover:text-white"
              aria-label="關閉"
            >
              ✕
            </button>
          </div>
        </div>
        <Segmented<Source>
          columns={3}
          value={source}
          onChange={setSource}
          options={[
            { id: 'project', label: `📁 專案素材 ${projectFiles.length}`, description: `R2 · ${cueMediaFolder(projectName, projectId)}` },
            { id: 'default', label: `📌 Default 共用 ${shared.media ? defaultFiles.length : '…'}`, description: 'R2 · 所有專案共用的音效 / 音樂' },
            { id: 'audience', label: `📥 觀眾上傳 ${audienceCount}`, description: 'Cloudinary · 此專案或所有專案的觀眾作品' },
          ]}
        />
        {source !== 'audience' && (
          <R2PathBar
            lockKind={lockKind}
            onPick={(m) => {
              onPickMedia(m)
              onClose()
            }}
          />
        )}
      </header>

      <div className="min-h-0 flex-1">
        {source === 'default' ? (
          <DefaultFolder
            projectId={projectId}
            files={defaultFiles}
            loading={liveDefault.files === null}
            r2={shared.r2}
            lockKind={lockKind}
            onReload={shared.reload}
            onPick={(m) => {
              onPickMedia(m)
              onClose()
            }}
          />
        ) : source === 'audience' ? (
          <div className="flex h-full flex-col">
            <div className="flex items-center gap-2 border-b border-line px-4 py-2 text-xs">
              <span className="text-white/45">☁ Cloudinary 觀眾互動空間</span>
              <div className="ml-auto grid grid-cols-2 gap-0.5 rounded-lg bg-black/40 p-0.5">
                {(
                  [
                    ['project', '此專案'],
                    ['all', '所有專案'],
                  ] as const
                ).map(([id, label]) => (
                  <button key={id} type="button" onClick={() => setAudienceScope(id)} className={`min-h-7 rounded-md px-3 font-semibold ${audienceScope === id ? 'bg-white/15 text-white' : 'text-white/45'}`} data-audience-scope={id}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="min-h-0 flex-1">
              {audienceScope === 'project' ? (
                <MediaPool
                  uploads={uploads}
                  cues={cues}
                  mode="pick"
                  lockKind={audienceKind}
                  onPick={(upload) => {
                    onPick(upload)
                    onClose()
                  }}
                />
              ) : (
                <AudiencePoolGrid
                  kind={audienceKind}
                  projectId={projectId}
                  onPick={(upload) => {
                    onPick(upload)
                    onClose()
                  }}
                />
              )}
            </div>
          </div>
        ) : (
          <ProjectFolder
            projectId={projectId}
            folder={cueMediaFolder(projectName, projectId)}
            files={projectFiles}
            loading={liveProject.files === null}
            legacy={legacy}
            lockKind={lockKind}
            onPick={(m) => {
              onPickMedia(m)
              onClose()
            }}
          />
        )}
      </div>
    </>
  )
}

/** A grid of library files; `onRemove` adds a small ✕ to entries that can be removed. */
function MediaGrid({ files, onPick, onRemove }: { files: ProjectMedia[]; onPick: (m: ProjectMedia) => void; onRemove?: (m: ProjectMedia) => void }) {
  const admin = isAdmin(useAuth().user)
  return (
    <ul className="grid grid-cols-2 content-start gap-2.5 p-3 sm:grid-cols-3" data-media-grid>
      {files.map((m) => (
        <li key={m.id} className="group relative">
          <button
            type="button"
            onClick={() => onPick(m)}
            className="block w-full overflow-hidden rounded-xl border border-line bg-white/[0.03] text-left transition hover:ring-2 hover:ring-accent"
            data-media-item={m.publicId}
          >
            {m.kind === 'image' ? (
              <img
                src={m.url}
                alt=""
                loading="lazy"
                className="aspect-[3/2] w-full bg-black object-cover"
              />
            ) : (
              <div className="flex aspect-[3/2] flex-col items-center justify-center gap-1 bg-gradient-to-b from-go/15 to-transparent">
                <span className="text-2xl">{KIND_ICON[m.kind]}</span>
                <span className="font-mono text-xs text-white/60 tabular">{m.duration ? formatTime(m.duration) : ''}</span>
              </div>
            )}
            <div className="space-y-0.5 px-2.5 py-2">
              <div className="truncate text-xs font-medium text-white/85" title={m.name}>
                {m.name}
              </div>
              <div className="truncate font-mono text-[10px] text-white/30" title={m.folder}>
                <span className="mr-1 rounded bg-[#f6821f]/20 px-1 text-[#f6a35c]">R2</span>
                {m.folder}/
              </div>
            </div>
          </button>
          {onRemove && admin && (
            <button
              type="button"
              onClick={() =>
                confirm(`永久刪除 Default 共用資料夾裡的「${m.name}」？（R2 上的檔案會被刪除；使用它的 Cue 會無法播放）`) && onRemove(m)
              }
              className="absolute top-1.5 right-1.5 flex h-7 w-7 items-center justify-center rounded-md bg-black/70 text-xs text-white/60 opacity-0 transition group-hover:opacity-100 hover:text-panic focus:opacity-100 pointer-coarse:opacity-100"
              aria-label={`刪除 ${m.name}`}
            >
              ✕
            </button>
          )}
        </li>
      ))}
    </ul>
  )
}

/** The shared Default folders on R2 (theatre/cues/Default, theatre/daw/Default): browse; admins upload and delete. */
function DefaultFolder({
  projectId,
  files,
  loading,
  r2,
  lockKind,
  onReload,
  onPick,
}: {
  projectId: string
  files: ProjectMedia[]
  loading: boolean
  r2: R2Listing
  lockKind?: MediaKind
  onReload: () => void
  onPick: (m: ProjectMedia) => void
}) {
  const admin = isAdmin(useAuth().user)
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)

  return (
    <div className="flex h-full flex-col" data-default-folder>
      <div className="space-y-2 border-b border-line px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-auto font-mono text-xs text-white/60">
            <span className="mr-1 rounded bg-[#f6821f]/20 px-1 text-[#f6a35c]">R2</span>
            {DEFAULT_MEDIA_FOLDER}/
          </span>
          {admin && (
            <div className="w-44">
              <MediaUploadButton
                accept={lockKind ? ACCEPT[lockKind] : 'audio/*,video/*,image/*'}
                folder={DEFAULT_MEDIA_FOLDER}
                library={{ projectId, source: 'cue', shared: true }}
                label="上傳到 Default"
                onUploaded={(_r, file) => setMessage({ text: `已上傳「${file.name}」到 R2 的 Default 資料夾`, ok: true })}
              />
            </div>
          )}
        </div>
        {message && <p className={`text-xs ${message.ok ? 'text-go' : 'text-panic'}`}>{message.text}</p>}
        {r2.status !== 'off' && (
          <p className="text-[11px] text-[#f6a35c]/80" data-r2-listing={r2.status}>
            {r2.status === 'ok' ? `R2：已同步 Default 資料夾（${r2.count} 個檔案）` : r2.status === 'error' ? `R2：${r2.message}` : 'R2：讀取中…'}
          </p>
        )}
        {!admin && <p className="text-[11px] text-white/35">Default 共用資料夾由管理員維護：所有專案都可以選用，只有管理員能上傳、改名或刪除。</p>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <p className="p-8 text-center text-sm text-white/30">載入共用素材…</p>
        ) : files.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-16 text-center">
            <div className="text-4xl text-white/10">📌</div>
            <p className="text-sm text-white/40">Default 共用資料夾還沒有{lockKind ? '這類' : ''}檔案</p>
            <p className="text-xs text-white/25">上傳到 Default 的檔案，在每個專案的「選取檔案」都看得到</p>
          </div>
        ) : (
          <MediaGrid
            files={files}
            onPick={onPick}
            onRemove={!admin ? undefined : (m) =>
              // The R2 file is deleted along with every record pointing at it (so no picker shows a
              // dead entry).
              deleteR2([m.publicId])
                .then(() => forgetDeletedKeys(projectId, [m.publicId]))
                .then(() => {
                  void logFileActivity({ action: 'delete', name: m.name, fileType: fileTypeOf(m.name, m.kind), storage: 'r2', url: m.url, key: m.publicId, record: m.id.startsWith('r2:') ? null : `${SHARED_MEDIA_PATH}/${m.id}`, projectName: 'Default 共用資源庫', from: m.folder, to: '已刪除（含 R2 檔案）' })
                  onReload()
                })
                .catch((err: Error) => alert(err.message))
            }
          />
        )}
      </div>
    </div>
  )
}

/** This project's files on R2 (theatre/cues/{project}): browse and upload. */
function ProjectFolder({
  projectId,
  folder,
  files,
  loading,
  legacy,
  lockKind,
  onPick,
}: {
  projectId: string
  folder: string
  files: ProjectMedia[]
  loading: boolean
  /** Records still pointing at the old storage, offered for copying to R2. */
  legacy: ProjectMedia[]
  lockKind?: MediaKind
  onPick: (m: ProjectMedia) => void
}) {
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)
  const [moving, setMoving] = useState(false)
  const migrate = async () => {
    setMoving(true)
    setMessage(null)
    const { moved, failed } = await migrateMediaToR2(projectId, folder, legacy)
    setMoving(false)
    setMessage(failed.length ? { text: `已搬移 ${moved} 個；${failed.length} 個失敗（${failed.join('、')}）`, ok: false } : { text: `已把 ${moved} 個舊檔複製到 R2`, ok: true })
  }
  return (
    <div className="flex h-full flex-col" data-project-folder>
      <div className="space-y-2 border-b border-line px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-auto font-mono text-xs text-white/60">
            <span className="mr-1 rounded bg-[#f6821f]/20 px-1 text-[#f6a35c]">R2</span>
            {folder}/
          </span>
          <div className="w-44">
            <MediaUploadButton
              accept={lockKind ? ACCEPT[lockKind] : 'audio/*,video/*,image/*'}
              folder={folder}
              library={{ projectId, source: 'cue' }}
              label="上傳到此專案"
              onUploaded={(_r, file) => setMessage({ text: `已上傳「${file.name}」到 R2`, ok: true })}
            />
          </div>
        </div>
        {legacy.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-white/45" data-legacy-media={legacy.length}>
            <span>另有 {legacy.length} 個舊檔案還沒搬到 R2，搬移後才會出現在這裡。</span>
            <button type="button" onClick={migrate} disabled={moving} className="h-7 rounded-md bg-white/[0.07] px-2 text-white/75 hover:bg-white/15 disabled:opacity-50" data-migrate-r2>
              {moving ? '搬移中…' : '搬到 R2'}
            </button>
          </div>
        )}
        {message && <p className={`text-xs ${message.ok ? 'text-go' : 'text-panic'}`}>{message.text}</p>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <p className="p-8 text-center text-sm text-white/30">載入專案素材…</p>
        ) : files.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-16 text-center">
            <div className="text-4xl text-white/10">📁</div>
            <p className="text-sm text-white/40">此專案還沒有{lockKind ? '這類' : ''}素材</p>
            <p className="text-xs text-white/25">上傳後就會出現在這裡，也可以在上方輸入 R2 檔案路徑</p>
          </div>
        ) : (
          <MediaGrid files={files} onPick={onPick} />
        )}
      </div>
    </div>
  )
}

const KIND_LABEL: Record<MediaKind, string> = { image: '圖片', audio: '音訊', video: '影片' }

/** Use a file by its R2 path or URL (typed or pasted). */
function R2PathBar({ lockKind, onPick }: { lockKind?: MediaKind; onPick: (m: ProjectMedia) => void }) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const use = async () => {
    if (!value.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      const m = await lookupR2Input(value)
      if (lockKind && m.kind !== lockKind) throw new Error(`這是${KIND_LABEL[m.kind]}檔，這個 Cue 需要${KIND_LABEL[lockKind]}`)
      onPick(m)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-1">
      <div className="flex gap-2">
        <input
          className={`${fieldClass} font-mono text-xs`}
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            setError(null)
          }}
          onKeyDown={(e) => e.key === 'Enter' && use()}
          placeholder={R2_INPUT_PLACEHOLDER}
          aria-label="R2 檔案路徑或網址"
          spellCheck={false}
          data-r2-path
        />
        <button type="button" onClick={use} disabled={!value.trim() || busy} className="min-h-11 shrink-0 rounded-lg bg-accent px-4 text-xs font-semibold text-white disabled:opacity-40" data-r2-path-use>
          {busy ? '確認中…' : '使用此檔案'}
        </button>
      </div>
      {error && (
        <p className="text-xs text-panic" data-r2-path-error>
          {error}
        </p>
      )}
    </div>
  )
}
