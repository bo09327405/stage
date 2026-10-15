import { useState } from 'react'
import { useFullscreen } from '../../hooks/useFullscreen'

/** "⛶ 全螢幕" / "退出全螢幕 ↘": browser full screen for the whole page. Hidden where unsupported (iPhone Safari). */
export function FullscreenButton({ compact = false }: { compact?: boolean }) {
  const { isFullscreen, supported, toggle } = useFullscreen()
  const [error, setError] = useState<string | null>(null)
  if (!supported) return null
  return (
    <button
      type="button"
      onClick={() => {
        setError(null)
        toggle().catch((err: Error) => setError(err.message))
      }}
      aria-pressed={isFullscreen}
      className={`flex min-h-10 items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold transition ${
        isFullscreen ? 'bg-white text-black hover:bg-white/85' : 'bg-white/[0.06] text-white/70 hover:bg-white/10 hover:text-white'
      }`}
      title={error ? `無法切換全螢幕：${error}` : isFullscreen ? '退出全螢幕（或按 Esc）' : '整個畫面全螢幕顯示'}
      data-fullscreen-toggle={isFullscreen ? 'on' : 'off'}
    >
      {isFullscreen ? (compact ? '↘' : '退出全螢幕 ↘') : compact ? '⛶' : '⛶ 全螢幕'}
    </button>
  )
}
