import { useMemo, type ReactNode } from 'react'
import { useStageMonitorAudio } from '../../hooks/useStageMonitorAudio'
import type { useTheatreEngine } from '../../hooks/useTheatreEngine'
import { stageMonitor, useStageMonitor, useVideoOwner } from '../../services/stageMonitor'
import { activeList, cueTargets, type Cue } from '../../types/cue'
import type { ShowRef } from '../../types/project'
import { channelIds, channelLabel } from '../../types/channels'
import { StageDisplay } from '../audience/StageDisplay'
import { DimButton } from '../ui/DimButton'

export type StageFrame = 'phone' | 'screen'

/**
 * The Stage simulation itself, shared by the Stage window and Stage buttons on the control panel:
 * toolbar (LIVE / IDLE / PAUSED, 🔊 / 🔇, 📱 / 🖥, plus the host's own buttons), the simulated
 * audience screen, the "tap to enable sound" prompt and the status line.
 *
 * Sound and the simulated audience code are shared by every viewer on the page (one audio engine).
 */
export function StageViewer({
  engine,
  show,
  cues,
  variant,
  frame,
  onFrameChange,
  title = 'Stage',
  titleColor,
  actions,
  onScreenClick,
  screenLabel,
  collapsed = false,
}: {
  engine: ReturnType<typeof useTheatreEngine>
  show: ShowRef
  cues: Cue[]
  /** "panel": the Stage window. "mini": a control-panel button (compact). */
  variant: 'panel' | 'mini'
  frame: StageFrame
  onFrameChange: (frame: StageFrame) => void
  title?: string
  titleColor?: string
  /** Extra toolbar buttons from the host (fold / hide / open window…). */
  actions?: ReactNode
  /** Clicking the screen (mini: opens / closes the Stage window). */
  onScreenClick?: () => void
  screenLabel?: string
  /** Mini only: toolbar and status line only, no screen. */
  collapsed?: boolean
}) {
  const mini = variant === 'mini'
  const { showState, serverNow } = engine
  const monitor = useStageMonitor()
  const { audience, channel } = monitor
  const groups = channelIds(showState.channels.count)
  const audio = useStageMonitorAudio(engine, show.projectId)
  // The window outranks buttons for the engine's live (audible) video element.
  const ownsVideo = useVideoOwner(mini ? 1 : 2)

  const codes = useMemo(() => [...new Set(cues.flatMap((c) => (c.targetMode === 'all' ? [] : (c.targetIds ?? []))))].sort(), [cues])
  const live = activeList(showState).filter((a) => a.stopAt == null && cueTargets(a.cue, audience, channel || null))
  const sounding = live.filter((a) => a.cue.type === 'AUDIO' || a.cue.type === 'VIDEO')
  const newest = live[live.length - 1]
  const playback = engine.playbackState

  const btn = mini
    ? 'flex h-6 min-w-6 shrink-0 items-center justify-center rounded px-1 text-[11px] whitespace-nowrap text-white/70 hover:bg-white/15 hover:text-white'
    : 'flex h-8 min-w-8 shrink-0 items-center justify-center rounded-md px-1.5 text-xs whitespace-nowrap text-white/60 hover:bg-white/10 hover:text-white'
  const soundState = audio.sound ? (audio.playing ? 'on' : 'blocked') : 'off'

  return (
    <div
      className="flex h-full min-h-0 w-full flex-col"
      // Any click in the viewer counts as the gesture browsers need before audio may play.
      onClickCapture={() => audio.needsTap && audio.unlock()}
      data-stage-viewer={variant}
    >
      <header className={`flex shrink-0 items-center gap-1 border-b border-white/10 ${mini ? 'px-1.5 py-1' : 'py-2 pr-3 pl-4'}`}>
        <span className={`mr-auto flex min-w-0 items-center gap-1.5 truncate font-semibold tracking-wider ${mini ? 'text-[11px]' : 'text-xs text-white/60'}`} style={titleColor ? { color: titleColor } : undefined}>
          🎭 <span className="truncate">{title}</span>
          <span
            className={`shrink-0 rounded px-1.5 py-px text-[9px] font-bold tracking-widest ${playback === 'playing' ? 'bg-go/20 text-go' : playback === 'paused' ? 'bg-standby text-black' : 'bg-white/10 text-white/40'}`}
            data-stage-live={playback}
          >
            {{ idle: 'IDLE', playing: 'LIVE', paused: 'PAUSED' }[playback]}
          </span>
        </span>
        <button
          type="button"
          onClick={() => {
            if (!audio.sound) audio.unlock()
            stageMonitor.setSound(!audio.sound)
          }}
          className={`${btn} ${audio.sound ? (audio.playing ? 'text-go' : 'text-standby') : ''}`}
          title={audio.sound ? (audio.playing ? '聲音開啟（透過這台電腦播放）· 點一下靜音' : '聲音被瀏覽器擋住 · 點一下啟用') : '聲音關閉 · 點一下開啟'}
          aria-label={audio.sound ? '靜音 Stage' : '開啟 Stage 聲音'}
          aria-pressed={audio.sound}
          data-stage-sound={soundState}
        >
          {audio.sound ? '🔊' : '🔇'}
        </button>
        {/* Headphone DIM: this operator's monitoring only (never the audience). */}
        <DimButton
          area="monitor"
          active={monitor.dim}
          db={monitor.dimDb}
          onToggle={() => stageMonitor.setDim(!monitor.dim)}
          onDbChange={(v) => stageMonitor.setDimDb(v)}
          scope="耳機監聽：只影響這台電腦的 Stage 聲音，不影響觀眾"
          className={`${btn} font-bold`}
          activeClassName="!bg-standby !text-black"
          inactiveClassName=""
        />
        <button
          type="button"
          onClick={() => onFrameChange(frame === 'phone' ? 'screen' : 'phone')}
          className={btn}
          title={frame === 'phone' ? '改為投影畫面 16:9' : '改為觀眾手機 9:16'}
          aria-label={frame === 'phone' ? '切換為投影 16:9' : '切換為手機 9:16'}
          data-stage-frame={frame}
        >
          {frame === 'phone' ? (mini ? '📱' : '📱 手機') : mini ? '🖥' : '🖥 投影'}
        </button>
        {actions}
      </header>

      {!mini && groups.length > 0 && (
        <label className="flex items-center gap-2 border-b border-line px-4 py-1.5 text-[11px] text-white/45">
          模擬組別
          <select value={channel} onChange={(e) => stageMonitor.setChannel(e.target.value)} className="min-h-7 flex-1 rounded-md border border-white/10 bg-black/40 px-2 text-xs text-white" data-stage-channel>
            <option value="">全部組別（所有 Cue）</option>
            {groups.map((g) => (
              <option key={g} value={g}>
                {channelLabel(g)}（只播給此組的 Cue）
              </option>
            ))}
          </select>
        </label>
      )}

      {!mini && codes.length > 0 && (
        <label className="flex items-center gap-2 border-b border-line px-4 py-1.5 text-[11px] text-white/45">
          模擬
          <select value={audience} onChange={(e) => stageMonitor.setAudience(e.target.value)} className="min-h-7 flex-1 rounded-md border border-white/10 bg-black/40 px-2 text-xs text-white" data-stage-audience>
            <option value="">全體觀眾（只看廣播 Cue）</option>
            {codes.map((c) => (
              <option key={c} value={c}>
                觀眾 {c}
              </option>
            ))}
          </select>
        </label>
      )}

      {!collapsed && (
        // The simulated device. Container units let text scale with the frame.
        <div className={`flex min-h-0 flex-1 items-center justify-center ${mini ? 'p-1.5' : 'p-4'}`}>
          <div
            onClick={onScreenClick}
            role={onScreenClick ? 'button' : undefined}
            aria-label={onScreenClick ? screenLabel : undefined}
            className={`@container relative overflow-hidden bg-black text-white shadow-[0_0_0_1px_rgba(255,255,255,0.12),0_20px_60px_-20px_rgba(0,0,0,0.9)] ${
              frame === 'phone' ? `aspect-[9/16] h-full max-h-full max-w-full ${mini ? 'rounded-[10px]' : 'rounded-[22px]'}` : 'aspect-video max-h-full w-full rounded-md'
            } ${showState.dim ? 'brightness-50' : ''} ${onScreenClick ? 'cursor-pointer' : ''}`}
            data-stage-screen
          >
            <StageDisplay showState={showState} serverNow={serverNow} audienceId={audience} audienceChannel={channel || null} show={show} preview previewSound={ownsVideo && audio.playing} />
            {audio.needsTap && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  audio.unlock()
                }}
                className={`absolute z-10 rounded-full bg-white/90 font-semibold text-black shadow-lg ${mini ? 'inset-x-1.5 bottom-1.5 px-2 py-1 text-[10px]' : 'inset-x-3 bottom-3 px-3 py-2 text-xs'}`}
                data-stage-unlock
              >
                🔈 {mini ? '啟用聲音' : '點一下啟用聲音'}
              </button>
            )}
            {frame === 'phone' && <span className={`pointer-events-none absolute left-1/2 h-1 -translate-x-1/2 rounded-full bg-white/15 ${mini ? 'top-1 w-5' : 'top-1.5 w-10'}`} />}
          </div>
        </div>
      )}

      {mini ? (
        <footer className="flex shrink-0 items-center gap-1.5 truncate border-t border-white/10 px-2 py-0.5 text-[10px] text-white/50" data-stage-status>
          {newest ? (
            <span className="truncate text-white/75">
              {newest.cue.type === 'AUDIO' ? '♪' : newest.cue.type === 'VIDEO' ? '▶' : '●'} Q{newest.cue.cueNumber} {newest.cue.title}
            </span>
          ) : (
            <span>待機中</span>
          )}
          <span className="ml-auto shrink-0">{showState.muted ? 'MUTE' : `${Math.round(showState.masterVolume)}%`}</span>
        </footer>
      ) : (
        <footer className="space-y-1 border-t border-line px-4 py-2 text-[11px]" data-stage-status>
          <div className="flex items-center gap-2 text-white/50">
            <span>🔊 {showState.muted ? 'MUTE' : `${Math.round(showState.masterVolume)}%`}</span>
            {showState.dim && <span className="rounded bg-standby/20 px-1 text-standby">DIM</span>}
            <span className="ml-auto">{live.length} 個 Cue 執行中</span>
          </div>
          {sounding.length > 0 ? (
            <ul className="space-y-0.5">
              {sounding.slice(-3).map((a) => (
                <li key={a.instanceId} className="truncate text-white/70">
                  {a.cue.type === 'VIDEO' ? '▶' : '♪'} Q{a.cue.cueNumber} {a.cue.title}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-white/30">{audio.sound ? '目前沒有聲音' : '🔇 聲音已關閉（只看畫面）'}</p>
          )}
        </footer>
      )}
    </div>
  )
}
