import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import type { NotionError, NotionPage } from '../src/types/notion.ts'
import { notionFailure, notionIdOf, readNotionPage } from './notionCore.ts'

/** Dev / preview server endpoint: GET /api/notion?id=<page id> (the logic is in notionCore.ts). */
async function handle(req: IncomingMessage, res: ServerResponse) {
  const send = (status: number, body: NotionPage | NotionError) => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(body))
  }
  const id = notionIdOf(new URL(req.url ?? '', 'http://x').searchParams.get('id'))
  if (!id) return send(400, { error: 'invalid_url', message: '網址中找不到 Notion 頁面 ID' })
  try {
    send(200, await readNotionPage(id))
  } catch (err) {
    const f = notionFailure(err)
    send(f.status, f.body)
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
