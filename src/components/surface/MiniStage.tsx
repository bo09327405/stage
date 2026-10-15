import { useEffect, useState } from 'react'
import type { useTheatreEngine } from '../../hooks/useTheatreEngine'
import { emitPanel } from '../../services/panelBus'
import type { Cue } from '../../types/cue'
import type { ShowRef } from '../../types/project'
import type { SurfaceWidget } from '../../types/surface'
import { StageViewer, type StageFrame } from '../stage/StageViewer'

const readPref = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
const writePref = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Not remembered; harmless.
  }
}

/**
 * A surface button set to "Stage" display: the same Stage simulation as the Stage window — LIVE
 * status, 🔊 / 🔇 (shared with the window), 📱 / 🖥 — with sound in step with the cues. ⤢ (or a tap
 * on the picture) opens / closes the big Stage window; ▾ folds the block to its toolbar.
 * In edit mode (`preview`) the block only previews, so it can be dragged.
 */
export function MiniStage({
  widget,
  engine,
  show,
  cues,
  stageOpen,
  preview = false,
}: {
  widget: SurfaceWidget
  engine: ReturnType<typeof useTheatreEngine>
  show: ShowRef
  cues: Cue[]
  /** Whether the Stage window is showing (null when this page has none to show). */
  stageOpen: boolean | null
  preview?: boolean
}) {
  const key = `theatre.miniStage.${widget.id}`
  const [frame, setFrame] = useState<StageFrame>(() => (readPref(`${key}.frame`) === 'phone' ? 'phone' : 'screen'))
  const [folded, setFolded] = useState(() => readPref(`${key}.folded`) === '1')
  useEffect(() => {
    writePref(`${key}.frame`, frame)
    writePref(`${key}.folded`, folded ? '1' : '0')
  }, [key, frame, folded])

  const btn = 'flex h-6 min-w-6 shrink-0 items-center justify-center rounded px-1 text-[11px] whitespace-nowrap text-white/70 hover:bg-white/15 hover:text-white'
  const toggleWindow = () => !preview && emitPanel('stage', 'toggle')

  return (
    <div className="h-full w-full overflow-hidden rounded-[inherit] bg-black text-white" data-mini-stage={widget.id} data-folded={folded ? '1' : '0'}>
      <StageViewer
        engine={engine}
        show={show}
        cues={cues}
        variant="mini"
        frame={frame}
        onFrameChange={setFrame}
        title={widget.label}
        titleColor={widget.color}
        collapsed={folded}
        onScreenClick={toggleWindow}
        screenLabel={`${stageOpen ? '收合' : '開啟'} Stage 模擬畫面視窗`}
        actions={
          <>
            <button
              type="button"
              onClick={toggleWindow}
              className={`${btn} ${stageOpen ? 'bg-white/15 text-white' : ''}`}
              aria-pressed={stageOpen ?? undefined}
              aria-label={`${stageOpen ? '收合' : '開啟'} Stage 視窗`}
              title={stageOpen ? '收合 Stage 視窗' : '開啟大的 Stage 視窗'}
              data-mini-stage-window
            >
              ⤢
            </button>
            <button
              type="button"
              onClick={() => setFolded(!folded)}
              className={btn}
              aria-expanded={!folded}
              aria-label={folded ? '展開預覽' : '收合預覽'}
              title={folded ? '展開預覽畫面' : '收合成工具列'}
              data-mini-stage-fold
            >
              {folded ? '▸' : '▾'}
            </button>
          </>
        }
      />
    </div>
  )
}
