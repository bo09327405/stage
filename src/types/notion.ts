/** A Notion page reduced to what a rehearsal note needs (built by server/notionProxy.ts). */

/** A run of text with its marks: bold, italic, strike, code, underline, link, color. */
export interface NotionSpan {
  t: string
  b?: boolean
  i?: boolean
  s?: boolean
  c?: boolean
  u?: boolean
  a?: string
  /** Notion color: "red", "blue"… (text) or "red_background"… (highlight). */
  h?: string
}

export type NotionBlockType =
  | 'h1'
  | 'h2'
  | 'h3'
  | 'p'
  | 'bullet'
  | 'number'
  | 'todo'
  | 'quote'
  | 'callout'
  | 'toggle'
  | 'code'
  | 'divider'
  | 'image'
  | 'page'
  | 'table'
  | 'columns'
  | 'column'
  | 'database'
  | 'bookmark'
  | 'synced'
  | 'unsupported'

export interface NotionBlock {
  id: string
  type: NotionBlockType
  text: NotionSpan[]
  /** to-do */
  checked?: boolean
  /** callout / sub-page icon (emoji) */
  icon?: string
  /** image source (proxied through notion.so), bookmark / page link */
  url?: string
  /** table cells: rows → cells → spans; first row may be a header */
  rows?: NotionSpan[][][]
  headerRow?: boolean
  children?: NotionBlock[]
  /** synced block whose source couldn't be read (not public, deleted, or not fetched yet) */
  unresolved?: boolean
  /** Whole-block color set in Notion (text "red" or background "red_background"). */
  color?: string
}

export interface NotionPage {
  id: string
  title: string
  icon: string
  /** Public URL to open the page in Notion. */
  url: string
  blocks: NotionBlock[]
  /** Server time the page was read. */
  fetchedAt: number
  /** True when the page was longer than what was loaded. */
  truncated: boolean
  /** Synced blocks / nested blocks that couldn't be loaded this time (worth retrying). */
  unresolved: number
}

export interface NotionError {
  /** preview_unavailable: this site has no preview server (static hosting such as GitHub Pages). */
  error: 'invalid_url' | 'not_public' | 'unreachable' | 'rate_limited' | 'preview_unavailable'
  message: string
}
