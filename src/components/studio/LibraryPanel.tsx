import { useAudiencePool } from '../../services/uploads'
import { isAdmin, useAuth } from '../../services/auth'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { recordProjectMedia, useDefaultMedia, useProjectMedia, type ProjectMedia } from '../../services/mediaLibrary'
import { importToR2, r2KeyOf, uploadStudioFile } from '../../services/storage'
import { SHARED_MEDIA_PATH, STUDIO_DEFAULT_FOLDER, projectMediaPath } from '../../types/project'
import { linkProjectAsset, useAssetFolders } from '../../services/assetLibrary'
import { AssetList } from './AssetList'
import { MediaUploadButton } from '../ui/MediaUploadButton'
import { Section } from './Inspector'

type Source = 'project' | 'default' | 'audience'

/**
 * Audio for the studio, all on Cloudflare R2: the project's files, the shared Default folder, and
 * audience recordings (on Cloudinary, copied into R2 before use, so a studio never points at
 * Cloudinary). Preview a file, or put it on the selected track at the playhead.
 *
 * The project tab carries the Set Cue project's name; inside, one folder per Studio with its
 * standard folders (背景音樂 / 錄音 / 上傳 / 語音), where new files are filed automatically (see
 * assetLibrary.ts).
 *
 * Every member organises the project's files (rename, delete, drag to reorder, custom folders);
 * the shared Default folder stays admin-managed.
 */
export function LibraryPanel({
  projectId,
  projectName,
  readOnly,
  studios,
  studioId,
  folder,
  onInsert,
  busy,
  onNotify,
  reveal = null,
}: {
  projectId: string
  projectName: string
  /** Locked project / official template: browse only. */
  readOnly: boolean
  /** The project's Studios (tab order) — one folder each in the project's tree — and the one open now. */
  studios: { id: string; name: string }[]
  studioId: string | null
  onNotify: (text: string, error?: boolean) => void
  /** A clip clicked on the timeline: find its file here, expand its folders, highlight it. */
  reveal?: { url: string; publicId: string; name: string; nonce: number } | null
  /** Upload target for new files: theatre/daw/{project}. */
  folder: string
  onInsert: (media: { url: string; name: string; publicId: string }) => void
  busy: string | null
}) {
  const { media } = useProjectMedia(projectId)
  const shared = useDefaultMedia()
  const [source, setSource] = useState<Source>('project')
  const [copying, setCopying] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [previewing, setPreviewing] = useState<string | null>(null)
  const audio = useRef<HTMLAudioElement | null>(null)
  useEffect(() => () => audio.current?.pause(), [])

  const audioOnly = (list: ProjectMedia[] | null | undefined) => list?.filter((m) => m.kind !== 'image') ?? null
  const onR2 = (list: ProjectMedia[] | null) => list?.filter((m) => m.storage === 'r2') ?? null
  // Audience recordings from every project (Cloudinary audience space): copied into R2 when used.
  const pool = useAudiencePool('audio')
  const { user } = useAuth()
  const admin = isAdmin(user)
  const assetFolders = useAssetFolders(projectId)
  const lists: Record<Source, ProjectMedia[] | null> = {
    audience:
      pool?.map((u) => ({
        id: u.id,
        kind: 'audio' as const,
        url: u.url,
        publicId: u.publicId,
        folder: u.projectName ? `觀眾 · ${u.projectName}` : '觀眾上傳',
        name: `觀眾錄音 ${new Date(u.createdAt).toLocaleString('zh-TW', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}.${u.url.split('.').pop() ?? 'wav'}`,
        duration: u.duration,
        bytes: 0,
        source: 'link' as const,
        createdAt: u.createdAt,
        storage: 'cloudinary' as const,
      })) ?? null,
    project: onR2(audioOnly(media)),
    default: onR2(audioOnly(shared.media)),
  }
  const all = lists[source]

  // Reveal the file behind a clicked clip: the project library first, then Default. Waits for the
  // lists to load (the panel may have just opened); each click is handled once.
  const [target, setTarget] = useState<{ id: string; nonce: number } | null>(null)
  const [handled, setHandled] = useState<number | null>(null)
  const [missing, setMissing] = useState<{ name: string; nonce: number } | null>(null)
  if (reveal && handled !== reveal.nonce && lists.project && lists.default) {
    // A new click (adjusting state while rendering, once per click).
    setHandled(reveal.nonce)
    const key = r2KeyOf(reveal.url) ?? reveal.publicId
    const same = (m: ProjectMedia) => m.url === reveal.url || (!!key && (m.publicId === key || r2KeyOf(m.url) === key))
    const found = lists.project.find(same) ?? lists.default.find(same)
    if (!found) setMissing({ name: reveal.name, nonce: reveal.nonce })
    else {
      setSource(lists.project.includes(found) ? 'project' : 'default')
      // A search that would hide it is cleared.
      if (query && !found.name.toLowerCase().includes(query.toLowerCase())) setQuery('')
      setTarget({ id: found.id, nonce: reveal.nonce })
    }
  }
  const notifyRef = useRef(onNotify)
  useLayoutEffect(() => {
    notifyRef.current = onNotify
  })
  useEffect(() => {
    if (missing) notifyRef.current(`素材庫中找不到「${missing.name}」的音檔（可能已從素材庫移除）`, true)
  }, [missing])
  const uploadFolder = source === 'default' ? STUDIO_DEFAULT_FOLDER : folder

  /** Copy a Set Cue file into this studio's R2 folder (and its library), then insert the copy. */
  const copyIn = async (m: ProjectMedia) => {
    setCopying(m.id)
    setError(null)
    try {
      const result = await importToR2(m.url, { folder, name: m.name })
      const file = new File([], m.name, { type: 'audio/*' })
      await recordProjectMedia(projectId, { ...result, duration: m.duration }, file, folder, 'studio').catch(() => {})
      onInsert({ url: result.secure_url, name: m.name.replace(/\.[^.]+$/, ''), publicId: result.public_id })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setCopying(null)
    }
  }

  const preview = (m: ProjectMedia) => {
    audio.current?.pause()
    if (previewing === m.id) return setPreviewing(null)
    const el = new Audio(m.url)
    el.onended = () => setPreviewing(null)
    el.play().catch(() => setPreviewing(null))
    audio.current = el
    setPreviewing(m.id)
  }

  const lead = (m: ProjectMedia) => (
    <button
      type="button"
      onClick={() => preview(m)}
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-xs ${previewing === m.id ? 'bg-go text-black' : 'bg-white/[0.07] text-white/70'}`}
      aria-label={previewing === m.id ? `停止試聽 ${m.name}` : `試聽 ${m.name}`}
    >
      {previewing === m.id ? '■' : '▶'}
    </button>
  )
  const action = (m: ProjectMedia) =>
    source === 'audience' ? (
      <button
        type="button"
        onClick={() => copyIn(m)}
        disabled={copying !== null}
        className="h-8 shrink-0 rounded-md bg-[#f6821f]/20 px-2 text-[11px] font-semibold text-[#f6a35c] hover:bg-[#f6821f] hover:text-black disabled:opacity-50"
        data-library-copy={m.publicId}
        title="複製到 R2 後加入"
      >
        {copying === m.id ? '複製中…' : '⇪ 複製加入'}
      </button>
    ) : (
      <button
        type="button"
        onClick={() => {
          onInsert({ url: m.url, name: m.name.replace(/\.[^.]+$/, ''), publicId: m.publicId })
          // A Default file used here joins the project's library, filed under 背景音樂.
          if (source === 'default' && !readOnly)
            linkProjectAsset(projectId, m, studioId ? { studioId, category: 'bgm' } : null).catch((err: Error) => onNotify(`已加入音軌，但未能加入專案素材：${err.message}`, true))
        }}
        disabled={busy === m.url}
        className="h-8 shrink-0 rounded-md bg-accent/20 px-2 text-[11px] font-semibold text-accent hover:bg-accent hover:text-white disabled:opacity-50"
        data-library-insert={m.publicId}
      >
        {busy === m.url ? '…' : '＋ 加入'}
      </button>
    )
  // The project's files: every member manages them; Default: admins; Set Cue / audience: copy in only.
  const mode = source === 'project' ? (readOnly ? 'view' : 'project') : source === 'default' && admin ? 'shared' : 'view'

  return (
    <div data-library-panel>
      <Section title="R2 素材">
        <div className="grid grid-cols-[2fr_1fr_1fr] gap-1 rounded-lg bg-black/40 p-1">
          {(
            [
              // The project's own files, under the Set Cue project's actual name.
              ['project', `📁 ${projectName || '專案'} ${lists.project?.length ?? '…'}`],
              ['default', '☁ Default'],
              ['audience', `👥 觀眾 ${lists.audience?.length ?? '…'}`],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setSource(id)}
              aria-pressed={source === id}
              className={`min-h-8 min-w-0 truncate rounded-md px-1 text-xs ${source === id ? 'bg-white/15 text-white' : 'text-white/50'}`}
              title={label}
              data-library-source={id}
            >
              {label}
            </button>
          ))}
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜尋檔名…"
          className="w-full rounded-lg border border-white/15 bg-black/40 px-2.5 py-1.5 text-xs text-white outline-none focus:border-accent"
        />
        {source === 'audience' ? (
          <p className="text-[10px] text-white/40">
            所有專案的觀眾錄音（Cloudinary 觀眾互動空間，審查通過的）。加入時會先複製一份到這個 Studio 的 R2 資料夾，Studio 只使用 R2 上的副本。
          </p>
        ) : source === 'default' && !admin ? (
          <p className="text-[10px] text-white/40">📌 Default 共用資料夾（R2）由管理員維護，所有專案都可以加入使用；加入的檔案會收進專案素材的「背景音樂」資料夾。</p>
        ) : (
          <>
            <MediaUploadButton
              accept="audio/*,video/*"
              folder={uploadFolder}
              library={{ projectId, source: 'studio', shared: source === 'default', studioId: source === 'project' ? studioId : null }}
              upload={(file) => uploadStudioFile(file, { folder: uploadFolder, name: file.name })}
              label={source === 'default' ? '上傳到 Default' : '上傳音檔'}
              onUploaded={(result, file) => {
                onInsert({ url: result.secure_url, name: file.name.replace(/\.[^.]+$/, ''), publicId: result.public_id })
                // Uploaded to the shared Default folder from a Studio: it's this Studio's 背景音樂 too.
                if (source === 'default' && studioId && !readOnly)
                  linkProjectAsset(
                    projectId,
                    { id: '', kind: 'audio', url: result.secure_url, publicId: result.public_id, folder: uploadFolder, name: file.name, duration: result.duration ?? 0, bytes: result.bytes ?? 0, source: 'studio', storage: 'r2', createdAt: Date.now() },
                    { studioId, category: 'bgm' },
                  ).catch((err: Error) => onNotify(`已上傳到 Default，但未能加入專案素材：${err.message}`, true))
              }}
            />
            <p className="text-[10px] text-white/30">
              {source === 'default'
                ? '上傳到 Default 共用資料夾（R2），放到選取音軌的播放頭位置，並收進目前 Studio 的「背景音樂」'
                : '上傳到 Cloudflare R2，放到選取音軌的播放頭位置，並收進目前 Studio 的「上傳」'}
            </p>
          </>
        )}
        {error && <p className="text-[11px] text-panic" data-library-error>{error}</p>}
      </Section>
      {all === null || (source === 'project' && assetFolders === null) ? (
        <p className="p-4 text-center text-xs text-white/35">載入中…</p>
      ) : all.length === 0 && !(source === 'project' && mode === 'project') ? (
        <p className="p-4 text-center text-xs text-white/35">{source === 'audience' ? '還沒有觀眾錄音' : '這個 R2 資料夾還沒有音檔'}</p>
      ) : (
        <AssetList
          key={source}
          mode={mode}
          projectId={projectId}
          projectName={projectName}
          base={source === 'default' ? SHARED_MEDIA_PATH : projectMediaPath(projectId)}
          user={user}
          assets={all}
          folders={source === 'project' ? (assetFolders ?? []) : []}
          studios={source === 'project' ? studios : []}
          currentStudio={studioId}
          reveal={target}
          query={query}
          renderLead={lead}
          renderAction={action}
          onNotify={onNotify}
        />
      )}
    </div>
  )
}
