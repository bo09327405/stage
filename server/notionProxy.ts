import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import type { NotionBlock, NotionBlockType, NotionError, NotionPage, NotionSpan } from '../src/types/notion.ts'

/**
 * Dev / preview server endpoint: GET /api/notion?id=<page id>
 *
 * Reads a *public* Notion page ("Share → Publish / Share to web") through Notion's own public page
 * endpoint and returns it as clean, simple blocks. The browser can't call Notion directly (CORS),
 * and Notion pages refuse to be shown in an iframe (X-Frame-Options), so the app asks this proxy.
 * Only the page id is taken from the client and only notion.so is contacted.
 */

const NOTION = 'https://www.notion.so/api/v3'
const MAX_CHUNKS = 6
/** Rounds of fetching blocks the page endpoint left out (synced block sources, nested content). */
const MAX_FILL_ROUNDS = 4
/** Upper bound on extra blocks fetched per page, to stay polite to Notion. */
const MAX_FILL_BLOCKS = 900
const CACHE_MS = 20_000
/** A page with unresolved blocks is cached briefly, so a retry really asks Notion again. */
const PARTIAL_CACHE_MS = 3_000
const cache = new Map<string, { at: number; page: NotionPage }>()

type Rich = [string, ([string] | [string, string])[]?][]
interface RawBlock {
  id: string
  type?: string
  properties?: Record<string, Rich>
  format?: Record<string, unknown>
  content?: string[]
  alive?: boolean
}
type RecordMap = { block?: Record<string, { value?: unknown }>; collection?: Record<string, { value?: unknown }> }

const uuid = (hex: string) => `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
/** Records come as { value } or, in newer responses, { value: { value, role } }. */
const unwrap = <T>(rec: { value?: unknown } | undefined): T | undefined => {
  const v = rec?.value as { value?: unknown; role?: unknown } | undefined
  return (v && 'role' in v && v.value ? v.value : v) as T | undefined
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** POST to Notion's public API; one quiet retry on rate limiting / server hiccups. */
async function notion<T>(endpoint: string, body: unknown): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${NOTION}/${endpoint}`, {
      method: 'POST',
      // Without a User-Agent Notion's edge answers 403 with an HTML challenge page.
      headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'TheatreCue-NotePreview/1.0 (+notion public page reader)' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12_000),
    })
    if ((res.status === 429 || res.status >= 500) && attempt === 0) {
      await sleep(Number(res.headers.get('retry-after')) * 1000 || 900)
      continue
    }
    if (res.status === 429) throw Object.assign(new Error('rate_limited'), { code: 'rate_limited' })
    // An HTML answer is Notion's firewall, not a verdict about the page.
    if (!res.headers.get('content-type')?.includes('json')) throw new Error(`Notion 拒絕了請求（HTTP ${res.status}）`)
    if (!res.ok) throw Object.assign(new Error(`Notion 回應 ${res.status}`), { status: res.status })
    return (await res.json()) as T
  }
}

function absorb(map: RecordMap | undefined, blocks: Record<string, RawBlock>, collections: Record<string, { name?: Rich }>) {
  for (const [key, rec] of Object.entries(map?.block ?? {})) {
    const b = unwrap<RawBlock>(rec)
    if (b) blocks[key] = b
  }
  for (const [key, rec] of Object.entries(map?.collection ?? {})) {
    const c = unwrap<{ name?: Rich }>(rec)
    if (c) collections[key] = c
  }
}

/** The source block a synced-block copy points to. */
const syncSource = (b: RawBlock | undefined) =>
  b?.type === 'transclusion_reference' ? (b.format?.transclusion_reference_pointer as { id?: string } | undefined)?.id : undefined

/**
 * Block ids this page needs but doesn't have yet: walking from the page through content (not into
 * sub-pages or databases) and through synced-block references to their sources.
 */
function missingIds(root: string, blocks: Record<string, RawBlock>) {
  const missing = new Set<string>()
  const seen = new Set<string>()
  const visit = (id: string, depth: number) => {
    if (seen.has(id) || depth > 14) return
    seen.add(id)
    const b = blocks[id]
    if (!b) return void missing.add(id)
    if (id !== root && (b.type === 'page' || b.type?.startsWith('collection_view'))) return
    const source = syncSource(b)
    if (source) visit(source, depth + 1)
    for (const child of b.content ?? []) visit(child, depth + 1)
  }
  visit(root, 0)
  return [...missing]
}

async function loadPage(id: string) {
  const blocks: Record<string, RawBlock> = {}
  const collections: Record<string, { name?: Rich }> = {}
  let cursor: { stack: unknown[] } = { stack: [] }
  let truncated = false
  for (let chunk = 0; chunk < MAX_CHUNKS; chunk++) {
    const data = await notion<{ recordMap?: RecordMap; cursor?: { stack: unknown[] } }>('loadPageChunk', {
      pageId: id,
      limit: 100,
      cursor,
      chunkNumber: chunk,
      verticalColumns: false,
    })
    absorb(data.recordMap, blocks, collections)
    cursor = data.cursor ?? { stack: [] }
    if (!cursor.stack?.length) break
    if (chunk === MAX_CHUNKS - 1) truncated = true
  }
  if (!blocks[id]) return { blocks, collections, truncated }

  // The page endpoint leaves out synced block sources (often on another page) and some nested
  // content (toggles, columns). Fetch those by id, a few rounds deep.
  let fetched = 0
  for (let round = 0; round < MAX_FILL_ROUNDS; round++) {
    const want = missingIds(id, blocks).slice(0, MAX_FILL_BLOCKS - fetched)
    if (want.length === 0) break
    for (let i = 0; i < want.length; i += 100) {
      const batch = want.slice(i, i + 100)
      try {
        const data = await notion<{ recordMap?: RecordMap }>('syncRecordValues', {
          requests: batch.map((bid) => ({ pointer: { table: 'block', id: bid }, version: -1 })),
        })
        absorb(data.recordMap, blocks, collections)
      } catch (err) {
        // Partial pages are still useful; what's missing is reported as unresolved.
        if ((err as { code?: string }).code === 'rate_limited') break
      }
    }
    fetched += want.length
    if (fetched >= MAX_FILL_BLOCKS) {
      truncated = true
      break
    }
  }
  return { blocks, collections, truncated }
}

function spans(rich: Rich | undefined, blocks: Record<string, RawBlock>): NotionSpan[] {
  if (!rich) return []
  return rich.map(([text, marks = []]) => {
    const span: NotionSpan = { t: text }
    for (const [mark, arg] of marks) {
      if (mark === 'b') span.b = true
      else if (mark === 'i') span.i = true
      else if (mark === 's') span.s = true
      else if (mark === 'c') span.c = true
      else if (mark === '_') span.u = true
      else if (mark === 'a' && arg) span.a = arg
      else if (mark === 'h' && typeof arg === 'string' && arg !== 'default') span.h = arg // text color / highlight
      else if (mark === 'p' && arg) span.t = plain(blocks[arg]?.properties?.title) || '頁面' // page mention
      else if (mark === 'd' && arg && typeof arg === 'object') span.t = (arg as { start_date?: string }).start_date ?? text // date
      else if (mark === 'u') span.t = '@成員'
    }
    return span
  })
}
const plain = (rich: Rich | undefined) => (rich ?? []).map(([t]) => t).join('')

const TYPE_MAP: Record<string, NotionBlockType> = {
  header: 'h1',
  sub_header: 'h2',
  sub_sub_header: 'h3',
  header_4: 'h3',
  text: 'p',
  bulleted_list: 'bullet',
  numbered_list: 'number',
  to_do: 'todo',
  quote: 'quote',
  callout: 'callout',
  toggle: 'toggle',
  code: 'code',
  divider: 'divider',
  image: 'image',
  page: 'page',
  table: 'table',
  column_list: 'columns',
  column: 'column',
  collection_view: 'database',
  collection_view_page: 'database',
  bookmark: 'bookmark',
  // Synced blocks: the original holds the content, copies point to it.
  transclusion_container: 'synced',
  transclusion_reference: 'synced',
}

interface Ctx {
  blocks: Record<string, RawBlock>
  collections: Record<string, { name?: Rich }>
  /** Blocks referenced but not loaded. */
  unresolved: number
  /** Synced sources currently being expanded (guards against a block syncing itself). */
  expanding: Set<string>
}

function convert(id: string, ctx: Ctx, depth = 0): NotionBlock | null {
  const { blocks, collections } = ctx
  const raw = blocks[id]
  if (!raw) {
    ctx.unresolved++
    return null
  }
  if (raw.alive === false || depth > 14) return null
  const type = TYPE_MAP[raw.type ?? ''] ?? 'unsupported'
  const props = raw.properties ?? {}
  const format = raw.format ?? {}
  const block: NotionBlock = { id, type, text: spans(props.title, blocks) }
  // Block color ("Color" in the block menu): text or background for the whole block.
  if (typeof format.block_color === 'string' && format.block_color !== 'default') block.color = format.block_color

  if (type === 'todo') block.checked = plain(props.checked) === 'Yes'
  if (type === 'callout' || type === 'page') block.icon = typeof format.page_icon === 'string' && !format.page_icon.startsWith('http') ? format.page_icon : undefined
  if (type === 'image') {
    const src = (format.display_source as string | undefined) ?? plain(props.source)
    if (src) block.url = src.startsWith('http') && !src.includes('amazonaws.com') && !src.startsWith('attachment:') ? src : `https://www.notion.so/image/${encodeURIComponent(src)}?table=block&id=${id}&cache=v2`
    block.text = spans(props.caption, blocks)
  }
  if (type === 'bookmark') {
    block.url = plain(props.link)
    block.text = props.title ? spans(props.title, blocks) : [{ t: block.url }]
  }
  if (type === 'page') block.url = `https://www.notion.so/${id.replaceAll('-', '')}`
  if (type === 'synced') {
    // A copy shows its source's content; the original shows its own.
    const sourceId = syncSource(raw) ?? id
    const source = blocks[sourceId]
    if (!source || source.alive === false || ctx.expanding.has(sourceId)) {
      if (!source) ctx.unresolved++
      return { id, type, text: [], unresolved: true, url: `https://www.notion.so/${sourceId.replaceAll('-', '')}` }
    }
    ctx.expanding.add(sourceId)
    block.children = (source.content ?? []).map((cid) => convert(cid, ctx, depth + 1)).filter((b): b is NotionBlock => !!b)
    ctx.expanding.delete(sourceId)
    if ((source.content?.length ?? 0) > 0 && block.children.length === 0) block.unresolved = true
    return block
  }
  if (type === 'database') {
    const cid = format.collection_pointer && typeof format.collection_pointer === 'object' ? (format.collection_pointer as { id?: string }).id : (raw as { collection_id?: string }).collection_id
    block.text = [{ t: plain(cid ? collections[cid]?.name : undefined) || '資料庫' }]
    return block // rows are not loaded by the page endpoint; shown as a card
  }
  if (type === 'table') {
    const order = (format.table_block_column_order as string[] | undefined) ?? []
    block.headerRow = !!format.table_block_column_header
    block.rows = (raw.content ?? []).map((rid) => order.map((col) => spans(blocks[rid]?.properties?.[col], blocks)))
    return block
  }
  // A sub-page's own content belongs to that page; show it as a link.
  if (type !== 'page' && raw.content?.length) {
    block.children = raw.content.map((cid) => convert(cid, ctx, depth + 1)).filter((b): b is NotionBlock => !!b)
  }
  if (type === 'unsupported' && !block.text.length && !block.children?.length) return null
  return block
}

export async function readNotionPage(rawId: string): Promise<NotionPage> {
  const hex = rawId.replace(/-/g, '').toLowerCase()
  const id = uuid(hex)
  const hit = cache.get(id)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.page

  let loaded: Awaited<ReturnType<typeof loadPage>>
  try {
    loaded = await loadPage(id)
  } catch (err) {
    // Rate limited: an older copy beats an error.
    if ((err as { code?: string }).code === 'rate_limited' && hit) return hit.page
    throw err
  }
  const { blocks, collections, truncated } = loaded
  const root = blocks[id]
  if (!root) throw Object.assign(new Error('not_public'), { code: 'not_public' })
  const format = root.format ?? {}
  const icon = typeof format.page_icon === 'string' && !format.page_icon.startsWith('http') ? format.page_icon : ''
  const ctx: Ctx = { blocks, collections, unresolved: 0, expanding: new Set() }
  const page: NotionPage = {
    id,
    // A full-page database keeps its title on the collection.
    title: plain(root.properties?.title) || plain(collections[(root as { collection_id?: string }).collection_id ?? '']?.name) || '未命名頁面',
    icon,
    url: `https://www.notion.so/${hex}`,
    blocks: (root.content ?? []).map((cid) => convert(cid, ctx)).filter((b): b is NotionBlock => !!b),
    fetchedAt: Date.now(),
    truncated,
    unresolved: ctx.unresolved,
  }
  // A full-page database may still have page content (synced blocks, notes) above the table.
  if (root.type === 'collection_view_page' && page.blocks.length === 0) page.blocks = [{ id, type: 'database', text: [{ t: page.title }] }]
  cache.set(id, { at: Date.now() - (page.unresolved ? CACHE_MS - PARTIAL_CACHE_MS : 0), page })
  return page
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const send = (status: number, body: NotionPage | NotionError) => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(body))
  }
  const id = new URL(req.url ?? '', 'http://x').searchParams.get('id') ?? ''
  if (!/^[0-9a-f]{32}$/i.test(id.replace(/-/g, ''))) {
    return send(400, { error: 'invalid_url', message: '網址中找不到 Notion 頁面 ID' })
  }
  try {
    send(200, await readNotionPage(id))
  } catch (err) {
    const e = err as Error & { code?: string; status?: number }
    // Notion answers 400 for ids it doesn't know or won't show (private / deleted pages).
    if (e.code === 'rate_limited') {
      return send(429, { error: 'rate_limited', message: 'Notion 暫時限制了讀取次數，稍後會自動重試' })
    }
    if (e.code === 'not_public' || e.status === 400 || e.status === 401 || e.status === 403 || e.status === 404) {
      return send(404, { error: 'not_public', message: '此頁面不存在，或尚未公開分享。' })
    }
    send(502, { error: 'unreachable', message: `無法連線到 Notion：${e.message}` })
  }
}

/** Vite plugin mounting the endpoint on `npm run dev` and `vite preview`. */
export function notionProxy(): Plugin {
  // Must return nothing: a function returned from configureServer is run as a post-hook.
  const mount = (server: { middlewares: { use: (path: string, fn: (req: IncomingMessage, res: ServerResponse) => void) => unknown } }) => {
    server.middlewares.use('/api/notion', (req, res) => {
      handle(req, res).catch(() => {
        res.statusCode = 500
        res.end()
      })
    })
  }
  return { name: 'notion-proxy', configureServer: mount, configurePreviewServer: mount }
}
