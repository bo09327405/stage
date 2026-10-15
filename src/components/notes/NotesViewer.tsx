import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { useTheatreEngine } from '../../hooks/useTheatreEngine'
import { isOnlyNotionUrl, parseNotionUrl } from '../../services/notion'
import { SCRIPT_HELP, type ScriptSource } from '../../services/script'
import type { Cue } from '../../types/cue'
import { LiveNotion, LiveScript } from './LiveScript'
import { NotionUrlField } from './NotionUrlField'
import { NOTE_THEME_LABELS, noteSkin, useStageDark } from './stageTheme'
import type { NotePrefs } from './useNotePrefs'

/** Where a note's content comes from and how it is saved (the show script, or a button's own note). */
export interface NoteSource {
  text: string
  source: ScriptSource
  notionUrl: string
  saveText: (text: string) => Promise<void>
  saveSource: (source: ScriptSource, notionUrl?: string) => Promise<void>
  /** Shown when there is no text. */
  empty?: string
}

/**
 * The Note window itself, shared by the Notes drawer and Note buttons on the control panel:
 * toolbar (theme ◐, 📌 跟隨, A− / A+, ✎ 編輯 or 🔗 網址, ↻ for Notion, plus the host's own
 * buttons), the 手動筆記 / Notion switch, editing, and the live script or Notion page that lights up
 * cue points and scrolls to the standby cue.
 */
export function NotesViewer({
  engine,
  cues,
  note,
  prefs,
  variant,
  title,
  titleColor,
  actions,
  interactive = true,
  scale = 1,
}: {
  engine: ReturnType<typeof useTheatreEngine>
  cues: Cue[]
  note: NoteSource
  prefs: NotePrefs
  /** "panel": the drawer (and expanded views). "mini": a control-panel button (compact). */
  variant: 'panel' | 'mini'
  title: ReactNode
  titleColor?: string
  /** Host buttons at the end of the toolbar (fold / hide / expand…). */
  actions?: ReactNode
  /** False in the control panel's edit mode: a preview only. */
  interactive?: boolean
  /** Extra text scale on top of A− / A+ (the expanded view). */
  scale?: number
}) {
  const mini = variant === 'mini'
  const { font, setFont, follow, setFollow, theme, setTheme } = prefs
  const { text, source, notionUrl, saveText, saveSource } = note
  const notion = source === 'notion'
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(text)
  const [urlDraft, setUrlDraft] = useState(notionUrl)
  const [notice, setNotice] = useState<string | null>(null)
  const [refreshSignal, setRefreshSignal] = useState(0)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  // True while an IME (Zhuyin / Pinyin) is composing: the text still holds unconfirmed symbols.
  const composing = useRef(false)

  // Saved a moment after typing stops, and immediately when editing ends.
  const flush = (value: string) => {
    clearTimeout(timer.current)
    if (value !== text) saveText(value).catch(() => {})
  }
  const onType = (value: string) => {
    setDraft(value)
    clearTimeout(timer.current)
    if (composing.current) return // saved once the characters are chosen (compositionend)
    timer.current = setTimeout(() => flush(value), 600)
  }
  useEffect(() => () => clearTimeout(timer.current), [])
  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 4000)
    return () => clearTimeout(t)
  }, [notice])

  /** Show a Notion page instead of the manual notes (which are kept). */
  const showNotion = (url: string) => {
    clearTimeout(timer.current)
    if (draft !== text) saveText(draft).catch(() => {})
    saveSource('notion', url).catch(() => {})
    setEditing(false)
    setNotice('已切換為 Notion 預覽 · 手動筆記內容仍保留')
  }
  const switchMode = (next: ScriptSource) => {
    if (next === source) return
    if (editing && !notion) flush(draft)
    saveSource(next).catch(() => {})
    // Notion without a link yet: go straight to entering one.
    setUrlDraft(notionUrl)
    setEditing(next === 'notion' && !notionUrl)
  }
  const draftNotion = !notion && editing ? parseNotionUrl(draft) : null

  /* ---------- look: follows the stage ---------- */
  const dark = useStageDark(engine, theme)
  const skin = noteSkin(dark)
  const nextTheme = { auto: 'normal', normal: 'dark', dark: 'auto' } as const

  const btn = mini
    ? 'flex h-6 min-w-6 shrink-0 items-center justify-center rounded px-1 text-[11px] whitespace-nowrap text-white/60 hover:bg-white/10 hover:text-white'
    : 'flex h-8 min-w-8 shrink-0 items-center justify-center rounded-md px-1.5 text-xs whitespace-nowrap text-white/60 hover:bg-white/10 hover:text-white'
  const fontScale = font * scale

  return (
    <div className={`flex h-full min-h-0 w-full flex-col transition-colors duration-700 ${dark ? 'bg-[#060606]' : 'bg-[#14121a]'}`} data-notes-viewer={variant} data-stage={dark ? 'dark' : 'normal'}>
      <header className={`flex shrink-0 items-center gap-1 border-b ${skin.header} ${mini ? 'px-1.5 py-1' : 'py-2 pr-3 pl-4'}`}>
        <span className={`mr-auto flex min-w-0 items-center gap-1.5 truncate font-semibold tracking-wider ${mini ? 'text-[11px]' : 'text-xs text-white/60'}`} style={titleColor ? { color: titleColor } : undefined}>
          {title}
          {dark && <span className="shrink-0 rounded bg-white/10 px-1.5 py-px text-[9px] font-bold tracking-widest text-white/50">暗場</span>}
        </span>
        {interactive && (
          <>
            <button
              type="button"
              onClick={() => setTheme(nextTheme[theme])}
              className={`${btn} ${theme !== 'auto' ? 'bg-white/10 text-white/80' : ''}`}
              title={`配色：${NOTE_THEME_LABELS[theme]}（點擊切換）`}
              aria-label={`筆記配色：${NOTE_THEME_LABELS[theme]}`}
              data-notes-theme={theme}
            >
              {theme === 'auto' ? '◐' : theme === 'dark' ? '●' : '○'}
            </button>
            {!editing && (
              <>
                <button
                  type="button"
                  onClick={() => setFollow(!follow)}
                  aria-pressed={follow}
                  className={`${btn} ${follow ? 'bg-standby/15 text-standby' : ''}`}
                  title="自動捲到 Standby Cue 所在的行"
                  data-notes-follow={follow ? 'on' : 'off'}
                >
                  {mini ? '📌' : '📌 跟隨'}
                </button>
                <button type="button" onClick={() => setFont(Math.max(0.7, Math.round((font - 0.1) * 10) / 10))} className={btn} aria-label="縮小文字" title={`文字 ${Math.round(font * 100)}%`} data-notes-font-down>
                  A−
                </button>
                <button type="button" onClick={() => setFont(Math.min(2.4, Math.round((font + 0.1) * 10) / 10))} className={btn} aria-label="放大文字" title={`文字 ${Math.round(font * 100)}%`} data-notes-font-up>
                  A+
                </button>
                {notion && notionUrl && (
                  <button type="button" onClick={() => setRefreshSignal((n) => n + 1)} className={btn} aria-label="重新整理 Notion 頁面" title="重新整理 Notion 頁面" data-notes-refresh>
                    ↻
                  </button>
                )}
              </>
            )}
            <button
              type="button"
              onClick={() => {
                if (notion) {
                  if (editing && urlDraft.trim() !== notionUrl) saveSource('notion', urlDraft).catch(() => {})
                  else if (!editing) setUrlDraft(notionUrl)
                } else if (editing) flush(draft)
                else setDraft(text)
                setEditing(!editing)
              }}
              className={`${btn} ${editing ? 'bg-accent text-white hover:bg-accent' : ''}`}
              data-notes-edit
            >
              {editing ? (mini ? '✓' : '✓ 完成') : notion ? (mini ? '🔗' : '🔗 網址') : mini ? '✎' : '✎ 編輯'}
            </button>
          </>
        )}
        {actions}
      </header>
      {interactive && (
        <div className={`flex shrink-0 items-center gap-1 border-b ${skin.header} ${mini ? 'px-1.5 py-0.5' : 'py-1.5 pr-3 pl-4'}`} role="group" aria-label="筆記模式" data-notes-mode>
          {(
            [
              ['manual', '✎ 手動筆記'],
              ['notion', 'N Notion 預覽'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => switchMode(id)}
              aria-pressed={source === id}
              className={`flex-1 rounded-md font-medium transition ${mini ? 'min-h-5 text-[10px]' : 'min-h-7 text-[11px]'} ${source === id ? 'bg-white/15 text-white' : 'text-white/45 hover:text-white/80'}`}
              data-notes-mode-option={id}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {notice && (
        <p className="border-b border-line bg-accent/10 px-3 py-1.5 text-[11px] text-accent" role="status" data-notes-notice>
          {notice}
        </p>
      )}
      <div className="min-h-0 flex-1 pl-1 transition-[filter] duration-700" style={skin.content} data-notes-content>
        {notion ? (
          editing ? (
            <div className="space-y-3 p-3">
              <NotionUrlField value={urlDraft} onChange={setUrlDraft} autoFocus />
              <button
                type="button"
                disabled={!parseNotionUrl(urlDraft)}
                onClick={() => {
                  saveSource('notion', urlDraft).catch(() => {})
                  setEditing(false)
                }}
                className="min-h-9 w-full rounded-lg bg-accent text-xs font-semibold text-white disabled:opacity-40"
                data-notion-apply
              >
                預覽此頁面
              </button>
            </div>
          ) : notionUrl ? (
            <LiveNotion engine={engine} cues={cues} url={notionUrl} fontScale={fontScale} follow={follow} interactive={interactive} compact={mini} refreshSignal={refreshSignal} />
          ) : (
            <p className="p-4 text-sm text-white/40">按「🔗 網址」貼上公開的 Notion 頁面網址。</p>
          )
        ) : editing ? (
          <textarea
            value={draft}
            onChange={(e) => onType(e.target.value)}
            onCompositionStart={() => {
              composing.current = true
              clearTimeout(timer.current)
            }}
            onCompositionEnd={(e) => {
              composing.current = false
              onType(e.currentTarget.value)
            }}
            onBlur={() => {
              composing.current = false
              flush(draft)
            }}
            onPaste={(e) => {
              // Pasting just a Notion link means "show that page".
              const pasted = e.clipboardData.getData('text')
              if (!isOnlyNotionUrl(pasted) || draft.trim()) return
              e.preventDefault()
              showNotion(pasted.trim())
            }}
            placeholder={SCRIPT_HELP}
            className="h-full w-full resize-none bg-black/30 p-3 font-mono text-sm leading-relaxed text-white outline-none placeholder:text-white/30"
            autoFocus
            data-notes-textarea
          />
        ) : (
          <LiveScript engine={engine} cues={cues} text={text} fontScale={fontScale} follow={follow} interactive={interactive} empty={note.empty ?? SCRIPT_HELP} />
        )}
      </div>
      {draftNotion && (
        <div className="flex items-center gap-2 border-t border-line bg-black/30 px-3 py-2 text-[11px] text-white/60" data-notion-detected>
          <span className="min-w-0 flex-1">偵測到 Notion 頁面網址</span>
          <button type="button" onClick={() => showNotion(draftNotion.url)} className="min-h-8 shrink-0 rounded-md bg-accent px-2.5 font-semibold text-white">
            以 Notion 預覽
          </button>
        </div>
      )}
    </div>
  )
}
