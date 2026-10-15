import { parseNotionUrl, useNotionPage } from '../../services/notion'
import { fieldClass } from '../ui/controls'
import { ImeInput } from '../ui/ImeText'

/**
 * Notion page link input: recognises the link as you type or paste, and checks that the page can
 * actually be previewed (public) — showing its title, or why not.
 */
export function NotionUrlField({ value, onChange, autoFocus }: { value: string; onChange: (url: string) => void; autoFocus?: boolean }) {
  const parsed = value.trim() ? parseNotionUrl(value) : null
  const { state } = useNotionPage(parsed ? value : '')

  return (
    <div className="space-y-1.5" data-notion-url-field>
      <ImeInput
        className={`${fieldClass} font-mono text-xs`}
        value={value}
        onValueChange={onChange}
        placeholder="https://你的工作區.notion.site/頁面-1a2b3c…"
        inputMode="url"
        autoFocus={autoFocus}
        spellCheck={false}
        aria-label="Notion 頁面網址"
        data-field="Notion 網址"
      />
      <p className="text-[11px] leading-snug" data-notion-url-status>
        {!value.trim() ? (
          <span className="text-white/35">貼上已公開（Share → Publish）的 Notion 頁面網址</span>
        ) : !parsed ? (
          <span className="text-panic">✗ 不是 Notion 頁面網址（需包含頁面 ID）</span>
        ) : state.status === 'ready' ? (
          <span className="text-go">
            ✓ {state.page.icon ? `${state.page.icon} ` : ''}
            {state.page.title}
          </span>
        ) : state.status === 'error' ? (
          <span className="text-standby">⚠ {state.error.message}</span>
        ) : (
          <span className="text-white/50">✓ 已辨識 Notion 頁面 · 檢查中…</span>
        )}
      </p>
    </div>
  )
}
