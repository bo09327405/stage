import { useState } from 'react'
import { downloadToProject, fetchAudioFile, type ImportContent } from '../../services/urlImport'
import type { StoredFile } from '../../services/storage'
import { analyzeMediaUrl } from '../../utils/mediaUrl'
import { youtubeIdOf, youtubeStartOf, youtubeWatchUrl } from '../../utils/youtube'
import { fieldClass } from '../ui/controls'

type Mode = 'direct' | 'download'

/** Can this address be read from our pages (CORS)? Without it the audio engine and waveform can't use it. */
async function allowsCrossOrigin(url: string): Promise<boolean> {
  try {
    await fetch(url, { method: 'HEAD', mode: 'cors' })
    return true
  } catch {
    return false
  }
}

/**
 * "From a link": a media FILE address (…/song.mp3, a Dropbox / Drive share link) → use it directly, or have the
 * server download it into the project (whole video, or just the audio). Streaming-platform pages (YouTube, Vimeo,
 * SoundCloud, Spotify …) are recognised and refused with an explanation: they are not files, their terms forbid
 * downloading, and the content is usually someone else's.
 *
 * Set Cue passes onDirect / onStored; the Studio (audio only) passes onAudioFile and gets a File to place itself.
 */
export function UrlImporter({
  folder,
  allowDirect = true,
  audioOnly = false,
  onDirect,
  onStored,
  onAudioFile,
  onYoutube,
}: {
  folder: string
  allowDirect?: boolean
  /** Studio: only a sound file comes out (video links have their audio extracted). */
  audioOnly?: boolean
  onDirect?: (url: string) => void
  onStored?: (stored: { result: StoredFile; name: string; bytes: number }) => Promise<void> | void
  onAudioFile?: (file: File) => Promise<void> | void
  /** Set Cue: a YouTube link, played with YouTube's official embedded player (full video, direct stream only). */
  onYoutube?: (video: { id: string; url: string; start: number }) => void
}) {
  const [text, setText] = useState('')
  const [mode, setMode] = useState<Mode>(allowDirect && !audioOnly ? 'direct' : 'download')
  const [content, setContent] = useState<ImportContent>(audioOnly ? 'audio' : 'video')
  const [rights, setRights] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const info = text.trim() ? analyzeMediaUrl(text) : null
  const effectiveMode: Mode = audioOnly || !allowDirect ? 'download' : mode

  const run = async () => {
    if (!info || info.kind !== 'file') return
    setBusy(true)
    setError(null)
    setDone(null)
    setProgress(0)
    navigator.vibrate?.(10)
    try {
      if (effectiveMode === 'direct') {
        const ok = await allowsCrossOrigin(info.url)
        onDirect?.(info.url)
        setDone(
          ok
            ? '✓ 已設定為這個網址（直接讀取）'
            : '✓ 已設定網址，但這個網站不允許跨網站讀取：波形可能無法顯示，觀眾端也可能播不出來。建議改用「下載到專案」。',
        )
      } else if (onAudioFile) {
        const file = await fetchAudioFile(info.url, setStatus, setProgress)
        await onAudioFile(file)
        setDone(`✓ 已取得音訊「${file.name}」`)
      } else {
        const stored = await downloadToProject(info.url, { folder, content, onStatus: setStatus, onProgress: setProgress })
        await onStored?.(stored)
        setDone(`✓ 已下載並存到專案：${stored.name}`)
      }
      setText('')
      navigator.vibrate?.(20)
    } catch (err) {
      setError((err as Error).message)
      navigator.vibrate?.([30, 60, 30])
    } finally {
      setBusy(false)
      setStatus(null)
      setProgress(null)
    }
  }

  const needsRights = effectiveMode === 'download'
  const ready = info?.kind === 'file' && (!needsRights || rights) && !busy

  return (
    <div data-url-importer>
      <div className="space-y-3">
        <input
          className={`${fieldClass} font-mono text-xs`}
          type="url"
          inputMode="url"
          spellCheck={false}
          placeholder="https://…/檔案.mp3 或 .mp4（Dropbox / Google Drive 分享連結也可以）"
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            setError(null)
            setDone(null)
          }}
          aria-label="影音檔網址"
          data-url-input
        />

        {info?.kind === 'invalid' && <p className="text-xs text-panic">{info.note}</p>}
        {info?.kind === 'platform' && info.platform === 'YouTube' && onYoutube && youtubeIdOf(text) && (
          <div className="space-y-3 rounded-lg bg-white/[0.04] p-3" data-url-youtube>
            <p className="text-xs font-semibold text-white/80">▶ YouTube · 直接串流（官方嵌入播放器）</p>
            <div className="grid grid-cols-2 gap-1 rounded-lg bg-black/40 p-0.5" aria-label="素材格式">
              <span className="flex min-h-10 items-center justify-center rounded-md bg-accent text-xs font-semibold text-white">🎬 完整影片</span>
              <span className="flex min-h-10 items-center justify-center rounded-md text-xs font-semibold text-white/25 line-through" title="嵌入播放器必須顯示畫面，不能只取聲音">🎵 僅音訊</span>
            </div>
            <div className="grid grid-cols-2 gap-1 rounded-lg bg-black/40 p-0.5" aria-label="執行模式">
              <span className="flex min-h-10 items-center justify-center rounded-md bg-accent text-xs font-semibold text-white">⚡ 直接串流</span>
              <span className="flex min-h-10 items-center justify-center rounded-md text-xs font-semibold text-white/25 line-through" title="本系統不從 YouTube 下載或擷取影音">💾 下載存檔</span>
            </div>
            <ul className="list-disc space-y-1 pl-4 text-[11px] leading-relaxed text-white/45">
              <li>使用 YouTube 官方 IFrame 播放器（隱私增強網域、隱藏相關影片與多餘介面）；播放器畫面一定會顯示，是否有廣告由 YouTube 決定。</li>
              <li>不提供「僅音訊」與「下載存檔」：YouTube 條款不允許隱藏播放器、下載或擷取影音。要音檔請上傳你有權使用的檔案。</li>
              <li>演出需要網路；iPhone 可能要點一下畫面才會發聲，音量與淡入淡出透過播放器音量調整。</li>
            </ul>
            <button
              type="button"
              onClick={() => {
                const id = youtubeIdOf(text)!
                onYoutube({ id, url: youtubeWatchUrl(id), start: youtubeStartOf(text) })
                setDone('✓ 已設為 YouTube 串流（影片 Cue）')
                setText('')
              }}
              className="min-h-11 w-full rounded-xl bg-accent text-sm font-semibold text-white"
              data-youtube-use
            >
              使用 YouTube 串流
            </button>
          </div>
        )}
        {info?.kind === 'platform' && !(info.platform === 'YouTube' && onYoutube && youtubeIdOf(text)) && (
          <div className="space-y-1.5 rounded-lg bg-standby/10 p-3 text-xs leading-relaxed text-standby" data-url-platform>
            <p className="font-semibold">{info.platform} 的連結無法匯入</p>
            <p className="text-standby/85">
              這是串流平台的網頁，不是影音檔。平台的服務條款不允許下載或擷取其影音，內容也多半有著作權，所以本系統不提供從 {info.platform} 等平台下載、轉檔或擷取音訊。
            </p>
            <p className="text-standby/85">你可以：① 上傳你自己擁有或已獲授權的檔案；② 使用檔案的直接連結（結尾是 .mp3 / .wav / .mp4，或 Dropbox / Google Drive 分享連結）；③ 公眾領域或 CC 授權素材網站提供的下載連結。</p>
          </div>
        )}
        {info?.kind === 'file' && (
          <>
            <p className="truncate text-[11px] text-white/45">
              📄 {info.name}
              {info.note ? ` · ${info.note}` : ''}
            </p>

            {allowDirect && !audioOnly && (
              <div className="grid grid-cols-2 gap-1 rounded-lg bg-black/40 p-0.5" role="radiogroup" aria-label="匯入方式">
                {(
                  [
                    ['direct', '🔗 直接讀取網址'],
                    ['download', '⬇ 下載到專案'],
                  ] as const
                ).map(([id, label]) => (
                  <button key={id} type="button" role="radio" aria-checked={mode === id} onClick={() => setMode(id)} className={`min-h-10 rounded-md text-xs font-semibold ${mode === id ? 'bg-accent text-white' : 'text-white/55'}`} data-import-mode={id}>
                    {label}
                  </button>
                ))}
              </div>
            )}
            {effectiveMode === 'direct' ? (
              <p className="text-[11px] leading-relaxed text-white/40">每次播放時，觀眾裝置直接從這個網址讀取。對方網站要允許跨網站讀取（CORS）才能顯示波形與穩定播放；網址失效檔案就沒了。</p>
            ) : (
              <>
                {!audioOnly && (
                  <div className="grid grid-cols-2 gap-1 rounded-lg bg-black/40 p-0.5" role="radiogroup" aria-label="下載內容">
                    {(
                      [
                        ['video', '🎞 完整檔案（影片）'],
                        ['audio', '🎵 只要音訊'],
                      ] as const
                    ).map(([id, label]) => (
                      <button key={id} type="button" role="radio" aria-checked={content === id} onClick={() => setContent(id)} className={`min-h-10 rounded-md text-xs font-semibold ${content === id ? 'bg-accent text-white' : 'text-white/55'}`} data-import-content={id}>
                        {label}
                      </button>
                    ))}
                  </div>
                )}
                <p className="text-[11px] leading-relaxed text-white/40">
                  {audioOnly || content === 'audio' ? '影片檔會在瀏覽器擷取音軌並存成 WAV（檔案較大，很長的影片可能失敗）；本來就是音檔的連結則原樣存下。' : '伺服器下載原檔並存進專案（上限 250 MB）。'}
                </p>
                <label className="flex min-h-11 cursor-pointer items-start gap-2.5 rounded-lg bg-white/[0.04] p-2.5 text-[11px] leading-relaxed text-white/65">
                  <input type="checkbox" checked={rights} onChange={(e) => setRights(e.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 accent-[#0a84ff]" data-import-rights />
                  我確認有權使用這個內容（自己的作品、已取得授權，或公眾領域／CC 授權）
                </label>
              </>
            )}
          </>
        )}

        <button type="button" disabled={!ready} onClick={() => void run()} className="min-h-11 w-full rounded-xl bg-accent text-sm font-semibold text-white disabled:opacity-40" data-import-run>
          {busy ? '處理中…' : effectiveMode === 'direct' ? '使用這個網址' : audioOnly ? '取得音訊' : '下載並加入專案'}
        </button>
        {busy && (
          <div className="space-y-1" data-import-progress>
            <div className="h-2 overflow-hidden rounded-full bg-white/10">
              {progress != null && progress > 0 ? (
                <div className="h-full rounded-full bg-accent transition-[width] duration-200" style={{ width: `${progress}%` }} />
              ) : (
                <div className="h-full w-1/3 animate-[upload-slide_1.2s_ease-in-out_infinite] rounded-full bg-accent/70" />
              )}
            </div>
            <p className="text-[11px] text-white/50">
              {status ?? '處理中…'}
              {progress != null && progress > 0 ? ` ${progress}%` : ''}
            </p>
          </div>
        )}
        {done && <p className="text-xs leading-relaxed text-go">{done}</p>}
        {error && <p className="text-xs leading-relaxed text-panic">{error}</p>}
      </div>
    </div>
  )
}
