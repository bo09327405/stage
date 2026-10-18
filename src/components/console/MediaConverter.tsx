import { useEffect, useRef, useState } from 'react'
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
  // Leaving while converting stops it (and frees the engine's memory).
  useEffect(() => () => cancelConversion(), [])

  const set = <K extends keyof ConvertOptions>(key: K, value: ConvertOptions[K]) => setOptions((o) => ({ ...o, [key]: value }))
  const tooBig = files.filter((f) => f.size > MAX_CONVERT_BYTES)
  const formats: { id: OutputFormat; label: string; hint: string }[] = [
    { id: 'mp3', label: '🎵 MP3', hint: '檔案小，適合配樂與音效' },
    { id: 'wav', label: '🎼 WAV', hint: '無損，檔案大，適合精準剪輯' },
    ...(audioOnly ? [] : [{ id: 'mp4' as const, label: '🎬 MP4 影片', hint: 'H.264 / 最高 720p（瀏覽器轉影片很慢，適合短片）' }]),
  ]

  const run = async () => {
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
      <label className="flex min-h-14 cursor-pointer items-center justify-center rounded-xl border border-dashed border-white/25 px-3 text-center text-sm text-white/70 active:bg-white/10">
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
      {files.length > 0 && (
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
        <button type="button" disabled={busy || files.length === 0 || tooBig.length > 0} onClick={() => void run()} className="min-h-12 flex-1 rounded-xl bg-accent text-sm font-semibold text-white disabled:opacity-40" data-convert-run>
          {busy ? '轉檔中…' : `轉檔並${audioOnly ? '匯入' : '加入專案'}`}
        </button>
        {busy && (
          <button
            type="button"
            onClick={() => {
              cancelled.current = true
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
      <p className="text-[11px] leading-relaxed text-white/35">轉檔在你的裝置上進行，檔案不會先上傳。手機轉大檔案或影片會很慢、很耗電，建議保持螢幕開啟。請只轉換你有權使用的檔案。</p>
    </div>
  )
}
