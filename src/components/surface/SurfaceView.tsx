import { consoleUrl, returnToSetCue } from '../../services/navigation'
import { AnimatePresence } from 'motion/react'
import { useEffect, useState } from 'react'
import { useCueList } from '../../hooks/useCueList'
import { useHits } from '../../hooks/useHits'
import { useIntercom } from '../../hooks/useIntercom'
import { useTheatreEngine } from '../../hooks/useTheatreEngine'
import { useTriggerRouter } from '../../hooks/useTriggerRouter'
import { useHistoryShortcuts } from '../../services/history'
import { versionPath, type ShowRef } from '../../types/project'
import { HistoryControls } from '../ui/HistoryControls'
import { FullscreenButton } from '../ui/FullscreenButton'
import { CurrentUserChip } from '../hub/Hub'
import { CallFlash, IntercomButton, IntercomPanel } from '../intercom/IntercomPanel'
import { AudienceTalkGate } from '../intercom/AudienceTalkGate'
import { IntercomContext } from '../intercom/intercomContext'
import { ActivityDot } from '../triggers/ActivityDot'
import { GlobalTriggersPanel } from '../triggers/GlobalTriggersPanel'
import { SurfaceWorkspace } from './SurfaceWorkspace'

interface SurfaceViewProps {
  show: ShowRef
  projectName: string
  versionName: string
  initialSurfaceId: string | null
  onSurfaceChange: (surfaceId: string | null) => void
  onBack: () => void
}

/** Standalone full-screen control surface page (/surface): owns its engine, triggers and intercom. */
export function SurfaceView({ show, projectName, versionName, initialSurfaceId, onSurfaceChange, onBack }: SurfaceViewProps) {
  const basePath = versionPath(show)
  const { cues } = useCueList(basePath)
  const { hits } = useHits(basePath)
  const engine = useTheatreEngine('console', { basePath, cues })
  const router = useTriggerRouter({ show, basePath, label: `控制面板 · ${projectName}`, engine, cues, hits })
  const intercom = useIntercom(show.projectId, engine.showState.channels.count, basePath)
  const [intercomOpen, setIntercomOpen] = useState(false)
  const [triggersOpen, setTriggersOpen] = useState(false)
  const [backNote, setBackNote] = useState(false)
  const backToSetCue = () => {
    // Bring the console tab forward (or load it here when there's none).
    if (returnToSetCue(show) === 'focused') setBackNote(true)
  }
  useEffect(() => {
    if (!backNote) return
    const t = setTimeout(() => setBackNote(false), 6000)
    return () => clearTimeout(t)
  }, [backNote])
  useHistoryShortcuts(show.projectId)

  return (
    <IntercomContext.Provider value={intercom}>
      <SurfaceWorkspace
        show={show}
        engine={engine}
        cues={cues}
        hits={hits}
        router={router}
        variant="page"
        initialSurfaceId={initialSurfaceId}
        onSurfaceChange={onSurfaceChange}
        headerStart={
          <>
            <button
              onClick={backToSetCue}
              className="flex min-h-10 items-center gap-1.5 rounded-lg bg-accent px-3 text-sm font-semibold text-white shadow-[0_0_20px_-8px_#0a84ff] hover:brightness-110"
              title="回到這個專案的 Set Cue 主畫面（Cue 清單、劇本編輯）"
              data-back-to-setcue
            >
              🔙 <span className="hidden sm:inline">返回 Set Cue</span>
              <span className="sm:hidden">Set Cue</span>
            </button>
            <button
              type="button"
              onClick={backToSetCue}
              className="min-w-0 rounded-lg px-1.5 py-0.5 text-left hover:bg-white/10"
              title="回到 Set Cue 主畫面"
              data-project-link
            >
              <div className="truncate text-sm font-semibold underline-offset-2 hover:underline">{projectName}</div>
              <div className="truncate font-mono text-[11px] text-white/40">{versionName}</div>
            </button>
            <button
              onClick={onBack}
              className="flex min-h-10 items-center rounded-lg px-2 text-xs text-white/45 hover:bg-white/10 hover:text-white"
              title="回到大廳（所有專案）"
              data-back-to-hub
            >
              大廳
            </button>
          </>
        }
        headerEnd={
          <>
            <CurrentUserChip />
            <HistoryControls compact />
            <FullscreenButton />
            <IntercomButton intercom={intercom} onClick={() => setIntercomOpen(!intercomOpen)} />
            <button
              onClick={() => setTriggersOpen(true)}
              className="flex min-h-10 items-center gap-1.5 rounded-lg bg-white/[0.06] px-3 text-xs text-white/70 hover:bg-white/10"
              title={router.isHost ? '此分頁負責執行外部觸發' : `外部觸發由「${router.host?.label ?? '—'}」執行`}
            >
              ⚡ Triggers <ActivityDot connected={router.isHost} />
            </button>
          </>
        }
      />
      <AnimatePresence>{intercomOpen && <IntercomPanel intercom={intercom} onClose={() => setIntercomOpen(false)} />}</AnimatePresence>
      <CallFlash intercom={intercom} />
      <AudienceTalkGate intercom={intercom} />
      {backNote && (
        <div className="fixed top-16 left-3 z-[95] flex items-center gap-3 rounded-xl border border-white/15 bg-black/85 px-4 py-2.5 text-xs text-white shadow-2xl backdrop-blur" role="status" data-back-note>
          已切換到 Set Cue 分頁
          <a href={consoleUrl(show)} className="rounded-lg bg-white/10 px-2.5 py-1 font-semibold hover:bg-white/20" data-back-here>
            沒有切換？在此分頁開啟
          </a>
        </div>
      )}
      <AnimatePresence>
        {triggersOpen && <GlobalTriggersPanel projectId={show.projectId} router={router} onClose={() => setTriggersOpen(false)} />}
      </AnimatePresence>
    </IntercomContext.Provider>
  )
}
