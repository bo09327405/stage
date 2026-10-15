import { dimGain } from '../../utils/dim'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { useTheatreEngine } from '../../hooks/useTheatreEngine'
import type { useTriggerRouter } from '../../hooks/useTriggerRouter'
import { useAutoConnectMidi, useMidi } from '../../services/midi'
import { oscBridge, useOscBridge } from '../../services/oscBridge'
import {
  createSurface,
  deleteSurface,
  newWidgetId,
  removeWidget,
  replaceSurfaceLayout,
  saveFaderValue,
  saveMonitorLayout,
  saveWidget,
  updateSurfaceMeta,
  useSurfaces,
} from '../../services/surfaces'
import type { Cue, Hit } from '../../types/cue'
import type { ShowRef } from '../../types/project'
import { DEFAULT_MONITOR_LAYOUT, newIntercomWidget, newMonitorWidget, newNoteWidget, newStageWidget, newWidget, type Surface, type SurfaceWidget, type WidgetType } from '../../types/surface'
import { runWidgetActions } from '../../utils/surfaceActions'
import { buildSurfaceFile, downloadSurfaceFile, parseSurfaceFile } from '../../utils/surfaceTransfer'
import { addGlobalTriggerFull } from '../../services/triggers'
import { ActivityDot } from '../triggers/ActivityDot'
import { PromptDialog } from '../ui/PromptDialog'
import { CueMonitor } from './CueMonitor'
import { MonitorDrawerTab } from './MonitorDrawerTab'
import { MiniCueMonitor } from './MiniCueMonitor'
import { MiniNote } from '../notes/MiniNote'
import { MiniStage } from './MiniStage'
import { MiniIntercom } from '../intercom/MiniIntercom'
import { StagePanel } from '../stage/StagePanel'
import { applyPanelMode, usePanelCommands } from '../../services/panelBus'
import { NotesPanel } from '../notes/NotesPanel'
import { useScript } from '../../services/script'
import { versionPath } from '../../types/project'
import { SignalSettings } from './SignalSettings'
import { SurfaceCanvas } from './SurfaceCanvas'
import { WidgetProperties } from './WidgetProperties'
import { ModulesDialog } from './ModulesDialog'
import { ExecutorView } from './executors/ExecutorView'
import { GridSizeMenu } from './GridSize'
import { useFullscreen } from '../../hooks/useFullscreen'
import { useHeaderCollapse } from '../../utils/headerCollapse'
import { ExecutorSidebar, SidebarSplitter } from './executors/ExecutorSidebar'
import { useExecSidebar } from '../../utils/execSidebar'
import { GRID_PRESETS, PANEL_GRID_SLIDERS, useGridDensity } from '../../utils/gridDensity'
import { useExecutors } from './executors/useExecutors'

const ignore = () => {}

type Engine = ReturnType<typeof useTheatreEngine>
type Router = ReturnType<typeof useTriggerRouter>

interface SurfaceWorkspaceProps {
  show: ShowRef
  /** The page's cue engine. Passed in (never created here) so the Set Cue sidebar and the cue list
   * share one state machine. */
  engine: Engine
  cues: Cue[]
  hits: Hit[]
  /** Trigger router of the page; used for exporting the Global Profile with a layout. */
  router: Router
  /**
   * "page": the standalone /surface screen. "sidebar": docked next to the Set Cue editor.
   * "embedded": fills the Set Cue page in full control mode.
   */
  variant: 'page' | 'sidebar' | 'embedded'
  initialSurfaceId: string | null
  onSurfaceChange: (surfaceId: string | null) => void
  /** Page-specific header content (back button, project name / intercom, triggers). */
  headerStart?: ReactNode
  headerEnd?: ReactNode
}

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

/** The small tab at the top edge that folds / unfolds the bar (a 44 px touch target around it). */
function HeaderTab({ label, title, expanded, onClick, folded = false }: { label: string; title: string; expanded: boolean; onClick: () => void; folded?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`absolute left-1/2 z-[61] flex h-6 pointer-coarse:h-9 pointer-coarse:px-5 pointer-coarse:text-xs -translate-x-1/2 items-center gap-1 rounded-b-xl border border-t-0 border-line bg-panel/95 px-3 text-[11px] whitespace-nowrap text-white/55 shadow-lg backdrop-blur-xl transition before:absolute before:-inset-x-3 before:-inset-y-3 before:content-[''] hover:text-white ${folded ? 'top-0 opacity-70 hover:opacity-100' : 'top-full'}`}
      aria-label={title}
      aria-expanded={expanded}
      title={title}
      data-header-toggle={folded ? 'folded' : 'shown'}
    >
      {label}
    </button>
  )
}

/** First free top-left position for a w×h widget, scanning row by row. */
function freeSpot(widgets: SurfaceWidget[], w: number, h: number, columns: number) {
  const overlaps = (x: number, y: number) =>
    widgets.some((o) => x < o.x + o.w && x + w > o.x && y < o.y + o.h && y + h > o.y)
  for (let y = 0; y < 200; y++) {
    for (let x = 0; x <= columns - w; x++) if (!overlaps(x, y)) return { x, y }
  }
  return { x: 0, y: 0 }
}

/**
 * The control surface itself — surface picker, Cue monitor, button/fader canvas, edit mode,
 * properties and signal settings — without its own engine, so it can live on its own page or
 * docked beside the Set Cue editor.
 */
export function SurfaceWorkspace({
  show,
  engine,
  cues,
  hits,
  router,
  variant,
  initialSurfaceId,
  onSurfaceChange,
  headerStart,
  headerEnd,
}: SurfaceWorkspaceProps) {
  const sidebar = variant === 'sidebar'
  const { surfaces } = useSurfaces(show.projectId)
  const bridge = useOscBridge()
  const midiState = useMidi()

  const [surfaceId, setSurfaceId] = useState<string | null>(initialSurfaceId)
  const [editing, setEditing] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [drawer, setDrawer] = useState<'properties' | 'settings' | null>(null)
  const [naming, setNaming] = useState<'create' | 'rename' | null>(null)
  const [monitorOpen, setMonitorOpen] = useState(true)
  // Cue Monitor: shown or not, and docked above the surface or tucked into a side drawer.
  // Remembered per device and per place (page / sidebar / full control).
  const prefKey = `theatre.monitorView.${variant}`
  const [monitorShown, setMonitorShown] = useState(() => readPref(`${prefKey}.shown`) !== '0')
  const [monitorDock, setMonitorDock] = useState<'top' | 'drawer'>(() => (readPref(`${prefKey}.dock`) === 'drawer' ? 'drawer' : 'top'))
  const [drawerOpen, setDrawerOpen] = useState(false)
  useEffect(() => {
    writePref(`${prefKey}.shown`, monitorShown ? '1' : '0')
    writePref(`${prefKey}.dock`, monitorDock)
  }, [prefKey, monitorShown, monitorDock])

  // Script / notes area: shown or hidden, and open or folded to a tab on the right edge.
  const script = useScript(versionPath(show))
  const notesKey = `theatre.notesView.${variant}`
  const [notesShown, setNotesShown] = useState(() => readPref(`${notesKey}.shown`) === '1')
  const [notesCollapsed, setNotesCollapsed] = useState(() => readPref(`${notesKey}.collapsed`) === '1')
  useEffect(() => {
    writePref(`${notesKey}.shown`, notesShown ? '1' : '0')
    writePref(`${notesKey}.collapsed`, notesCollapsed ? '1' : '0')
  }, [notesKey, notesShown, notesCollapsed])
  // Stage simulation window. In the narrow console sidebar the console page owns it instead.
  const ownsStage = !sidebar
  const stageKey = `theatre.stageView.${variant}`
  const [stageShown, setStageShown] = useState(() => readPref(`${stageKey}.shown`) === '1')
  const [stageCollapsed, setStageCollapsed] = useState(() => readPref(`${stageKey}.collapsed`) === '1')
  useEffect(() => {
    writePref(`${stageKey}.shown`, stageShown ? '1' : '0')
    writePref(`${stageKey}.collapsed`, stageCollapsed ? '1' : '0')
  }, [stageKey, stageShown, stageCollapsed])

  // Window commands from buttons ("🪟 視窗開關" actions, Stage blocks), also when pressed via MIDI / OSC.
  usePanelCommands(ownsStage ? ['stage', 'notes', 'monitor'] : ['notes', 'monitor'], (target, mode) => {
    if (target === 'stage') {
      const next = applyPanelMode(stageShown && !stageCollapsed, mode)
      setStageShown(next)
      setStageCollapsed(false)
    } else if (target === 'notes') {
      const next = applyPanelMode(notesShown && !notesCollapsed, mode)
      setNotesShown(next)
      setNotesCollapsed(false)
    } else {
      setMonitorShown(applyPanelMode(monitorShown, mode))
      setDrawerOpen(false)
    }
  })
  const [notice, setNotice] = useState<string | null>(null)
  const [modulesOpen, setModulesOpen] = useState(false)
  const importInput = useRef<HTMLInputElement>(null)

  const surface: Surface | null = surfaces?.find((s) => s.id === surfaceId) ?? surfaces?.[0] ?? null
  const widgets = surface ? Object.values(surface.widgets) : []
  const [density, setDensity] = useGridDensity(surface?.id ?? null)
  const { isFullscreen } = useFullscreen()
  const header = useHeaderCollapse(isFullscreen)
  const [execSidebar, setExecSidebar] = useExecSidebar()
  // Executor playback runs whenever the panel is open (Follow / Time keep going in either view).
  const exec = useExecutors({ engine, surface, cues, hits })
  const [view, setViewState] = useState<'panel' | 'executor'>(() => (readPref('theatre.surface.view') === 'executor' ? 'executor' : 'panel'))
  const setView = (v: 'panel' | 'executor') => {
    setViewState(v)
    writePref('theatre.surface.view', v)
    if (v === 'executor') setEditing(false)
  }
  const selected = selectedId && surface ? (surface.widgets[selectedId] ?? null) : null
  const usesOsc = widgets.some((w) => w.actions.some((a) => a.kind === 'osc'))
  const usesMidi = widgets.some((w) => w.actions.some((a) => a.kind === 'midi'))

  // Bring up the signal paths this layout needs.
  useEffect(() => {
    if (usesOsc) oscBridge.connect()
  }, [usesOsc])
  useAutoConnectMidi(usesMidi)

  const chooseSurface = (id: string | null) => {
    setSurfaceId(id)
    setSelectedId(null)
    setDrawer(null)
    onSurfaceChange(id)
  }

  const exportLayout = () => {
    if (!surface) return
    downloadSurfaceFile(buildSurfaceFile(surface, cues, router.globalTriggers, hits))
  }

  const importLayout = async (file: File | undefined) => {
    if (!file || !surface) return
    try {
      const parsed = parseSurfaceFile(await file.text(), cues, () => newWidgetId(show.projectId, surface.id), hits)
      const ok = confirm(
        `匯入「${parsed.file.name}」的 ${parsed.widgets.length} 個元件，並覆蓋目前「${surface.name}」的佈局？`,
      )
      if (!ok) return
      await replaceSurfaceLayout(show.projectId, surface.id, parsed.widgets, {
        columns: parsed.file.columns || surface.columns,
        oscHost: parsed.file.oscHost ?? surface.oscHost,
        oscPort: parsed.file.oscPort || surface.oscPort,
      }, `匯入面板「${parsed.file.name}」`)
      const triggers = parsed.file.globalTriggers ?? []
      if (triggers.length > 0 && confirm(`檔案內含 ${triggers.length} 條 Global Trigger 規則，要一併加入此專案嗎？`)) {
        await Promise.all(triggers.map((t) => addGlobalTriggerFull(show.projectId, t)))
      }
      setSelectedId(null)
      setNotice(
        `已匯入 ${parsed.widgets.length} 個元件` +
          (parsed.unmatchedCues ? `；${parsed.unmatchedCues} 個 Cue 動作在此專案找不到對應 Cue，請重新指定` : '') +
          (parsed.unmatchedHits ? `；${parsed.unmatchedHits} 個 Hit 動作找不到對應 Hit` : ''),
      )
    } catch (err) {
      setNotice(`匯入失敗：${(err as Error).message}`)
    }
  }

  const addWidget = (type: WidgetType | 'monitor' | 'note' | 'stage' | 'intercom') => {
    if (!surface) return
    const id = newWidgetId(show.projectId, surface.id)
    const base =
      type === 'monitor'
        ? newMonitorWidget(id, 0, 0)
        : type === 'note'
          ? newNoteWidget(id, 0, 0)
          : type === 'stage'
            ? newStageWidget(id, 0, 0)
            : type === 'intercom'
              ? newIntercomWidget(id, 0, 0)
              : newWidget(type, id, 0, 0)
    const spot = freeSpot(widgets, base.w, base.h, surface.columns)
    const label =
      type === 'button' ? `Button ${widgets.length + 1}` : type === 'fader' ? `Fader ${widgets.length + 1}` : type === 'knob' ? `Knob ${widgets.length + 1}` : base.label
    const widget = { ...base, ...spot, label }
    saveWidget(show.projectId, surface.id, widget, 'add').catch(ignore)
    setSelectedId(widget.id)
    setDrawer('properties')
  }

  const playback = engine.playbackState
  const monitorProps = {
    engine,
    cues,
    compact: sidebar,
    layout: surface?.monitor ?? DEFAULT_MONITOR_LAYOUT,
    onLayoutChange: surface ? (layout: Surface['monitor']) => saveMonitorLayout(show.projectId, surface.id, layout).catch(ignore) : undefined,
    heightKey: `theatre.monitorHeight.${variant}`,
    defaultHeight: variant === 'sidebar' ? 230 : variant === 'embedded' ? 420 : 280,
  }

  return (
    <div className={`surface-touch relative flex flex-col bg-ink text-white ${variant === 'page' ? 'h-dvh' : 'h-full min-h-0'}`} data-header-collapsed={header.collapsed ? (header.peek ? 'peek' : 'hidden') : 'shown'}>
      {/* With a mouse, the top edge brings a folded bar back for a moment. */}
      {header.collapsed && !header.peek && <div className="absolute inset-x-0 top-0 z-[59] h-1.5" onPointerEnter={(e) => e.pointerType === 'mouse' && header.startPeek()} aria-hidden data-header-hotzone />}
      {header.collapsed && !header.peek && <HeaderTab label="⌄ 選單" title="展開頂端列" expanded={false} onClick={() => header.setCollapsed(false)} folded />}
      {/* Top bar (folds away in full screen) */}
      <header
        data-safe-header
        className={`flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line backdrop-blur-xl ${sidebar ? 'px-3 py-2' : 'px-4 py-2'} ${
          header.collapsed ? `absolute inset-x-0 top-0 z-[60] bg-panel/95 shadow-2xl transition-transform duration-200 ${header.peek ? 'translate-y-0' : '-translate-y-full'}` : 'relative z-40 bg-panel/70'
        }`}
        inert={header.collapsed && !header.peek}
        onPointerEnter={(e) => e.pointerType === 'mouse' && header.startPeek()}
        onPointerLeave={(e) => e.pointerType === 'mouse' && header.peek && header.endPeek()}
        data-surface-header
      >
        {headerStart}

        {surfaces && surfaces.length > 0 && (
          <select
            value={surface?.id ?? ''}
            onChange={(e) => chooseSurface(e.target.value)}
            className="min-h-10 max-w-48 appearance-none rounded-lg border border-line bg-black/40 px-3 text-sm text-white"
          >
            {surfaces.map((s) => (
              <option key={s.id} value={s.id}>
                🎛 {s.name}
              </option>
            ))}
          </select>
        )}
        <button
          onClick={() => setNaming('create')}
          className="min-h-10 rounded-lg bg-white/[0.06] px-3 text-xs text-white/70 hover:bg-white/10"
          title="新增控制面板"
        >
          {sidebar ? '＋' : '＋ 新控台'}
        </button>

        <span
          className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold tracking-wider ${
            playback === 'paused' ? 'bg-standby text-black' : playback === 'playing' ? 'bg-go/20 text-go' : 'bg-white/10 text-white/40'
          }`}
        >
          {{ idle: 'IDLE', playing: '▶ PLAYING', paused: '❚❚ PAUSED' }[playback]}
        </span>

        {surface && (
          <div className="flex rounded-lg bg-black/40 p-0.5 text-xs" role="tablist" aria-label="控制面板檢視">
            {(
              [
                ['panel', '🎛 面板'],
                ['executor', '🎚 Executor'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={view === id}
                onClick={() => setView(id)}
                className={`min-h-9 rounded-md px-3 font-semibold ${view === id ? 'bg-white/15 text-white' : 'text-white/50 hover:text-white/80'}`}
                data-surface-view={id}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        {surface && view === 'panel' && (
          <GridSizeMenu
            value={density}
            onChange={setDensity}
            presets={GRID_PRESETS}
            sliders={PANEL_GRID_SLIDERS}
            note="元件位置不變，整個面板等比例縮放；縮放超過 100% 時可左右捲動。"
            compact={sidebar}
          />
        )}
        {surface && view === 'panel' && (
          <button
            type="button"
            onClick={() => setExecSidebar({ open: !execSidebar.open })}
            aria-pressed={execSidebar.open}
            className={`flex min-h-10 items-center gap-1.5 rounded-lg px-3 text-xs ${execSidebar.open ? 'bg-white/15 text-white' : 'bg-white/[0.06] text-white/70 hover:bg-white/10'}`}
            title="Executor 側邊欄：推桿與序列停靠在面板旁"
            data-exec-sidebar-toggle
          >
            🎚{!sidebar && <span>側欄</span>}
            <span className={`h-1.5 w-1.5 rounded-full ${execSidebar.open ? 'bg-go' : 'bg-white/25'}`} />
          </button>
        )}

        <div className="ml-auto flex items-center gap-2">
          {headerEnd}
          <button
            onClick={() => {
              setMonitorShown(!monitorShown)
              setDrawerOpen(false)
            }}
            aria-pressed={monitorShown}
            className={`flex min-h-10 items-center gap-1.5 rounded-lg px-3 text-xs transition ${
              monitorShown ? 'bg-white/15 text-white' : 'bg-white/[0.06] text-white/50 hover:bg-white/10'
            }`}
            title={monitorShown ? '隱藏 Cue Monitor' : '顯示 Cue Monitor'}
            data-monitor-toggle
          >
            📺{!sidebar && <span>Monitor</span>}
            <span className={`h-1.5 w-1.5 rounded-full ${monitorShown ? 'bg-go' : 'bg-white/25'}`} />
          </button>
          <button
            onClick={() => {
              setNotesShown(!notesShown)
              setNotesCollapsed(false)
            }}
            aria-pressed={notesShown}
            className={`flex min-h-10 items-center gap-1.5 rounded-lg px-3 text-xs transition ${
              notesShown ? 'bg-white/15 text-white' : 'bg-white/[0.06] text-white/50 hover:bg-white/10'
            }`}
            title={notesShown ? '隱藏劇本筆記' : '顯示劇本筆記'}
            data-notes-toggle
          >
            📝{!sidebar && <span>Notes</span>}
            <span className={`h-1.5 w-1.5 rounded-full ${notesShown ? 'bg-[#bf5af2]' : 'bg-white/25'}`} />
          </button>
          {ownsStage && (
            <button
              onClick={() => {
                setStageShown(!stageShown)
                setStageCollapsed(false)
              }}
              aria-pressed={stageShown}
              className={`flex min-h-10 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold transition ${
                stageShown ? 'bg-white/15 text-white' : 'bg-white/[0.06] text-white/50 hover:bg-white/10'
              }`}
              title={stageShown ? '隱藏 Stage 模擬畫面' : '顯示 Stage 模擬觀眾畫面'}
              data-stage-toggle
            >
              🎭<span>Stage</span>
              <span className={`h-1.5 w-1.5 rounded-full ${stageShown ? 'bg-[#64d2ff]' : 'bg-white/25'}`} />
            </button>
          )}
          <button
            onClick={() => setDrawer(drawer === 'settings' ? null : 'settings')}
            className={`flex min-h-10 items-center gap-2 rounded-lg px-3 text-xs transition ${
              drawer === 'settings' ? 'bg-white/15 text-white' : 'bg-white/[0.06] text-white/70 hover:bg-white/10'
            }`}
          >
            {/* Flash on every incoming signal, so hardware hits are visible during rehearsal. */}
            <ActivityDot source="osc" connected={bridge.status === 'connected'} error={bridge.status === 'error'} /> OSC
            <ActivityDot
              source="midi"
              connected={midiState.status === 'ready' && (midiState.outputs.length > 0 || midiState.inputs.length > 0)}
              error={midiState.status === 'denied'}
            />{' '}
            MIDI
          </button>
          {surface && (
            <button
              onClick={() => {
                setEditing(!editing)
                setSelectedId(null)
                if (drawer === 'properties') setDrawer(null)
              }}
              className={`min-h-10 rounded-lg px-4 text-sm font-semibold transition ${
                editing ? 'bg-accent text-white' : 'bg-white/[0.06] text-white/80 hover:bg-white/10'
              }`}
            >
              {editing ? '✓ 完成' : sidebar ? '✎' : '✎ 編輯面板'}
            </button>
          )}
        </div>
        {(!header.collapsed || header.peek) && (
          // Hangs below the bar: fold it away, or pin a peeked bar open.
          <HeaderTab label={header.peek ? '📌 固定' : '⌃ 收合'} title={header.peek ? '固定顯示頂端列' : '收合頂端列（釋放更多空間）'} expanded onClick={() => header.setCollapsed(header.peek ? false : true)} />
        )}
      </header>

      {/* Edit toolbar */}
      <AnimatePresence>
        {editing && surface && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden border-b border-line bg-accent/[0.06]"
          >
            <div className="flex flex-wrap items-center gap-2 px-4 py-2.5">
              <span className="text-xs text-white/50">拖曳移動 · 右下角調整大小 · 點選設定屬性</span>
              <button onClick={() => addWidget('button')} className="min-h-10 rounded-lg bg-go/15 px-4 text-sm font-semibold text-go">
                ＋ 按鈕
              </button>
              <button onClick={() => addWidget('fader')} className="min-h-10 rounded-lg bg-accent/20 px-4 text-sm font-semibold text-accent">
                ＋ 推桿
              </button>
              <button onClick={() => addWidget('knob')} className="min-h-10 rounded-lg bg-[#ff9f0a]/15 px-4 text-sm font-semibold text-[#ff9f0a]" data-add-knob>
                ＋ 旋鈕
              </button>
              <button onClick={() => addWidget('monitor')} className="min-h-10 rounded-lg bg-standby/15 px-4 text-sm font-semibold text-standby">
                ＋ Cue Monitor
              </button>
              <button onClick={() => addWidget('note')} className="min-h-10 rounded-lg bg-[#bf5af2]/15 px-4 text-sm font-semibold text-[#bf5af2]">
                ＋ Note
              </button>
              <button onClick={() => addWidget('stage')} className="min-h-10 rounded-lg bg-[#64d2ff]/15 px-4 text-sm font-semibold text-[#64d2ff]" data-add-stage>
                ＋ Stage
              </button>
              <button onClick={() => addWidget('intercom')} className="min-h-10 rounded-lg bg-go/15 px-4 text-sm font-semibold text-go" data-add-intercom>
                ＋ Intercom
              </button>
              <span className="mx-1 h-6 w-px bg-white/10" />
              <button onClick={() => setModulesOpen(true)} className="min-h-10 rounded-lg bg-white/10 px-3 text-xs font-semibold text-white hover:bg-white/15" data-open-modules>
                📦 模組
              </button>
              <button onClick={exportLayout} className="min-h-10 rounded-lg bg-white/[0.06] px-3 text-xs text-white/80 hover:bg-white/10">
                ⇩ 匯出面板 JSON
              </button>
              <button
                onClick={() => importInput.current?.click()}
                className="min-h-10 rounded-lg bg-white/[0.06] px-3 text-xs text-white/80 hover:bg-white/10"
              >
                ⇧ 匯入面板 JSON
              </button>
              <input
                ref={importInput}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(e) => {
                  importLayout(e.target.files?.[0])
                  e.target.value = ''
                }}
              />
              <button onClick={() => setNaming('rename')} className="min-h-10 rounded-lg bg-white/[0.06] px-3 text-xs text-white/70">
                重新命名
              </button>
              <button
                onClick={() => {
                  if (confirm(`刪除控台「${surface.name}」與其中 ${widgets.length} 個元件？`)) {
                    deleteSurface(show.projectId, surface.id, surface.name).catch(ignore)
                    chooseSurface(null)
                    setEditing(false)
                  }
                }}
                className="ml-auto min-h-10 rounded-lg px-3 text-xs text-white/35 hover:bg-panic/15 hover:text-panic"
              >
                刪除控台
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {monitorShown && monitorDock === 'top' && (
        <CueMonitor
          {...monitorProps}
          open={monitorOpen}
          onToggle={() => setMonitorOpen(!monitorOpen)}
          headerExtra={
            <button
              type="button"
              onClick={() => {
                setMonitorDock('drawer')
                setDrawerOpen(false)
              }}
              className="flex min-h-8 shrink-0 items-center rounded-lg bg-white/[0.06] px-2 text-xs text-white/60 hover:bg-white/10 hover:text-white"
              title="收到側邊抽屜，釋放主畫面空間"
              aria-label="收到側欄"
            >
              ⇤{!sidebar && ' 收到側欄'}
            </button>
          }
        />
      )}

      <div className="relative flex min-h-0 flex-1">
        {monitorShown && monitorDock === 'drawer' && (
          <>
            {/* Collapsed: a slim tab on the left edge. Open: the monitor slides over the surface. */}
            <MonitorDrawerTab engine={engine} onOpen={() => setDrawerOpen(true)} hidden={drawerOpen} />
            <AnimatePresence>
              {drawerOpen && (
                <>
                  <motion.div
                    key="scrim"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    onClick={() => setDrawerOpen(false)}
                    className="absolute inset-0 z-30 bg-black/40"
                  />
                  <motion.aside
                    key="drawer"
                    initial={{ x: '-100%' }}
                    animate={{ x: 0 }}
                    exit={{ x: '-100%' }}
                    transition={{ type: 'spring', stiffness: 420, damping: 40 }}
                    className="absolute inset-y-0 left-0 z-40 flex w-[min(440px,92%)] flex-col border-r border-line bg-ink shadow-2xl"
                    aria-label="Cue Monitor 側欄"
                    data-monitor-drawer
                  >
                    <CueMonitor
                      {...monitorProps}
                      open
                      onToggle={() => setDrawerOpen(false)}
                      fill
                      headerExtra={
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              setMonitorDock('top')
                              setDrawerOpen(false)
                              setMonitorOpen(true)
                            }}
                            className="flex min-h-8 shrink-0 items-center rounded-lg bg-white/[0.06] px-2 text-xs text-white/60 hover:bg-white/10 hover:text-white"
                            title="固定回主畫面上方"
                            aria-label="固定到上方"
                          >
                            ⤒
                          </button>
                          <button
                            type="button"
                            onClick={() => setDrawerOpen(false)}
                            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white/50 hover:bg-white/10 hover:text-white"
                            aria-label="收合側欄"
                          >
                            ✕
                          </button>
                        </>
                      }
                    />
                  </motion.aside>
                </>
              )}
            </AnimatePresence>
          </>
        )}

        <main className={`min-h-0 flex-1 overflow-y-auto ${sidebar ? 'p-3' : 'p-4'} ${monitorShown && monitorDock === 'drawer' ? 'pl-10' : ''}`}>
          {surfaces === null ? (
            <p className="p-8 text-sm text-white/30">載入控台…</p>
          ) : !surface ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <div className="text-5xl text-white/10">🎛</div>
              <p className="text-white/50">此專案還沒有控制面板</p>
              <p className="max-w-sm text-xs text-white/30">建立面板後，放上按鈕與推桿，綁定 Cue、MIDI 或 OSC 訊號。每個團隊可以有自己的面板。</p>
              <button onClick={() => setNaming('create')} className="min-h-12 rounded-xl bg-accent px-6 text-sm font-semibold">
                建立第一個控台
              </button>
            </div>
          ) : view === 'executor' ? (
            <ExecutorView engine={engine} exec={exec} surface={surface} projectId={show.projectId} cues={cues} />
          ) : widgets.length === 0 && !editing ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <p className="text-white/50">「{surface.name}」是空的</p>
              <button onClick={() => setEditing(true)} className="min-h-12 rounded-xl bg-accent px-6 text-sm font-semibold">
                ✎ 開始編輯
              </button>
            </div>
          ) : (
            <SurfaceCanvas
              widgets={widgets}
              liveValue={(w) => {
                // Faders bound to the show master follow it — dimmed while DIM is on.
                const bound = w.type === 'fader' && w.actions.some((a) => a.kind === 'master' || (a.kind === 'param' && a.target.scope === 'show' && a.target.param === 'master'))
                if (!bound) return null
                const norm = (engine.showState.masterVolume / 100) * dimGain(engine.showState.dim, engine.showState.dimDb)
                return w.min + Math.max(0, Math.min(1, norm)) * (w.max - w.min)
              }}
              columns={surface.columns}
              density={density}
              editing={editing}
              selectedId={selectedId}
              cues={cues}
              onSelect={(id) => {
                setSelectedId(id)
                if (id) setDrawer('properties')
              }}
              onLayout={(w) => saveWidget(show.projectId, surface.id, w, 'layout').catch(ignore)}
              onTrigger={(w, phase, value) => runWidgetActions(w, phase, value, { engine, cues, hits, surface, projectId: show.projectId, executors: exec })}
              onFaderCommit={(w, value) => saveFaderValue(show.projectId, surface.id, w.id, value).catch(ignore)}
              renderDisplay={(w, preview) =>
                w.display === 'intercom' ? (
                  <MiniIntercom widget={w} preview={preview} />
                ) : w.display === 'stage' ? (
                  <MiniStage widget={w} engine={engine} show={show} cues={cues} stageOpen={ownsStage ? stageShown && !stageCollapsed : null} preview={preview} />
                ) : w.display === 'note' ? (
                  <MiniNote widget={w} engine={engine} cues={cues} script={script} preview={preview} onChange={(nw) => surface && saveWidget(show.projectId, surface.id, nw).catch(ignore)} />
                ) : (
                  <MiniCueMonitor widget={w} engine={engine} cues={cues} preview={preview} />
                )
              }
            />
          )}
        </main>
        {surface && view === 'panel' && execSidebar.open && (
          <>
            <SidebarSplitter prefs={execSidebar} onPrefs={setExecSidebar} />
            <ExecutorSidebar engine={engine} exec={exec} surface={surface} cues={cues} prefs={execSidebar} onPrefs={setExecSidebar} onOpenPage={() => setView('executor')} />
          </>
        )}

        <AnimatePresence>
          {notesShown && (
            <NotesPanel
              key="notes"
              engine={engine}
              cues={cues}
              text={script.text}
              onSave={script.save}
              source={script.source}
              notionUrl={script.notionUrl}
              onSaveSource={script.saveSource}
              prefKey={notesKey}
              overlay={sidebar}
              collapsed={notesCollapsed}
              onCollapsedChange={setNotesCollapsed}
              onHide={() => setNotesShown(false)}
            />
          )}
        </AnimatePresence>

        <AnimatePresence>
          {ownsStage && stageShown && (
            <StagePanel
              key="stage"
              engine={engine}
              show={show}
              cues={cues}
              prefKey={stageKey}
              collapsed={stageCollapsed}
              onCollapsedChange={setStageCollapsed}
              onHide={() => setStageShown(false)}
            />
          )}
        </AnimatePresence>

        <AnimatePresence>
          {surface && (drawer === 'settings' || (drawer === 'properties' && selected && editing)) && (
            <motion.aside
              key={drawer === 'settings' ? 'settings' : `props-${selected?.id}`}
              initial={{ x: 40, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: 40, opacity: 0 }}
              transition={{ duration: 0.18 }}
              className={`absolute inset-y-0 right-0 z-20 w-full max-w-md border-l border-line bg-panel/90 shadow-2xl backdrop-blur-2xl ${
                sidebar ? '' : 'md:relative md:shrink-0'
              }`}
            >
              {drawer === 'settings' ? (
                <SignalSettings
                  surface={surface}
                  onSurfaceTarget={(oscHost, oscPort) => updateSurfaceMeta(show.projectId, surface.id, { oscHost, oscPort }).catch(ignore)}
                  onClose={() => setDrawer(null)}
                />
              ) : (
                selected && (
                  <WidgetProperties
                    widget={selected}
                    cues={cues}
                    hits={hits}
                    projectId={show.projectId}
                    defaultOscTarget={surface.oscHost ? `${surface.oscHost}:${surface.oscPort}` : ''}
                    onChange={(w) => saveWidget(show.projectId, surface.id, w).catch(ignore)}
                    onDelete={() => {
                      removeWidget(show.projectId, surface.id, selected.id, selected.label).catch(ignore)
                      setSelectedId(null)
                      setDrawer(null)
                    }}
                    onClose={() => {
                      setSelectedId(null)
                      setDrawer(null)
                    }}
                  />
                )
              )}
            </motion.aside>
          )}
        </AnimatePresence>
      </div>

      <AnimatePresence>
        {notice && (
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 16 }}
            onAnimationComplete={() => setTimeout(() => setNotice(null), 4000)}
            style={{ marginBottom: 'env(safe-area-inset-bottom)' }} className="fixed bottom-6 left-1/2 z-40 -translate-x-1/2 rounded-full border border-line bg-panel/95 px-5 py-2.5 text-sm shadow-2xl backdrop-blur-xl"
          >
            {notice}
          </motion.div>
        )}
      </AnimatePresence>

      <PromptDialog
        open={naming !== null}
        title={naming === 'rename' ? '重新命名控台' : '新增控制面板'}
        description={naming === 'create' ? '會預先載入內建「Theatre」模組（Cue Monitor、GO、Pause / Panic、Master、Hits 1–8、Stage、Intercom），可再自由調整，或從「📦 模組」改套用「Live Music」。' : undefined}
        initialValue={naming === 'rename' ? surface?.name : ''}
        placeholder="控台名稱"
        confirmLabel={naming === 'rename' ? '儲存' : '建立'}
        onClose={() => setNaming(null)}
        onConfirm={async (name) => {
          if (naming === 'rename' && surface) await updateSurfaceMeta(show.projectId, surface.id, { name })
          else {
            const id = await createSurface(show.projectId, name)
            chooseSurface(id)
            setEditing(true)
          }
        }}
      />
      {surface && (
        <ModulesDialog
          open={modulesOpen}
          onClose={() => setModulesOpen(false)}
          projectId={show.projectId}
          surface={surface}
          cues={cues}
          hits={hits}
          newId={() => newWidgetId(show.projectId, surface.id)}
          onLoaded={(msg) => {
            setSelectedId(null)
            setNotice(msg)
          }}
        />
      )}
    </div>
  )
}
