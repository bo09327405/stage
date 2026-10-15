/**
 * Downloads the open-source TTS model the Studio uses — Kokoro multi-language v1.1 (int8), for
 * sherpa-onnx: Mandarin + English voices, run locally on the CPU, no API key — into tts-models/.
 * Files come from the sherpa-onnx author's Hugging Face mirror (much faster than the GitHub
 * release archive); files already downloaded with the right size are skipped, so it can resume.
 *
 *   npm run tts:setup
 */
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const MODEL = 'kokoro-int8-multi-lang-v1_1'
const REPO = `csukuangfj/${MODEL}`
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const target = join(root, 'tts-models', MODEL)

const res = await fetch(`https://huggingface.co/api/models/${REPO}/tree/main?recursive=true`)
if (!res.ok) throw new Error(`無法取得模型檔案清單：HTTP ${res.status}`)
const files = (await res.json()).filter((f) => f.type === 'file' && !f.path.startsWith('.'))
const total = files.reduce((n, f) => n + (f.size ?? 0), 0)
console.log(`${MODEL}：${files.length} 個檔案，共 ${(total / 1e6).toFixed(0)} MB → ${target}`)

let done = 0
for (const f of files) {
  const out = join(target, f.path)
  if (existsSync(out) && statSync(out).size === f.size) {
    done += f.size
    continue
  }
  mkdirSync(dirname(out), { recursive: true })
  const r = await fetch(`https://huggingface.co/${REPO}/resolve/main/${f.path.split('/').map(encodeURIComponent).join('/')}`, { redirect: 'follow' })
  if (!r.ok || !r.body) throw new Error(`下載 ${f.path} 失敗：HTTP ${r.status}`)
  // Written under a temporary name, so an interrupted download is retried next time.
  await pipeline(Readable.fromWeb(r.body), createWriteStream(`${out}.part`))
  renameSync(`${out}.part`, out)
  done += f.size
  if (f.size > 1e6) console.log(`  ${f.path}（${(done / 1e6).toFixed(0)}/${(total / 1e6).toFixed(0)} MB）`)
}
console.log(`✓ 完成：${target}`)
