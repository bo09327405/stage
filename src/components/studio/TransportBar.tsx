import type { ReactNode } from 'react'
import { timecode } from '../../studio/format'

/** Play / pause / stop / record, the timecode, and the arrange-view toggles. */
export function TransportBar({
  playing,
  loading,
  recording,
  position,
  length,
  level,
  stereo,
  automationMode,
  snap,
  onPlay,
  onStop,
  onRewind,
  onRecord,
  onStereo,
  onAutomation,
  onSnap,
  inputOpen,
  onInput,
  master,
}: {
  playing: boolean
  loading: boolean
  recording: { elapsed: number; level: number; channels: number } | null
  position: number
  length: number
  level: number
  stereo: boolean
  automationMode: boolean
  snap: boolean
  onPlay: () => void
  onStop: () => void
  onRewind: () => void
  onRecord: () => void
  onStereo: () => void
  onAutomation: () => void
  onSnap: () => void
  inputOpen: boolean
  onInput: () => void
  /** The master section (fader, meters, MUTE / DIM). */
  master?: ReactNode
}) {
  const btn = 'flex h-10 w-10 items-center justify-center rounded-lg text-lg transition'
  const meter = Math.min(1, recording ? recording.level : level)
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line bg-[#141414] px-3 py-2" data-transport>
      <button type="button" onClick={onRewind} className={`${btn} bg-white/[0.06] text-white/70 hover:bg-white/12`} aria-label="回到開頭" title="回到開頭（Home）">
        ⏮
      </button>
      <button
        type="button"
        onClick={onPlay}
        className={`${btn} ${playing ? 'bg-go text-black' : 'bg-white/[0.08] text-white hover:bg-white/15'}`}
        aria-label={playing ? '暫停' : '播放'}
        title="播放 / 暫停（Space）"
        data-play
      >
        {loading ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-black/20 border-t-current" /> : playing ? '❚❚' : '▶'}
      </button>
      <button type="button" onClick={onStop} className={`${btn} bg-white/[0.06] text-white/70 hover:bg-white/12`} aria-label="停止" title="停止">
        ■
      </button>
      <button
        type="button"
        onClick={onRecord}
        className={`${btn} ${recording ? 'animate-pulse bg-panic text-white' : 'bg-white/[0.06] text-panic hover:bg-panic/20'}`}
        aria-label={recording ? '停止錄音' : '錄音'}
        title="錄音（R）：錄到「●」預備的音軌"
        data-record
      >
        ●
      </button>
      <button
        type="button"
        onClick={onStereo}
        disabled={!!recording}
        className={`h-10 rounded-lg px-2.5 text-[11px] font-semibold ${stereo ? 'bg-white/12 text-white' : 'bg-white/[0.05] text-white/50'}`}
        title="錄音聲道：立體聲需要支援兩聲道的音訊介面；內建麥克風會複製成左右聲道"
        data-stereo={stereo ? '1' : '0'}
      >
        {stereo ? '立體聲' : '單聲道'}
      </button>

      <div className="ml-1 flex items-baseline gap-2 rounded-lg bg-black/60 px-3 py-1.5 font-mono tabular">
        <span className={`text-xl font-semibold ${recording ? 'text-panic' : 'text-white'}`} data-timecode>
          {timecode(position)}
        </span>
        <span className="text-xs text-white/35">/ {timecode(length, false)}</span>
      </div>
      {recording ? (
        <div className="flex h-10 w-2 flex-col justify-end overflow-hidden rounded-full bg-white/10" title="輸入電平" data-meter>
          <div className="w-full rounded-full transition-[height] duration-75" style={{ height: `${meter * 100}%`, background: meter > 0.95 ? '#ff453a' : meter > 0.7 ? '#ffd60a' : '#30d158' }} />
        </div>
      ) : null}
      {master}
      {recording && (
        <span className="text-xs text-panic">
          錄音中 {timecode(recording.elapsed, false)} · {recording.channels === 2 ? '立體聲' : '單聲道輸入'}
        </span>
      )}

      <div className="ml-auto flex items-center gap-1.5">
        <button
          type="button"
          onClick={onInput}
          aria-pressed={inputOpen}
          className={`h-9 rounded-lg px-3 text-xs font-semibold ${inputOpen ? 'bg-panic/80 text-white' : 'bg-white/[0.06] text-white/70 hover:bg-white/12'}`}
          title="麥克風與輸入設定：裝置、電平、校準、監聽、預設集、降噪、修音"
          data-input-toggle
        >
          🎙 輸入
        </button>
        <button
          type="button"
          onClick={onAutomation}
          aria-pressed={automationMode}
          className={`h-9 rounded-lg px-3 text-xs font-semibold ${automationMode ? 'bg-standby text-black' : 'bg-white/[0.06] text-white/70 hover:bg-white/12'}`}
          title="音量自動化：點片段新增節點、拖曳節點、雙擊刪除（A）"
          data-automation-toggle
        >
          〰 自動化
        </button>
        <button
          type="button"
          onClick={onSnap}
          aria-pressed={snap}
          className={`h-9 rounded-lg px-3 text-xs ${snap ? 'bg-white/12 text-white' : 'bg-white/[0.05] text-white/45'}`}
          title="吸附：對齊格線、播放頭與其他片段邊緣"
        >
          ⌗ 吸附
        </button>
      </div>
    </div>
  )
}
