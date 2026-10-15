import { Component, createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useNotionPage } from '../../services/notion'
import type { NotionBlock, NotionSpan } from '../../types/notion'
import { isTextColor, notionColor } from './notionColors'

interface NotionViewProps {
  url: string
  /** Text size multiplier (follows the note's A− / A+ or font slider). */
  fontScale?: number
  /** Small header for note buttons. */
  compact?: boolean
  /** Renders plain text runs, e.g. to turn "Q3" into live cue chips. */
  renderText?: (text: string) => ReactNode
  /** The cue to keep in view (its first chip in the page), if any. */
  followCueId?: string | null
  /** Changing this number reloads the page (a ↻ button outside the view). */
  refreshSignal?: number
}

const ago = (at: number) => {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000))
  return s < 60 ? '剛剛' : s < 3600 ? `${Math.floor(s / 60)} 分鐘前` : new Date(at).toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit' })
}

/**
 * A public Notion page shown as clean reading text inside a note: headings, lists, to-dos, quotes,
 * callouts, toggles, tables, columns and images. Scales with the note's text size and scrolls.
 */
export function NotionView({ url, fontScale = 1, compact = false, renderText = (t) => t, followCueId = null, refreshSignal = 0 }: NotionViewProps) {
  const { ref, state, refresh } = useNotionPage(url)
  // A toolbar outside asked for a reload (its ↻ button).
  const lastSignal = useRef(refreshSignal)
  useEffect(() => {
    if (refreshSignal === lastSignal.current) return
    lastSignal.current = refreshSignal
    refresh()
  }, [refreshSignal, refresh])
  const box = useRef<HTMLDivElement>(null)
  const openHref = ref?.url ?? url

  // Keep the standby cue's chip in view, scrolling only this box.
  const ready = state.status === 'ready'
  useEffect(() => {
    if (!followCueId || !ready || !box.current) return
    const chip = box.current.querySelector<HTMLElement>(`[data-script-cue="${followCueId}"]`)
    if (!chip) return
    const top = chip.getBoundingClientRect().top - box.current.getBoundingClientRect().top + box.current.scrollTop
    box.current.scrollTo({ top: top - box.current.clientHeight / 3, behavior: 'smooth' })
  }, [followCueId, ready])

  const openButton = (label = '在 Notion 開啟') => (
    <a
      href={openHref}
      target="_blank"
      rel="noreferrer"
      className="inline-flex min-h-9 items-center gap-1 rounded-lg bg-white/[0.08] px-3 text-xs font-medium text-white/80 hover:bg-white/15 hover:text-white"
      data-notion-open
    >
      ↗ {label}
    </a>
  )

  if (!ref) {
    return (
      <Message icon="🔗" title="不是 Notion 頁面網址" data="invalid">
        請貼上像 <code className="text-white/70">https://xxx.notion.site/頁面名稱-1a2b3c…</code> 或 notion.so 的頁面連結。
      </Message>
    )
  }

  if (state.status === 'loading' || state.status === 'idle') {
    return (
      <div className="flex h-full flex-col gap-3 p-4" role="status" aria-live="polite" data-notion-loading>
        <div className="flex items-center gap-2 text-xs text-white/50">
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/20 border-t-white/70" />
          正在載入 Notion 頁面…
        </div>
        {[72, 92, 58, 84, 40].map((w, i) => (
          <span key={i} className="h-3 animate-pulse rounded bg-white/[0.07]" style={{ width: `${w}%`, animationDelay: `${i * 120}ms` }} />
        ))}
      </div>
    )
  }

  if (state.status === 'error') {
    const { error } = state
    if (error.error === 'preview_unavailable') {
      // Static hosting: no preview server. A calm card, with "open in Notion" as the main action.
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center" data-notion-unavailable>
          <span className="text-3xl" aria-hidden>
            🗒️
          </span>
          <p className="text-sm font-semibold text-white/85">Notion 預覽僅限本機版</p>
          <p className="max-w-xs text-xs leading-relaxed text-white/50">這個環境（例如 GitHub Pages）沒有預覽服務，無法在這裡顯示頁面內容。請直接在 Notion 開啟。</p>
          <a
            href={openHref}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-accent px-5 text-sm font-semibold text-white hover:brightness-110"
            data-notion-open
          >
            ↗ 在 Notion 獨立分頁開啟
          </a>
          <button type="button" onClick={refresh} className="min-h-9 rounded-lg px-3 text-[11px] text-white/40 hover:bg-white/10 hover:text-white/70">
            ↻ 重新檢查
          </button>
        </div>
      )
    }
    return (
      <Message
        icon={error.error === 'not_public' ? '🔒' : error.error === 'rate_limited' ? '⏳' : '⚠️'}
        title={error.error === 'not_public' ? '無法讀取此頁面' : error.error === 'rate_limited' ? 'Notion 忙碌中' : '載入失敗'}
        data={error.error}
        actions={
          <>
            {openButton()}
            <button type="button" onClick={refresh} className="min-h-9 rounded-lg px-3 text-xs text-white/60 hover:bg-white/10 hover:text-white">
              ↻ 重試
            </button>
          </>
        }
      >
        {error.message}
        {state.retrying && <span className="mt-1 block text-white/40">⟳ 稍後會自動重試…</span>}
        {error.error === 'not_public' && <span className="mt-1 block text-white/35">頁面需在 Notion 開啟「Share → Publish（發布到網路）」才能預覽；私人頁面請直接點下方按鈕開啟。</span>}
      </Message>
    )
  }

  const { page, refreshing, syncing, refreshError } = state
  return (
    <div className="flex h-full min-h-0 flex-col" data-notion-view>
      <div className={`flex shrink-0 items-center gap-2 border-b border-white/10 ${compact ? 'px-2.5 py-1' : 'px-3 py-2'}`}>
        <span className={`min-w-0 flex-1 truncate font-semibold text-white ${compact ? 'text-xs' : 'text-sm'}`} data-notion-title>
          {page.icon && <span className="mr-1">{page.icon}</span>}
          {page.title}
        </span>
        {!compact && (
          <span className={`shrink-0 text-[10px] ${refreshError ? 'text-standby' : 'text-white/30'}`} title={refreshError?.message}>
            {refreshing ? '更新中…' : refreshError ? '更新失敗 · 顯示上次內容' : `更新於 ${ago(page.fetchedAt)}`}
          </span>
        )}
        <button
          type="button"
          onClick={refresh}
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-white/50 hover:bg-white/10 hover:text-white ${refreshing ? 'animate-spin' : ''}`}
          aria-label="重新整理 Notion 內容"
          title="重新整理"
        >
          ↻
        </button>
        <a
          href={openHref}
          target="_blank"
          rel="noreferrer"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-white/50 hover:bg-white/10 hover:text-white"
          aria-label="在 Notion 開啟"
          title="在 Notion 開啟"
        >
          ↗
        </a>
      </div>
      <div
        ref={box}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-2 leading-relaxed break-words text-white/85 touch-pan-y"
        style={{ fontSize: `calc(0.9rem * ${fontScale})` }}
        data-notion-body
      >
        {syncing ? (
          <p className="mb-2 flex items-center gap-2 rounded-md bg-accent/10 px-2 py-1 text-[0.8em] text-accent" role="status" data-notion-syncing>
            <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />
            正在同步區塊內容…
          </p>
        ) : (
          page.unresolved > 0 && (
            <p className="mb-2 rounded-md bg-standby/10 px-2 py-1 text-[0.8em] text-standby" data-notion-unresolved>
              有 {page.unresolved} 個區塊無法讀取（同步來源未公開或已刪除）。{openButton('在 Notion 查看')}
            </p>
          )
        )}
        <ViewBoundary openHref={openHref} onRetry={refresh}>
          <Syncing.Provider value={syncing}>
            {(page.blocks ?? []).length === 0 ? <p className="text-white/35">（這個頁面沒有文字內容）</p> : <Blocks blocks={page.blocks} renderText={renderText} />}
          </Syncing.Provider>
        </ViewBoundary>
        {page.truncated && <p className="mt-3 text-[0.8em] text-white/35">頁面較長，只顯示前段內容。{openButton('看完整頁面')}</p>}
      </div>
    </div>
  )
}

function Message({ icon, title, data, children, actions }: { icon: string; title: string; data: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 overflow-y-auto p-4 text-center" data-notion-error={data}>
      <span className="text-2xl">{icon}</span>
      <span className="text-sm font-semibold text-white/85">{title}</span>
      <span className="max-w-sm text-xs text-white/50">{children}</span>
      {actions && <span className="mt-1 flex flex-wrap justify-center gap-2">{actions}</span>}
    </div>
  )
}

type Render = (text: string) => ReactNode

function Spans({ spans, renderText }: { spans: NotionSpan[]; renderText: Render }) {
  return (
    <>
      {(spans ?? []).map((s, i) => {
        if (!s || typeof s.t !== 'string') return null
        // Notion's own color / highlight goes on the outermost element, and nothing inside sets
        // a color of its own, so the colored text keeps its color through bold, strike, code…
        const colored = isTextColor(s.h)
        const style = notionColor(s.h)
        let node: ReactNode = s.a ? s.t : renderText(s.t)
        if (s.c) node = <code className={`rounded bg-white/10 px-1 font-mono text-[0.9em] ${colored ? '' : 'text-[#ff8f8f]'}`}>{node}</code>
        if (s.b) node = <b className="font-semibold">{node}</b>
        if (s.i) node = <i>{node}</i>
        if (s.s) node = <s className={colored ? '' : 'opacity-60'}>{node}</s>
        if (s.u) node = <u>{node}</u>
        if (s.a)
          node = (
            <a href={s.a.startsWith('/') ? `https://www.notion.so${s.a}` : s.a} target="_blank" rel="noreferrer" className={`underline underline-offset-2 ${colored ? '' : 'text-accent'}`}>
              {node}
            </a>
          )
        return (
          <span key={i} style={style} className={style?.backgroundColor ? 'rounded-[3px] px-[0.15em] [box-decoration-break:clone]' : undefined} data-notion-color={s.h}>
            {node}
          </span>
        )
      })}
    </>
  )
}

/** Siblings, with consecutive numbered items counted 1, 2, 3 … */
function Blocks({ blocks, renderText }: { blocks: NotionBlock[]; renderText: Render }) {
  const list = (blocks ?? []).filter((b): b is NotionBlock => !!b && typeof b.type === 'string')
  const numbers = list.reduce<number[]>((acc, b, i) => [...acc, b.type === 'number' ? (acc[i - 1] ?? 0) + 1 : 0], [])
  return (
    <>
      {list.map((b, i) => (
        // One malformed block shows a small notice instead of blanking the whole note.
        <BlockBoundary key={b.id ?? i}>
          <Block block={b} index={numbers[i]} renderText={renderText} />
        </BlockBoundary>
      ))}
    </>
  )
}

function Block(props: { block: NotionBlock; index: number; renderText: Render }) {
  const color = props.block.color
  const style = notionColor(color)
  // A callout carries its color on its own box (as in Notion), not on an extra wrapper.
  if (!style || props.block.type === 'callout') return <BlockContent {...props} />
  const content = <BlockContent {...props} />
  // A block colored in Notion: its text color, or a full-width background.
  return (
    <div style={style} className={style.backgroundColor ? 'my-[0.1em] rounded-[4px] px-[0.4em] py-[0.05em]' : undefined} data-notion-block-color={color}>
      {content}
    </div>
  )
}

function BlockContent({ block: b, index, renderText }: { block: NotionBlock; index: number; renderText: Render }) {
  const syncing = useContext(Syncing)
  // A block colored in Notion keeps that color: headings / quotes don't force their own.
  const ink = (cls: string) => (isTextColor(b.color) ? '' : cls)
  const text = <Spans spans={b.text ?? []} renderText={renderText} />
  const kids = b.children?.length ? <Blocks blocks={b.children} renderText={renderText} /> : null
  const nested = kids && <div className="pl-[1.4em]">{kids}</div>

  switch (b.type) {
    case 'h1':
      return <h3 className={`mt-[0.9em] mb-[0.2em] text-[1.45em] leading-snug font-bold ${ink('text-white')}`}>{text}</h3>
    case 'h2':
      return <h4 className={`mt-[0.8em] mb-[0.15em] text-[1.25em] leading-snug font-bold ${ink('text-white')}`}>{text}</h4>
    case 'h3':
      return <h5 className={`mt-[0.6em] mb-[0.1em] text-[1.08em] font-semibold ${ink('text-white')}`}>{text}</h5>
    case 'p':
      return (
        <div className="my-[0.15em] min-h-[1.2em] whitespace-pre-wrap">
          {text}
          {nested}
        </div>
      )
    case 'bullet':
    case 'number':
      return (
        <div className="my-[0.1em]">
          <div className="flex gap-[0.5em]">
            <span className="w-[1.2em] shrink-0 text-right text-white/45">{b.type === 'bullet' ? '•' : `${index}.`}</span>
            <span className="min-w-0 flex-1 whitespace-pre-wrap">{text}</span>
          </div>
          {nested}
        </div>
      )
    case 'todo':
      return (
        <div className="my-[0.1em]">
          <div className="flex gap-[0.5em]">
            <span className={`shrink-0 ${b.checked ? 'text-go' : 'text-white/45'}`}>{b.checked ? '☑' : '☐'}</span>
            <span className={`min-w-0 flex-1 whitespace-pre-wrap ${b.checked ? 'text-white/40 line-through' : ''}`}>{text}</span>
          </div>
          {nested}
        </div>
      )
    case 'quote':
      return (
        <blockquote className={`my-[0.4em] border-l-[3px] border-white/40 pl-[0.8em] whitespace-pre-wrap ${ink('text-white/75')}`}>
          {text}
          {kids}
        </blockquote>
      )
    case 'callout':
      return (
        <div className={`my-[0.5em] flex gap-[0.6em] rounded-lg p-[0.7em] ${notionColor(b.color)?.backgroundColor ? '' : 'bg-white/[0.06]'}`} style={notionColor(b.color)} data-notion-block-color={b.color}>
          {b.icon && <span className="shrink-0">{b.icon}</span>}
          <div className="min-w-0 flex-1">
            {b.text.length > 0 && <div className="whitespace-pre-wrap">{text}</div>}
            {kids}
          </div>
        </div>
      )
    case 'toggle':
      return (
        <details className="my-[0.2em]">
          <summary className="cursor-pointer whitespace-pre-wrap marker:text-white/45">{text}</summary>
          {nested}
        </details>
      )
    case 'code':
      return <pre className="my-[0.4em] overflow-x-auto rounded-lg bg-black/50 p-[0.7em] font-mono text-[0.85em] whitespace-pre text-white/80">{b.text.map((s) => s.t).join('')}</pre>
    case 'divider':
      return <hr className="my-[0.7em] border-white/15" />
    case 'image':
      return b.url ? (
        <figure className="my-[0.5em]">
          <img src={b.url} alt="" loading="lazy" className="max-h-[24em] max-w-full rounded-lg" onError={(e) => (e.currentTarget.style.display = 'none')} />
          {b.text.length > 0 && <figcaption className="mt-1 text-[0.8em] text-white/45">{text}</figcaption>}
        </figure>
      ) : null
    case 'page':
      return (
        <a href={b.url} target="_blank" rel="noreferrer" className="my-[0.15em] flex items-center gap-[0.4em] rounded px-1 text-white/85 underline decoration-white/25 underline-offset-2 hover:bg-white/[0.06]">
          <span>{b.icon ?? '📄'}</span>
          <span>{b.text.length ? text : '未命名頁面'}</span>
        </a>
      )
    case 'bookmark':
      return (
        <a href={b.url} target="_blank" rel="noreferrer" className="my-[0.4em] block truncate rounded-lg border border-white/15 px-[0.8em] py-[0.5em] text-[0.9em] text-accent hover:bg-white/[0.05]">
          🔖 {text}
        </a>
      )
    case 'synced':
      // Synced block: its source's content, as if written here. A thin rail marks it on hover.
      if (b.unresolved && !kids) {
        return syncing ? (
          <div className="my-[0.3em] flex items-center gap-2 rounded-md border border-dashed border-accent/40 px-[0.7em] py-[0.4em] text-[0.85em] text-accent/80" data-notion-synced="pending">
            <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />
            正在同步區塊內容…
          </div>
        ) : (
          <div className="my-[0.3em] rounded-md border border-dashed border-white/20 px-[0.7em] py-[0.4em] text-[0.85em] text-white/45" data-notion-synced="unresolved">
            ⟲ 同步區塊無法讀取（來源頁面未公開或已刪除）
            {b.url && (
              <a href={b.url} target="_blank" rel="noreferrer" className="ml-2 text-accent underline underline-offset-2">
                在 Notion 查看 ↗
              </a>
            )}
          </div>
        )
      }
      return (
        <div className="group/synced relative my-[0.2em] border-l-2 border-transparent pl-[0.5em] hover:border-[#eb5757]/50" data-notion-synced="ok">
          {kids}
        </div>
      )
    case 'database':
      return (
        <div className="my-[0.4em] rounded-lg border border-dashed border-white/20 px-[0.8em] py-[0.5em] text-[0.9em] text-white/55">
          🗃 資料庫「{text}」<span className="text-white/35">· 資料庫內容請在 Notion 中檢視</span>
        </div>
      )
    case 'table':
      return (
        <div className="my-[0.5em] overflow-x-auto">
          <table className="w-full border-collapse text-[0.9em]">
            <tbody>
              {(b.rows ?? []).filter(Array.isArray).map((row, r) => (
                <tr key={r} className={r === 0 && b.headerRow ? 'bg-white/[0.06] font-semibold text-white' : ''}>
                  {row.map((cell, c) => (
                    <td key={c} className="border border-white/15 px-[0.5em] py-[0.25em] align-top whitespace-pre-wrap">
                      <Spans spans={cell} renderText={renderText} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    case 'columns':
      return <div className="my-[0.3em] grid gap-[1em] [grid-template-columns:repeat(auto-fit,minmax(12em,1fr))]">{kids}</div>
    case 'column':
      return <div className="min-w-0">{kids}</div>
    default:
      return b.text.length || kids ? (
        <div className="my-[0.15em] whitespace-pre-wrap">
          {text}
          {nested}
        </div>
      ) : null
  }
}

/** Whether a retry for missing synced blocks is under way (for their placeholders). */
const Syncing = createContext(false)

/** Contains a rendering failure of one block. */
class BlockBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? <p className="my-[0.2em] text-[0.8em] text-white/30">（此區塊無法顯示）</p> : this.props.children
  }
}

/** Last line of defence for the whole page body: a notice with retry / open-in-Notion instead of a blank note. */
function ViewBoundary({ children, openHref, onRetry }: { children: ReactNode; openHref: string; onRetry: () => void }) {
  const [generation, setGeneration] = useState(0)
  return (
    <ViewBoundaryInner
      key={generation}
      openHref={openHref}
      onRetry={() => {
        onRetry()
        setGeneration((g) => g + 1)
      }}
    >
      {children}
    </ViewBoundaryInner>
  )
}

class ViewBoundaryInner extends Component<{ children: ReactNode; openHref: string; onRetry: () => void }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div className="flex flex-col items-center gap-2 py-6 text-center text-xs text-white/50" data-notion-crash>
        <span className="text-xl">⚠️</span>
        此頁面的部分內容無法排版顯示
        <span className="flex gap-2">
          <a href={this.props.openHref} target="_blank" rel="noreferrer" className="rounded-lg bg-white/[0.08] px-3 py-1.5 text-white/80 hover:bg-white/15">
            ↗ 在 Notion 開啟
          </a>
          <button type="button" onClick={this.props.onRetry} className="rounded-lg px-3 py-1.5 hover:bg-white/10">
            ↻ 重新載入
          </button>
        </span>
      </div>
    )
  }
}
