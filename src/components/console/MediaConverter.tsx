import { useEffect, useRef, useState } from 'react'
import {
  START_COMMAND,
  companionCancel,
  companionConvert,
  companionDownload,
  companionFiles,
  companionStatus,
  companionToken,
  companionUpload,
  companionUrl,
  companionWatch,
  saveCompanion,
  type CompanionFile,
  type CompanionStatus,
} from '../../services/companion'
import { DEFAULT_CONVERT, MAX_CONVERT_BYTES, cancelConversion, convertFile, loadFFmpeg, type ConvertOptions, type OutputFormat } from '../../services/ffmpegConvert'

const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`

/**
 * "Convert a file": pick files from this device, turn them into MP3 / WAV (audio only — the sound of a video
 * included) or a lighter MP4, optionally normalising the loudness, then hand the results on (upload / place on a
 * track). Done in the browser with ffmpeg.wasm: nothing to install, works on phones, files stay on the device until
 * the result is uploaded.
 */
export function MediaConverter({ audioOnly = false, onConverted }: { audioOnly?: boolean; onConverted: (files: File[]) => Promise<void> | void }) {
  const [files, setFiles] = useState<File[]>([])
  const [options, setOptions] = useState<ConvertOptions>(DEFAULT_CONVERT)
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState<string | null>(null)
  const [index, setIndex] = useState(0)
  const [ratio, setRatio] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const cancelled = useRef(false)
  // "This computer's ffmpeg": the local companion (companion-tool/) instead of the in-browser engine.
  const [mode, setMode] = useState<'browser' | 'companion'>('browser')
  const [status, setStatus] = useState<CompanionStatus>({ state: 'offline' })
  const [localFiles, setLocalFiles] = useState<CompanionFile[]>([])
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [urlText, setUrlText] = useState(companionUrl())
  const [tokenText, setTokenText] = useState(companionToken())
  const [jobId, setJobId] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const companion = mode === 'companion'

  // While the companion tab is open: keep the status light current and the file list fresh.
  useEffect(() => {
    if (!companion) return
    let alive = true
    const tick = async () => {
      const s = await companionStatus()
      if (!alive) return
      setStatus(s)
      if (s.state === 'online') companionFiles().then((f) => alive && setLocalFiles(f), () => {})
    }
    void tick()
    const timer = window.setInterval(() => void tick(), 3000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [companion])
  // Leaving while converting stops it (and frees the engine's memory).
  useEffect(() => () => cancelConversion(), [])

  const set = <K extends keyof ConvertOptions>(key: K, value: ConvertOptions[K]) => setOptions((o) => ({ ...o, [key]: value }))
  const tooBig = companion ? [] : files.filter((f) => f.size > MAX_CONVERT_BYTES)
  const online = status.state === 'online'
  const count = companion ? picked.size : files.length
  const formats: { id: OutputFormat; label: string; hint: string }[] = [
    { id: 'mp3', label: '🎵 MP3', hint: '檔案小，適合配樂與音效' },
    { id: 'wav', label: '🎼 WAV', hint: '無損，檔案大，適合精準剪輯' },
    ...(audioOnly ? [] : [{ id: 'mp4' as const, label: '🎬 MP4 影片', hint: 'H.264 / 最高 720p（瀏覽器轉影片很慢，適合短片）' }]),
  ]

  const runCompanion = async () => {
    cancelled.current = false
    setBusy(true)
    setError(null)
    setDone(null)
    navigator.vibrate?.(10)
    const out: File[] = []
    const names = [...picked]
    try {
      for (let i = 0; i < names.length; i++) {
        if (cancelled.current) throw new Error('已取消')
        setIndex(i)
        setPhase(`本機轉檔 ${i + 1}/${names.length}：${names[i]}`)
        setRatio(0)
        const job = await companionConvert(names[i], options)
        setJobId(job.id)
        const watch = companionWatch(job.id, (j) => setRatio(j.percent / 100))
        const finished = await watch.done
        setPhase(`取回轉好的檔案 ${i + 1}/${names.length}…`)
        setRatio(null)
        out.push(await companionDownload(finished))
        setJobId(null)
      }
      setPhase('處理結果…')
      await onConverted(out)
      setDone(`✓ 已完成 ${out.length} 個檔案（共 ${mb(out.reduce((n, f) => n + f.size, 0))}）`)
      setPicked(new Set())
      navigator.vibrate?.(20)
    } catch (err) {
      setError((err as Error).message)
      navigator.vibrate?.([30, 60, 30])
    } finally {
      setBusy(false)
      setPhase(null)
      setRatio(null)
      setJobId(null)
    }
  }

  const run = async () => {
    if (companion) return runCompanion()
    cancelled.current = false
    setBusy(true)
    setError(null)
    setDone(null)
    navigator.vibrate?.(10)
    const out: File[] = []
    try {
      setPhase('載入轉檔引擎（約 30 MB，只需下載一次）…')
      setRatio(null)
      await loadFFmpeg()
      for (let i = 0; i < files.length; i++) {
        if (cancelled.current) throw new Error('已取消')
        setIndex(i)
        setPhase(`轉檔中 ${i + 1}/${files.length}：${files[i].name}`)
        setRatio(0)
        out.push(await convertFile(files[i], options, setRatio))
      }
      setRatio(null)
      setPhase('處理結果…')
      await onConverted(out)
      setDone(`✓ 已完成 ${out.length} 個檔案（共 ${mb(out.reduce((n, f) => n + f.size, 0))}）`)
      setFiles([])
      navigator.vibrate?.(20)
    } catch (err) {
      setError((err as Error).message)
      navigator.vibrate?.([30, 60, 30])
    } finally {
      setBusy(false)
      setPhase(null)
      setRatio(null)
    }
  }

  const seg = (on: boolean) => `min-h-10 rounded-md text-xs font-semibold transition ${on ? 'bg-accent text-white' : 'text-white/55'}`

  return (
    <div className="space-y-3" data-media-converter>
      <div className="grid grid-cols-2 gap-1 rounded-lg bg-black/40 p-0.5" role="radiogroup" aria-label="轉檔方式">
        {(
          [
            ['browser', '🌐 瀏覽器轉檔'],
            ['companion', '🖥 本機伴侶（ffmpeg）'],
          ] as const
        ).map(([id, label]) => (
          <button key={id} type="button" role="radio" aria-checked={mode === id} disabled={busy} onClick={() => setMode(id)} className={`min-h-10 rounded-md text-xs font-semibold ${mode === id ? 'bg-accent text-white' : 'text-white/55'}`} data-convert-mode={id}>
            {label}
          </button>
        ))}
      </div>

      {companion && (
        <div className="space-y-2 rounded-xl border border-line bg-white/[0.03] p-3" data-companion-panel>
          <div className="flex items-center gap-2 text-xs">
            <span className={`h-2.5 w-2.5 rounded-full ${online ? 'bg-go' : status.state === 'offline' ? 'bg-panic' : 'bg-standby'}`} />
            <span className="font-semibold text-white/80" data-companion-state={status.state}>
              {online ? '已連線' : status.state === 'offline' ? '未啟動' : status.state === 'needs-token' ? '需要配對碼' : '配對碼不正確'}
            </span>
            {online && status.ffmpeg && <span className="min-w-0 flex-1 truncate text-white/35">{status.ffmpeg}</span>}
          </div>
          {status.state === 'offline' && (
            <div className="space-y-1.5 text-[11px] leading-relaxed text-white/50">
              <p>請在這台電腦的終端機啟動本機伴侶（需要 Node.js 與 ffmpeg，詳見 companion-tool/README.md）：</p>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(START_COMMAND).then(() => setCopied(true))
                  window.setTimeout(() => setCopied(false), 1500)
                }}
                className="min-h-10 w-full rounded-lg bg-black/50 px-3 text-left font-mono text-xs text-white/80"
              >
                $ {START_COMMAND} <span className="float-right text-white/35">{copied ? '已複製' : '點一下複製'}</span>
              </button>
              <p>只有執行伴侶的那台電腦能用；Safari 不允許連到本機，請用 Chrome / Edge / Firefox，或改用「瀏覽器轉檔」。</p>
            </div>
          )}
          {(status.state === 'needs-token' || status.state === 'bad-token' || status.state === 'offline') && (
            <div className="grid grid-cols-[1fr_auto] gap-2">
              <input value={tokenText} onChange={(e) => setTokenText(e.target.value)} placeholder="配對碼（終端機會顯示）" className="min-h-10 rounded-lg border border-line bg-black/30 px-2 font-mono text-xs text-white" aria-label="配對碼" data-companion-token />
              <button type="button" onClick={() => { saveCompanion(urlText, tokenText); void companionStatus().then(setStatus) }} className="min-h-10 rounded-lg bg-white/10 px-3 text-xs font-semibold text-white/80">
                儲存
              </button>
              <input value={urlText} onChange={(e) => setUrlText(e.target.value)} className="col-span-2 min-h-9 rounded-lg border border-line bg-black/30 px-2 font-mono text-[11px] text-white/60" aria-label="本機伴侶位址" />
            </div>
          )}
          {online && (
            <>
              <div className="flex items-center justify-between text-[11px] text-white/45">
                <span className="truncate">📁 {status.watchDir}</span>
                <label className="shrink-0 cursor-pointer rounded-md bg-white/10 px-2 py-1 font-semibold text-white/75">
                  ＋ 加入電腦裡的檔案
                  <input
                    type="file"
                    multiple
                    accept="audio/*,video/*,.mkv,.avi,.mov,.flac,.aif,.aiff"
                    className="hidden"
                    onChange={async (e) => {
                      const picks = [...(e.target.files ?? [])]
                      e.target.value = ''
                      try {
                        for (const f of picks) await companionUpload(f)
                        setLocalFiles(await companionFiles())
                        setPicked((p) => new Set([...p, ...picks.map((f) => f.name)]))
                      } catch (err) {
                        setError((err as Error).message)
                      }
                    }}
                    data-companion-add
                  />
                </label>
              </div>
              {localFiles.length === 0 ? (
                <p className="rounded-lg bg-black/30 p-3 text-center text-xs text-white/40">監看資料夾裡還沒有影音檔：把檔案放進去，或按上面的「加入電腦裡的檔案」。</p>
              ) : (
                <ul className="max-h-40 space-y-1 overflow-y-auto" data-companion-files>
                  {localFiles.map((f) => (
                    <li key={f.name}>
                      <label className="flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg bg-black/25 px-2.5 text-xs text-white/75">
                        <input
                          type="checkbox"
                          checked={picked.has(f.name)}
                          onChange={() => setPicked((p) => { const n = new Set(p); if (n.has(f.name)) n.delete(f.name); else n.add(f.name); return n })}
                          className="h-5 w-5 shrink-0 accent-[#0a84ff]"
                          disabled={busy}
                        />
                        <span className="min-w-0 flex-1 truncate">{f.name}</span>
                        <span className="shrink-0 font-mono text-[10px] text-white/40">{mb(f.bytes)}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}

      <label className={`${companion ? 'hidden ' : ''}flex min-h-14 cursor-pointer items-center justify-center rounded-xl border border-dashed border-white/25 px-3 text-center text-sm text-white/70 active:bg-white/10`}>
        {files.length ? `已選 ${files.length} 個檔案（${mb(files.reduce((n, f) => n + f.size, 0))}）· 點一下重選` : '⇪ 選擇要轉檔的檔案（可多選）'}
        <input
          type="file"
          multiple
          accept="audio/*,video/*,.mp3,.wav,.m4a,.aac,.ogg,.flac,.aif,.aiff,.mp4,.mov,.mkv,.webm,.avi,.m4v"
          className="hidden"
          disabled={busy}
          onChange={(e) => {
            setFiles([...(e.target.files ?? [])])
            setDone(null)
            setError(null)
            e.target.value = ''
          }}
          data-convert-input
        />
      </label>
      {!companion && files.length > 0 && (
        <ul className="max-h-28 space-y-0.5 overflow-y-auto text-[11px] text-white/45">
          {files.map((f) => (
            <li key={f.name + f.size} className="flex justify-between gap-2">
              <span className="truncate">{f.name}</span>
              <span className={f.size > MAX_CONVERT_BYTES ? 'text-panic' : ''}>{mb(f.size)}</span>
            </li>
          ))}
        </ul>
      )}
      {tooBig.length > 0 && <p className="text-xs text-panic">有檔案超過 {MAX_CONVERT_BYTES / 1048576} MB，瀏覽器轉不動：請先用電腦上的軟體壓縮或剪短。</p>}

      <div>
        <div className="mb-1.5 text-[11px] font-semibold tracking-widest text-white/50 uppercase">輸出格式</div>
        <div className={`grid gap-1 rounded-lg bg-black/40 p-0.5 ${formats.length === 3 ? 'grid-cols-3' : 'grid-cols-2'}`} role="radiogroup" aria-label="輸出格式">
          {formats.map((f) => (
            <button key={f.id} type="button" role="radio" aria-checked={options.format === f.id} onClick={() => set('format', f.id)} className={seg(options.format === f.id)} data-convert-format={f.id}>
              {f.label}
            </button>
          ))}
        </div>
        <p className="mt-1 text-[11px] text-white/35">{formats.find((f) => f.id === options.format)?.hint}</p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {options.format === 'mp3' && (
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium text-white/50">MP3 品質</span>
            <select value={options.bitrate} onChange={(e) => set('bitrate', Number(e.target.value) as ConvertOptions['bitrate'])} className="min-h-11 w-full rounded-lg border border-line bg-white/[0.04] px-2 text-xs text-white">
              <option value={128}>128 kbps（小）</option>
              <option value={192}>192 kbps（標準）</option>
              <option value={320}>320 kbps（高音質）</option>
            </select>
          </label>
        )}
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium text-white/50">聲道</span>
          <select value={options.channels} onChange={(e) => set('channels', e.target.value as ConvertOptions['channels'])} className="min-h-11 w-full rounded-lg border border-line bg-white/[0.04] px-2 text-xs text-white">
            <option value="keep">保持原樣</option>
            <option value="stereo">立體聲</option>
            <option value="mono">單聲道</option>
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium text-white/50">取樣率</span>
          <select value={String(options.sampleRate)} onChange={(e) => set('sampleRate', e.target.value === 'keep' ? 'keep' : (Number(e.target.value) as 44100 | 48000))} className="min-h-11 w-full rounded-lg border border-line bg-white/[0.04] px-2 text-xs text-white">
            <option value="keep">保持原樣</option>
            <option value="44100">44.1 kHz</option>
            <option value="48000">48 kHz</option>
          </select>
        </label>
      </div>
      <button
        type="button"
        onClick={() => set('normalize', !options.normalize)}
        aria-pressed={options.normalize}
        className={`flex min-h-12 w-full items-center justify-between rounded-xl border px-3 text-left text-sm font-semibold ${options.normalize ? 'border-accent bg-accent/15 text-white' : 'border-line text-white/60'}`}
        data-convert-normalize
      >
        <span>🔊 平均音量（Loudness 正規化）</span>
        <span className="text-xs">{options.normalize ? '開啟' : '關閉'}</span>
      </button>

      {busy && (
        <div className="space-y-1" data-convert-progress>
          <div className="h-2 overflow-hidden rounded-full bg-white/10">
            {ratio != null && ratio > 0 ? (
              <div className="h-full rounded-full bg-accent transition-[width] duration-200" style={{ width: `${Math.round(ratio * 100)}%` }} />
            ) : (
              <div className="h-full w-1/3 animate-[upload-slide_1.2s_ease-in-out_infinite] rounded-full bg-accent/70" />
            )}
          </div>
          <p className="text-[11px] text-white/55">
            {phase}
            {ratio != null && ratio > 0 ? ` ${Math.round(ratio * 100)}%` : ''}
            {files.length > 1 && ratio != null ? `（第 ${index + 1}/${files.length} 個）` : ''}
          </p>
        </div>
      )}
      {done && <p className="text-xs text-go">{done}</p>}
      {error && <p className="text-xs leading-relaxed text-panic">{error}</p>}

      <div className="flex gap-2">
        <button type="button" disabled={busy || count === 0 || tooBig.length > 0 || (companion && !online)} onClick={() => void run()} className="min-h-12 flex-1 rounded-xl bg-accent text-sm font-semibold text-white disabled:opacity-40" data-convert-run>
          {busy ? '轉檔中…' : `${companion ? `本機轉檔${count ? ` ${count} 個檔案` : ''}並` : '轉檔並'}${audioOnly ? '匯入' : '加入專案'}`}
        </button>
        {busy && (
          <button
            type="button"
            onClick={() => {
              cancelled.current = true
              if (jobId) void companionCancel(jobId)
              cancelConversion()
              setBusy(false)
              setPhase(null)
              setRatio(null)
              setError('已取消')
            }}
            className="min-h-12 rounded-xl bg-white/10 px-4 text-sm font-semibold text-white/80"
          >
            取消
          </button>
        )}
      </div>
      <p className="text-[11px] leading-relaxed text-white/35">{companion ? '轉檔在執行伴侶的這台電腦上用 ffmpeg 進行，轉好後才由網頁上傳到專案。' : '轉檔在你的裝置上進行，檔案不會先上傳。手機轉大檔案或影片會很慢、很耗電，建議保持螢幕開啟。'}請只轉換你有權使用的檔案。</p>
    </div>
  )
}
