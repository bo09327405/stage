import { useDimDb } from '../../utils/dim'
import { useProjectLock } from '../../services/projectLock'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useHistoryShortcuts } from '../../services/history'
import {
  addRegions,
  addSection,
  addTrack,
  nextSectionName,
  removeSection,
  setTrackAutomation,
  updateSections,
  createStudio,
  deleteStudio,
  removeRegions,
  removeTrack,
  renameStudio,
  reorderStudios,
  setMasterVolume,
  splitRegions,
  updateRegions,
  updateTrack,
  useLengthSync,
  useStudio,
  useStudioList,
  useStudioPresence,
} from '../../services/studio'
import { loadSource } from '../../studio/audio'
import { uploadStudioAudio } from '../../studio/cloud'
import { uploadStudioFile } from '../../services/storage'
import { recordProjectMedia } from '../../services/mediaLibrary'
import { LaneMenu } from './LaneMenu'
import { StudioTabs } from './StudioTabs'
import { PublishDialog } from './PublishDialog'
import { MasterStrip } from './MasterStrip'
import { isAdmin, useAuth } from '../../services/auth'
import { deleteProject } from '../../services/projects'
import { claimStudio, joinStudio } from '../../services/membership'
import { CurrentUserChip } from '../hub/Hub'
import { contentSig, useLiveAudio } from '../../studio/publish'
import { clampZoom, isAudioFile, timecode, ZOOM_MAX, ZOOM_MIN } from '../../studio/format'
import { StudioPlayer } from '../../studio/player'
import { InputChain, listInputs, type InputDevice } from '../../studio/inputChain'
import { deleteStripPreset, saveStripPreset, stripOf, useStripPresets } from '../../studio/presets'
import { tuneBuffer } from '../../studio/tuner'
import { studioMediaFolder, type ShowRef } from '../../types/project'
import { projectLength, sortedTracks, type StudioRegion, type StudioSection, type StudioTrack } from '../../types/studio'
import { HistoryControls } from '../ui/HistoryControls'
import { InputPanel, type ChainStatus } from './InputPanel'
import { Arrange, HEADER_W, LANE_H, type RecordingPreview } from './Arrange'
import { ExportDialog } from './ExportDialog'
import { FxPanel, Inspector, PropertiesPanel, type InspectorTab } from './Inspector'
import { LibraryPanel } from './LibraryPanel'
import { RegionMenu, type RegionAction } from './RegionMenu'
import { SectionMenu, type SectionAction } from './SectionMenu'
import { StudioFilesDialog, type FilesTab } from './StudioFilesDialog'
import {
  buildStudioFile,
  createStudioFromFile,
  downloadStudioFile,
  duplicateStudio,
  publishToDefault,
  uniqueStudioName,
  type StudioFile,
} from '../../studio/projectFile'
import { TrackHeader } from './TrackHeader'
import { TransportBar } from './TransportBar'
import { TtsPanel } from './TtsPanel'
import { AutoSaveBadge } from '../ui/AutoSaveBadge'
import { useR2AutoSave } from '../../hooks/useR2AutoSave'
import { dawProjectKey } from '../../services/storage'
import { summarizeStudio } from '../../services/versionHistory'
import { applyStudioVersion } from '../../services/versionApply'
import { VersionHistoryDialog } from '../ui/VersionHistoryDialog'
import { StudioVersionPreview } from '../ui/VersionPreviews'

const readPref = (k: string) => {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}
const writePref = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v)
  } catch {
    // not remembered
  }
}

/** Where each open tab was left (playhead, selection), so switching tabs picks up where you were. */
const tabMemory = new Map<string, { playhead: number; selection: string[] }>()

/** Copied regions, shared by every studio tab (paste into another project works too). */
let clipboard: { regions: Omit<StudioRegion, 'id'>[]; trackOrder: string[] } | null = null

/**
 * Theatre DAW Studio: tabbed multitrack projects with a transport, track list, timeline and a
 * tools sidebar. Edits sync live through Firebase (everyone sees each other's playhead and
 * selection) and are undoable; playback is a live Web Audio mix of every track.
 */
export function StudioView({
  show,
  projectName,
  onBack,
  backLabel = '控台',
  standalone = false,
}: {
  show: ShowRef
  projectName: string
  onBack: () => void
  backLabel?: string
  /** A standalone Studio project: its studio is the project, so only admins delete it (to the trash). */
  standalone?: boolean
}) {
  const projectId = show.projectId
  useHistoryShortcuts(projectId)
  const list = useStudioList(projectId)
  const folder = studioMediaFolder(projectName, projectId)

  /* ---------- tabs ---------- */
  const tabsKey = `theatre.studio.tabs.${projectId}`
  const [tabs, setTabs] = useState<string[]>(() => {
    const fromUrl = new URLSearchParams(location.search).get('studio')
    let saved: string[] = []
    try {
      saved = JSON.parse(readPref(tabsKey) ?? '[]')
    } catch {
      // ignore
    }
    return fromUrl && !saved.includes(fromUrl) ? [...saved, fromUrl] : saved
  })
  const [active, setActive] = useState<string | null>(() => new URLSearchParams(location.search).get('studio') ?? tabs[0] ?? null)
  // Drop tabs whose studio was deleted (by anyone). Open tabs follow the shared tab order
  // (studioPath/{sid}/tabOrder); tabs never reordered keep the order they were opened in.
  const existing = list?.map((s) => s.id)
  const rank = (id: string) => list?.find((s) => s.id === id)?.tabOrder ?? Infinity
  const liveTabs = (existing ? tabs.filter((t) => existing.includes(t)) : tabs)
    .map((id, i) => ({ id, i }))
    .sort((a, b) => rank(a.id) - rank(b.id) || a.i - b.i)
    .map((t) => t.id)
  const current = active && liveTabs.includes(active) ? active : (liveTabs[0] ?? null)
  useEffect(() => {
    writePref(tabsKey, JSON.stringify(liveTabs))
    const params = new URLSearchParams(location.search)
    if (current) params.set('studio', current)
    else params.delete('studio')
    history.replaceState(null, '', `${location.pathname}?${params}`)
  }, [tabsKey, liveTabs.join(), current]) // eslint-disable-line react-hooks/exhaustive-deps
  const openTab = (id: string) => {
    setTabs((t) => (t.includes(id) ? t : [...t, id]))
    setActive(id)
  }
  /**
   * Save a new left-to-right order after one tab moved. Every studio of the show gets a tabOrder;
   * only the moved one changes place — it lands next to its new neighbour among the open tabs —
   * so studios not open here (maybe open on someone else's screen) keep their relative order.
   */
  const reorderTabs = (next: string[], moved: string) => {
    if (!list) return
    const local = (id: string) => tabs.indexOf(id)
    const all = list
      .map((s, i) => ({ id: s.id, i }))
      .sort((a, b) => rank(a.id) - rank(b.id) || (local(a.id) >= 0 && local(b.id) >= 0 ? local(a.id) - local(b.id) : a.i - b.i))
      .map((s) => s.id)
      .filter((id) => id !== moved)
    const k = next.indexOf(moved)
    const at = k < next.length - 1 ? all.indexOf(next[k + 1]) : all.indexOf(next[k - 1]) + 1
    all.splice(at, 0, moved)
    setTabs(next)
    reorderStudios(projectId, all).catch((err: Error) => notify(`無法儲存分頁順序：${err.message}`, true))
  }
  const closeTab = (id: string) => {
    setTabs((t) => t.filter((x) => x !== id))
    if (current === id) setActive(liveTabs.filter((x) => x !== id).at(-1) ?? null)
  }
  /** Close several tabs at once (tab menu); if the active one goes, `keep` (the clicked tab) becomes active. */
  const closeTabs = (ids: string[], keep: string) => {
    if (!ids.length) return
    setTabs((t) => t.filter((x) => !ids.includes(x)))
    if (current && ids.includes(current)) setActive(keep)
  }

  const studio = useStudio(projectId, current)
  // Signed in: opening a studio joins it (it appears in your hub); studios you create are yours.
  const { user } = useAuth()
  const lock = useProjectLock(projectId, user)
  const studioId = studio?.id
  const studioName = studio?.name
  const joinedName = useRef(studioName)
  joinedName.current = studioName
  useEffect(() => {
    if (user && studioId && joinedName.current) joinStudio(user, projectId, show.versionId, studioId, joinedName.current).catch(() => {})
  }, [user, studioId, projectId, show.versionId])
  const claim = (id: string, name: string) => {
    if (user) claimStudio(user, projectId, show.versionId, id, name).catch(() => {})
  }
  // Auto-save the open studio to R2 (theatre/projects/{show}/{studio}.json) after each pause in editing.
  const autoSaveFile = useMemo(() => (studio ? { ...buildStudioFile(studio), exportedAt: '' } : null), [studio])
  const autoSaveSig = useMemo(() => (autoSaveFile ? JSON.stringify(autoSaveFile) : null), [autoSaveFile])
  const autoSave = useR2AutoSave(
    studio && !lock.readOnly ? dawProjectKey(projectId, studio.id) : null,
    autoSaveSig,
    () => JSON.stringify({ ...autoSaveFile, exportedAt: new Date().toISOString(), show: { id: projectId, name: projectName }, studioId: studio?.id }),
    summarizeStudio,
  )
  // Fixed-URL MP3 (e.g. embedded in Notion): kept current while this studio is open.
  const live = useLiveAudio(projectId, studio, useMemo(() => (autoSaveSig ? contentSig(autoSaveSig) : null), [autoSaveSig]))
  // Version history (embedded in the same R2 file): badge, project menu, ⌘S = save a version now.
  const [historyOpen, setHistoryOpen] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        if (studio) autoSave.saveNow().catch(() => {})
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [studio, autoSave])
  useLengthSync(projectId, studio)
  const tracks = useMemo(() => (studio ? sortedTracks(studio) : []), [studio])

  /* ---------- player ---------- */
  const [player] = useState(() => new StudioPlayer())
  // Development only: lets automated tests measure the output (never in a production build).
  useEffect(() => {
    if (import.meta.env.DEV) (window as unknown as { __studioPlayer?: StudioPlayer }).__studioPlayer = player
  }, [player])
  const [selection, setSelection] = useState<string[]>([])
  const [playing, setPlaying] = useState(false)
  const [loading, setLoading] = useState(false)
  const [playhead, setPlayhead] = useState(0)
  const [levels, setLevels] = useState({ l: 0, r: 0 })
  const level = Math.max(levels.l, levels.r)
  // Master MUTE / DIM: monitoring only (this listener), remembered on this device; DIM's amount too.
  const [studioDimDb, setStudioDimDb] = useDimDb('studio')
  const [monitor, setMonitor] = useState<{ mute: boolean; dim: boolean }>(() => {
    try {
      return { mute: false, dim: false, ...JSON.parse(localStorage.getItem('theatre.studio.monitor') ?? '{}') }
    } catch {
      return { mute: false, dim: false }
    }
  })
  useEffect(() => {
    player.onEnded = () => {
      setPlaying(false)
      setPlayhead(player.position())
    }
    player.onLoading = setLoading
    return () => player.dispose()
  }, [player])
  // Switching tabs stops playback; each studio comes back where it was left.
  const [tabFor, setTabFor] = useState(current)
  if (tabFor !== current) {
    const back = current ? tabMemory.get(`${projectId}/${current}`) : undefined
    setTabFor(current)
    setPlaying(false)
    setPlayhead(back?.playhead ?? 0)
    setSelection(back?.selection ?? [])
  }
  useEffect(() => {
    player.stop(current ? (tabMemory.get(`${projectId}/${current}`)?.playhead ?? 0) : 0)
  }, [current, player, projectId])
  useEffect(() => {
    if (current) tabMemory.set(`${projectId}/${current}`, { playhead, selection })
  }, [projectId, current, playhead, selection])
  // Follow edits while playing (live for track settings, a quick re-cue for region edits).
  const lastRegions = useRef('')
  useEffect(() => {
    if (!studio) return
    const regions = JSON.stringify(studio.regions)
    player.update(studio, regions !== lastRegions.current)
    lastRegions.current = regions
  }, [studio, player])

  /* ---------- UI state ---------- */
  const [selectedTrack, setSelectedTrack] = useState<string | null>(null)
  const [armed, setArmed] = useState<string | null>(null)
  const [zoom, setZoomState] = useState(() => clampZoom(Number(readPref('theatre.studio.zoom')) || 60))
  const setZoom = (z: number) => {
    setZoomState(z)
    writePref('theatre.studio.zoom', String(Math.round(z)))
  }
  const [automationMode, setAutomationMode] = useState(false)
  const [snap, setSnap] = useState(true)
  const [stereo, setStereo] = useState(() => readPref('theatre.studio.stereo') !== '0')
  // Phones: the track-control column folds into a narrow stub and its controls live in a slide-in drawer.
  // The choice (pinned open on the left, or folded) is remembered; a phone starts folded.
  const [phone, setPhone] = useState(() => window.matchMedia('(max-width: 767px)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)')
    const on = () => setPhone(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  const [tracksFolded, setTracksFolded] = useState(() => readPref('theatre.studio.tracksFolded') !== '0')
  const [trackDrawer, setTrackDrawer] = useState(false)
  const setFolded = (folded: boolean) => {
    setTracksFolded(folded)
    writePref('theatre.studio.tracksFolded', folded ? '1' : '0')
  }
  const folded = phone && tracksFolded
  const headerW = folded ? 44 : HEADER_W
  const [tab, setTab] = useState<InspectorTab>('props')
  // Below lg the side panel is a slide-out drawer over the timeline (always docked from lg up).
  const [sideOpen, setSideOpen] = useState(false)
  // Clicking a clip on the timeline reveals its file in the 素材 panel (folders expanded, highlighted).
  const [reveal, setReveal] = useState<{ url: string; publicId: string; name: string; nonce: number } | null>(null)
  const [menu, setMenu] = useState<{ region: StudioRegion; x: number; y: number } | null>(null)
  const [exportOpen, setExportOpen] = useState<null | { tracks: string[] | null }>(null)
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const notify = (text: string, error = false) => setToast({ text, error })
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), toast.error ? 6000 : 3000)
    return () => clearTimeout(t)
  }, [toast])

  const validSelection = studio ? selection.filter((id) => studio.regions[id]) : []
  const selectedRegions = validSelection.map((id) => studio!.regions[id])
  const trackForInsert = selectedTrack && studio?.tracks[selectedTrack] ? selectedTrack : armed && studio?.tracks[armed] ? armed : (tracks[0]?.id ?? null)

  /* ---------- presence ---------- */
  const { me, others } = useStudioPresence(projectId, current, { playhead, playing, selection: validSelection })

  /* ---------- transport ---------- */
  // Move the playhead and meter every frame while playing.
  useEffect(() => {
    if (!playing) return
    let frame = 0
    const loop = () => {
      setPlayhead(player.position())
      setLevels(player.levels())
      frame = requestAnimationFrame(loop)
    }
    frame = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(frame)
  }, [playing, player])
  useEffect(() => {
    player.setMonitor({ ...monitor, dimDb: studioDimDb })
    try {
      localStorage.setItem('theatre.studio.monitor', JSON.stringify(monitor))
    } catch {
      // ignore
    }
  }, [monitor, studioDimDb, player])
  // Meters fall back to zero when playback stops.
  useEffect(() => {
    if (!playing) setLevels({ l: 0, r: 0 })
  }, [playing])

  const play = async () => {
    if (!studio) return
    if (player.playing) {
      player.pause()
      setPlaying(false)
      setPlayhead(player.position())
      setLevels({ l: 0, r: 0 })
      return
    }
    const from = playhead >= projectLength(studio) - 0.05 ? 0 : playhead
    try {
      setPlaying(true)
      await player.play(studio, from)
    } catch (err) {
      setPlaying(false)
      notify(`無法播放：${(err as Error).message}`, true)
    }
  }
  const stop = () => {
    player.stop(0)
    setPlaying(false)
    setPlayhead(0)
    setLevels({ l: 0, r: 0 })
  }
  const seek = (t: number) => {
    setPlayhead(t)
    player.seek(t)
  }

  /* ---------- edits ---------- */
  const commit = (changes: { id: string; patch: Partial<StudioRegion> }[], label: string, coalesce?: string) => {
    if (!studio || changes.length === 0) return
    updateRegions(projectId, studio.id, changes, label, coalesce).catch((err) => notify((err as Error).message, true))
  }
  const onTrackChange = (track: StudioTrack, patch: Partial<StudioTrack>, label: string) => {
    if (!studio) return
    updateTrack(projectId, studio.id, track, patch, label).catch((err) => notify((err as Error).message, true))
  }

  /** Put an audio file on the timeline at the playhead (selected / armed / first track). */
  const insertUrl = async ({
    url,
    name,
    publicId,
    kind = 'file' as StudioRegion['kind'],
    buffer,
    trackId: onTrack,
    start = playhead,
  }: {
    url: string
    name: string
    publicId: string
    kind?: StudioRegion['kind']
    buffer?: AudioBuffer
    /** A track to put it on (default: the selected / armed / first track). */
    trackId?: string
    /** Where on the timeline (default: the playhead). */
    start?: number
  }): Promise<number> => {
    if (!studio) return 0
    setBusy(url)
    try {
      // A given track may have been created a moment ago (not in this render's studio yet).
      let trackId = onTrack ?? trackForInsert
      if (!trackId) trackId = await addTrack(projectId, studio)
      const duration = (buffer ?? (await loadSource(url))).duration
      const ids = await addRegions(
        projectId,
        studio.id,
        [
          {
            trackId,
            name,
            kind,
            url,
            publicId,
            start,
            offset: 0,
            duration,
            sourceDuration: duration,
            gain: 1,
            fadeIn: 0,
            fadeOut: 0,
            muted: false,
            reverse: false,
            pitch: 0,
            cleanup: false,
            comment: '',
            automation: [],
          },
        ],
        `加入「${name}」`,
      )
      setSelection(ids)
      setSelectedTrack(trackId)
      notify(`已加入「${name}」（${timecode(duration)}）`)
      return duration
    } catch (err) {
      notify(`無法加入：${(err as Error).message}`, true)
      return 0
    } finally {
      setBusy(null)
    }
  }

  /**
   * Upload audio files from the computer to R2 (this studio's folder, and its media library) and
   * place them on `trackId` (null: a new track) from `time`, one after another.
   */
  const uploadAndPlace = async (files: File[], trackId: string | null, time: number) => {
    if (!studio) return
    const audio = files.filter(isAudioFile)
    if (audio.length === 0) return notify(files.length ? '只能上傳音檔（mp3、wav、webm、m4a、ogg、flac…）' : '沒有收到檔案', true)
    if (audio.length < files.length) notify(`略過 ${files.length - audio.length} 個不是音檔的檔案`, true)
    let target = trackId && studio.tracks[trackId] ? trackId : await addTrack(projectId, studio)
    let at = time
    for (const [i, file] of audio.entries()) {
      notify(`上傳到 R2 ${i + 1}/${audio.length}：「${file.name}」…`)
      try {
        const result = await uploadStudioFile(file, { folder, name: file.name })
        await recordProjectMedia(projectId, result, file, folder, 'studio', { studioId: studio.id, category: 'upload' }).catch(() => {})
        const length = await insertUrl({ url: result.secure_url, name: file.name.replace(/\.[^.]+$/, ''), publicId: result.public_id, trackId: target, start: at })
        at += length
      } catch (err) {
        notify(`「${file.name}」上傳失敗：${(err as Error).message}`, true)
      }
    }
  }
  // Right-click on a lane: a small menu at that track / time.
  const [publishOpen, setPublishOpen] = useState(false)
  const [laneMenu, setLaneMenu] = useState<{ trackId: string; time: number; x: number; y: number } | null>(null)
  const laneUpload = useRef<HTMLInputElement>(null)
  const laneTarget = useRef<{ trackId: string; time: number } | null>(null)
  // A file dropped outside the timeline must not make the browser leave the page to open it.
  useEffect(() => {
    const stop = (e: DragEvent) => {
      if ([...(e.dataTransfer?.types ?? [])].includes('Files')) e.preventDefault()
    }
    window.addEventListener('dragover', stop)
    window.addEventListener('drop', stop)
    return () => {
      window.removeEventListener('dragover', stop)
      window.removeEventListener('drop', stop)
    }
  }, [])
  const insertBuffer = async (buffer: AudioBuffer, name: string, kind: StudioRegion['kind']) => {
    // Filed in this Studio's folder: recordings under 錄音, text-to-speech under 語音, anything else in the Studio folder itself.
    const placement = studio ? { studioId: studio.id, category: kind === 'recording' ? ('recording' as const) : kind === 'tts' ? ('tts' as const) : null } : null
    const result = await uploadStudioAudio(buffer, { name, folder, projectId, placement })
    await insertUrl({ url: result.secure_url, name, publicId: result.public_id, kind, buffer })
  }

  /* ---------- region actions (menu + shortcuts) ---------- */
  // Touch helper bar: nudge the selected clips left / right by a chosen step.
  const [nudgeStep, setNudgeStep] = useState(0.1)
  const nudge = (dir: -1 | 1) => {
    const sel = selectedRegions
    if (!sel.length) return
    const delta = dir * nudgeStep
    // Keep the group together: stop at the timeline's start instead of squashing clips.
    const room = Math.min(...sel.map((r) => r.start))
    const d = delta < 0 ? Math.max(delta, -room) : delta
    if (d === 0) return
    commit(sel.map((r) => ({ id: r.id, patch: { start: Math.round((r.start + d) * 1000) / 1000 } })), '微調片段位置', 'nudge')
  }
  /** One track's full control strip (inline column, or inside the phone drawer). */
  const trackHeaderOf = (track: StudioTrack) => (
    <TrackHeader
      track={track}
      armed={armed === track.id}
      onArm={() => setArmed(armed === track.id ? null : track.id)}
      onChange={(patch, label) => onTrackChange(track, patch, label)}
      onRemove={() => removeTrack(projectId, studio!, track)}
      onToggleLane={(param) =>
        setTrackAutomation(projectId, studio!.id, track, param, { shown: !track.automation[param]?.shown, ...(track.automation[param] ? {} : { points: [] }) }, track.automation[param]?.shown ? '隱藏自動化軌' : '顯示自動化軌')
      }
    />
  )

  /** Open the 素材 panel on the file behind a clip. */
  const revealInLibrary = (r: StudioRegion) => {
    if (!r.url) return
    setTab('library')
    setSideOpen(true)
    setReveal({ url: r.url, publicId: r.publicId, name: r.name, nonce: Date.now() })
  }
  const regionAction = async (a: RegionAction) => {
    if (!studio) return
    const sel = selectedRegions
    const ids = sel.map((r) => r.id)
    const copy = () => {
      if (!sel.length) return
      const min = Math.min(...sel.map((r) => r.start))
      clipboard = { regions: sel.map(({ id: _id, ...r }) => ({ ...r, start: r.start - min })), trackOrder: tracks.map((t) => t.id) }
    }
    if (a === 'copy') return copy()
    if (a === 'cut') {
      copy()
      return removeRegions(projectId, studio.id, ids, `剪下 ${ids.length} 個片段`).then(() => setSelection([]))
    }
    if (a === 'delete') return removeRegions(projectId, studio.id, ids, ids.length === 1 ? `刪除「${sel[0].name}」` : `刪除 ${ids.length} 個片段`).then(() => setSelection([]))
    if (a === 'paste') {
      if (!clipboard) return
      // Same tracks when they exist here; otherwise everything lands on the selected track.
      const sameStudio = clipboard.trackOrder.some((t) => studio.tracks[t])
      const regions = clipboard.regions.map((r) => ({ ...r, start: playhead + r.start, trackId: sameStudio && studio.tracks[r.trackId] ? r.trackId : (trackForInsert ?? tracks[0]?.id ?? '') }))
      if (!regions.every((r) => r.trackId)) return
      const newIds = await addRegions(projectId, studio.id, regions, `貼上 ${regions.length} 個片段`)
      return setSelection(newIds)
    }
    if (a === 'duplicate') {
      if (!sel.length) return
      const end = Math.max(...sel.map((r) => r.start + r.duration))
      const min = Math.min(...sel.map((r) => r.start))
      const newIds = await addRegions(projectId, studio.id, sel.map(({ id: _id, ...r }) => ({ ...r, start: end + (r.start - min) })), `複製 ${sel.length} 個片段`)
      return setSelection(newIds)
    }
    if (a === 'split') {
      // Selected regions under the playhead; with none selected, everything under it on the selected track.
      const targets = (sel.length ? sel : Object.values(studio.regions).filter((r) => r.trackId === trackForInsert)).filter((r) => playhead > r.start && playhead < r.start + r.duration)
      navigator.vibrate?.(10)
      const n = await splitRegions(projectId, studio, targets.map((r) => r.id), playhead)
      if (!n) notify('播放頭沒有落在選取的片段上')
      return
    }
    if (!sel.length) return
    if (a === 'reveal') return revealInLibrary(sel[0])
    if (a === 'mute') return commit(sel.map((r) => ({ id: r.id, patch: { muted: !sel[0].muted } })), sel[0].muted ? '取消靜音片段' : '靜音片段')
    if (a === 'reverse') return commit(sel.map((r) => ({ id: r.id, patch: { reverse: !sel[0].reverse } })), sel[0].reverse ? '取消反轉' : '反轉片段')
    if (a === 'cleanup') return commit(sel.map((r) => ({ id: r.id, patch: { cleanup: !sel[0].cleanup } })), sel[0].cleanup ? '取消人聲清理' : '人聲清理')
    if (a === 'resetAutomation') return commit(sel.map((r) => ({ id: r.id, patch: { automation: [] } })), '清除自動化')
    if ('rename' in a) return commit([{ id: sel[0].id, patch: { name: a.rename } }], `片段重新命名為「${a.rename}」`)
    if ('comment' in a) return commit(sel.map((r) => ({ id: r.id, patch: { comment: a.comment } })), a.comment ? '新增註解' : '移除註解')
    if ('pitch' in a) return commit(sel.map((r) => ({ id: r.id, patch: { pitch: a.pitch } })), `變調 ${a.pitch > 0 ? '+' : ''}${a.pitch} 半音`)
  }

  /* ---------- microphone input (channel strip) ---------- */
  const [inputOpen, setInputOpen] = useState(false)
  const [deviceId, setDeviceId] = useState(() => readPref('theatre.studio.inputDevice') ?? '')
  const [monitoring, setMonitoring] = useState(false)
  const [devices, setDevices] = useState<InputDevice[]>([])
  const [chain, setChain] = useState<InputChain | null>(null)
  const [chainStatus, setChainStatus] = useState<ChainStatus>({ state: 'off' })
  const chainRef = useRef<InputChain | null>(null)
  const presets = useStripPresets(projectId)
  // The strip edits the record-armed track, else the selected one.
  const inputTrack = (armed && studio?.tracks[armed]) || (selectedTrack && studio?.tracks[selectedTrack]) || tracks[0] || null

  const openChain = async (device = deviceId, st = stereo): Promise<InputChain> => {
    if (chainRef.current) return chainRef.current
    setChainStatus({ state: 'opening' })
    try {
      const c = await InputChain.open({ deviceId: device || undefined, stereo: st })
      chainRef.current = c
      setChain(c)
      setChainStatus({ state: 'on' })
      listInputs().then(setDevices, () => {})
      return c
    } catch (err) {
      setChainStatus({ state: 'error', message: (err as Error).message })
      throw err
    }
  }
  const closeChain = () => {
    chainRef.current?.close()
    chainRef.current = null
    setChain(null)
    setChainStatus({ state: 'off' })
    setMonitoring(false)
  }
  const reopenChain = (device: string, st: boolean) => {
    if (!chainRef.current || recRef.current) return
    closeChain()
    openChain(device, st).catch(() => {})
  }
  const toggleInputPanel = () => {
    if (inputOpen) {
      setInputOpen(false)
      if (!recRef.current) closeChain()
    } else {
      setInputOpen(true)
      openChain().catch(() => {})
    }
  }
  // Keep the mic chain in step with the track's settings and the monitoring switch.
  const inputKey = JSON.stringify(inputTrack?.input)
  useEffect(() => {
    if (chain && inputTrack) chain.apply(inputTrack.input)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- inputKey stands in for inputTrack.input
  }, [chain, inputKey])
  useEffect(() => {
    if (chain && inputTrack) chain.setMonitoring(monitoring, { volume: inputTrack.volume, pan: inputTrack.pan, reverb: inputTrack.fx.reverb })
  }, [chain, monitoring, inputTrack?.volume, inputTrack?.pan, inputTrack?.fx.reverb]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const md = navigator.mediaDevices
    if (!md?.addEventListener) return
    const refresh = () => listInputs().then(setDevices, () => {})
    md.addEventListener('devicechange', refresh)
    return () => md.removeEventListener('devicechange', refresh)
  }, [])
  useEffect(() => () => chainRef.current?.close(), [])

  /* ---------- recording ---------- */
  const recRef = useRef<{ chain: InputChain; trackId: string; start: number; closeAfter: boolean } | null>(null)
  const [recView, setRecView] = useState<{ preview: RecordingPreview; level: number; channels: number } | null>(null)
  useEffect(() => {
    if (!recView) return
    const t = setInterval(() => {
      const r = recRef.current
      if (r) setRecView((v) => v && { ...v, preview: { ...v.preview, elapsed: r.chain.elapsed() }, level: r.chain.level().peak })
    }, 80)
    return () => clearInterval(t)
  }, [recView !== null]) // eslint-disable-line react-hooks/exhaustive-deps
  const record = async () => {
    if (!studio) return
    if (recRef.current) {
      const { chain: c, trackId, start, closeAfter } = recRef.current
      recRef.current = null
      setRecView(null)
      player.pause()
      setPlaying(false)
      try {
        let buffer = c.stopCapture()
        if (closeAfter) closeChain()
        if (buffer.duration < 0.2) return notify('錄音太短，已捨棄')
        // Tuner set to "after recording": correct the take now, before it's saved.
        const tuner = studio.tracks[trackId]?.input.tuner
        if (tuner?.enabled && !tuner.realtime) buffer = tuneBuffer(buffer, tuner)
        notify('上傳錄音中…')
        const name = `錄音 ${new Date().toLocaleTimeString('zh-TW', { hour12: false })}`
        const result = await uploadStudioAudio(buffer, { name, folder, projectId, placement: { studioId: studio.id, category: 'recording' } })
        const ids = await addRegions(
          projectId,
          studio.id,
          [
            {
              trackId,
              name,
              kind: 'recording',
              url: result.secure_url,
              publicId: result.public_id,
              start,
              offset: 0,
              duration: buffer.duration,
              sourceDuration: buffer.duration,
              gain: 1,
              fadeIn: 0,
              fadeOut: 0,
              muted: false,
              reverse: false,
              pitch: 0,
              cleanup: false,
              comment: '',
              automation: [],
            },
          ],
          '錄音',
        )
        setSelection(ids)
        notify(`✓ 錄音完成 ${timecode(buffer.duration)}（${buffer.numberOfChannels === 2 ? '立體聲' : '單聲道'}${tuner?.enabled ? '・已修音' : ''}）`)
      } catch (err) {
        notify(`錄音儲存失敗：${(err as Error).message}`, true)
      }
      return
    }
    let trackId = armed && studio.tracks[armed] ? armed : trackForInsert
    try {
      if (!trackId) trackId = await addTrack(projectId, studio, '錄音')
      const closeAfter = !chainRef.current
      const c = await openChain()
      const settings = studio.tracks[trackId]?.input
      if (settings) c.apply(settings)
      const start = playhead
      c.startCapture()
      recRef.current = { chain: c, trackId, start, closeAfter }
      setRecView({ preview: { trackId, start, elapsed: 0 }, level: 0, channels: c.channels })
      setArmed(trackId)
      // Play the other tracks while recording (overdub).
      if (Object.keys(studio.regions).length) {
        setPlaying(true)
        player.play(studio, start).catch(() => {})
      }
    } catch (err) {
      notify((err as Error).message, true)
    }
  }
  // A running take keeps the playhead moving even with nothing to play.
  const shownPlayhead = recView ? recView.preview.start + recView.preview.elapsed : playhead

  /* ---------- keyboard ---------- */
  const handlers = useRef({ play, record, regionAction, stop, setAutomationMode, setSelection, studio })
  // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh the shortcut handlers every render
  useEffect(() => {
    handlers.current = { play, record, regionAction, stop, setAutomationMode, setSelection, studio }
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return
      if ((e.target as HTMLElement).closest?.('input, textarea, select, [contenteditable]')) return
      const h = handlers.current
      const mod = e.metaKey || e.ctrlKey
      const key = e.key.toLowerCase()
      if (mod && ['c', 'x', 'v', 'd', 'e', 'm'].includes(key)) {
        e.preventDefault()
        h.regionAction({ c: 'copy', x: 'cut', v: 'paste', d: 'duplicate', e: 'split', m: 'mute' }[key] as RegionAction)
      } else if (mod && key === 'a') {
        e.preventDefault()
        if (h.studio) h.setSelection(Object.keys(h.studio.regions))
      } else if (mod) {
        return
      } else if (e.code === 'Space') {
        e.preventDefault()
        if (!e.repeat) h.play()
      } else if (key === 'r') h.record()
      else if (key === 'a') h.setAutomationMode((m) => !m)
      else if (e.key === 'Home' || e.key === 'Enter') h.stop()
      else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        h.regionAction('delete')
      } else if (e.key === 'Escape') h.setSelection([])
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /* ---------- previews ---------- */
  const previewBuffer = (buffer: AudioBuffer) => {
    const ctx = player.context
    ctx.resume().then(() => {
      const src = new AudioBufferSourceNode(ctx, { buffer })
      src.connect(player.output())
      src.start()
    })
  }

  /* ---------- new / rename / delete studio ---------- */
  const [naming, setNaming] = useState<null | { mode: 'create' | 'rename' | 'saveAs'; value: string }>(null)
  /* ---------- project files (export / import / save as / cloud) ---------- */
  const [filesDialog, setFilesDialog] = useState<FilesTab | null>(null)
  const [projectMenu, setProjectMenu] = useState<{ x: number; y: number } | null>(null)
  const takenNames = list?.map((s) => s.name) ?? []
  const importFile = async (file: StudioFile, name: string) => {
    const id = await createStudioFromFile(projectId, file, name, `匯入 Studio「${name}」`)
    claim(id, name)
    setFilesDialog(null)
    openTab(id)
    notify(`✓ 已匯入「${name}」（${Object.keys(file.studio.regions).length} 個片段）`)
  }
  /** Publish a copy to the Default shared library (this show's own copy is the auto-save). */
  const publishDefault = async () => {
    if (!studio) return
    notify('發佈到 Default 共用…')
    try {
      await publishToDefault({ projectName, studio })
      notify(`✓ 已發佈到 Default 共用資料夾：「${studio.name}」`)
    } catch (err) {
      notify(`上傳失敗：${(err as Error).message}`, true)
    }
  }
  const [openMenu, setOpenMenu] = useState<{ x: number; y: number } | null>(null)
  const [creating, setCreating] = useState(false)
  /** "+": a new studio with the next free name, opened in a new tab (rename by double-clicking the tab). */
  const createNew = async () => {
    if (creating) return
    setCreating(true)
    try {
      const names = new Set(list?.map((s) => s.name))
      let n = (list?.length ?? 0) + 1
      while (names.has(`Studio ${n}`)) n++
      const id = await createStudio(projectId, `Studio ${n}`, { parentProjectId: standalone ? undefined : projectId })
      claim(id, `Studio ${n}`)
      openTab(id)
      notify(`已建立「Studio ${n}」· 雙擊分頁可重新命名`)
    } catch (err) {
      notify(`無法建立：${(err as Error).message}`, true)
    } finally {
      setCreating(false)
    }
  }
  const submitName = async () => {
    if (!naming) return
    const name = naming.value.trim()
    if (!name) return
    if (naming.mode === 'create') {
      const id = await createStudio(projectId, name, { parentProjectId: standalone ? undefined : projectId })
      claim(id, name)
      openTab(id)
    }
    else if (naming.mode === 'saveAs' && studio) {
      const id = await duplicateStudio(projectId, studio, name)
      claim(id, name)
      openTab(id)
      notify(`✓ 已另存為「${name}」並開啟`)
    }
    else if (studio) await renameStudio(projectId, studio.id, name)
    setNaming(null)
  }

  /* ---------- sections ---------- */
  const [sectionMenu, setSectionMenu] = useState<{ section: StudioSection; x: number; y: number } | null>(null)
  const sectionAction = (sec: StudioSection, a: SectionAction) => {
    if (!studio) return
    const commitSec = (patch: Partial<StudioSection>, label: string) => updateSections(projectId, studio.id, [{ id: sec.id, patch }], label).catch((err) => notify((err as Error).message, true))
    if (a === 'jump') return seek(sec.start)
    if (a === 'delete') return removeSection(projectId, studio.id, sec)
    if (a === 'select') {
      const ids = Object.values(studio.regions).filter((r) => r.start < sec.end && r.start + r.duration > sec.start).map((r) => r.id)
      setSelection(ids)
      return notify(`已選取區段「${sec.name}」內 ${ids.length} 個片段`)
    }
    if ('rename' in a) return commitSec({ name: a.rename }, `區段重新命名為「${a.rename}」`)
    if ('color' in a) return commitSec({ color: a.color }, '區段顏色')
    if ('length' in a) return commitSec({ end: Math.round((sec.start + a.length) * 1000) / 1000 }, `區段「${sec.name}」長度 ${a.length}s`)
  }

  const length = studio ? projectLength(studio) : 0
  const selectedTrackObj = (selectedTrack && studio?.tracks[selectedTrack]) || null

  return (
    <div className="flex h-dvh flex-col bg-ink text-white" data-studio>
      {/* Header: back, tabs, collaborators, undo */}
      {/* Safe-area padding keeps the buttons clear of the notch / Dynamic Island / status bar (and rounded corners in landscape);
          on phones the tab strip drops to its own row so nothing is pushed off-screen. */}
      <header
        className="relative z-40 flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line bg-panel/80 pt-[calc(0.375rem+env(safe-area-inset-top,0px))] pr-[max(0.75rem,env(safe-area-inset-right,0px))] pb-1.5 pl-[max(0.75rem,env(safe-area-inset-left,0px))] backdrop-blur-xl sm:flex-nowrap"
        data-studio-header
      >
        <button type="button" onClick={onBack} className="flex min-h-11 items-center sm:min-h-9 rounded-lg px-2 text-sm text-white/60 hover:bg-white/10 hover:text-white" title="回到 Set Cue 控台">
          ‹ {backLabel}
        </button>
        <div className="mr-1 hidden min-w-0 sm:block">
          <div className="truncate text-xs font-semibold">🎚 DAW Studio</div>
          <div className="truncate text-[10px] text-white/40">{projectName}</div>
        </div>
        <div className="no-scrollbar order-last flex min-w-0 basis-full items-center gap-1 overflow-x-auto sm:order-none sm:flex-1 sm:basis-0" role="tablist" aria-label="Studio 專案" data-studio-tabs>
          <StudioTabs
            tabs={liveTabs}
            names={Object.fromEntries((list ?? []).map((s) => [s.id, s.name]))}
            current={current}
            canReorder={!lock.readOnly && !!list}
            onSelect={setActive}
            onClose={closeTab}
            onCloseOthers={(id) => closeTabs(liveTabs.filter((x) => x !== id), id)}
            onCloseRight={(id) => closeTabs(liveTabs.slice(liveTabs.indexOf(id) + 1), id)}
            onRename={() => studio && setNaming({ mode: 'rename', value: studio.name })}
            onReorder={reorderTabs}
            hrefFor={(id) =>
              `${location.origin}${location.pathname}?role=studio&project=${encodeURIComponent(projectId)}&version=${encodeURIComponent(show.versionId)}&studio=${encodeURIComponent(id)}`
            }
            onPopOut={closeTab}
            onNotify={notify}
          />
          <button
            type="button"
            onClick={createNew}
            disabled={creating}
            className="h-8 shrink-0 rounded-lg px-2.5 text-sm text-white/60 hover:bg-white/10 hover:text-white disabled:opacity-40"
            aria-label="新增 Studio 專案"
            title="新增 Studio 專案（新分頁）"
            data-studio-new
          >
            ＋
          </button>
          {list && list.some((s) => !liveTabs.includes(s.id)) && (
            <button
              type="button"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect()
                setOpenMenu(openMenu ? null : { x: r.left, y: r.bottom + 4 })
              }}
              className="h-8 shrink-0 rounded-lg px-2 text-xs text-white/50 hover:bg-white/10 hover:text-white"
              title="開啟其他 Studio 專案"
              aria-expanded={!!openMenu}
              data-studio-open-menu
            >
              ⌄ 開啟
            </button>
          )}
        </div>
        <div className="ml-auto flex items-center -space-x-1.5" title="正在編輯的成員" data-collaborators>
          <span className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-panel text-[10px] font-bold text-black" style={{ background: me.color }} title={`${me.name}（你）`}>
            {me.name.slice(-2)}
          </span>
          {others.map((o) => (
            <span key={o.id} className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-panel text-[10px] font-bold text-black" style={{ background: o.color }} title={`${o.name}${o.playing ? '（播放中）' : ''}`}>
              {(o.name ?? '?').slice(-2)}
            </span>
          ))}
        </div>
        <button
          type="button"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            setProjectMenu(projectMenu ? null : { x: r.right, y: r.bottom + 4 })
          }}
          aria-expanded={!!projectMenu}
          className="min-h-11 rounded-lg bg-white/[0.07] px-3 text-xs font-semibold text-white/85 hover:bg-white/15 sm:min-h-9"
          data-project-menu
        >
          📁 專案 ▾
        </button>
        {studio && <AutoSaveBadge status={autoSave.status} onClick={() => setHistoryOpen(true)} />}
        <CurrentUserChip />
        <HistoryControls compact />
        {studio && (
          <>
            <button type="button" onClick={() => setPublishOpen(true)} className="min-h-9 rounded-lg bg-accent/20 px-3 text-xs font-semibold text-accent hover:bg-accent hover:text-white" title="專案連結、公開音檔（可嵌入 Notion）" data-studio-publish>
              🔗 發布
            </button>
            <button type="button" onClick={() => setExportOpen({ tracks: null })} className="min-h-9 rounded-lg bg-white/[0.07] px-3 text-xs font-semibold text-white/85 hover:bg-white/15" title="混音匯出成 WAV" data-studio-export>
              ⇩ 音訊
            </button>
            {standalone ? (
              user &&
              isAdmin(user) && (
                <button
                  type="button"
                  onClick={async () => {
                    if (!confirm(`刪除 Studio 專案「${studio.name}」？\n專案會移到管理員回收桶，可隨時還原。`)) return
                    try {
                      await deleteProject(projectId, user)
                      onBack()
                    } catch (err) {
                      alert((err as Error).message)
                    }
                  }}
                  className="min-h-9 rounded-lg px-2 text-xs text-white/35 hover:bg-panic/15 hover:text-panic"
                  title="刪除此 Studio 專案（移到回收桶，管理員可還原）"
                  data-studio-delete
                >
                  🗑
                </button>
              )
            ) : (
              <button
                type="button"
                onClick={() => confirm(`刪除 Studio「${studio.name}」？（可用 ⌘Z 復原；綁定它的 Cue 會無法播放）`) && deleteStudio(projectId, studio.id, studio.name)}
                className="min-h-9 rounded-lg px-2 text-xs text-white/35 hover:bg-panic/15 hover:text-panic"
                title="刪除此 Studio（專案內容，成員可刪除）"
                data-studio-delete
              >
                🗑
              </button>
            )}
          </>
        )}
      </header>

      {studio === null && current && <p className="p-8 text-sm text-white/40">載入 Studio…</p>}
      {!current && (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
          <div className="text-5xl">🎚</div>
          <p className="text-white/60">{list?.length ? '選擇要開啟的 Studio 專案' : '這個演出還沒有 Studio 專案'}</p>
          <div className="flex max-w-lg flex-wrap justify-center gap-2">
            {list?.map((s) => (
              <button key={s.id} type="button" onClick={() => openTab(s.id)} className="min-h-11 rounded-xl bg-white/[0.07] px-4 text-sm hover:bg-white/15">
                {s.name} <span className="ml-1 font-mono text-xs text-white/40">{timecode(s.length, false)}</span>
              </button>
            ))}
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            <button type="button" onClick={() => setNaming({ mode: 'create', value: `Studio ${(list?.length ?? 0) + 1}` })} className="min-h-12 rounded-xl bg-accent px-6 text-sm font-semibold" data-studio-create-first>
              ＋ 建立 Studio 專案
            </button>
            <button type="button" onClick={() => setFilesDialog('local')} className="min-h-12 rounded-xl bg-white/[0.08] px-6 text-sm font-semibold hover:bg-white/15" data-studio-import-first>
              📁 匯入專案…
            </button>
            <button type="button" onClick={() => setFilesDialog('default')} className="min-h-12 rounded-xl bg-white/[0.08] px-6 text-sm font-semibold hover:bg-white/15">
              ☁ 從 Default 開啟
            </button>
          </div>
          <p className="max-w-md text-xs text-white/35">在 Studio 編好的多軌音效，可以直接在 Set Cue 的音訊 Cue 選擇「DAW Studio」綁定，GO 時即時混音播放，不需要匯出。</p>
        </div>
      )}

      {studio && (
        <>
          <TransportBar
            playing={playing}
            loading={loading}
            recording={recView ? { elapsed: recView.preview.elapsed, level: recView.level, channels: recView.channels } : null}
            position={shownPlayhead}
            length={length}
            level={level}
            master={
              studio && (
                <MasterStrip
                  volume={studio.masterVolume}
                  onVolume={(v, undim) => {
                    // Moving the Master fader while DIM is on switches DIM off at that level.
                    if (undim) setMonitor((m) => ({ ...m, dim: false }))
                    setMasterVolume(projectId, studio.id, v).catch((err: Error) => notify(err.message, true))
                  }}
                  levels={levels}
                  mute={monitor.mute}
                  dim={monitor.dim}
                  onMute={() => setMonitor((m) => ({ ...m, mute: !m.mute }))}
                  onDim={() => setMonitor((m) => ({ ...m, dim: !m.dim }))}
                  dimDb={studioDimDb}
                  onDimDb={setStudioDimDb}
                />
              )
            }
            stereo={stereo}
            automationMode={automationMode}
            snap={snap}
            onPlay={play}
            onStop={stop}
            onRewind={() => seek(0)}
            onRecord={record}
            onStereo={() => {
              setStereo(!stereo)
              writePref('theatre.studio.stereo', stereo ? '0' : '1')
            }}
            onAutomation={() => setAutomationMode(!automationMode)}
            onSnap={() => setSnap(!snap)}
            inputOpen={inputOpen}
            onInput={toggleInputPanel}
          />
          <div className="flex min-h-0 flex-1">
            <div className="relative min-w-0 flex-1">
              <Arrange
                studio={studio}
                tracks={tracks}
                zoom={zoom}
                onZoom={setZoom}
                playhead={shownPlayhead}
                onSeek={seek}
                selection={validSelection}
                onSelect={setSelection}
                onDropFiles={(files, trackId, time) => uploadAndPlace(files, trackId, time)}
                onLaneMenu={(trackId, time, x, y) => setLaneMenu({ trackId, time, x, y })}
                selectedTrack={selectedTrack}
                onSelectTrack={setSelectedTrack}
                automationMode={automationMode}
                snap={snap}
                others={others}
                recording={recView?.preview ?? null}
                following={playing || !!recView}
                onCommit={(changes, label) => commit(changes, label)}
                onRegionMenu={(region, x, y) => setMenu({ region, x, y })}
                onRegionClick={(r) => {
                  // Phones: selecting a clip only highlights it — the library covers the timeline there.
                  // It opens from the menu / helper bar instead ("在素材庫中定位").
                  if (window.matchMedia('(max-width: 767px)').matches) return
                  revealInLibrary(r)
                }}
                onSectionsCommit={(changes, label) => updateSections(projectId, studio.id, changes, label).catch((err) => notify((err as Error).message, true))}
                onAddSection={(start, end) => addSection(projectId, studio, { name: nextSectionName(studio), start: Math.round(start * 1000) / 1000, end: Math.round(end * 1000) / 1000 })}
                onSectionMenu={(section, x, y) => setSectionMenu({ section, x, y })}
                onTrackAutomation={(track, param, points, label) => setTrackAutomation(projectId, studio.id, track, param, { points, shown: true }, label)}
                onHideLane={(track, param) => setTrackAutomation(projectId, studio.id, track, param, { shown: false }, '隱藏自動化軌')}
                headerWidth={headerW}
                corner={
                  folded ? (
                    <button type="button" onClick={() => setTrackDrawer(true)} className="flex h-full w-full items-center justify-center text-base" aria-label="開啟音軌列表" data-track-drawer-open>
                      🎛
                    </button>
                  ) : (
                    <span className="text-[10px] font-semibold tracking-widest text-white/40 uppercase">{tracks.length} 音軌</span>
                  )
                }
                footer={
                  folded ? (
                    <button type="button" onClick={() => addTrack(projectId, studio)} className="flex h-9 w-full items-center justify-center rounded-lg border border-dashed border-white/20 text-sm text-white/60" aria-label="新增音軌">
                      ＋
                    </button>
                  ) : (
                  <button type="button" onClick={() => addTrack(projectId, studio)} className="min-h-9 w-full rounded-lg border border-dashed border-white/20 text-xs text-white/60 hover:border-accent hover:text-white" data-add-track>
                    ＋ 新增音軌
                  </button>
                  )
                }
                renderHeader={(track) =>
                  folded ? (
                    <button
                      type="button"
                      onClick={() => setTrackDrawer(true)}
                      className="flex h-full w-full flex-col items-center justify-center gap-1.5 text-[10px] font-bold text-white/70"
                      aria-label={`音軌 ${track.name}：開啟音軌列表`}
                    >
                      <span className="h-3 w-3 rounded-full" style={{ background: track.color }} />
                      <span className="max-w-full overflow-hidden px-0.5 text-center leading-tight break-all">{[...track.name][0]}</span>
                      {track.mute && <span className="text-standby">M</span>}
                      {track.solo && <span className="text-accent">S</span>}
                    </button>
                  ) : (
                    trackHeaderOf(track)
                  )
                }
              />
              {/* Zoom (bottom right) */}
              <div className="absolute right-3 bottom-3 z-30 flex items-center gap-1.5 rounded-xl border border-white/10 bg-[#1d1d1d]/95 px-2 py-1.5 shadow-xl backdrop-blur" data-zoom>
                <button
                  type="button"
                  onClick={() => (folded ? setTrackDrawer(true) : setFolded(true))}
                  className="h-9 rounded-md bg-white/10 px-2.5 text-[11px] font-semibold text-white/85 hover:bg-white/15 md:hidden"
                  aria-label={folded ? '開啟音軌列表' : '收合音軌欄位'}
                  aria-expanded={!folded}
                  data-tracks-toggle
                >
                  🎛 {folded ? '音軌列表' : '收合音軌'}
                </button>
                <button
                  type="button"
                  onClick={() => setSideOpen(true)}
                  className="h-9 rounded-md bg-white/10 px-2.5 text-[11px] font-semibold text-white/85 hover:bg-white/15 lg:hidden"
                  aria-label="開啟素材與屬性面板"
                  aria-expanded={sideOpen}
                  data-side-toggle
                >
                  ☰ 面板
                </button>
                <button type="button" onClick={() => setZoom(clampZoom(zoom / 1.5))} className="h-7 w-7 rounded-md text-sm text-white/70 hover:bg-white/10" aria-label="縮小">
                  −
                </button>
                <input
                  type="range"
                  min={Math.log(ZOOM_MIN)}
                  max={Math.log(ZOOM_MAX)}
                  step={0.01}
                  value={Math.log(zoom)}
                  onChange={(e) => setZoom(clampZoom(Math.exp(Number(e.target.value))))}
                  className="w-28 accent-[#0a84ff]"
                  aria-label="時間軸縮放"
                  title="縮放（也可用 ⌘/Ctrl + 滾輪，或觸控板兩指開合）"
                  data-zoom-slider
                />
                <button type="button" onClick={() => setZoom(clampZoom(zoom * 1.5))} className="h-7 w-7 rounded-md text-sm text-white/70 hover:bg-white/10" aria-label="放大">
                  ＋
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const width = (document.querySelector('[data-arrange]')?.clientWidth ?? 900) - headerW - 40
                    setZoom(clampZoom(width / Math.max(5, length)))
                  }}
                  className="h-7 rounded-md px-2 text-[11px] text-white/60 hover:bg-white/10"
                  title="縮放到整個專案"
                >
                  ⤢
                </button>
                <span className="w-14 text-right font-mono text-[10px] text-white/40 tabular">{Math.round(zoom)} px/s</span>
              </div>
            </div>
            {sideOpen && <div className="fixed inset-0 z-[55] bg-black/50 lg:hidden" onClick={() => setSideOpen(false)} aria-hidden data-side-backdrop />}
            <div
              className={`fixed inset-y-0 right-0 z-[60] flex w-[min(340px,88vw)] flex-col max-sm:inset-x-0 max-sm:top-auto max-sm:bottom-0 max-sm:h-[85dvh] max-sm:w-full max-sm:rounded-t-2xl lg:block bg-[#151515] pt-[env(safe-area-inset-top,0px)] pr-[env(safe-area-inset-right,0px)] pb-[env(safe-area-inset-bottom,0px)] shadow-2xl transition-[transform,visibility] duration-200 lg:static lg:z-auto lg:w-[320px] lg:shrink-0 lg:translate-x-0 lg:p-0 lg:shadow-none ${sideOpen ? 'translate-x-0' : 'invisible translate-x-full lg:visible'}`}
              data-side-drawer
              data-open={sideOpen}
            >
              <div className="flex shrink-0 items-center justify-between border-b border-line px-3 py-1 lg:hidden">
                <span className="text-xs font-semibold text-white/60">素材與屬性</span>
                <button type="button" onClick={() => setSideOpen(false)} className="h-9 rounded-md px-3 text-sm text-white/60 hover:bg-white/10 hover:text-white" aria-label="關閉面板">
                  ✕
                </button>
              </div>
              <div className="min-h-0 flex-1 lg:h-full">
              <Inspector tab={tab} onTab={setTab}>
                {tab === 'props' && (
                  <PropertiesPanel
                    studio={studio}
                    region={selectedRegions[0] ?? null}
                    selectionCount={selectedRegions.length}
                    track={selectedTrackObj}
                    onRegion={(patch, label, coalesce) => selectedRegions[0] && commit([{ id: selectedRegions[0].id, patch }], label, coalesce)}
                    onTrack={(patch, label) => selectedTrackObj && onTrackChange(selectedTrackObj, patch, label)}
                    onMaster={(v) => setMasterVolume(projectId, studio.id, v)}
                  />
                )}
                {tab === 'fx' && <FxPanel track={selectedTrackObj ?? tracks[0] ?? null} onTrack={(patch, label) => onTrackChange(selectedTrackObj ?? tracks[0], patch, label)} />}
                {tab === 'library' && <LibraryPanel projectId={projectId} projectName={projectName} readOnly={lock.readOnly} studios={list ?? []} studioId={current} reveal={reveal} folder={folder} busy={busy} onInsert={(m) => insertUrl(m)} onNotify={notify} />}
                {tab === 'tts' && <TtsPanel onPreview={previewBuffer} onInsert={(buffer, name) => insertBuffer(buffer, name, 'tts')} />}
              </Inspector>
              </div>
            </div>
          </div>
          {inputOpen && inputTrack && (
            <InputPanel
              track={inputTrack}
              chain={chain}
              status={chainStatus}
              devices={devices}
              deviceId={deviceId}
              stereo={stereo}
              monitoring={monitoring}
              presets={presets}
              selectedRegionCleanup={selectedRegions[0] ? selectedRegions[0].cleanup : null}
              onDevice={(id) => {
                setDeviceId(id)
                writePref('theatre.studio.inputDevice', id)
                reopenChain(id, stereo)
              }}
              onStereo={(st) => {
                setStereo(st)
                writePref('theatre.studio.stereo', st ? '1' : '0')
                reopenChain(deviceId, st)
              }}
              onMonitoring={setMonitoring}
              onTrack={(patch, label) => onTrackChange(inputTrack, patch, label)}
              onInput={(patch, label) => onTrackChange(inputTrack, { input: { ...inputTrack.input, ...patch } }, label)}
              onApplyPreset={(p) =>
                onTrackChange(
                  inputTrack,
                  { input: p.settings.input, volume: p.settings.volume, pan: p.settings.pan, eq: p.settings.eq, fx: { ...inputTrack.fx, reverb: p.settings.reverb, compressor: p.settings.compressor, highpass: p.settings.highpass } },
                  `套用預設「${p.name}」`,
                )
              }
              onSavePreset={async (name) => {
                await saveStripPreset(projectId, name, stripOf(inputTrack))
                notify(`已儲存預設集「${name}」（團隊共用）`)
              }}
              onDeletePreset={(p) => deleteStripPreset(projectId, p.id).then(() => notify(`已刪除預設集「${p.name}」`))}
              onCleanupRegion={() => regionAction('cleanup')}
              onClose={toggleInputPanel}
            />
          )}
          <div className="flex items-center gap-3 border-t border-line bg-[#121212] px-3 py-1 text-[10px] text-white/35">
            <span>Space 播放 · R 錄音 · A 自動化 · ⌘E 分割 · ⌘M 靜音 · ⌘C/X/V 複製剪下貼上 · ⌘D 複製一份 · ⌫ 刪除 · ⌘Z 復原</span>
            <span className="ml-auto">已選 {validSelection.length} 個片段 · 長度 {timecode(length)}</span>
          </div>
          {/* Phone track drawer: every track's controls, sliding over the timeline */}
          {phone && (
            <>
              <div
                className={`fixed inset-0 z-[74] bg-black/50 transition-opacity duration-200 ${trackDrawer ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
                onClick={() => setTrackDrawer(false)}
                aria-hidden
                data-track-backdrop
              />
              <aside
                className={`fixed inset-y-0 left-0 z-[75] flex w-[min(340px,90vw)] flex-col bg-[#151515] pt-[env(safe-area-inset-top,0px)] pb-[env(safe-area-inset-bottom,0px)] pl-[env(safe-area-inset-left,0px)] shadow-2xl transition-[transform,visibility] duration-200 will-change-transform ${trackDrawer ? 'visible translate-x-0' : 'invisible -translate-x-full'}`}
                aria-label="音軌列表"
                aria-hidden={!trackDrawer}
                data-track-drawer
              >
                <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
                  <span className="text-sm font-semibold">🎛 音軌列表 · {tracks.length}</span>
                  <button
                    type="button"
                    onClick={() => {
                      setFolded(false)
                      setTrackDrawer(false)
                    }}
                    className="ml-auto h-10 rounded-lg bg-white/10 px-3 text-xs font-semibold"
                    title="固定顯示在左側（再按「收合音軌」可收起）"
                  >
                    📌 固定在左側
                  </button>
                  <button type="button" onClick={() => setTrackDrawer(false)} className="h-10 w-10 rounded-lg bg-white/10 text-lg" aria-label="關閉音軌列表">
                    ✕
                  </button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                  {tracks.map((track) => (
                    <div
                      key={track.id}
                      className={`border-b border-line ${selectedTrack === track.id ? 'bg-[#232323]' : 'bg-[#191919]'}`}
                      style={{ height: LANE_H }}
                      onPointerDown={() => setSelectedTrack(track.id)}
                    >
                      {trackHeaderOf(track)}
                    </div>
                  ))}
                  <div className="p-3">
                    <button type="button" onClick={() => addTrack(projectId, studio!)} className="min-h-12 w-full rounded-lg border border-dashed border-white/20 text-sm text-white/70">
                      ＋ 新增音軌
                    </button>
                  </div>
                </div>
              </aside>
            </>
          )}
          {/* Touch helper bar: the same actions as the long-press menu, one tap away */}
          {selectedRegions.length > 0 && !menu && (
            <div
              className="fixed bottom-[max(0.75rem,env(safe-area-inset-bottom))] left-1/2 z-[70] hidden max-w-[96vw] -translate-x-1/2 items-center gap-1 overflow-x-auto rounded-2xl border border-white/15 bg-[#1c1c1e]/95 p-1.5 shadow-2xl backdrop-blur-xl pointer-coarse:flex no-scrollbar"
              data-touch-bar
            >
              <button type="button" className="h-12 shrink-0 rounded-xl bg-white/10 px-3 text-sm font-semibold" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ region: selectedRegions[0], x: r.left, y: r.top }) }}>編輯選單</button>
              <button type="button" data-haptic="tap" className="h-12 w-12 shrink-0 rounded-xl bg-white/10 text-lg" aria-label="往前微調" onClick={() => nudge(-1)}>◀</button>
              <button type="button" className="h-12 shrink-0 rounded-xl bg-white/[0.06] px-2 font-mono text-xs text-white/70" aria-label="微調步進" onClick={() => setNudgeStep((s) => (s === 0.01 ? 0.1 : s === 0.1 ? 1 : 0.01))}>{nudgeStep}s</button>
              <button type="button" data-haptic="tap" className="h-12 w-12 shrink-0 rounded-xl bg-white/10 text-lg" aria-label="往後微調" onClick={() => nudge(1)}>▶</button>
              {selectedRegions[0]?.url && <button type="button" className="h-12 shrink-0 rounded-xl bg-white/10 px-3 text-sm font-semibold" onClick={() => regionAction('reveal')}>素材庫定位</button>}
              <button type="button" data-haptic="tap" className="h-12 shrink-0 rounded-xl bg-white/10 px-3 text-sm font-semibold" onClick={() => regionAction('duplicate')}>複製</button>
              <button type="button" data-haptic="strong" className="h-12 shrink-0 rounded-xl bg-panic/80 px-3 text-sm font-semibold text-white" onClick={() => regionAction('delete')}>刪除</button>
            </div>
          )}
          {menu && (
            <RegionMenu
              region={studio.regions[menu.region.id] ?? menu.region}
              count={validSelection.length}
              x={menu.x}
              y={menu.y}
              canPaste={!!clipboard}
              onAction={regionAction}
              onClose={() => setMenu(null)}
            />
          )}
          <ExportDialog open={!!exportOpen} studio={studio} projectId={projectId} folder={folder} initialTracks={exportOpen?.tracks ?? null} onClose={() => setExportOpen(null)} />
        </>
      )}

      {naming && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-4" onClick={() => setNaming(null)}>
          <form
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault()
              submitName().catch((err) => notify((err as Error).message, true))
            }}
            className="w-full max-w-sm space-y-3 rounded-2xl border border-line bg-panel p-5"
            data-studio-name-dialog
          >
            <h2 className="font-semibold">{{ create: '新增 Studio 專案', rename: '重新命名 Studio', saveAs: '另存新檔（複製成新的 Studio 專案）' }[naming.mode]}</h2>
            <input autoFocus value={naming.value} onChange={(e) => setNaming({ ...naming, value: e.target.value })} className="w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm outline-none focus:border-accent" />
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setNaming(null)} className="min-h-10 rounded-lg px-4 text-sm text-white/60 hover:bg-white/10">
                取消
              </button>
              <button type="submit" className="min-h-10 rounded-lg bg-accent px-4 text-sm font-semibold">
                {{ create: '建立', rename: '儲存', saveAs: '另存' }[naming.mode]}
              </button>
            </div>
          </form>
        </div>
      )}

      {openMenu && list && (
        <OpenStudioMenu
          x={openMenu.x}
          y={openMenu.y}
          studios={list.filter((s) => !liveTabs.includes(s.id))}
          onOpen={(id) => {
            setOpenMenu(null)
            openTab(id)
          }}
          onClose={() => setOpenMenu(null)}
        />
      )}
      {sectionMenu && studio?.sections[sectionMenu.section.id] && (
        <SectionMenu section={studio.sections[sectionMenu.section.id]} x={sectionMenu.x} y={sectionMenu.y} onAction={(a) => sectionAction(studio.sections[sectionMenu.section.id], a)} onClose={() => setSectionMenu(null)} />
      )}

      {projectMenu && (
        <ProjectMenu
          x={projectMenu.x}
          y={projectMenu.y}
          hasStudio={!!studio}
          onClose={() => setProjectMenu(null)}
          onAction={(a) => {
            setProjectMenu(null)
            if (a === 'export' && studio) {
              downloadStudioFile(studio)
              notify(`已下載「${studio.name}.daw.json」（僅此 Studio，不含 Set Cue 母專案）`)
            } else if (a === 'saveAs' && studio) setNaming({ mode: 'saveAs', value: uniqueStudioName(`${studio.name} 副本`, takenNames) })
            else if (a === 'import') setFilesDialog('local')
            else if (a === 'openDefault') setFilesDialog('default')
            else if (a === 'openShow') setFilesDialog('show')
            else if (a === 'publishDefault') publishDefault()
            else if (a === 'share') setPublishOpen(true)
            else if (a === 'history') setHistoryOpen(true)
            else if (a === 'saveVersion') autoSave.saveNow().then(() => notify('✓ 已建立手動存檔版本'), (err: Error) => notify(`存檔失敗：${err.message}`, true))
          }}
        />
      )}
      {studio && (
        <VersionHistoryDialog
          open={historyOpen}
          onClose={() => setHistoryOpen(false)}
          title={`DAW Studio「${studio.name}」`}
          fileKey={dawProjectKey(projectId, studio.id)}
          revision={autoSave.revision}
          saveNow={autoSave.saveNow}
          live={async () => ({ ...autoSaveFile, show: { id: projectId, name: projectName }, studioId: studio.id })}
          apply={applyStudioVersion(projectId, studio.id)}
          summarize={summarizeStudio}
          preview={(state) => <StudioVersionPreview state={state} />}
        />
      )}
      {studio && <PublishDialog open={publishOpen} onClose={() => setPublishOpen(false)} show={show} studio={studio} live={live} />}
      {laneMenu && (
        <LaneMenu
          x={laneMenu.x}
          y={laneMenu.y}
          time={laneMenu.time}
          trackName={studio?.tracks[laneMenu.trackId]?.name ?? ''}
          onUpload={() => {
            laneTarget.current = { trackId: laneMenu.trackId, time: laneMenu.time }
            setLaneMenu(null)
            laneUpload.current?.click()
          }}
          onSeek={() => {
            seek(laneMenu.time)
            setLaneMenu(null)
          }}
          onClose={() => setLaneMenu(null)}
        />
      )}
      <input
        ref={laneUpload}
        type="file"
        accept="audio/*,video/*,.mp3,.wav,.webm,.m4a,.ogg,.flac,.aif,.aiff"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = [...(e.target.files ?? [])]
          e.target.value = ''
          const t = laneTarget.current
          if (files.length && t) uploadAndPlace(files, t.trackId, t.time)
        }}
        data-lane-upload-input
      />
      <StudioFilesDialog
        open={!!filesDialog}
        initialTab={filesDialog ?? 'local'}
        projectId={projectId}
        projectName={projectName}
        current={studio ?? null}
        takenNames={takenNames}
        onImport={importFile}
        onOpenStudio={openTab}
        studios={list}
        currentStudioId={studio?.id ?? null}
        autoSave={studio ? autoSave.status : null}
        onClose={() => setFilesDialog(null)}
      />

      {toast && (
        <div className={`fixed bottom-10 left-1/2 z-[85] -translate-x-1/2 rounded-full border px-4 py-2 text-sm shadow-2xl ${toast.error ? 'border-panic/40 bg-[#2a1414] text-panic' : 'border-line bg-panel text-white/85'}`} role="status" data-studio-toast>
          {toast.text}
        </div>
      )}
    </div>
  )
}

/** "⌄ 開啟": studios of this show that aren't open in a tab. Rendered into <body> so nothing clips it. */
function OpenStudioMenu({ x, y, studios, onOpen, onClose }: { x: number; y: number; studios: { id: string; name: string; length: number }[]; onOpen: (id: string) => void; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const down = (e: PointerEvent) => !box.current?.contains(e.target as Node) && !(e.target as Element).closest?.('[data-studio-open-menu]') && onClose()
    window.addEventListener('pointerdown', down, true)
    return () => window.removeEventListener('pointerdown', down, true)
  }, [onClose])
  return createPortal(
    <div ref={box} data-sheet-menu className="fixed z-[90] w-64 rounded-xl border border-white/10 bg-[#202020] p-1 shadow-2xl" style={{ left: Math.min(x, window.innerWidth - 264), top: y }} role="menu" data-studio-open-list>
      <div className="px-3 pt-1 pb-1.5 text-[11px] text-white/40">開啟 Studio 專案</div>
      {studios.map((s) => (
        <button key={s.id} type="button" onClick={() => onOpen(s.id)} className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-xs text-white/80 hover:bg-white/10" data-open-studio-item={s.id}>
          <span className="min-w-0 flex-1 truncate">{s.name}</span>
          <span className="font-mono text-[10px] text-white/35">{timecode(s.length, false)}</span>
        </button>
      ))}
    </div>,
    document.body,
  )
}

type ProjectAction = 'export' | 'saveAs' | 'import' | 'openDefault' | 'openShow' | 'publishDefault' | 'history' | 'saveVersion' | 'share'

/** "📁 專案" menu: project files in and out. */
function ProjectMenu({ x, y, hasStudio, onAction, onClose }: { x: number; y: number; hasStudio: boolean; onAction: (a: ProjectAction) => void; onClose: () => void }) {
  const admin = isAdmin(useAuth().user)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const down = (e: PointerEvent) => !box.current?.contains(e.target as Node) && !(e.target as Element).closest?.('[data-project-menu]') && onClose()
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('keydown', key)
    }
  }, [onClose])
  const item = (a: ProjectAction, label: string, hint: string, needsStudio = true) => (
    <button
      key={a}
      type="button"
      disabled={needsStudio && !hasStudio}
      onClick={() => onAction(a)}
      className="flex w-full flex-col rounded-md px-3 py-1.5 text-left hover:bg-white/10 disabled:opacity-35"
      role="menuitem"
      data-project-action={a}
    >
      <span className="text-[13px] text-white/90">{label}</span>
      <span className="text-[10px] text-white/40">{hint}</span>
    </button>
  )
  return createPortal(
    <div ref={box} data-sheet-menu className="fixed z-[90] w-72 rounded-xl border border-white/10 bg-[#202020]/95 p-1 shadow-2xl backdrop-blur-xl" style={{ left: Math.max(8, x - 288), top: y }} role="menu" aria-label="專案檔案" data-project-menu-list>
      {item('saveVersion', '💾 立即存檔（⌘S）', '存成一個手動版本，不會被自動合併')}
      {item('history', '🕘 版本歷史…', '最近 15 個版本：預覽、還原、返回最新')}
      <div className="my-1 h-px bg-white/10" />
      {item('share', '🔗 發布 / 分享…', '專案連結、公開 MP3（可嵌入 Notion）')}
      {item('export', '⇩ 匯出此 Studio（.daw.json）', '僅此 Studio 的音軌、片段、自動化、FX 與區段；不含 Set Cue 母專案')}
      {item('saveAs', '⧉ 另存新檔…', '複製成一個獨立的新 Studio 專案')}
      <div className="my-1 h-px bg-white/10" />
      {item('import', '📁 匯入專案檔…', '從這台電腦選擇 .daw.json', false)}
      {item('openShow', '☁ 此演出雲端（R2）…', '這個演出的所有專案與音檔：自動儲存狀態、開啟、匯入、刪除', false)}
      {item('openDefault', '☁ 從 Default 共用開啟…', 'theatre/daw/Default（所有演出共用）', false)}
      {admin && item('publishDefault', '☁ 發佈到 Default 共用', '其他演出也能開啟這個專案的副本（管理員）')}
    </div>,
    document.body,
  )
}
