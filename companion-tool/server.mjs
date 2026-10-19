#!/usr/bin/env node
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createCompanion } from './lib/server.mjs'
import { ffmpegVersion } from './lib/ffmpeg.mjs'

// Theatre Cue local companion — see README.md.
const argv = process.argv.slice(2)
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
}
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`用法: node server.mjs [選項]

  --watch <資料夾>   監看資料夾（預設 ~/Theatre-Cue-Inbox）；轉好的檔案放在裡面的 converted/
  --port <埠號>      預設 3333
  --token <配對碼>   固定配對碼（預設每次啟動隨機產生；也可用環境變數 COMPANION_TOKEN）
  --no-token         不需要配對碼（只建議在自己信任的電腦上）
  --origin <網址>    額外允許的網頁來源，例如你自己部署的網址（可重複）
  --auto <格式>      新檔案一放進資料夾就自動轉檔：mp3 | wav | mp4
  --ffmpeg <路徑>    ffmpeg 的位置（預設用 PATH 裡的 ffmpeg）
  --ffprobe <路徑>   ffprobe 的位置`)
  process.exit(0)
}

const watchDir = flag('watch', join(homedir(), 'Theatre-Cue-Inbox'))
const port = Number(flag('port', '3333'))
const noToken = argv.includes('--no-token')
const token = noToken ? null : (flag('token') ?? process.env.COMPANION_TOKEN ?? randomBytes(3).toString('hex'))
const origins = argv.flatMap((a, i) => (a === '--origin' && argv[i + 1] ? [argv[i + 1]] : []))
const autoFormat = flag('auto')
const ffmpeg = flag('ffmpeg', 'ffmpeg')
const ffprobe = flag('ffprobe', ffmpeg.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1'))

const version = await ffmpegVersion(ffmpeg)
if (!version) {
  console.error(`✗ 找不到 ffmpeg（${ffmpeg}）。請先安裝：macOS 用 \`brew install ffmpeg\`，Windows 用 \`winget install ffmpeg\`，或用 --ffmpeg 指定路徑。`)
  process.exit(1)
}

const companion = createCompanion({
  watchDir,
  token,
  origins,
  ffmpeg,
  ffprobe,
  auto: autoFormat ? { format: autoFormat } : null,
  log: (line) => console.log(line),
})
const address = await companion.listen(port)
console.log(`
🎭 Theatre Cue 本機伴侶 ${address.address}:${address.port}
   ${version}
   監看資料夾：${companion.watchDir}
   輸出資料夾：${companion.outDir}
   ${token ? `配對碼：${token}   ← 貼到網頁的「本機伴侶」設定裡` : '（未啟用配對碼）'}
   ${autoFormat ? `自動轉檔：新檔案 → ${autoFormat}` : '把影音檔放進監看資料夾，然後在網頁選擇要轉檔的檔案。'}
   按 Ctrl+C 結束。
`)
process.on('SIGINT', async () => {
  await companion.close()
  process.exit(0)
})
