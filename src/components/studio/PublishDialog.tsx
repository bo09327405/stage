import { useInvite } from '../../services/membership'
import { InviteReset } from '../hub/InviteReset'
import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { timecode } from '../../studio/format'
import {
  isPrivateBase,
  publicAudioUrl,
  publishAudio,
  readShareBase,
  studioShareUrl,
  unpublishAudio,
  usePublishedAudio,
  useServerPublicBase,
  writeShareBase,
  type LiveAudioControl,
  type PublishedAudio,
} from '../../studio/publish'
import type { ShowRef } from '../../types/project'
import type { StudioProject } from '../../types/studio'
import { formatBytes, formatWhen } from '../../utils/formatFile'

/**
 * Publish / share from the DAW Studio:
 *  - 專案連結: opens this studio in the DAW (view and edit) for anyone who can reach the server;
 *  - 固定網址 MP3: one URL per studio that always plays the current mix (auto-updated after edits);
 *  - 版本快照: an MP3 of the mix as it is now, at its own URL that never changes content.
 * Both are embeddable in Notion (paste the link → Embed).
 */
export function PublishDialog({ open, onClose, show, studio, live }: { open: boolean; onClose: () => void; show: ShowRef; studio: StudioProject; live: LiveAudioControl }) {
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} className="fixed inset-0 z-[85] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <motion.div
            initial={{ scale: 0.96 }}
            animate={{ scale: 1 }}
            onClick={(e) => e.stopPropagation()}
            className="flex max-h-[90dvh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-line bg-panel text-white shadow-2xl"
            role="dialog"
            aria-label="發布 / 分享"
            data-publish-dialog
          >
            <Body onClose={onClose} show={show} studio={studio} live={live} />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}

function useCopy() {
  const [copied, setCopied] = useState<string | null>(null)
  const copy = (id: string, text: string) => {
    navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(id)
        setTimeout(() => setCopied((c) => (c === id ? null : c)), 1500)
      },
      () => setCopied(null),
    )
  }
  return { copied, copy }
}

function Body({ onClose, show, studio, live }: { onClose: () => void; show: ShowRef; studio: StudioProject; live: LiveAudioControl }) {
  const [base, setBase] = useState(readShareBase)
  const r2Public = useServerPublicBase()
  const published = usePublishedAudio(show.projectId)
  const [name, setName] = useState(studio.name)
  const [progress, setProgress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const { copied, copy } = useCopy()

  const invite = useInvite(show.projectId)
  const link = studioShareUrl(base, show, studio.id, invite)
  const privateBase = isPrivateBase(base)
  const mine = (published ?? []).filter((p) => p.studioId === studio.id)
  const others = (published ?? []).filter((p) => p.studioId !== studio.id)

  const publish = async () => {
    setError(null)
    try {
      await publishAudio(show.projectId, studio, name.trim() || studio.name, setProgress)
      setProgress('✓ 已發布')
      setTimeout(() => setProgress(null), 2000)
    } catch (err) {
      setProgress(null)
      setError((err as Error).message)
    }
  }

  const field = 'w-full rounded-lg border border-white/15 bg-black/40 px-2.5 py-2 text-sm text-white outline-none focus:border-accent'
  const small = 'min-h-8 shrink-0 rounded-lg px-3 text-xs font-semibold'

  const row = (p: PublishedAudio) => {
    const url = publicAudioUrl(p.key, base, r2Public)
    return (
      <li key={p.id} className="space-y-1.5 rounded-xl border border-white/10 bg-black/20 p-3" data-published={p.key}>
        <div className="flex items-center gap-2 text-xs">
          <span className="min-w-0 flex-1 truncate font-semibold text-white/90">🎧 {p.name}</span>
          <span className="shrink-0 text-white/40">
            {timecode(p.duration, false)} · {formatBytes(p.bytes)} · {formatWhen(p.createdAt)}
          </span>
        </div>
        <div className="flex gap-1.5">
          <input readOnly value={url} onFocus={(e) => e.currentTarget.select()} className={`${field} font-mono text-[11px]`} data-published-url />
          <button type="button" onClick={() => copy(p.id, url)} className={`${small} bg-accent text-white`} data-published-copy>
            {copied === p.id ? '✓ 已複製' : '複製'}
          </button>
          <button type="button" onClick={() => setConfirming(confirming === p.id ? null : p.id)} className={`${small} text-white/40 hover:bg-panic/15 hover:text-panic`} aria-label={`取消發布 ${p.name}`} data-published-delete>
            🗑
          </button>
        </div>
        <audio src={url} controls preload="none" className="h-8 w-full" />
        {confirming === p.id && (
          <div className="flex items-center gap-2 rounded-lg border border-panic/30 bg-panic/10 p-2 text-xs" data-published-confirm>
            <span className="flex-1 text-white/80">取消發布並刪除這個公開音檔？已嵌入的 Notion 頁面將無法再播放。</span>
            <button type="button" onClick={() => unpublishAudio(show.projectId, p).catch((err: Error) => setError(err.message))} className={`${small} bg-panic text-white`} data-published-confirm-delete>
              刪除
            </button>
            <button type="button" onClick={() => setConfirming(null)} className={`${small} text-white/60 hover:bg-white/10`}>
              取消
            </button>
          </div>
        )}
      </li>
    )
  }

  return (
    <>
      <header className="flex items-start justify-between border-b border-line px-5 py-4">
        <div>
          <h2 className="text-lg font-semibold">🔗 發布 / 分享</h2>
          <p className="text-xs text-white/40">Studio「{studio.name}」</p>
        </div>
        <button type="button" onClick={onClose} className="h-9 w-9 rounded-lg text-white/50 hover:bg-white/10" aria-label="關閉">
          ✕
        </button>
      </header>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
        <label className="block">
          <span className="mb-1 block text-xs text-white/55">對外網址（別人用來連到這台伺服器的位址，例如 ngrok 網址）</span>
          <input
            value={base}
            onChange={(e) => setBase(e.target.value)}
            onBlur={() => writeShareBase(base.trim() || location.origin)}
            placeholder="https://xxxx.ngrok-free.app"
            className={`${field} font-mono text-xs`}
            data-share-base
          />
          {privateBase && (
            <span className="mt-1 block text-[11px] text-standby" data-share-private>
              ⚠ 這是本機 / 區域網路位址：只有這台電腦（或同一個網路）打得開，Notion 也讀不到。請改填 ngrok 或正式網域。
            </span>
          )}
        </label>

        <section className="space-y-2">
          <h3 className="text-sm font-semibold">專案連結</h3>
          <p className="text-[11px] text-white/45">開啟後直接進入 DAW Studio 並載入這個專案，可檢視與編輯（多人即時同步）。對方用 Google 登入後會加入成為協作者。</p>
          <div className="flex gap-1.5">
            <input readOnly value={link} onFocus={(e) => e.currentTarget.select()} className={`${field} font-mono text-[11px]`} data-share-link />
            <button type="button" onClick={() => copy('link', link)} className={`${small} bg-accent text-white`} data-share-copy>
              {copied === 'link' ? '✓ 已複製' : '複製'}
            </button>
            <a href={link} target="_blank" rel="noreferrer" className={`${small} flex items-center bg-white/10 text-white/80 hover:bg-white/15`}>
              開啟 ↗
            </a>
          </div>
          <InviteReset projectId={show.projectId} token={invite} />
        </section>

        <section className="space-y-2" data-live-section>
          <h3 className="text-sm font-semibold">固定網址 MP3（可嵌入 Notion · 自動更新）</h3>
          <p className="text-[11px] text-white/45">
            這個 Studio 專屬、永遠不變的網址。專案修改後會自動重新轉檔並覆蓋同一個檔案，Notion 頁面重新整理就會播到最新內容（不需要重貼連結）。
            混音在瀏覽器裡進行，所以要有人開著這個 Studio 才會自動更新。
            {r2Public ? ` 檔案由 R2 公開網域提供：${r2Public}` : ' 檔案由這台伺服器提供，伺服器要保持開著。'}
          </p>
          {live.loading ? (
            <p className="text-xs text-white/35">載入中…</p>
          ) : !live.entry ? (
            <button type="button" disabled={live.state.phase === 'updating'} onClick={() => live.enable()} className={`${small} min-h-10 w-full bg-go text-black disabled:opacity-50`} data-live-enable>
              {live.state.phase === 'updating' ? live.state.step : '📌 建立固定網址 MP3'}
            </button>
          ) : (
            <div className="space-y-2 rounded-xl border border-go/25 bg-go/[0.05] p-3" data-live>
              <div className="flex gap-1.5">
                <input readOnly value={publicAudioUrl(live.entry.key, base, r2Public)} onFocus={(e) => e.currentTarget.select()} className={`${field} font-mono text-[11px]`} data-live-url />
                <button type="button" onClick={() => copy('live', publicAudioUrl(live.entry!.key, base, r2Public))} className={`${small} bg-accent text-white`} data-live-copy>
                  {copied === 'live' ? '✓ 已複製' : '複製'}
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span
                  className={
                    live.state.phase === 'current' ? 'text-go' : live.state.phase === 'error' ? 'text-panic' : live.state.phase === 'updating' ? 'text-accent' : 'text-standby'
                  }
                  data-live-state={live.state.phase}
                >
                  {live.state.phase === 'current'
                    ? `✓ 已是最新（${formatWhen(live.entry.updatedAt)} · ${timecode(live.entry.duration, false)} · ${formatBytes(live.entry.bytes)}）`
                    : live.state.phase === 'updating'
                      ? `⟳ ${live.state.step}`
                      : live.state.phase === 'error'
                        ? `⚠ ${live.state.message}`
                        : live.entry.auto
                          ? '● 專案有變更，停止編輯 30 秒後自動更新'
                          : '● 專案有變更，尚未更新'}
                </span>
                <label className="ml-auto flex items-center gap-1.5 text-white/70">
                  <input type="checkbox" checked={live.entry.auto} onChange={(e) => live.setAuto(e.target.checked)} className="h-4 w-4 accent-[#30d158]" data-live-auto />
                  自動更新
                </label>
                <button type="button" disabled={live.state.phase === 'updating'} onClick={() => live.updateNow()} className={`${small} bg-white/10 text-white/85 hover:bg-white/15 disabled:opacity-40`} data-live-update>
                  ⟳ 立即更新
                </button>
                <button type="button" onClick={() => setConfirming(confirming === 'live' ? null : 'live')} className={`${small} text-white/40 hover:bg-panic/15 hover:text-panic`} aria-label="停用固定網址" data-live-delete>
                  🗑
                </button>
              </div>
              {live.entry.updatedAt > 0 && <audio key={live.entry.updatedAt} src={`${publicAudioUrl(live.entry.key, base, r2Public)}?v=${live.entry.updatedAt}`} controls preload="none" className="h-8 w-full" />}
              {confirming === 'live' && (
                <div className="flex items-center gap-2 rounded-lg border border-panic/30 bg-panic/10 p-2 text-xs" data-live-confirm>
                  <span className="flex-1 text-white/80">停用並刪除固定網址的音檔？已嵌入的 Notion 頁面將無法再播放。</span>
                  <button
                    type="button"
                    onClick={() => {
                      setConfirming(null)
                      Promise.resolve(live.disable()).catch((err: Error) => setError(err.message))
                    }}
                    className={`${small} bg-panic text-white`}
                    data-live-confirm-delete
                  >
                    刪除
                  </button>
                  <button type="button" onClick={() => setConfirming(null)} className={`${small} text-white/60 hover:bg-white/10`}>
                    取消
                  </button>
                </div>
              )}
            </div>
          )}
        </section>

        <section className="space-y-2">
          <h3 className="text-sm font-semibold">版本快照 MP3</h3>
          <p className="text-[11px] text-white/45">
            把目前的混音存成一個獨立網址，之後修改專案也不會影響它（適合留存某一次排練或定稿）。同樣可嵌入 Notion。
          </p>
          <div className="flex gap-1.5">
            <input value={name} onChange={(e) => setName(e.target.value)} className={field} placeholder="音檔名稱" data-publish-name />
            <button type="button" disabled={!!progress && !progress.startsWith('✓')} onClick={publish} className={`${small} bg-go text-black disabled:opacity-50`} data-publish-audio>
              {progress && !progress.startsWith('✓') ? progress : '📸 發布快照'}
            </button>
          </div>
          {progress?.startsWith('✓') && <p className="text-xs text-go">{progress}</p>}
          {error && <p className="text-xs text-panic" data-publish-error>{error}</p>}
          <ul className="space-y-2">
            {published === null && <li className="text-xs text-white/35">載入中…</li>}
            {mine.map(row)}
            {published && mine.length === 0 && <li className="text-xs text-white/35">這個 Studio 還沒有版本快照</li>}
          </ul>
          {others.length > 0 && (
            <details className="text-xs">
              <summary className="cursor-pointer text-white/45">此演出其他 Studio 發布的音檔（{others.length}）</summary>
              <ul className="mt-2 space-y-2">{others.map(row)}</ul>
            </details>
          )}
        </section>
      </div>
    </>
  )
}
