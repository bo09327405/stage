import { DEFAULT_DIM_DB, clampDimDb, dimGain, useDimDb } from '../../utils/dim'
import { useGoButtonLayout } from '../../hooks/useMedia'
import { MobileGoBar } from './MobileGoBar'
import { MobileSideRail } from './MobileSideRail'
import { instanceTiming } from '../../utils/cueTiming'
import { StudioMenu } from './StudioMenu'
import { useHeaderCollapse } from '../../utils/headerCollapse'
import { listenForFocusRequests } from '../../services/navigation'
import { useProjectLock } from '../../services/projectLock'
import { isAdmin, useAuth } from '../../services/auth'
import { CHANNEL_ALL, channelIds, reachesChannel } from '../../types/channels'
import { cuesForChannel, useChannelView } from '../../hooks/useChannelView'
import { AnnouncePanel } from './AnnouncePanel'
import { ChannelChips } from './ChannelChips'
import { ChannelOverview } from './ChannelOverview'
import { ChannelSettings } from './ChannelSettings'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useMemo, useState } from 'react'
import { useCueList } from '../../hooks/useCueList'
import { useHits } from '../../hooks/useHits'
import { useServerNow } from '../../hooks/useServerNow'
import { useTheatreEngine } from '../../hooks/useTheatreEngine'
import { usePresence } from '../../services/presence'
import { recheckModeration, setUploadHidden, setUploadModeration, useProjectUploads } from '../../services/uploads'
import { cueFromUpload } from '../../utils/uploadCue'
import { saveAsNewVersion, setLivePointer, touchProject, useLivePointer } from '../../services/projects'
import { DEFAULT_CUE, activeList, instanceClock, showClock, type ActiveCue, type AudienceUpload, type Cue } from '../../types/cue'
import { versionPath, type ShowRef } from '../../types/project'
import { PromptDialog } from '../ui/PromptDialog'
import { CueEditor } from './CueEditor'
import { useHistoryShortcuts } from '../../services/history'
import { HistoryControls } from '../ui/HistoryControls'
import { CueBulkBar } from './CueBulkBar'
import { CueList } from './CueList'
import { HitsPanel } from './HitsPanel'
import { TransportPanel } from './TransportPanel'
import { useTriggerRouter } from '../../hooks/useTriggerRouter'
import { HITS_PER_PAGE, type ShowAction } from '../../types/actions'
import { executeShowAction } from '../../utils/showActions'
import { useIntercom } from '../../hooks/useIntercom'
import { useAudienceStudios } from '../../hooks/useAudienceStudios'
import { CallFlash, IntercomButton, IntercomPanel } from '../intercom/IntercomPanel'
import { AudienceTalkGate } from '../intercom/AudienceTalkGate'
import { IntercomContext } from '../intercom/intercomContext'
import { ActivityDot } from '../triggers/ActivityDot'
import { GlobalTriggersPanel } from '../triggers/GlobalTriggersPanel'
import { SurfaceWorkspace } from '../surface/SurfaceWorkspace'
import { ControlSidebar } from './ControlSidebar'
import { MediaPool } from './MediaPool'
import { SetCueProjectDialog } from './SetCueProjectDialog'
import { NotesPanel } from '../notes/NotesPanel'
import { StagePanel } from '../stage/StagePanel'
import { useScript } from '../../services/script'
import { applyPanelMode, usePanelCommands } from '../../services/panelBus'
import { AutoSaveBadge } from '../ui/AutoSaveBadge'
import { FullscreenButton } from '../ui/FullscreenButton'
import { CurrentUserChip } from '../hub/Hub'
import { escapeLeavesFullscreen } from '../../hooks/useFullscreen'
import { useR2AutoSave } from '../../hooks/useR2AutoSave'
import { useRtdbSignature } from '../../hooks/useRtdbSignature'
import { setCueProjectKey } from '../../services/storage'
import { buildSetCueFile } from '../../services/projectTransfer'
import { summarizeSetCue } from '../../services/versionHistory'
import { applySetCueVersion } from '../../services/versionApply'
import { VersionHistoryDialog } from '../ui/VersionHistoryDialog'
import { SetCueVersionPreview } from '../ui/VersionPreviews'

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

type EditorState = { mode: 'edit'; cueId: string } | { mode: 'create' } | null

const ignore = () => {}

interface ConsoleViewProps {
  show: ShowRef
  projectName: string
  versionName: string
  onBack: () => void
  onOpenVersion: (show: ShowRef) => void
}

export function ConsoleView({ show, projectName, versionName, onBack, onOpenVersion }: ConsoleViewProps) {
  const basePath = versionPath(show)
  const { cues, loaded, error: cueListError, addCue, saveCue, removeCue, updateCues, removeCues, setCueNumbers } = useCueList(basePath)
  useAudienceStudios(show.projectId, cues)
  // The whole top bar (nav, undo / redo, save state, Studio, Intercom, project, status line) can fold
  // away to give the cue list the full height; remembered per device. Folded, it takes no space.
  const bar = useHeaderCollapse(false, 'isConsoleBarCollapsed')
  // In control mode the control panel's toolbar (surface picker, Panel / Executor, grid, Monitor, Notes,
  // Stage, OSC / MIDI, edit) is merged into this bar, filling its free space: one bar, one fold button.
  const [surfaceSlot, setSurfaceSlot] = useState<HTMLElement | null>(null)
  const { collapsed: barFolded, peek: barPeek, startPeek: peekBar } = bar
  useEffect(() => {
    if (!barFolded || barPeek) return
    // A mouse at the very top edge brings it back for a moment (a listener, not an overlay on the cue list).
    const onMove = (e: PointerEvent) => e.pointerType === 'mouse' && e.clientY <= 2 && peekBar()
    window.addEventListener('pointermove', onMove, { passive: true })
    return () => window.removeEventListener('pointermove', onMove)
  }, [barFolded, barPeek, peekBar])
  // Pop-outs of this project (control panel) can ask this tab to come forward.
  useEffect(() => listenForFocusRequests(show), [show])
  // Multi-selection in the cue list (bulk edit / delete / renumber).
  const [checked, setChecked] = useState<Set<string>>(() => new Set())
  const { hits, addHit, updateHit, removeHit } = useHits(basePath)
  const engine = useTheatreEngine('console', { basePath, cues })
  const { showState, connected, error, serverNow } = engine
  const presence = usePresence(basePath)
  const live = useLivePointer()
  const [editor, setEditor] = useState<EditorState>(null)
  // Phone / portrait iPad: Go Button layout (GO bar on top, DIM + Master rail, editor as a full-screen sheet).
  const compact = useGoButtonLayout()
  const [mobileSheet, setMobileSheet] = useState(false)
  const [channelSettingsOpen, setChannelSettingsOpen] = useState(false)
  const [announceOpen, setAnnounceOpen] = useState(false)
  const [selectMode, setSelectMode] = useState(false)
  const [savingAs, setSavingAs] = useState(false)
  const [triggersOpen, setTriggersOpen] = useState(false)
  // Full control mode (surface fills the page) and the collapsible editor column.
  const [controlMode, setControlMode] = useState(() => readPref('theatre.consoleControlMode') === '1')
  const [inspectorOpen, setInspectorOpen] = useState(() => readPref('theatre.consoleInspectorOpen') !== '0')

  // Set Cue side drawers: Note (the version's script / notes, same as the control panel's) and
  // Stage (simulated audience picture). Each is shown or hidden, and open or folded to a tab.
  const script = useScript(versionPath(show))
  const [notesShown, setNotesShown] = useState(() => readPref('theatre.notesView.setcue.shown') === '1')
  const [notesCollapsed, setNotesCollapsed] = useState(() => readPref('theatre.notesView.setcue.collapsed') === '1')
  const [stageShown, setStageShown] = useState(() => readPref('theatre.stageView.setcue.shown') === '1')
  const [stageCollapsed, setStageCollapsed] = useState(() => readPref('theatre.stageView.setcue.collapsed') === '1')
  useEffect(() => {
    writePref('theatre.notesView.setcue.shown', notesShown ? '1' : '0')
    writePref('theatre.notesView.setcue.collapsed', notesCollapsed ? '1' : '0')
    writePref('theatre.stageView.setcue.shown', stageShown ? '1' : '0')
    writePref('theatre.stageView.setcue.collapsed', stageCollapsed ? '1' : '0')
  }, [notesShown, notesCollapsed, stageShown, stageCollapsed])
  const toggleControlMode = () => {
    setControlMode(!controlMode)
    writePref('theatre.consoleControlMode', controlMode ? '0' : '1')
  }
  const setInspector = (open: boolean) => {
    setInspectorOpen(open)
    writePref('theatre.consoleInspectorOpen', open ? '1' : '0')
  }
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    try {
      return localStorage.getItem('theatre.controlSidebarOpen') === '1'
    } catch {
      return false
    }
  })
  const toggleSidebar = () => {
    const next = !sidebarOpen
    setSidebarOpen(next)
    try {
      localStorage.setItem('theatre.controlSidebarOpen', next ? '1' : '0')
    } catch {
      // Not remembered; harmless.
    }
  }
  const intercom = useIntercom(show.projectId, showState.channels.count, versionPath(show))
  const [consoleDimDb, setConsoleDimDb] = useDimDb('console')
  // Auto-save the show (cue lists, hits, script, surfaces, triggers, media) to R2 after each pause in
  // editing: theatre/setcue-projects/{pid}.json. Playback state isn't watched, so running the show
  // doesn't trigger saves.
  const pid = show.projectId
  const user = useAuth().user
  const admin = isAdmin(user)
  const lock = useProjectLock(pid, user)
  const autoSave = useR2AutoSave(
    // Read-only viewers (official template, locked) never save over the project's file.
    lock.readOnly ? null : setCueProjectKey(pid),
    useRtdbSignature([
      `projectIndex/${pid}/name`,
      `projectIndex/${pid}/versions`,
      `${versionPath(show)}/cueList`,
      `${versionPath(show)}/hits`,
      `${versionPath(show)}/script`,
      `projects/${pid}/surfaces`,
      `projects/${pid}/triggers`,
      `projects/${pid}/media`,
    ]),
    async () => JSON.stringify(await buildSetCueFile(pid)),
    summarizeSetCue,
  )
  const [historyOpen, setHistoryOpen] = useState(false)
  const [projectOpen, setProjectOpen] = useState(false)
  const [intercomOpen, setIntercomOpen] = useState(false)
  const router = useTriggerRouter({ show, basePath, label: `控台 · ${versionName}`, engine, cues, hits })
  const { uploads } = useProjectUploads(show.projectId)
  const [rightTab, setRightTab] = useState<'editor' | 'inbox'>('inbox')
  // Count of uploads already seen in the inbox, for the "+n new" badge.
  const [seenCount, setSeenCount] = useState<number | null>(null)
  const inboxCount = uploads?.length ?? 0
  const unseen = rightTab === 'inbox' || seenCount == null ? 0 : Math.max(0, inboxCount - seenCount)
  if (uploads && seenCount == null) setSeenCount(uploads.length)

  // Window commands from control-panel buttons. In full control mode the control panel owns its
  // own windows; with the console sidebar open, its Notes belong to the sidebar.
  usePanelCommands(
    sidebarOpen ? ['stage'] : ['stage', 'notes'],
    (target, mode) => {
      if (target === 'stage') {
        setStageShown(applyPanelMode(stageShown && !stageCollapsed, mode))
        setStageCollapsed(false)
      } else {
        setNotesShown(applyPanelMode(notesShown && !notesCollapsed, mode))
        setNotesCollapsed(false)
      }
    },
    !controlMode,
  )

  const switchRightTab = (tab: 'editor' | 'inbox') => {
    setSeenCount(inboxCount)
    setRightTab(tab)
  }
  const openEditor = (state: EditorState) => {
    setEditor(state)
    if (state) {
      switchRightTab('editor')
      setMobileSheet(true)
      // Picking a cue to edit brings the collapsed editor back.
      setInspector(true)
    }
  }

  const isLive = live?.projectId === show.projectId && live?.versionId === show.versionId
  const onlineAudience = presence.map((p) => p.audienceId)

  const instances = useMemo(() => activeList(showState), [showState])
  const { playbackState } = engine
  const paused = playbackState === 'paused'
  // Show clock: frozen at pausedAt while paused, so progress bars and countdowns hold still.
  const liveNow = useServerNow(serverNow, !paused && (instances.length > 0 || showState.goLockedUntil > 0))
  const now = showClock(showState, liveNow)

  // Latest instance per cue, for row progress bars.
  // Audience channel groups: which one the console is focused on (ALL = overview of every group).
  const channelCount = showState.channels.count
  const [channelView, chooseChannel] = useChannelView(channelCount)
  const visibleCues = useMemo(() => cuesForChannel(cues, channelView, channelCount), [cues, channelCount, channelView])
  const runningPerChannel = useMemo(() => {
    const out: Record<string, number> = {}
    for (const inst of instances) {
      if (inst.stopAt != null) continue
      for (const id of channelIds(channelCount)) if (reachesChannel(inst.cue.targetChannels, id)) out[id] = (out[id] ?? 0) + 1
    }
    return out
  }, [instances, channelCount])
  const onlinePerChannel = useMemo(() => {
    const out: Record<string, number> = {}
    for (const p of presence) if (p.channel) out[p.channel] = (out[p.channel] ?? 0) + 1
    return out
  }, [presence])
  const running = useMemo(() => {
    const map = new Map<string, ActiveCue>()
    for (const inst of instances) map.set(inst.cue.id, inst)
    return map
  }, [instances])

  const standbyCue = showState.standbyCue
  const lockRemaining = Math.max(0, (showState.goLockedUntil - now) / 1000)
  const lastLockingCue = instances.findLast((i) => i.cue.preventGoDuration > 0)?.cue
  const editingCue = editor?.mode === 'edit' ? (cues.find((c) => c.id === editor.cueId) ?? null) : null
  const latestInteractive = instances.findLast((i) => i.cue.type === 'INTERACTIVE_UPLOAD')?.cue ?? null
  const nextCueNumber = cues.length > 0 ? Math.floor(cues[cues.length - 1].cueNumber) + 1 : 1

  // Quick Create: append a cue built from an inbox file to the end of the list.
  const handleQuickCreate = async (upload: AudienceUpload) => {
    const cue = await addCue(cueFromUpload(upload, nextCueNumber))
    touchProject(show.projectId).catch(ignore)
    return cue
  }

  // Same state machine as the surface GO: with nothing selected, GO selects the first cue.
  const handleGo = () => {
    engine.go().catch(ignore)
  }

  const moveStandby = (delta: number) => {
    if (cues.length === 0) return
    const index = cues.findIndex((c) => c.id === standbyCue?.id)
    const next = index < 0 ? 0 : Math.min(cues.length - 1, Math.max(0, index + delta))
    engine.standby(cues[next]).catch(ignore)
  }

  // ⌘/Ctrl+Z undo · ⌘⇧Z / Ctrl+Y redo (edits only, never show playback)
  useHistoryShortcuts(show.projectId)

  // Space = GO · ↑↓ = move standby · Esc = Stop All · D = DIM · M = Mute · 1–8 = hits on the current page
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      // Never steal keys from an IME composition (Zhuyin space / number selection) or a text field.
      if (e.isComposing || e.keyCode === 229) return
      if ((e.target as HTMLElement).closest?.('input, textarea, select, [contenteditable]')) return
      if (e.code === 'Space') {
        e.preventDefault()
        if (!e.repeat) (paused ? engine.resume() : Promise.resolve(handleGo())).catch(ignore)
      } else if (e.key === 'p' || e.key === 'P') {
        ;(paused ? engine.resume() : engine.pause()).catch(ignore)
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        moveStandby(e.key === 'ArrowDown' ? 1 : -1)
      } else if (e.key === 'Escape') {
        // Esc that leaves full screen must not also fade out the whole show.
        if (escapeLeavesFullscreen()) return
        engine.stopAll().catch(ignore)
      } else if (e.key === 'd' || e.key === 'D') {
        engine.setDim(!showState.dim).catch(ignore)
      } else if (/^[1-9]$/.test(e.key)) {
        // 1–8 play the hits on the current page (Play Hit 1–8).
        if (Number(e.key) <= HITS_PER_PAGE) executeShowAction(`hitPlay${Number(e.key)}` as ShowAction, { engine, cues, hits })
      } else if (e.key === 'm' || e.key === 'M') {
        engine.setMuted(!showState.muted).catch(ignore)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // Header folded: the Go bar is the topmost thing, so it must clear the notch / Dynamic Island itself.
  const barInset = bar.collapsed ? 'env(safe-area-inset-top, 0px)' : '0px'
  const clock = new Date(now).toLocaleTimeString('zh-TW', { hour12: false })

  return (
    <IntercomContext.Provider value={intercom}>
      <div className="relative flex h-dvh flex-col bg-ink text-white" data-console data-console-bar={bar.collapsed ? (bar.peek ? 'peek' : 'hidden') : 'shown'}>
        {/* Folded: only a small tab at the top edge brings the bar back */}
        {bar.collapsed && !bar.peek && (
          <button
            type="button"
            onClick={() => bar.setCollapsed(false)}
            className="absolute top-[calc(env(safe-area-inset-top,0px)+0.25rem)] right-[max(0.75rem,env(safe-area-inset-right,0px))] z-[61] flex h-6 items-center gap-1 rounded-b-xl border border-t-0 border-line pointer-coarse:rounded-xl pointer-coarse:border-t bg-panel/95 px-3 text-[11px] whitespace-nowrap text-white/55 opacity-70 shadow-lg backdrop-blur-xl transition hover:text-white hover:opacity-100 pointer-coarse:h-9 pointer-coarse:px-5 pointer-coarse:text-xs"
            aria-label="展開頂端列"
            aria-expanded="false"
            data-header-toggle="folded"
          >
            ⌄ 選單
          </button>
        )}
        {/* Top bar */}
        {/* z-40: dropdowns opened from the header (history log) must float over the panels below. */}
        <header
          data-safe-header
          className={`flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-2 backdrop-blur-xl ${
            bar.collapsed ? `absolute inset-x-0 top-0 z-[60] bg-panel/95 transition-transform duration-200 ${bar.peek ? 'translate-y-0 shadow-2xl' : 'invisible pointer-events-none -translate-y-full'}` : 'relative z-40 bg-panel/60'
          }`}
          inert={bar.collapsed && !bar.peek}
          onPointerEnter={(e) => e.pointerType === 'mouse' && bar.startPeek()}
          onPointerLeave={(e) => e.pointerType === 'mouse' && bar.peek && bar.endPeek()}
          data-console-header
        >
          <button
            onClick={onBack}
            className="flex min-h-10 items-center gap-1.5 rounded-lg px-2.5 text-sm text-white/60 hover:bg-white/10 hover:text-white"
            title="返回專案大廳"
          >
            ‹ <span className="hidden sm:inline">大廳</span>
          </button>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{projectName}</div>
            <div className="truncate font-mono text-[11px] text-white/40">{versionName}</div>
          </div>
          <CurrentUserChip />
          <HistoryControls />
          <AutoSaveBadge status={autoSave.status} onClick={() => setHistoryOpen(true)} />
          <button
            onClick={toggleControlMode}
            className={`flex min-h-10 items-center gap-1.5 rounded-lg px-3 text-xs font-bold transition ${
              controlMode ? 'bg-go text-black shadow-[0_0_18px_-6px_#30d158]' : 'bg-white/[0.08] text-white hover:bg-white/15'
            }`}
            aria-pressed={controlMode}
            title={controlMode ? '回到 Cue 編輯畫面' : '隱藏編輯區，讓控制面板佔滿畫面'}
          >
            {controlMode ? '✎ 返回編輯' : '🎛 切換為控制面板'}
          </button>
          {!controlMode && (
          <button
            onClick={toggleSidebar}
            className={`flex min-h-10 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold transition ${
              sidebarOpen ? 'bg-accent text-white' : 'bg-white/[0.06] text-white/70 hover:bg-white/10 hover:text-white'
            }`}
            aria-pressed={sidebarOpen}
            title="在 Cue 編輯器旁開啟 / 關閉控制面板"
          >
            {sidebarOpen ? '關閉控台側欄' : '控台側欄'}
          </button>
          )}
          {!controlMode && (
            <>
              <button
                onClick={() => {
                  setNotesShown(!notesShown)
                  setNotesCollapsed(false)
                }}
                aria-pressed={notesShown}
                className={`flex min-h-10 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold transition ${notesShown ? 'bg-white/15 text-white' : 'bg-white/[0.06] text-white/50 hover:bg-white/10'}`}
                title={notesShown ? '隱藏 Note 筆記' : '顯示 Note 筆記（劇本 / 提示）'}
                data-setcue-notes-toggle
              >
                📝<span className="hidden sm:inline">Note</span>
                <span className={`h-1.5 w-1.5 rounded-full ${notesShown ? 'bg-[#bf5af2]' : 'bg-white/25'}`} />
              </button>
              <button
                onClick={() => {
                  setStageShown(!stageShown)
                  setStageCollapsed(false)
                }}
                aria-pressed={stageShown}
                className={`flex min-h-10 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold transition ${stageShown ? 'bg-white/15 text-white' : 'bg-white/[0.06] text-white/50 hover:bg-white/10'}`}
                title={stageShown ? '隱藏 Stage 模擬畫面' : '顯示 Stage 模擬觀眾畫面'}
                data-setcue-stage-toggle
              >
                🎭<span className="hidden sm:inline">Stage</span>
                <span className={`h-1.5 w-1.5 rounded-full ${stageShown ? 'bg-[#64d2ff]' : 'bg-white/25'}`} />
              </button>
            </>
          )}
          <FullscreenButton />
          <StudioMenu show={show} user={user} readOnly={lock.readOnly} />
          <IntercomButton intercom={intercom} onClick={() => setIntercomOpen(!intercomOpen)} />
          <button
            onClick={() => setTriggersOpen(true)}
            className="flex min-h-10 items-center gap-1.5 rounded-lg bg-white/[0.06] px-3 text-xs text-white/70 hover:bg-white/10 hover:text-white"
            title={router.isHost ? '此分頁負責執行外部觸發' : `外部觸發由「${router.host?.label ?? '—'}」執行`}
          >
            ⚡ 外部觸發
            {/* Lit while this tab is the trigger host; flashes on every incoming MIDI/OSC signal. */}
            <ActivityDot connected={router.isHost} />
          </button>
          {admin && (
            <>
              <button
                onClick={() => setChannelSettingsOpen(true)}
                className="min-h-10 rounded-lg bg-white/[0.06] px-3 text-xs text-white/70 hover:bg-white/10 hover:text-white"
                title="觀眾分組（Ch 1 – Ch 10）"
                data-setcue-channels
              >
                📡 分組{channelCount > 0 ? ` ${channelCount}` : ''}
              </button>
              <button
                onClick={() => setAnnounceOpen(true)}
                className="min-h-10 rounded-lg bg-white/[0.06] px-3 text-xs text-white/70 hover:bg-white/10 hover:text-white"
                title="對觀眾單向廣播（提示音 / 震動 / 朗讀）"
                data-setcue-announce
              >
                📢 廣播
              </button>
            </>
          )}
          <button
            onClick={() => setProjectOpen(true)}
            className="min-h-10 rounded-lg bg-white/[0.06] px-3 text-xs text-white/70 hover:bg-white/10 hover:text-white"
            title="匯入／匯出 JSON、發布專案網址、成員"
            data-setcue-project-open
          >
            📦 專案
          </button>
          <button
            onClick={() => setSavingAs(true)}
            className="min-h-10 rounded-lg bg-white/[0.06] px-3 text-xs text-white/70 hover:bg-white/10 hover:text-white"
          >
            另存新版本
          </button>
          <button
            onClick={() =>
              setLivePointer(isLive ? null : { ...show, projectName, versionName }).catch(ignore)
            }
            className={`min-h-10 rounded-lg px-3 text-xs font-semibold transition ${
              isLive ? 'bg-panic text-white shadow-[0_0_18px_-4px_#ff453a]' : 'bg-white/[0.06] text-white/70 hover:bg-white/10'
            }`}
            title={isLive ? '觀眾端正在跟隨此版本，點擊下線' : '讓觀眾端跟隨此版本'}
          >
            {isLive ? '● ON AIR' : '上線此版本'}
          </button>
          {!isLive && live && (
            <span className="truncate text-[11px] text-white/35">觀眾目前在：{live.projectName} · {live.versionName}</span>
          )}
          {controlMode && <div ref={setSurfaceSlot} className="contents" data-surface-slot />}
          <span
            className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${
              connected ? 'bg-go/15 text-go' : 'bg-panic/15 text-panic'
            }`}
          >
            {connected ? '● 已連線' : '○ 離線'}
          </span>
          <span className="rounded-full bg-white/[0.06] px-2.5 py-0.5 text-[11px] text-white/60" title="連線中的觀眾">
            👥 {presence.length}
          </span>
          {paused ? (
            <motion.span
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              className="rounded-full bg-standby px-2.5 py-0.5 text-[11px] font-bold tracking-wider text-black"
            >
              ❚❚ PAUSED · {instances.length} 個 Cue 暫停中
            </motion.span>
          ) : (
            instances.length > 0 && (
              <span className="rounded-full bg-white/[0.06] px-2.5 py-0.5 text-[11px] text-white/60">
                {instances.length} 個播放中
              </span>
            )
          )}
          {(error || cueListError) && (
            <span className="truncate text-xs text-panic">{(error ?? cueListError)!.message}</span>
          )}
          <span className={`ml-auto hidden text-[11px] text-white/30 ${controlMode ? '' : 'lg:block'}`}>
            ⌘Z 復原 · Space GO/Resume · P Pause · ↑↓ Standby · Esc Fade All · D DIM · M Mute · 1–8 Hits
          </span>
          <span className={`font-mono text-sm text-white/70 tabular ${controlMode ? 'ml-auto' : ''}`}>{clock}</span>
          <button
            type="button"
            onClick={() => bar.setCollapsed(bar.peek ? false : true)}
            className="flex min-h-10 items-center gap-1 rounded-lg bg-white/[0.06] px-3 text-xs text-white/60 hover:bg-white/10 hover:text-white"
            aria-label={bar.peek ? '固定顯示頂端列' : '收合頂端列'}
            title={bar.peek ? '固定顯示頂端列' : '收合整個頂端列（釋放更多空間）'}
            data-header-toggle="shown"
          >
            {bar.peek ? '📌 固定' : '⌃ 收合'}
          </button>
        </header>

        <SetCueProjectDialog
          open={projectOpen}
          onClose={() => setProjectOpen(false)}
          show={show}
          projectName={projectName}
          autoSave={autoSave.status}
          saveNow={autoSave.saveNow}
          onOpenShow={onOpenVersion}
        />
        <VersionHistoryDialog
          open={historyOpen}
          onClose={() => setHistoryOpen(false)}
          title={`Set Cue「${projectName}」`}
          fileKey={setCueProjectKey(pid)}
          revision={autoSave.revision}
          saveNow={autoSave.saveNow}
          live={async () => (await buildSetCueFile(pid)) as unknown as Record<string, unknown>}
          apply={applySetCueVersion(pid)}
          summarize={summarizeSetCue}
          preview={(state) => <SetCueVersionPreview state={state} versionId={show.versionId} />}
        />
        <ChannelSettings
          open={channelSettingsOpen}
          onClose={() => setChannelSettingsOpen(false)}
          config={showState.channels}
          online={presence.length}
          admin={admin}
          onChange={(changes) => engine.setChannels(changes)}
        />
        <AnnouncePanel
          open={announceOpen}
          onClose={() => setAnnounceOpen(false)}
          projectId={show.projectId}
          count={channelCount}
          admin={admin}
          online={presence.length}
          send={(message) => engine.announce(message)}
          defaultChannel={channelView}
        />
        <AnimatePresence>{intercomOpen && <IntercomPanel intercom={intercom} onClose={() => setIntercomOpen(false)} />}</AnimatePresence>
        <CallFlash intercom={intercom} />
        <AudienceTalkGate intercom={intercom} />

        <AnimatePresence>
          {triggersOpen && <GlobalTriggersPanel projectId={show.projectId} router={router} onClose={() => setTriggersOpen(false)} />}
        </AnimatePresence>

        <PromptDialog
          open={savingAs}
          title="另存新版本"
          description="複製目前的 Cue 清單與 Hits 到一個新版本，並切換過去。原版本保持不變。"
          placeholder="例如：彩排二 / 正式演出"
          confirmLabel="另存並開啟"
          onClose={() => setSavingAs(false)}
          onConfirm={async (name) => onOpenVersion(await saveAsNewVersion(show, name))}
        />

        {controlMode ? (
          // Full control mode: the surface (Cue Monitor grid + buttons/faders) takes the whole page,
          // driven by this page's engine.
          <div className="min-h-0 flex-1">
            <SurfaceWorkspace
              show={show}
              engine={engine}
              cues={cues}
              hits={hits}
              router={router}
              variant="embedded"
              mergeHeader
              headerSlot={surfaceSlot}
              initialSurfaceId={readPref(`theatre.sidebarSurface.${show.projectId}`)}
              onSurfaceChange={(id) => id && writePref(`theatre.sidebarSurface.${show.projectId}`, id)}
            />
          </div>
        ) : (
        <div className="flex min-h-0 flex-1">
        {/* With the control sidebar open, the transport column (its GO / Pause / Panic are on the
            surface too) only stays on very wide screens, so the cue list keeps usable width. A
            collapsed editor shrinks to a 44 px rail. */}
        <div
          className={`flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto lg:grid lg:overflow-hidden ${
            sidebarOpen
              ? inspectorOpen
                ? 'lg:grid-cols-[minmax(0,1fr)_380px] min-[1800px]:grid-cols-[260px_minmax(0,1fr)_400px]'
                : 'lg:grid-cols-[minmax(0,1fr)_44px] min-[1800px]:grid-cols-[260px_minmax(0,1fr)_44px]'
              : inspectorOpen
                ? 'lg:grid-cols-[280px_minmax(0,1fr)_420px]'
                : 'lg:grid-cols-[280px_minmax(0,1fr)_44px]'
          }`}
        >
          {/* Left: transport */}
          {compact && (
            <MobileGoBar
              title={projectName}
              clearTopInset={bar.collapsed}
              playbackState={playbackState}
              standbyCue={standbyCue}
              firstCue={cues[0] ?? null}
              elapsed={instances.length > 0 ? Math.max(...instances.map((i) => instanceTiming(i, instanceClock(i, now)).elapsed)) : null}
              lockRemaining={lockRemaining}
              onGo={handleGo}
              onPause={() => engine.pause().catch(ignore)}
              onResume={() => engine.resume().catch(ignore)}
              onStop={() => engine.panic().catch(ignore)}
              onAdd={() => openEditor({ mode: 'create' })}
            />
          )}
          <aside className={`shrink-0 border-line lg:overflow-y-auto lg:border-r ${compact ? 'hidden' : ''} ${sidebarOpen ? 'lg:hidden min-[1800px]:block' : ''}`}>
            <TransportPanel
              playbackState={playbackState}
              standbyCue={standbyCue}
              firstCue={cues[0] ?? null}
              lockRemaining={lockRemaining}
              lockTotal={lastLockingCue?.preventGoDuration ?? lockRemaining}
              masterVolume={showState.masterVolume}
              dim={showState.dim}
              dimDb={showState.dim ? clampDimDb(showState.dimDb ?? DEFAULT_DIM_DB) : consoleDimDb}
              muted={showState.muted}
              onMute={(m) => engine.setMuted(m).catch(ignore)}
              onGo={handleGo}
              onStopAll={() => engine.stopAll().catch(ignore)}
              onPause={() => engine.pause().catch(ignore)}
              onResume={() => engine.resume().catch(ignore)}
              onStop={() => engine.panic().catch(ignore)}
              onMasterVolume={(v, undim) => engine.setMasterVolume(v, { undim }).catch(ignore)}
              // Turning DIM on applies this operator's chosen amount; right-click changes it (live if on).
              onDim={(d) => engine.setDim(d, d ? consoleDimDb : undefined).catch(ignore)}
              onDimDb={(v) => {
                setConsoleDimDb(v)
                if (showState.dim) engine.setDimDb(v).catch(ignore)
              }}
            />
          </aside>

          {/* Center: cue list + hits */}
          <main className={`flex min-h-[70dvh] shrink-0 flex-col lg:min-h-0 lg:shrink ${compact ? 'pb-[calc(5.5rem+env(safe-area-inset-bottom,0px))]' : ''}`}>
            <div className="flex items-center justify-between px-5 pt-4 pb-1">
              <h1 className="text-[11px] font-semibold tracking-widest text-white/50 uppercase">
                Cue List <span className="ml-1 text-white/25">{cues.length}</span>
              </h1>
              <div className="flex items-center gap-2">
                {compact && admin && (
                  <>
                    <button onClick={() => setChannelSettingsOpen(true)} className="min-h-10 rounded-lg bg-white/[0.07] px-3 text-xs font-medium text-white/80" aria-label="觀眾分組">
                      📡
                    </button>
                    <button onClick={() => setAnnounceOpen(true)} className="min-h-10 rounded-lg bg-white/[0.07] px-3 text-xs font-medium text-white/80" aria-label="觀眾廣播">
                      📢
                    </button>
                  </>
                )}
                {compact && (
                  <button
                    onClick={() => {
                      switchRightTab('inbox')
                      setMobileSheet(true)
                    }}
                    className="min-h-10 rounded-lg bg-white/[0.07] px-3 text-xs font-medium text-white/80"
                  >
                    📥 收件匣{unseen > 0 ? ` +${unseen}` : ''}
                  </button>
                )}
                <button
                  onClick={() => openEditor({ mode: 'create' })}
                  className="rounded-lg bg-white/[0.07] px-3 py-1.5 text-xs font-medium text-white/80 transition hover:bg-accent hover:text-white pointer-coarse:min-h-10"
                >
                  ＋ 新增 Cue
                </button>
              </div>
            </div>
            <ChannelChips count={channelCount} value={channelView} onChange={chooseChannel} running={runningPerChannel} />
            {channelCount > 0 && channelView === CHANNEL_ALL && <ChannelOverview count={channelCount} instances={instances} now={now} online={onlinePerChannel} onPick={chooseChannel} />}
            <CueBulkBar
              cues={visibleCues}
              checked={checked}
              onCheckedChange={setChecked}
              onlineAudience={onlineAudience}
              updateCues={updateCues}
              removeCues={removeCues}
              setCueNumbers={setCueNumbers}
              channelCount={channelCount}
              bottom={compact ? { editing: selectMode, onEditingChange: setSelectMode } : undefined}
            />
            <div className={`min-h-[240px] flex-1 ${compact ? 'flex' : 'overflow-y-auto'}`}>
              {compact && (
                <div
                  className="sticky z-20 shrink-0 self-start border-r border-line bg-[#151517]"
                  style={{ top: `calc(176px + ${barInset})`, height: `calc(100dvh - 176px - ${barInset} - 5rem - env(safe-area-inset-bottom, 0px))` }}
                >
                  <MobileSideRail
                    effective={showState.masterVolume * dimGain(showState.dim, showState.dim ? clampDimDb(showState.dimDb ?? DEFAULT_DIM_DB) : consoleDimDb)}
                    dim={showState.dim}
                    dimDb={showState.dim ? clampDimDb(showState.dimDb ?? DEFAULT_DIM_DB) : consoleDimDb}
                    muted={showState.muted}
                    onMasterVolume={(v, undim) => engine.setMasterVolume(v, { undim }).catch(ignore)}
                    onDim={(d) => engine.setDim(d, d ? consoleDimDb : undefined).catch(ignore)}
                    onDimDb={(v) => {
                      setConsoleDimDb(v)
                      if (showState.dim) engine.setDimDb(v).catch(ignore)
                    }}
                  />
                </div>
              )}
              <div className={compact ? 'min-w-0 flex-1' : 'contents'}>
              {loaded ? (
                <CueList
                  checked={checked}
                  onCheckedChange={setChecked}
                  onRenumber={(numbers) => setCueNumbers(numbers).catch(ignore)}
                  cues={visibleCues}
                  showChannels={channelCount > 0}
                  running={running}
                  now={now}
                  standbyId={standbyCue?.id ?? null}
                  selectedId={editingCue?.id ?? null}
                  selectMode={compact && selectMode}
                  onSelect={(cue) => openEditor({ mode: 'edit', cueId: cue.id })}
                  onStandby={(cue) => engine.standby(cue).catch(ignore)}
                  onDelete={(cue) => {
                    if (window.confirm(`刪除 Q${cue.cueNumber}「${cue.title || '未命名'}」？`)) removeCue(cue.id)
                  }}
                  paused={paused}
                  onStop={(id) => engine.stopInstance(id).catch(ignore)}
                  onPauseToggle={(inst) =>
                    (inst.pausedAt != null ? engine.unpauseInstance(inst.instanceId) : engine.pauseInstance(inst.instanceId)).catch(ignore)
                  }
                />
              ) : (
                <p className="p-8 text-sm text-white/30">載入 Cue 清單…</p>
              )}
              </div>
            </div>
            <HitsPanel
              projectId={show.projectId}
              projectName={projectName}
              page={showState.hitsPage}
              onPage={(p) => engine.setHitsPage(p).catch(ignore)}
              onStopAll={() => engine.stopHits('*').catch(ignore)}
              hits={hits}
              onFire={(hit) => engine.fireHit(hit).catch(ignore)}
              onAdd={addHit}
              onUpdate={updateHit}
              onRemove={removeHit}
            />
          </main>

          {/* Right: inspector — cue editor / audience inbox (collapsible) */}
          {compact && !(mobileSheet && (editor != null || rightTab === 'inbox')) ? null : !compact && !inspectorOpen ? (
            <button
              onClick={() => setInspector(true)}
              className="flex min-h-12 items-center justify-center gap-2 border-t border-line bg-panel/50 text-xs text-white/55 hover:bg-white/[0.06] hover:text-white lg:min-h-0 lg:flex-col lg:border-t-0 lg:border-l lg:py-4"
              title="展開 Cue 編輯區"
            >
              <span className="text-base">‹</span>
              <span className="lg:[writing-mode:vertical-rl]">展開編輯區{unseen > 0 ? ` · 收件匣 +${unseen}` : ''}</span>
            </button>
          ) : (
          <>
          {compact && (
            // Phones: the editor is a bottom sheet over a blurred dark backdrop; tapping the backdrop closes it.
            <div
              className="fixed inset-0 z-[69] bg-black/60 backdrop-blur-sm"
              onClick={() => {
                setMobileSheet(false)
                setEditor(null)
              }}
              data-mobile-sheet-backdrop
            />
          )}
          <aside
            className={
              compact
                ? 'fixed inset-x-0 bottom-0 z-[70] flex h-[92dvh] flex-col overflow-hidden rounded-t-3xl border border-b-0 border-line bg-[#0b0b0d] pb-[env(safe-area-inset-bottom,0px)] shadow-[0_-20px_60px_-20px_rgba(0,0,0,0.9)]'
                : 'relative flex min-h-[520px] shrink-0 flex-col border-t border-line bg-panel/50 backdrop-blur-xl lg:min-h-0 lg:border-t-0 lg:border-l'
            }
            data-mobile-sheet={compact || undefined}
          >
            <div className="flex gap-1 border-b border-line p-2" role="tablist">
              <button
                onClick={() => {
                  if (compact) {
                    setMobileSheet(false)
                    setEditor(null)
                  } else setInspector(false)
                }}
                className="flex min-h-10 w-9 shrink-0 items-center justify-center rounded-lg text-white/45 hover:bg-white/10 hover:text-white"
                title="收合編輯區"
                aria-label="收合編輯區"
              >
                ›
              </button>
              <RightTab active={rightTab === 'editor'} onClick={() => switchRightTab('editor')}>
                ✎ Cue 編輯
              </RightTab>
              <RightTab active={rightTab === 'inbox'} onClick={() => switchRightTab('inbox')}>
                📥 收件匣
                <span className="ml-1.5 font-mono text-[11px] opacity-60">{inboxCount}</span>
                {unseen > 0 && (
                  <span className="ml-1.5 rounded-full bg-go px-1.5 text-[10px] font-bold text-black">+{unseen}</span>
                )}
              </RightTab>
            </div>

            <div className="relative min-h-0 flex-1">
              <AnimatePresence mode="wait">
                {rightTab === 'inbox' ? (
                  <motion.div
                    // Re-mount when an interactive cue fires so the inbox jumps to its uploads.
                    key={`inbox-${latestInteractive?.id ?? 'all'}`}
                    initial={{ opacity: 0, x: -16 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -16 }}
                    transition={{ duration: 0.18 }}
                    className="absolute inset-0"
                  >
                    <MediaPool
                      uploads={uploads}
                      cues={cues}
                      mode="manage"
                      initialCueId={latestInteractive?.id ?? null}
                      onCreateCue={handleQuickCreate}
                      onModerate={(upload, status) => setUploadModeration(show.projectId, upload.id, status).catch(ignore)}
                      onHide={(upload, hidden) => setUploadHidden(show.projectId, upload.id, hidden).catch(ignore)}
                      onRecheck={(upload) => recheckModeration(show.projectId, upload).catch((err: Error) => alert(err.message))}
                    />
                  </motion.div>
                ) : editor ? (
                  <motion.div
                    key={editor.mode === 'edit' ? editor.cueId : 'create'}
                    initial={{ opacity: 0, x: 24 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 24 }}
                    transition={{ duration: 0.18 }}
                    className="absolute inset-0"
                  >
                    {editor.mode === 'create' ? (
                      <CueEditor
                        cue={null}
                        initial={{ ...DEFAULT_CUE, cueNumber: nextCueNumber, targetChannels: channelCount > 0 && channelView !== CHANNEL_ALL ? [channelView] : ['all'] }}
                        channelCount={channelCount}
                        onlineAudience={onlineAudience}
                        inbox={uploads}
                        allCues={cues}
                        projectId={show.projectId}
                        projectName={projectName}
                        onClose={() => setEditor(null)}
                        onSave={async (draft) => {
                          const saved = await addCue(draft)
                          touchProject(show.projectId).catch(ignore)
                          setEditor({ mode: 'edit', cueId: saved.id })
                        }}
                      />
                    ) : editingCue ? (
                      <CueEditor
                        cue={editingCue}
                        channelCount={channelCount}
                        initial={stripId(editingCue)}
                        onlineAudience={onlineAudience}
                        inbox={uploads}
                        allCues={cues}
                        projectId={show.projectId}
                        projectName={projectName}
                        onClose={() => setEditor(null)}
                        onSave={async (draft) => {
                          await saveCue(editingCue.id, draft)
                          touchProject(show.projectId).catch(ignore)
                        }}
                        onDelete={() => {
                          setEditor(null)
                          removeCue(editingCue.id)
                        }}
                      />
                    ) : null}
                  </motion.div>
                ) : (
                  <motion.div
                    key="idle"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-8 text-center"
                  >
                    <div className="text-3xl text-white/10">✎</div>
                    <p className="text-sm text-white/40">點選 Cue 以編輯</p>
                    <p className="text-xs text-white/25">或從「收件匣」把觀眾上傳的檔案一鍵建立為 Cue</p>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </aside>
          </>
          )}
        </div>

        <AnimatePresence>
          {notesShown && (
            <NotesPanel
              key="setcue-notes"
              engine={engine}
              cues={cues}
              text={script.text}
              onSave={script.save}
              source={script.source}
              notionUrl={script.notionUrl}
              onSaveSource={script.saveSource}
              prefKey="theatre.notesView.setcue"
              overlay={false}
              collapsed={notesCollapsed}
              onCollapsedChange={setNotesCollapsed}
              onHide={() => setNotesShown(false)}
            />
          )}
        </AnimatePresence>
        <AnimatePresence>
          {stageShown && (
            <StagePanel
              key="setcue-stage"
              engine={engine}
              show={show}
              cues={cues}
              prefKey="theatre.stageView.setcue"
              collapsed={stageCollapsed}
              onCollapsedChange={setStageCollapsed}
              onHide={() => setStageShown(false)}
            />
          )}
        </AnimatePresence>

        <AnimatePresence>
          {sidebarOpen && (
            <ControlSidebar show={show} engine={engine} cues={cues} hits={hits} router={router} onClose={toggleSidebar} />
          )}
        </AnimatePresence>
        </div>
        )}
      </div>
    </IntercomContext.Provider>
  )
}

function RightTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`flex min-h-10 flex-1 items-center justify-center rounded-lg text-xs font-medium transition pointer-coarse:min-h-12 pointer-coarse:text-sm ${
        active ? 'bg-white/10 text-white' : 'text-white/45 hover:bg-white/[0.04] hover:text-white/75'
      }`}
    >
      {children}
    </button>
  )
}

function stripId({ id: _id, ...rest }: Cue): Omit<Cue, 'id'> {
  return rest
}
