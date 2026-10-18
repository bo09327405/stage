import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { timecode } from '../../studio/format'

/** Right-click menu on an empty part of a track lane: upload audio right there, or move the playhead. */
export function LaneMenu({ x, y, time, trackName, onUpload, onUrl, onConvert, onSeek, onClose }: { x: number; y: number; time: number; trackName: string; onUpload: () => void; onUrl?: () => void; onConvert?: () => void; onSeek: () => void; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null)
  // Registered once (latest onClose via a ref) and in the capture phase, so Esc always reaches it.
  const close = useRef(onClose)
  useEffect(() => {
    close.current = onClose
  })
  useEffect(() => {
    const down = (e: PointerEvent) => !box.current?.contains(e.target as Node) && close.current()
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      close.current()
    }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('keydown', key, true)
    }
  }, [])
  const item = 'flex w-full flex-col rounded-md px-3 py-1.5 text-left hover:bg-white/10'
  return createPortal(
    <div
      ref={box}
      data-sheet-menu className="fixed z-[90] w-64 rounded-xl border border-white/10 bg-[#202020]/95 p-1 text-white shadow-2xl backdrop-blur-xl"
      style={{ left: Math.min(x, window.innerWidth - 264), top: Math.min(y, window.innerHeight - 120) }}
      role="menu"
      aria-label="音軌選單"
      data-lane-menu
    >
      <div className="px-3 pt-1 pb-1.5 text-[10px] text-white/40">
        {trackName} · {timecode(time)}
      </div>
      <button type="button" role="menuitem" onClick={onUpload} className={item} data-lane-upload>
        <span className="text-[13px]">⇪ 上傳音檔到這裡…</span>
        <span className="text-[10px] text-white/40">選擇檔案，上傳到 R2 並放在這個時間點（可多選，依序排列）</span>
      </button>
      {onConvert && (
        <button type="button" role="menuitem" onClick={onConvert} className={item} data-lane-convert>
          <span className="text-[13px]">🛠 轉檔後匯入…</span>
          <span className="text-[10px] text-white/40">選擇影片或音檔，在裝置上轉成 MP3 / WAV 再放到這個時間點</span>
        </button>
      )}
      {onUrl && (
        <button type="button" role="menuitem" onClick={onUrl} className={item} data-lane-url>
          <span className="text-[13px]">🌐 從網址匯入音訊…</span>
          <span className="text-[10px] text-white/40">貼上 mp3 / wav / mp4 檔案連結，取得音訊並放在這個時間點</span>
        </button>
      )}
      <button type="button" role="menuitem" onClick={onSeek} className={item}>
        <span className="text-[13px]">▸ 播放頭移到這裡</span>
      </button>
    </div>,
    document.body,
  )
}
