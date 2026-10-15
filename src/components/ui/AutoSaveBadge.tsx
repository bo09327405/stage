import type { AutoSaveStatus } from '../../hooks/useR2AutoSave'

const time = (ms: number) => new Date(ms).toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })

/** Live auto-save state: "正在儲存至雲端…" / "已自動儲存". */
export function AutoSaveBadge({ status, className = '', onClick }: { status: AutoSaveStatus; className?: string; onClick?: () => void }) {
  const [text, tone, title] =
    status.phase === 'saving'
      ? ['⟳ 正在儲存至雲端…', 'text-accent', 'Cloudflare R2']
      : status.phase === 'pending'
        ? ['● 有變更，即將儲存', 'text-standby', '停止編輯 2 秒後自動儲存到 Cloudflare R2']
        : status.phase === 'saved'
          ? [`✓ 已自動儲存 ${time(status.at)}`, 'text-go', '已儲存到 Cloudflare R2']
          : status.phase === 'error'
            ? ['⚠ 雲端儲存失敗，重試中', 'text-panic', status.message]
            : status.phase === 'off'
              ? ['R2 未設定，未自動儲存', 'text-white/35', '.env.local 缺少 R2_* 設定']
              : ['☁ 自動儲存', 'text-white/35', 'Cloudflare R2']
  const cls = `inline-flex shrink-0 items-center gap-1 rounded-full bg-white/[0.06] px-2.5 py-1 text-[11px] whitespace-nowrap ${tone} ${className}`
  // Clickable: opens the version history.
  return onClick ? (
    <button type="button" onClick={onClick} className={`${cls} hover:bg-white/15`} title={`${title} · 點一下查看版本歷史`} data-autosave={status.phase} aria-live="polite">
      {text}
      <span className="text-white/40">🕘</span>
    </button>
  ) : (
    <span className={cls} title={title} data-autosave={status.phase} aria-live="polite">
      {text}
    </span>
  )
}
