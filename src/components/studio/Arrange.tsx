import { createPortal } from 'react-dom'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type MouseEvent as ReactMouseEvent, type PointerEvent, type ReactNode } from 'react'
import { PEAK_RESOLUTION, bufferOffset, peaksOf, regionBuffer } from '../../studio/audio'
import { clampZoom, dbLabel, rulerLabel, rulerStep, timecode } from '../../studio/format'
import { AutomationNodeEditor, AutomationNodeMenu, type NodeInfo } from './AutomationNodeMenu'
import { bendHandles, handlesFromControls, resetShape, segmentControls, shapeOf, type PresetShape, type Range } from '../../studio/curves'
import { CurveLayer, CurveToolbar } from './CurveEditor'
import { useLongPressContextMenu } from '../../hooks/useLongPressContextMenu'
import { LONG_PRESS_MS, curvePath, curveSegments as curveSegmentsOf, type CurveGeometry, type CurveGrab } from '../../studio/curveGeometry'
import {
  FADE_SHAPES,
  PARAM_INFO,
  REGION_GAIN_RANGE,
  TRACK_PARAMS,
  fadeRamp,
  filterHz,
  laneValueAt,
  sortedSections,
  type FadeShape,
  type StudioPoint,
  type StudioPresence,
  type StudioProject,
  type StudioRegion,
  type StudioSection,
  type StudioTrack,
  type TrackParam,
} from '../../types/studio'

export const HEADER_W = 232
/** Touch screens get taller lanes: the track header needs 44 px mute / solo / fader targets. */
export const LANE_H = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches ? 132 : 92
const RULER_H = 30
const SECTION_H = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches ? 44 : 26
/** Height of a track automation lane. */
export const AUTO_H = 64
const AUTO_PAD = 7

/** Display of an automation value (dB, L/R, Hz). */
function paramLabel(param: TrackParam, v: number) {
  if (param === 'volume') return dbLabel(v)
  if (param === 'pan') return Math.abs(v) < 0.01 ? 'C' : v < 0 ? `L ${Math.round(-v * 100)}` : `R ${Math.round(v * 100)}`
  const hz = filterHz(v)
  return hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10000 ? 0 : 1)} kHz` : `${Math.round(hz)} Hz`
}
const autoNorm = (param: TrackParam, v: number) => (v - PARAM_INFO[param].min) / (PARAM_INFO[param].max - PARAM_INFO[param].min)
const autoY = (param: TrackParam, v: number) => AUTO_PAD + (1 - autoNorm(param, v)) * (AUTO_H - AUTO_PAD * 2)
/** Value at a y position without the unity / center snap (for curve handles). */
const autoValueRaw = (param: TrackParam, y: number) => {
  const info = PARAM_INFO[param]
  return info.min + Math.min(1, Math.max(0, 1 - (y - AUTO_PAD) / (AUTO_H - AUTO_PAD * 2))) * (info.max - info.min)
}
const autoValue = (param: TrackParam, y: number) => {
  const info = PARAM_INFO[param]
  const n = Math.min(1, Math.max(0, 1 - (y - AUTO_PAD) / (AUTO_H - AUTO_PAD * 2)))
  const v = info.min + n * (info.max - info.min)
  // Pan snaps to center, volume to unity, so they're easy to hit.
  if (param === 'pan' && Math.abs(v) < 0.04) return 0
  if (param === 'volume' && Math.abs(v - 1) < 0.03) return 1
  return Math.round(v * 1000) / 1000
}
/** Automation value at the top of a region (≈ +3.5 dB); unity sits at two thirds of the height. */
const AUTO_MAX = 1.5
/** Height of a region's name bar; automation is drawn below it. */
const BAR_H = 16
/** Automation value at a y position inside a region (top of the region = `top`, its height = `height`). */
const valueAtY = (y: number, top: number, height: number) => Math.min(AUTO_MAX, Math.max(0, (1 - (y - top - BAR_H) / (height - BAR_H)) * AUTO_MAX))

type Drafts = Record<string, Partial<StudioRegion>>

/** An automation node: on a region's volume curve, or on a track automation lane. */
type NodeTarget = { kind: 'region'; regionId: string; index: number } | { kind: 'lane'; trackId: string; param: TrackParam; index: number }
/** A picked curve segment (node `index` → `index + 1`) of a lane ("lane:<track>:<param>") or region ("region:<id>"). */
type SegTarget = { key: string; index: number }
/** Where a curve drag applies: how pointer positions map to time / value, and how to draft / save. */
interface CurveSpec {
  range: Range
  def: PresetShape
  toT: (clientX: number) => number
  toV: (clientY: number) => number
  draft: (points: StudioPoint[] | null) => void
  commit: (points: StudioPoint[], label: string) => void
}

export interface RecordingPreview {
  trackId: string
  start: number
  elapsed: number
}

interface ArrangeProps {
  studio: StudioProject
  tracks: StudioTrack[]
  zoom: number
  onZoom: (zoom: number) => void
  playhead: number
  onSeek: (t: number) => void
  selection: string[]
  onSelect: (ids: string[]) => void
  selectedTrack: string | null
  onSelectTrack: (id: string) => void
  automationMode: boolean
  snap: boolean
  others: StudioPresence[]
  recording: RecordingPreview | null
  following: boolean
  renderHeader: (track: StudioTrack) => ReactNode
  /** The selected timeline section (its handles show; the Section helper bar acts on it). */
  selectedSection?: string | null
  onSelectSection?: (id: string | null) => void
  /** Per-clip undo (the last 10 edits of one clip). */
  canUndoRegion?: (id: string) => boolean
  onUndoRegion?: (id: string) => void
  /** Width of the track-control column (default HEADER_W; a narrow stub when collapsed on phones). */
  headerWidth?: number
  corner: ReactNode
  footer: ReactNode
  /** Commit region edits made by a gesture. */
  onCommit: (changes: { id: string; patch: Partial<StudioRegion> }[], label: string) => void
  onRegionMenu: (region: StudioRegion, x: number, y: number) => void
  /** A clip was clicked (pressed and released without dragging). */
  onRegionClick?: (region: StudioRegion) => void
  /** Sections (timeline blocks above the tracks). */
  onSectionsCommit: (changes: { id: string; patch: Partial<StudioSection> }[], label: string) => void
  onAddSection: (start: number, end: number) => void
  onSectionMenu: (section: StudioSection, x: number, y: number) => void
  /** Track automation lanes. */
  onTrackAutomation: (track: StudioTrack, param: TrackParam, points: StudioPoint[], label: string) => void
  onHideLane: (track: StudioTrack, param: TrackParam) => void
  /** Audio files dropped from the computer: on a track (or below them all: a new track) at a time. */
  onDropFiles: (files: File[], trackId: string | null, time: number) => void
  /** Right-click on an empty part of a lane. */
  onLaneMenu: (trackId: string, time: number, x: number, y: number) => void
}


/**
 * The arrange view: a ruler, one lane per track with its regions (waveform, fades, automation),
 * the playhead and collaborators' playheads. One scroller holds everything, so the track headers
 * (sticky left) and the ruler (sticky top) stay aligned with the lanes.
 *
 * Zoom: ⌘/Ctrl + wheel or a trackpad pinch (zooms around the pointer), a two-finger pinch on touch
 * screens, or the slider. Regions: drag to move (also across tracks), drag edges to trim, drag the
 * top corners for fades; in automation mode click to add a node, drag nodes, double-click to remove.
 */
/** The area a fade removes (between the clip's top edge and the gain curve), as an SVG path in an h-tall box. */
function fadeAreaPath(shape: FadeShape | undefined, len: number, h: number, dir: 'in' | 'out', boxW = 0): string {
  const n = 24
  const silentX = dir === 'in' ? 0 : boxW
  const fullX = dir === 'in' ? len : boxW - len
  // Curve points from the full-level end (p = 1) back to the silent end (p = 0).
  const curve: string[] = []
  for (let i = n; i >= 0; i--) {
    const p = i / n
    const gain = fadeRamp(shape, p, dir === 'out')
    const x = silentX + (fullX - silentX) * p
    curve.push(`${x.toFixed(1)},${((1 - gain) * h).toFixed(1)}`)
  }
  return `M${silentX.toFixed(1)},0 L${fullX.toFixed(1)},0 L${curve.join(' L')} Z`
}

/** Fade curve picker: opens at the node on desktop, as a bottom sheet on phones (see [data-sheet-menu]). */
function FadeShapeMenu({ kind, x, y, value, onPick, onClose }: { kind: 'in' | 'out'; x: number; y: number; value: FadeShape; onPick: (s: FadeShape) => void; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const down = (e: globalThis.PointerEvent) => !box.current?.contains(e.target as Node) && onClose()
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    // A tick later: the press that opened the menu (still releasing) must not close it.
    const t = window.setTimeout(() => window.addEventListener('pointerdown', down, true), 80)
    window.addEventListener('keydown', key)
    return () => {
      window.clearTimeout(t)
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('keydown', key)
    }
  }, [onClose])
  return createPortal(
    <div
      ref={box}
      data-sheet-menu
      role="menu"
      aria-label={kind === 'in' ? '淡入模式' : '淡出模式'}
      className="fixed z-[130] w-64 rounded-xl border border-white/10 bg-[#202020]/95 p-1 text-white shadow-2xl backdrop-blur-xl"
      style={{ left: Math.min(x, window.innerWidth - 270), top: Math.min(y, window.innerHeight - 260) }}
    >
      <div className="px-3 py-2 text-xs text-white/45">{kind === 'in' ? '淡入模式' : '淡出模式'}</div>
      {FADE_SHAPES.map((s) => (
        <button
          key={s.id}
          type="button"
          role="menuitemradio"
          aria-checked={value === s.id}
          onClick={() => onPick(s.id)}
          className="flex min-h-10 w-full items-center justify-between rounded-lg px-3 text-left text-sm hover:bg-white/10"
        >
          <span>{s.label}</span>
          {value === s.id && <span>✓</span>}
        </button>
      ))}
    </div>,
    document.body,
  )
}

export function Arrange(props: ArrangeProps) {
  const { studio, tracks, zoom, onZoom, playhead, onSeek, selection, onSelect, selectedTrack, onSelectTrack, automationMode, snap, others, recording } = props
  const headerW = props.headerWidth ?? HEADER_W
  const scroller = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ left: 0, width: 1200 })
  const [drafts, setDrafts] = useState<Drafts | null>(null)
  // Live section / automation-node edits while dragging.
  const [secDrafts, setSecDrafts] = useState<Record<string, Partial<StudioSection>> | null>(null)
  const [autoDrafts, setAutoDrafts] = useState<Record<string, StudioPoint[]> | null>(null)
  // Automation node picked by a click (Delete removes it), its right-click menu, and its editor.
  const [pickedNode, setPickedNode] = useState<NodeTarget | null>(null)
  const [nodeMenu, setNodeMenu] = useState<{ target: NodeTarget; x: number; y: number } | null>(null)
  const [nodeEditing, setNodeEditing] = useState<NodeTarget | null>(null)
  const [pickedSeg, setPickedSeg] = useState<SegTarget | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  const sections = sortedSections(studio).map((sec) => (secDrafts?.[sec.id] ? { ...sec, ...secDrafts[sec.id] } : sec))

  const length = Object.values(studio.regions).reduce((e, r) => Math.max(e, r.start + r.duration), 0)
  const sectionsEnd = Object.values(studio.sections).reduce((e, s) => Math.max(e, s.end), 0)
  const seconds = Math.max(length + 30, sectionsEnd + 10, (view.width - headerW) / zoom + 1, recording ? recording.start + recording.elapsed + 10 : 0)
  const contentW = Math.ceil(seconds * zoom)

  /* ---------- scroll tracking (for waveform slices) ---------- */
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    let frame = 0
    const update = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setView({ left: Math.max(0, el.scrollLeft), width: el.clientWidth }))
    }
    update()
    el.addEventListener('scroll', update, { passive: true })
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', update)
      ro.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [])

  // Keep the playhead in view while playing.
  useEffect(() => {
    const el = scroller.current
    if (!el || !props.following) return
    const x = playhead * zoom
    const visible = el.clientWidth - headerW
    if (x < el.scrollLeft || x > el.scrollLeft + visible - 40) el.scrollLeft = Math.max(0, x - visible * 0.15)
  }, [playhead, zoom, props.following, headerW])

  /* ---------- zoom: wheel / trackpad pinch / Safari gesture / touch pinch ---------- */
  const zoomRef = useRef(zoom)
  useEffect(() => {
    zoomRef.current = zoom
  }, [zoom])
  const zoomAround = (next: number, clientX: number) => {
    const el = scroller.current
    if (!el) return
    const z = clampZoom(next)
    const x = clientX - el.getBoundingClientRect().left - headerW
    const t = (el.scrollLeft + x) / zoomRef.current
    zoomRef.current = z
    onZoom(z)
    // After the new width renders, keep the time under the pointer where it was.
    requestAnimationFrame(() => (el.scrollLeft = Math.max(0, t * z - x)))
  }
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    // Trackpad pinch arrives as a wheel event with ctrlKey (Chrome, Edge, Firefox).
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      zoomAround(zoomRef.current * Math.exp(-e.deltaY * 0.01), e.clientX)
    }
    // Safari's own pinch events.
    let gestureStart = 1
    const onGestureStart = (e: Event) => {
      e.preventDefault()
      gestureStart = zoomRef.current
    }
    const onGestureChange = (e: Event) => {
      e.preventDefault()
      const g = e as Event & { scale: number; clientX: number }
      zoomAround(gestureStart * g.scale, g.clientX)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('gesturestart', onGestureStart)
    el.addEventListener('gesturechange', onGestureChange)
    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('gesturestart', onGestureStart)
      el.removeEventListener('gesturechange', onGestureChange)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handlers read refs
  }, [])
  // Two-finger pinch on touch screens.
  const longPressMenu = useLongPressContextMenu()
  const touches = useRef(new Map<number, number>())
  const pinch = useRef<{ dist: number; zoom: number } | null>(null)
  const onTouchDown = (e: PointerEvent) => {
    if (e.pointerType !== 'touch') return
    touches.current.set(e.pointerId, e.clientX)
    if (touches.current.size === 2) {
      const [a, b] = [...touches.current.values()]
      pinch.current = { dist: Math.abs(a - b), zoom: zoomRef.current }
    }
  }
  const onTouchMove = (e: PointerEvent) => {
    if (e.pointerType !== 'touch' || !touches.current.has(e.pointerId)) return
    touches.current.set(e.pointerId, e.clientX)
    if (pinch.current && touches.current.size === 2) {
      const [a, b] = [...touches.current.values()]
      zoomAround((pinch.current.zoom * Math.max(10, Math.abs(a - b))) / Math.max(10, pinch.current.dist), (a + b) / 2)
    }
  }
  const onTouchUp = (e: PointerEvent) => {
    touches.current.delete(e.pointerId)
    if (touches.current.size < 2) pinch.current = null
  }

  /* ---------- snapping ---------- */
  const edges = useMemo(() => {
    const out: number[] = []
    for (const r of Object.values(studio.regions)) out.push(r.start, r.start + r.duration)
    return out
  }, [studio.regions])
  const sectionEdges = useMemo(() => Object.values(studio.sections).flatMap((s) => [s.start, s.end]), [studio.sections])
  const snapTime = (t: number, exclude: string[] = []) => {
    if (!snap) return Math.max(0, t)
    const tolerance = 8 / zoom
    let best = t
    let bestDist = tolerance
    const candidates = [
      playhead,
      ...edges.filter((_, i) => !exclude.includes(Object.values(studio.regions)[i >> 1]?.id)),
      ...sectionEdges.filter((_, i) => !exclude.includes(Object.values(studio.sections)[i >> 1]?.id)),
    ]
    for (const c of candidates) if (Math.abs(c - t) < bestDist) [best, bestDist] = [c, Math.abs(c - t)]
    if (best === t) {
      const grid = rulerStep(zoom) / 4
      best = Math.round(t / grid) * grid
    }
    return Math.max(0, best)
  }

  /* ---------- region gestures ---------- */
  type Gesture =
    | { kind: 'move'; x: number; y: number; ids: string[]; origin: Record<string, { start: number; trackIndex: number }>; moved: boolean; clicked: string }
    | { kind: 'trim-l' | 'trim-r' | 'fade-in' | 'fade-out'; x: number; id: string; origin: StudioRegion; moved: boolean }
    | { kind: 'gain'; x: number; y: number; id: string; origin: StudioRegion; moved: boolean; armed: boolean }
    | { kind: 'node'; id: string; index: number; origin: StudioRegion; height: number; rectTop: number; rectLeft: number; moved: boolean }
    | { kind: 'sec-move' | 'sec-l' | 'sec-r'; x: number; id: string; origin: StudioSection; moved: boolean }
    | { kind: 'anode'; track: StudioTrack; param: TrackParam; index: number; origin: StudioPoint[]; laneLeft: number; laneTop: number; moved: boolean }
    | { kind: 'curve'; what: CurveGrab; index: number; origin: StudioPoint[]; spec: CurveSpec; x: number; y: number; moved: boolean; latest: StudioPoint[] | null }
  const gesture = useRef<Gesture | null>(null)
  // Floating readout while a clip's volume is dragged, and the fade-curve picker (long-press on a fade node).
  const [secTip, setSecTip] = useState<{ x: number; y: number; text: string } | null>(null)
  const [gainTip, setGainTip] = useState<{ x: number; y: number; text: string } | null>(null)
  const [shapeMenu, setShapeMenu] = useState<{ id: string; kind: 'in' | 'out'; x: number; y: number } | null>(null)
  const draftsRef = useRef<Drafts | null>(null)
  const setDraftsBoth = (d: Drafts | null) => {
    draftsRef.current = d
    setDrafts(d)
  }
  const trackIndex = (id: string) => tracks.findIndex((t) => t.id === id)

  /** The ═ node on top of a selected clip: drag down = quieter, up = louder. */
  const beginGain = (e: PointerEvent, r: StudioRegion) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    gesture.current = { kind: 'gain', x: e.clientX, y: e.clientY, id: r.id, origin: r, moved: false, armed: true }
  }

  const beginMove = (e: PointerEvent, r: StudioRegion, grip = false) => {
    if (e.button !== 0 || e.pointerType === 'touch' && touches.current.size > 1) return
    e.stopPropagation()
    // Touch: the three gestures never share a press. An unselected clip only taps to select (a drag
    // on it scrolls the timeline, a hold opens its menu); a selected clip — or its grip — drags.
    if (e.pointerType !== 'mouse' && !grip && !selection.includes(r.id)) {
      const from = { x: e.clientX, y: e.clientY, id: e.pointerId }
      const finish = (up: globalThis.PointerEvent, cancelled: boolean) => {
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onCancel)
        if (!cancelled && up.pointerId === from.id && Math.hypot(up.clientX - from.x, up.clientY - from.y) < 6) {
          onSelect([r.id])
          onSelectTrack(r.trackId)
        }
      }
      const onUp = (up: globalThis.PointerEvent) => finish(up, false)
      const onCancel = (up: globalThis.PointerEvent) => finish(up, true)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onCancel)
      return
    }
    let ids = selection
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      ids = selection.includes(r.id) ? selection.filter((x) => x !== r.id) : [...selection, r.id]
      onSelect(ids)
      return
    }
    if (!selection.includes(r.id)) ids = [r.id]
    onSelect(ids)
    onSelectTrack(r.trackId)
    e.currentTarget.setPointerCapture(e.pointerId)
    const origin: Record<string, { start: number; trackIndex: number }> = {}
    for (const id of ids) {
      const reg = studio.regions[id]
      if (reg) origin[id] = { start: reg.start, trackIndex: trackIndex(reg.trackId) }
    }
    gesture.current = { kind: 'move', x: e.clientX, y: e.clientY, ids, origin, moved: false, clicked: r.id }
  }
  const beginEdge = (e: PointerEvent, r: StudioRegion, kind: 'trim-l' | 'trim-r' | 'fade-in' | 'fade-out') => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    onSelect([r.id])
    gesture.current = { kind, x: e.clientX, id: r.id, origin: r, moved: false }
  }
  const beginNode = (e: PointerEvent, r: StudioRegion, index: number, rect: DOMRect) => {
    e.stopPropagation()
    if (e.button !== 0) return // right-click opens the node menu instead
    setPickedNode({ kind: 'region', regionId: r.id, index })
    e.currentTarget.setPointerCapture(e.pointerId)
    gesture.current = { kind: 'node', id: r.id, index, origin: r, height: rect.height, rectTop: rect.top, rectLeft: rect.left, moved: false }
  }

  /**
   * Pressing a section selects it (its big handles and the Section helper bar appear). Touch: an
   * unselected section only taps to select (a drag on it scrolls the timeline); a selected one — or one
   * of its handles — drags. Movement under 5 px never counts as a drag.
   */
  const beginSection = (e: PointerEvent, sec: StudioSection, kind: 'sec-move' | 'sec-l' | 'sec-r') => {
    if (e.button !== 0 || renaming) return
    e.stopPropagation()
    const wasSelected = props.selectedSection === sec.id
    if (kind === 'sec-move' && e.pointerType !== 'mouse' && !wasSelected) {
      const from = { x: e.clientX, y: e.clientY, id: e.pointerId }
      const finish = (up: globalThis.PointerEvent, cancelled: boolean) => {
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onCancel)
        if (!cancelled && up.pointerId === from.id && Math.hypot(up.clientX - from.x, up.clientY - from.y) < 6) {
          onSelect([])
          props.onSelectSection?.(sec.id)
          navigator.vibrate?.(10)
        }
      }
      const onUp = (up: globalThis.PointerEvent) => finish(up, false)
      const onCancel = (up: globalThis.PointerEvent) => finish(up, true)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onCancel)
      return
    }
    if (!wasSelected) {
      onSelect([])
      props.onSelectSection?.(sec.id)
    }
    e.currentTarget.setPointerCapture(e.pointerId)
    gesture.current = { kind, x: e.clientX, id: sec.id, origin: sec, moved: false }
  }
  const beginAutoNode = (e: PointerEvent, track: StudioTrack, param: TrackParam, index: number, points: StudioPoint[], lane: DOMRect) => {
    e.stopPropagation()
    if (e.button !== 0) return
    setPickedNode({ kind: 'lane', trackId: track.id, param, index })
    setPickedSeg(null)
    e.currentTarget.setPointerCapture(e.pointerId)
    gesture.current = { kind: 'anode', track, param, index, origin: points, laneLeft: lane.left, laneTop: lane.top, moved: false }
  }

  /* ---------- automation curves: bend grips and Bézier handles (mouse, pen and touch) ---------- */
  const longPress = useRef(0)
  const resetCurve = (points: StudioPoint[], index: number, spec: Pick<CurveSpec, 'def' | 'commit'>) => {
    if (!points[index + 1]) return
    const next = points.map((p, i) => (i === index ? resetShape(p, spec.def) : p))
    spec.commit(next, shapeOf(next[index], spec.def) === 'linear' ? '自動化曲線改為直線' : '自動化曲線改為平滑')
  }
  const beginCurve = (e: PointerEvent, index: number, what: CurveGrab, points: StudioPoint[], spec: CurveSpec) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    gesture.current = { kind: 'curve', what, index, origin: points, spec, x: e.clientX, y: e.clientY, moved: false, latest: null }
    // Long press (held still) resets the segment — the touch equivalent of a double-click.
    window.clearTimeout(longPress.current)
    longPress.current = window.setTimeout(() => {
      const g = gesture.current
      if (g?.kind !== 'curve' || g.moved) return
      gesture.current = null
      spec.draft(null)
      resetCurve(points, index, spec)
      navigator.vibrate?.(15)
    }, LONG_PRESS_MS)
  }
  /** Curve spec of a track lane (lane SVG rect for the pointer mapping). */
  const laneSpec = (track: StudioTrack, param: TrackParam, svg: DOMRect): CurveSpec => ({
    range: PARAM_INFO[param],
    def: 'smooth',
    toT: (cx) => (cx - svg.left) / zoom,
    toV: (cy) => autoValueRaw(param, cy - svg.top),
    draft: (pts) => setAutoDrafts(pts ? { [`${track.id}:${param}`]: pts } : null),
    commit: (pts, label) => props.onTrackAutomation(track, param, pts, label),
  })
  /** Curve spec of a region's volume automation (region SVG rect). */
  const regionSpec = (r: StudioRegion, svg: DOMRect): CurveSpec => ({
    range: REGION_GAIN_RANGE,
    def: 'linear',
    toT: (cx) => (cx - svg.left) / zoom,
    toV: (cy) => valueAtY(cy, svg.top, svg.height),
    draft: (pts) => setDraftsBoth(pts ? { [r.id]: { automation: pts } } : null),
    commit: (pts, label) => props.onCommit([{ id: r.id, patch: { automation: pts } }], label),
  })

  const onGestureMove = (e: PointerEvent) => {
    const g = gesture.current
    if (!g) return
    if (g.kind === 'curve') {
      if (!g.moved && Math.hypot(e.clientX - g.x, e.clientY - g.y) < 4) return
      g.moved = true
      window.clearTimeout(longPress.current)
      const { range, def, toT, toV } = g.spec
      const pts = [...g.origin]
      const a = pts[g.index]
      const b = pts[g.index + 1]
      if (!a || !b) return
      const v = toV(e.clientY)
      let h
      if (g.what === 'grip') h = bendHandles(a, b, v, range)
      else {
        const c = segmentControls(a, b, range, def)
        const t = toT(e.clientX)
        h = handlesFromControls(a, b, g.what === 1 ? { t1: t, v1: v, t2: c.t2, v2: c.v2 } : { t1: c.t1, v1: c.v1, t2: t, v2: v }, range)
      }
      pts[g.index] = { ...a, curve: 'bezier', h }
      g.latest = pts
      g.spec.draft(pts)
      return
    }
    if (g.kind === 'sec-move' || g.kind === 'sec-l' || g.kind === 'sec-r') {
      if (!g.moved && Math.abs(e.clientX - g.x) < 5) return
      g.moved = true
      const o = g.origin
      const d = (e.clientX - g.x) / zoom
      let patch: Partial<StudioSection>
      if (g.kind === 'sec-move') {
        const start = Math.max(0, snapTime(o.start + d, [o.id]))
        patch = { start, end: start + (o.end - o.start) }
      } else if (g.kind === 'sec-l') patch = { start: Math.max(0, Math.min(o.end - 0.25, snapTime(o.start + d, [o.id]))) }
      else patch = { end: Math.max(o.start + 0.25, snapTime(o.end + d, [o.id])) }
      for (const k of ['start', 'end'] as const) if (patch[k] !== undefined) patch[k] = Math.round(patch[k]! * 1000) / 1000
      setSecDrafts({ [o.id]: patch })
      setSecTip({ x: e.clientX, y: e.clientY, text: `${timecode(patch.start ?? o.start)} → ${timecode(patch.end ?? o.end)}` })
      return
    }
    if (g.kind === 'anode') {
      g.moved = true
      const pts = [...g.origin]
      const lo = g.index > 0 ? pts[g.index - 1].t + 0.01 : 0
      const hi = g.index < pts.length - 1 ? pts[g.index + 1].t - 0.01 : Infinity
      const t = Math.min(hi, Math.max(lo, snapTime((e.clientX - g.laneLeft) / zoom)))
      // Keep the node's segment shape (curve / handles) while moving it.
      pts[g.index] = { ...pts[g.index], t: Math.round(t * 1000) / 1000, v: autoValue(g.param, e.clientY - g.laneTop) }
      setAutoDrafts({ [`${g.track.id}:${g.param}`]: pts })
      return
    }
    if (g.kind === 'move') {
      const dx = (e.clientX - g.x) / zoom
      const dy = Math.round((e.clientY - g.y) / LANE_H)
      if (!g.moved && Math.abs(e.clientX - g.x) < 3 && Math.abs(e.clientY - g.y) < 3) return
      g.moved = true
      // Snap the region the pointer grabbed; the rest of the selection follows by the same amount.
      const lead = g.ids[0]
      const leadStart = snapTime(g.origin[lead].start + dx, g.ids)
      const shift = leadStart - g.origin[lead].start
      const minStart = Math.min(...g.ids.map((id) => g.origin[id].start))
      const clampedShift = Math.max(-minStart, shift)
      const lanes = g.ids.map((id) => g.origin[id].trackIndex)
      const laneShift = Math.max(-Math.min(...lanes), Math.min(tracks.length - 1 - Math.max(...lanes), dy))
      const next: Drafts = {}
      for (const id of g.ids) next[id] = { start: g.origin[id].start + clampedShift, trackId: tracks[g.origin[id].trackIndex + laneShift]?.id }
      setDraftsBoth(next)
    } else if (g.kind === 'gain') {
      if (!g.moved && Math.hypot(e.clientX - g.x, e.clientY - g.y) < 4) return
      g.moved = true
      if (!g.armed) return
      // Drag up = louder, down = quieter; a full lane height is about ±2 in linear gain.
      const gain = Math.round(Math.min(2, Math.max(0, g.origin.gain - ((e.clientY - g.y) / (LANE_H * 0.9)) * 2)) * 100) / 100
      setDraftsBoth({ [g.id]: { gain } })
      setGainTip({ x: e.clientX, y: e.clientY, text: dbLabel(gain) })
    } else if (g.kind === 'node') {
      g.moved = true
      const r = g.origin
      const pts = [...r.automation]
      const left = g.rectLeft
      const lo = g.index > 0 ? pts[g.index - 1].t + 0.01 : 0
      const hi = g.index < pts.length - 1 ? pts[g.index + 1].t - 0.01 : r.duration
      const t = Math.min(hi, Math.max(lo, (e.clientX - left) / zoom))
      const v = valueAtY(e.clientY, g.rectTop, g.height)
      pts[g.index] = { ...pts[g.index], t: Math.round(t * 1000) / 1000, v: Math.round(v * 1000) / 1000 }
      setDraftsBoth({ [r.id]: { automation: pts } })
    } else {
      // Trims and fades (section and automation-node drags returned above).
      const r = g.origin as StudioRegion
      const d = (e.clientX - g.x) / zoom
      if (!g.moved && Math.abs(e.clientX - g.x) < 2) return
      g.moved = true
      const src = r.sourceDuration || r.offset + r.duration
      let patch: Partial<StudioRegion> = {}
      if (g.kind === 'trim-l') {
        // Can't start before 0 on the timeline or before the start of the source (end, if reversed).
        const room = r.reverse ? src - r.offset - r.duration : r.offset
        const delta = Math.max(-Math.min(room, r.start), Math.min(r.duration - 0.05, snapTime(r.start + d, [r.id]) - r.start))
        patch = { start: r.start + delta, duration: r.duration - delta, ...(r.reverse ? {} : { offset: r.offset + delta }) }
        patch.automation = r.automation.map((p) => ({ ...p, t: p.t - delta })).filter((p) => p.t >= 0)
      } else if (g.kind === 'trim-r') {
        const room = r.reverse ? r.offset : src - r.offset - r.duration
        const end = snapTime(r.start + r.duration + d, [r.id])
        const delta = Math.max(-(r.duration - 0.05), Math.min(room, end - r.start - r.duration))
        patch = { duration: r.duration + delta, ...(r.reverse ? { offset: r.offset - delta } : {}) }
        patch.automation = r.automation.filter((p) => p.t <= r.duration + delta)
      } else if (g.kind === 'fade-in') {
        patch = { fadeIn: Math.round(Math.min(r.duration - r.fadeOut, Math.max(0, r.fadeIn + d)) * 100) / 100 }
      } else {
        patch = { fadeOut: Math.round(Math.min(r.duration - r.fadeIn, Math.max(0, r.fadeOut - d)) * 100) / 100 }
      }
      setDraftsBoth({ [r.id]: patch })
    }
  }
  const onGestureEnd = () => {
    const g = gesture.current
    if (g && (g.kind === 'sec-move' || g.kind === 'sec-l' || g.kind === 'sec-r')) {
      gesture.current = null
      const d = secDrafts?.[g.id]
      setSecDrafts(null)
      setSecTip(null)
      if (!g.moved || !d) return // a plain click on a section does not move the playhead
      navigator.vibrate?.(10)
      props.onSectionsCommit([{ id: g.id, patch: d }], g.kind === 'sec-move' ? `移動區段「${g.origin.name}」` : `調整區段「${g.origin.name}」長度`)
      return
    }
    if (g?.kind === 'curve') {
      gesture.current = null
      window.clearTimeout(longPress.current)
      g.spec.draft(null)
      if (g.moved && g.latest) g.spec.commit(g.latest, g.what === 'grip' ? '彎曲自動化曲線' : '調整自動化曲線')
      return
    }
    if (g?.kind === 'anode') {
      gesture.current = null
      const pts = autoDrafts?.[`${g.track.id}:${g.param}`]
      setAutoDrafts(null)
      if (g.moved && pts) props.onTrackAutomation(g.track, g.param, pts, '調整自動化節點')
      return
    }
    gesture.current = null
    const d = draftsRef.current
    setDraftsBoth(null)
    setGainTip(null)
    // A plain click on a clip (no drag): e.g. reveal its file in the 素材 panel.
    if (g?.kind === 'move' && !g.moved) {
      const r = studio.regions[g.clicked]
      if (r) props.onRegionClick?.(r)
    }
    if (!g || !g.moved || !d) return
    const label = { move: '移動片段', gain: '調整片段音量', 'trim-l': '修剪片段', 'trim-r': '修剪片段', 'fade-in': '淡入', 'fade-out': '淡出', node: '調整自動化節點' }[g.kind as 'move']
    props.onCommit(
      Object.entries(d).map(([id, patch]) => ({ id, patch })),
      label,
    )
  }

  const addNode = (e: ReactMouseEvent, r: StudioRegion) => {
    if ((e.target as Element).closest?.('[data-curve-ui]')) return
    const rect = e.currentTarget.getBoundingClientRect()
    const t = Math.min(r.duration, Math.max(0, (e.clientX - rect.left) / zoom))
    const v = valueAtY(e.clientY, rect.top, rect.height)
    const pts: StudioPoint[] = [...r.automation, { t: Math.round(t * 1000) / 1000, v: Math.round(v * 1000) / 1000 }].sort((a, b) => a.t - b.t)
    props.onCommit([{ id: r.id, patch: { automation: pts } }], '新增自動化節點')
  }
  const removeNode = (r: StudioRegion, index: number) =>
    props.onCommit([{ id: r.id, patch: { automation: r.automation.filter((_, i) => i !== index) } }], '刪除自動化節點')

  /* ---------- automation nodes: pick, right-click menu, precise edit, delete ---------- */
  const nodePoints = (t: NodeTarget): StudioPoint[] | null =>
    t.kind === 'region' ? (studio.regions[t.regionId]?.automation ?? null) : (studio.tracks[t.trackId]?.automation[t.param]?.points ?? null)
  const commitNodes = (t: NodeTarget, points: StudioPoint[], label: string) => {
    if (t.kind === 'region') props.onCommit([{ id: t.regionId, patch: { automation: points } }], label)
    else props.onTrackAutomation(studio.tracks[t.trackId], t.param, points, label)
  }
  const nodeInfo = (t: NodeTarget): NodeInfo | null => {
    const p = nodePoints(t)?.[t.index]
    if (!p) return null
    if (t.kind === 'region') {
      const r = studio.regions[t.regionId]
      return { param: 'gain', time: r.start + p.t, value: p.v, minTime: r.start, maxTime: r.start + r.duration, where: `片段「${r.name}」· 音量` }
    }
    return { param: t.param, time: p.t, value: p.v, minTime: 0, maxTime: Math.max(seconds, p.t), where: `${studio.tracks[t.trackId]?.name ?? ''} · ${PARAM_INFO[t.param].label}` }
  }
  const deleteNode = (t: NodeTarget) => {
    const pts = nodePoints(t)
    if (!pts?.[t.index]) return
    commitNodes(t, pts.filter((_, i) => i !== t.index), '刪除自動化節點')
    setPickedNode(null)
  }
  const applyNodeEdit = (t: NodeTarget, time: number, value: number) => {
    const pts = nodePoints(t)
    if (!pts?.[t.index]) return
    const local = t.kind === 'region' ? time - studio.regions[t.regionId].start : time
    const moved = { ...pts[t.index], t: Math.round(local * 1000) / 1000, v: value }
    // Keep the nodes in time order; a node already at that exact time is replaced.
    const next = [...pts.filter((p, i) => i !== t.index && Math.abs(p.t - moved.t) > 0.0005), moved].sort((a, b) => a.t - b.t)
    commitNodes(t, next, '編輯自動化節點')
    setPickedNode({ ...t, index: next.indexOf(moved) })
  }
  const openNodeMenu = (target: NodeTarget, e: ReactMouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setPickedNode(target)
    setNodeMenu({ target, x: e.clientX, y: e.clientY })
  }
  // Delete / Backspace removes the picked node (before the studio's "delete selected regions").
  const pickedRef = useRef(pickedNode)
  useEffect(() => {
    pickedRef.current = pickedNode
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = pickedRef.current
      if (!t || (e.key !== 'Delete' && e.key !== 'Backspace') || e.isComposing) return
      if ((e.target as HTMLElement).closest?.('input, textarea, select, [contenteditable]')) return
      e.preventDefault()
      e.stopPropagation()
      deleteNode(t)
    }
    // Any click that isn't on a node lets go of it.
    const onDown = (e: Event) => {
      const el = e.target as Element
      if (!el.closest?.('[data-node], [data-auto-node], [data-node-menu], [data-node-editor]')) setPickedNode(null)
      if (!el.closest?.('[data-curve-ui], [data-seg-toolbar]')) setPickedSeg(null)
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('pointerdown', onDown, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('pointerdown', onDown, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studio])

  /* ---------- ruler / lane clicks ---------- */
  const timeAt = (clientX: number) => {
    const el = scroller.current!
    return Math.max(0, (clientX - el.getBoundingClientRect().left - headerW + el.scrollLeft) / zoom)
  }
  const seekDrag = useRef(false)
  const step = rulerStep(zoom)
  const ticks: number[] = []
  const firstTick = Math.floor(view.left / zoom / step) * step
  for (let t = firstTick; t <= (view.left + view.width) / zoom + step; t += step) ticks.push(Math.round(t * 1000) / 1000)

  const othersByRegion = new Map<string, StudioPresence>()
  for (const o of others) for (const id of o.selection) othersByRegion.set(id, o)

  /* ---------- drop audio files from the computer ---------- */
  const [dropAt, setDropAt] = useState<{ trackId: string | null; time: number; count: number } | null>(null)
  const dropTarget = (e: DragEvent) => {
    const lane = (e.target as Element).closest?.('[data-lane]') as HTMLElement | null
    const time = snap ? snapTime(timeAt(e.clientX)) : timeAt(e.clientX)
    return { trackId: lane?.dataset.lane ?? null, time: Math.max(0, time) }
  }
  const carriesFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files')

  return (
    <div
      ref={scroller}
      onDragOver={(e) => {
        if (!carriesFiles(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        const t = dropTarget(e)
        setDropAt((d) => (d && d.trackId === t.trackId && Math.abs(d.time - t.time) < 0.01 ? d : { ...t, count: e.dataTransfer.items.length }))
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropAt(null)
      }}
      onDrop={(e) => {
        if (!carriesFiles(e)) return
        e.preventDefault()
        const t = dropTarget(e)
        setDropAt(null)
        props.onDropFiles([...e.dataTransfer.files], t.trackId, t.time)
      }}
      className="relative h-full overflow-auto overscroll-contain bg-[#101010] select-none [-webkit-touch-callout:none]"
      {...longPressMenu}
      onPointerDown={onTouchDown}
      onPointerMove={(e) => {
        onTouchMove(e)
        onGestureMove(e)
      }}
      onPointerUp={(e) => {
        onTouchUp(e)
        onGestureEnd()
      }}
      onPointerCancel={(e) => {
        onTouchUp(e)
        onGestureEnd()
      }}
      data-arrange
    >
      <div className="relative" style={{ width: headerW + contentW, minHeight: '100%', ['--header-w' as string]: `${headerW}px` }}>
        {/* Ruler + sections */}
        <div className="sticky top-0 z-30">
        <div className="flex" style={{ height: RULER_H }}>
          <div className="sticky left-0 z-40 flex shrink-0 items-center border-r border-b border-line bg-[#171717] px-2" style={{ width: 'var(--header-w)' }}>
            {props.corner}
          </div>
          <div
            className="relative shrink-0 cursor-text touch-none border-b border-line bg-[#171717]"
            style={{ width: contentW }}
            // The only places that move the playhead: press / drag on this ruler (and the explicit menu items and transport buttons).
            onPointerDown={(e) => {
              if (e.button !== 0) return
              e.currentTarget.setPointerCapture(e.pointerId)
              seekDrag.current = true
              onSeek(timeAt(e.clientX))
            }}
            onPointerMove={(e) => seekDrag.current && onSeek(timeAt(e.clientX))}
            onPointerUp={() => (seekDrag.current = false)}
            onPointerCancel={() => (seekDrag.current = false)}
            data-ruler
          >
            {ticks.map((t) => (
              <div key={t} className="absolute top-0 bottom-0" style={{ left: t * zoom }}>
                <div className="h-full w-px bg-white/15" />
                <span className="absolute top-1 left-1 font-mono text-[10px] whitespace-nowrap text-white/45 tabular">{rulerLabel(t, step)}</span>
              </div>
            ))}
            {others.filter((o) => Number.isFinite(o.playhead)).map((o) => (
              <span key={o.id} className="absolute top-0 -translate-x-1/2 rounded-b px-1 text-[9px] font-semibold whitespace-nowrap text-black" style={{ left: o.playhead * zoom, background: o.color }}>
                {o.name}
              </span>
            ))}
            <span className="absolute -bottom-px h-2.5 w-2.5 -translate-x-1/2 rotate-45 bg-panic" style={{ left: (Number.isFinite(playhead) ? playhead : 0) * zoom }} />
          </div>
        </div>
        <div className="flex" style={{ height: SECTION_H }}>
          <div className="sticky left-0 z-40 flex shrink-0 items-center gap-1 border-r border-b border-line bg-[#151515] px-2" style={{ width: 'var(--header-w)' }}>
            <span className="text-[10px] font-semibold tracking-widest text-white/40 uppercase">區段</span>
            <button
              type="button"
              onClick={() => {
                const next = sections.find((sec) => sec.start > playhead + 0.01)
                props.onAddSection(playhead, Math.max(playhead + 1, Math.min(next?.start ?? Infinity, playhead + 8)))
              }}
              className="ml-auto h-5 rounded px-1.5 text-[11px] text-white/60 hover:bg-white/10 hover:text-white"
              title="在播放頭新增區段（也可在區段列雙擊）"
              data-add-section
            >
              ＋ 區段
            </button>
          </div>
          <div
            className="relative shrink-0 border-b border-line bg-[#131313]"
            style={{ width: contentW }}
            onDoubleClick={(e) => {
              if (e.target !== e.currentTarget) return
              const t = snapTime(timeAt(e.clientX))
              const next = sections.find((sec) => sec.start > t + 0.01)
              props.onAddSection(t, Math.max(t + 1, Math.min(next?.start ?? Infinity, t + 8)))
            }}
            title="雙擊新增區段"
            data-sections
          >
            {sections.map((sec) => (
              <div
                key={sec.id}
                className={`group absolute top-[3px] bottom-[3px] flex cursor-grab items-center overflow-hidden rounded-[5px] px-2 text-[11px] font-bold text-white shadow-sm active:cursor-grabbing ${props.selectedSection === sec.id ? 'touch-none ring-2 ring-white' : 'touch-pan-x touch-pan-y'}`}
                style={{ left: sec.start * zoom, width: Math.max(8, (sec.end - sec.start) * zoom), background: sec.color }}
                onPointerDown={(e) => beginSection(e, sec, 'sec-move')}
                onDoubleClick={(e) => {
                  e.stopPropagation()
                  setRenaming({ id: sec.id, name: sec.name })
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  props.onSectionMenu(sec, e.clientX, e.clientY)
                }}
                title={`${sec.name}（${(sec.end - sec.start).toFixed(2)}s）· 點擊選取 · 雙擊改名 · 右鍵更多`}
                data-section={sec.id}
              >
                {renaming?.id === sec.id ? (
                  <input
                    autoFocus
                    value={renaming.name}
                    onPointerDown={(e) => e.stopPropagation()}
                    onChange={(e) => setRenaming({ id: sec.id, name: e.target.value })}
                    onBlur={() => {
                      const name = renaming.name.trim()
                      setRenaming(null)
                      if (name && name !== sec.name) props.onSectionsCommit([{ id: sec.id, patch: { name } }], `區段重新命名為「${name}」`)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur()
                      if (e.key === 'Escape') setRenaming(null)
                    }}
                    className="w-full min-w-0 rounded bg-black/40 px-1 text-[11px] text-white outline-none"
                    aria-label="區段名稱"
                    data-section-rename
                  />
                ) : (
                  <span className="truncate">{sec.name}</span>
                )}
                <span className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize hover:bg-white/50" onPointerDown={(e) => beginSection(e, sec, 'sec-l')} data-section-edge="l" />
                <span className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize hover:bg-white/50" onPointerDown={(e) => beginSection(e, sec, 'sec-r')} data-section-edge="r" />
              </div>
            ))}
            {sections
              .filter((sec) => sec.id === props.selectedSection)
              .map((sec) => (
                <div key={`${sec.id}-handles`} className="pointer-events-none absolute inset-y-0 z-20" style={{ left: sec.start * zoom, width: Math.max(8, (sec.end - sec.start) * zoom) }} data-section-handles>
                  <div
                    className="pointer-events-auto absolute inset-y-0 -left-[22px] flex w-11 cursor-ew-resize touch-none items-center justify-center"
                    onPointerDown={(e) => beginSection(e, sec, 'sec-l')}
                    aria-label="拖曳調整區段起點"
                    data-section-handle="l"
                  >
                    <span className="h-5 w-3 rounded-full bg-white shadow ring-1 ring-black/60 pointer-coarse:h-7" />
                  </div>
                  <div
                    className="pointer-events-auto absolute inset-y-0 -right-[22px] flex w-11 cursor-ew-resize touch-none items-center justify-center"
                    onPointerDown={(e) => beginSection(e, sec, 'sec-r')}
                    aria-label="拖曳調整區段終點"
                    data-section-handle="r"
                  >
                    <span className="h-5 w-3 rounded-full bg-white shadow ring-1 ring-black/60 pointer-coarse:h-7" />
                  </div>
                </div>
              ))}
          </div>
        </div>
        </div>

        {/* Lanes */}
        {tracks.map((track) => {
          const lane = Object.values(studio.regions)
            .map((r) => (drafts?.[r.id] ? { ...r, ...drafts[r.id] } : r))
            .filter((r) => r.trackId === track.id)
          const lanes = TRACK_PARAMS.filter((param) => track.automation[param]?.shown)
          return (
            <div key={track.id}>
            <div className="flex" style={{ height: LANE_H }} data-lane={track.id}>
              <div
                className={`sticky left-0 z-20 shrink-0 border-r border-b border-line ${selectedTrack === track.id ? 'bg-[#232323]' : 'bg-[#191919]'}`}
                style={{ width: 'var(--header-w)' }}
                onPointerDown={() => onSelectTrack(track.id)}
              >
                {props.renderHeader(track)}
              </div>
              <div
                className={`relative shrink-0 border-b border-line ${selectedTrack === track.id ? 'bg-white/[0.025]' : ''}`}
                style={
                  {
                    width: contentW,
                    backgroundImage: `repeating-linear-gradient(to right, rgba(255,255,255,0.04) 0 1px, transparent 1px ${step * zoom}px)`,
                  } as CSSProperties
                }
                onPointerDown={(e) => {
                  if (e.button !== 0 || e.target !== e.currentTarget) return
                  // Clicks in the clip area are clip / track operations: the playhead only moves from the ruler.
                  onSelectTrack(track.id)
                  onSelect([])
                  props.onSelectSection?.(null)
                }}
                onContextMenu={(e) => {
                  if (e.target !== e.currentTarget) return
                  e.preventDefault()
                  onSelectTrack(track.id)
                  props.onLaneMenu(track.id, snap ? snapTime(timeAt(e.clientX)) : timeAt(e.clientX), e.clientX, e.clientY)
                }}
              >
                {dropAt?.trackId === track.id && (
                  <div className="pointer-events-none absolute inset-y-0 z-30 w-0.5 bg-go shadow-[0_0_10px_#30d158]" style={{ left: dropAt.time * zoom }} data-drop-indicator>
                    <span className="absolute top-1 left-1.5 rounded bg-go px-1.5 py-0.5 text-[10px] font-bold whitespace-nowrap text-black">
                      ⇪ 放開上傳到「{track.name}」@ {dropAt.time.toFixed(2)}s{dropAt.count > 1 ? `（${dropAt.count} 個檔案依序排列）` : ''}
                    </span>
                  </div>
                )}
                {lane.map((r) => (
                  <Region
                    key={r.id}
                    region={r}
                    track={track}
                    zoom={zoom}
                    view={view}
                    selected={selection.includes(r.id)}
                    remote={othersByRegion.get(r.id)}
                    automationMode={automationMode}
                    onMoveStart={(e, grip) => beginMove(e, r, grip)}
                    onGainStart={(e) => beginGain(e, r)}
                    onShape={(kind, e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      gesture.current = null // a long press on the node is not a drag
                      setDraftsBoth(null)
                      if (!selection.includes(r.id)) onSelect([r.id])
                      setShapeMenu({ id: r.id, kind, x: e.clientX, y: e.clientY })
                    }}
                    onToggleMute={() => props.onCommit([{ id: r.id, patch: { muted: !r.muted } }], r.muted ? '取消靜音片段' : '靜音片段')}
                    canUndo={props.canUndoRegion?.(r.id) ?? false}
                    onUndo={() => props.onUndoRegion?.(r.id)}
                    onEdgeStart={(e, kind) => beginEdge(e, r, kind)}
                    onNodeStart={(e, i, rect) => beginNode(e, r, i, rect)}
                    onAddNode={(e) => addNode(e, r)}
                    pickedNode={pickedNode?.kind === 'region' && pickedNode.regionId === r.id ? pickedNode.index : null}
                    onNodeMenu={(i, e) => openNodeMenu({ kind: 'region', regionId: r.id, index: i }, e)}
                    onRemoveNode={(i) => removeNode(r, i)}
                    pickedSeg={pickedSeg?.key === `region:${r.id}` ? pickedSeg.index : null}
                    onPickSeg={(index) => {
                      setPickedSeg(index == null ? null : { key: `region:${r.id}`, index })
                      setPickedNode(null)
                    }}
                    onCurveGrab={(e, index, what, svg) => beginCurve(e, index, what, r.automation, regionSpec(r, svg))}
                    onCurveReset={(index) => resetCurve(r.automation, index, { def: 'linear', commit: (pts, label) => props.onCommit([{ id: r.id, patch: { automation: pts } }], label) })}
                    onCurveChange={(pts, label) => props.onCommit([{ id: r.id, patch: { automation: pts } }], label)}
                    onMenu={(e) => {
                      e.preventDefault()
                      gesture.current = null
                      if (!selection.includes(r.id)) onSelect([r.id])
                      props.onRegionMenu(r, e.clientX, e.clientY)
                    }}
                  />
                ))}
                {recording?.trackId === track.id && (
                  <div
                    className="absolute top-1 bottom-1 rounded-md border border-panic bg-panic/25"
                    style={{ left: recording.start * zoom, width: Math.max(2, recording.elapsed * zoom) }}
                    data-recording-region
                  >
                    <span className="absolute top-1 left-1.5 text-[10px] font-bold text-panic">● REC</span>
                  </div>
                )}
              </div>
            </div>
            {lanes.map((param) => (
              <AutomationLaneRow
                key={param}
                track={track}
                param={param}
                points={autoDrafts?.[`${track.id}:${param}`] ?? track.automation[param]?.points ?? []}
                zoom={zoom}
                view={view}
                width={contentW}
                playhead={playhead}
                onAdd={(points, label) => props.onTrackAutomation(track, param, points, label)}
                onNodeStart={(e, index, points, lane) => beginAutoNode(e, track, param, index, points, lane)}
                pickedNode={pickedNode?.kind === 'lane' && pickedNode.trackId === track.id && pickedNode.param === param ? pickedNode.index : null}
                onNodeMenu={(i, e) => openNodeMenu({ kind: 'lane', trackId: track.id, param, index: i }, e)}
                onHide={() => props.onHideLane(track, param)}
                snapTime={snapTime}
                pickedSeg={pickedSeg?.key === `lane:${track.id}:${param}` ? pickedSeg.index : null}
                onPickSeg={(index) => {
                  setPickedSeg(index == null ? null : { key: `lane:${track.id}:${param}`, index })
                  setPickedNode(null)
                }}
                onCurveGrab={(e, index, what, points, svg) => beginCurve(e, index, what, points, laneSpec(track, param, svg))}
                onCurveReset={(index, points) => resetCurve(points, index, { def: 'smooth', commit: (pts, label) => props.onTrackAutomation(track, param, pts, label) })}
              />
            ))}
            </div>
          )
        })}
        {dropAt && dropAt.trackId === null && (
          <div className="pointer-events-none my-2 mr-2 rounded-lg border-2 border-dashed border-go/70 bg-go/10 py-3 text-center text-xs font-semibold text-go" style={{ marginLeft: headerW + 8 }} data-drop-new-track>
            ⇪ 放開上傳到新音軌 @ {dropAt.time.toFixed(2)}s
          </div>
        )}
        <div className="flex">
          <div className="sticky left-0 z-20 shrink-0 border-r border-line bg-[#151515] p-2" style={{ width: 'var(--header-w)' }}>
            {props.footer}
          </div>
        </div>

        {/* Section boundaries across the lanes */}
        {sections.flatMap((sec) => [
          <div key={`${sec.id}s`} className="pointer-events-none absolute bottom-0 z-[5] w-px opacity-40" style={{ top: RULER_H + SECTION_H, left: headerW + sec.start * zoom, background: sec.color }} />,
          <div key={`${sec.id}e`} className="pointer-events-none absolute bottom-0 z-[5] w-px opacity-25" style={{ top: RULER_H + SECTION_H, left: headerW + sec.end * zoom, background: sec.color }} />,
        ])}

        {/* Playheads */}
        <div className="pointer-events-none absolute top-0 bottom-0 z-[25] w-px bg-panic shadow-[0_0_6px_#ff453a]" style={{ left: headerW + (Number.isFinite(playhead) ? playhead : 0) * zoom }} data-playhead />
        {others.filter((o) => Number.isFinite(o.playhead)).map((o) => (
          <div key={o.id} className="pointer-events-none absolute top-0 bottom-0 z-[24] w-px opacity-70" style={{ left: headerW + o.playhead * zoom, background: o.color }} />
        ))}
      </div>
      {nodeMenu && nodeInfo(nodeMenu.target) && (
        <AutomationNodeMenu
          x={nodeMenu.x}
          y={nodeMenu.y}
          node={nodeInfo(nodeMenu.target)!}
          onEdit={() => {
            setNodeEditing(nodeMenu.target)
            setNodeMenu(null)
          }}
          onDelete={() => {
            deleteNode(nodeMenu.target)
            setNodeMenu(null)
          }}
          onClose={() => setNodeMenu(null)}
        />
      )}
      {nodeEditing && nodeInfo(nodeEditing) && (
        <AutomationNodeEditor
          node={nodeInfo(nodeEditing)!}
          onApply={(time, value) => {
            applyNodeEdit(nodeEditing, time, value)
            setNodeEditing(null)
          }}
          onClose={() => setNodeEditing(null)}
        />
      )}
      {/* Live start → end while a section is dragged or resized */}
      {secTip && (
        <div
          className="pointer-events-none fixed z-[120] -translate-x-1/2 -translate-y-full rounded-lg bg-black/90 px-3 py-1.5 font-mono text-base font-semibold whitespace-nowrap text-white shadow-xl ring-1 ring-white/20"
          style={{ left: secTip.x, top: secTip.y - 28 }}
          data-section-tip
        >
          {secTip.text}
        </div>
      )}
      {/* Live volume readout while a clip's gain is dragged */}
      {gainTip && (
        <div
          className="pointer-events-none fixed z-[120] -translate-x-1/2 -translate-y-full rounded-lg bg-black/90 px-3 py-1.5 font-mono text-lg font-semibold text-white shadow-xl ring-1 ring-white/20"
          style={{ left: gainTip.x, top: gainTip.y - 28 }}
          data-gain-tip
        >
          {gainTip.text}
        </div>
      )}
      {shapeMenu && studio.regions[shapeMenu.id] && (
        <FadeShapeMenu
          kind={shapeMenu.kind}
          x={shapeMenu.x}
          y={shapeMenu.y}
          value={(shapeMenu.kind === 'in' ? studio.regions[shapeMenu.id].fadeInShape : studio.regions[shapeMenu.id].fadeOutShape) ?? 'linear'}
          onPick={(shape) => {
            props.onCommit([{ id: shapeMenu.id, patch: shapeMenu.kind === 'in' ? { fadeInShape: shape } : { fadeOutShape: shape } }], shapeMenu.kind === 'in' ? '淡入曲線' : '淡出曲線')
            setShapeMenu(null)
          }}
          onClose={() => setShapeMenu(null)}
        />
      )}
    </div>
  )
}

/* ---------- one region ---------- */

function Region({
  region: r,
  track,
  zoom,
  view,
  selected,
  remote,
  automationMode,
  onMoveStart,
  onGainStart,
  onShape,
  onToggleMute,
  canUndo,
  onUndo,
  onEdgeStart,
  onNodeStart,
  onAddNode,
  onRemoveNode,
  onMenu,
  pickedNode,
  onNodeMenu,
  pickedSeg,
  onPickSeg,
  onCurveGrab,
  onCurveReset,
  onCurveChange,
}: {
  region: StudioRegion
  track: StudioTrack
  zoom: number
  view: { left: number; width: number }
  selected: boolean
  remote?: StudioPresence
  automationMode: boolean
  onMoveStart: (e: PointerEvent, grip?: boolean) => void
  /** The volume node: vertical drag sets the clip's gain. */
  onGainStart: (e: PointerEvent) => void
  /** Long-press / right-click on a fade node: pick the fade curve. */
  onShape: (kind: 'in' | 'out', e: ReactMouseEvent) => void
  onToggleMute: () => void
  canUndo: boolean
  onUndo: () => void
  onEdgeStart: (e: PointerEvent, kind: 'trim-l' | 'trim-r' | 'fade-in' | 'fade-out') => void
  onNodeStart: (e: PointerEvent, index: number, rect: DOMRect) => void
  onAddNode: (e: ReactMouseEvent) => void
  onRemoveNode: (index: number) => void
  onMenu: (e: ReactMouseEvent) => void
  /** Index of this region's picked automation node (highlighted; Delete removes it). */
  pickedNode: number | null
  onNodeMenu: (index: number, e: ReactMouseEvent) => void
  /** Picked curve segment of this region's volume automation. */
  pickedSeg: number | null
  onPickSeg: (index: number | null) => void
  onCurveGrab: (e: PointerEvent, index: number, what: CurveGrab, svg: DOMRect) => void
  onCurveReset: (index: number) => void
  onCurveChange: (points: StudioPoint[], label: string) => void
}) {
  const x = r.start * zoom
  const w = Math.max(3, r.duration * zoom)
  const h = LANE_H - 8
  const color = track.color
  const autoY = (v: number) => (1 - v / AUTO_MAX) * (h - BAR_H) + BAR_H
  // Straight lines between nodes unless a segment was curved (grips / Bézier handles in automation mode).
  const geometry: CurveGeometry = { X: (t) => t * zoom, Y: autoY, range: REGION_GAIN_RANGE, def: 'linear' }
  const pts = r.automation.length ? r.automation : [{ t: 0, v: 1 }, { t: r.duration, v: 1 }]
  const line = curvePath(pts, curveSegmentsOf(pts, geometry), geometry, 0, w)
  const seg = automationMode && pickedSeg != null && r.automation[pickedSeg + 1] ? pickedSeg : null

  return (
    <div
      className={`group absolute top-1 overflow-hidden rounded-md border ${selected ? 'touch-none border-white ring-1 ring-white/70' : 'touch-pan-x touch-pan-y border-black/40'} ${r.muted ? 'opacity-40' : ''}`}
      style={{ left: x, width: w, height: h, background: `${color}33`, outline: remote ? `2px solid ${remote.color}` : undefined }}
      onPointerDown={automationMode ? undefined : onMoveStart}
      onContextMenu={onMenu}
      data-region={r.id}
      title={r.comment || undefined}
    >
      {/* Name bar (always draggable, also in automation mode) */}
      <div
        className="relative z-10 flex h-4 items-center gap-1 px-1.5 text-[10px] font-semibold whitespace-nowrap text-black"
        style={{ background: color }}
        onPointerDown={automationMode ? onMoveStart : undefined}
      >
        <span className="truncate">{r.name}</span>
        {r.kind === 'tts' && <span className="rounded bg-black/20 px-1">TTS</span>}
        {r.kind === 'recording' && <span className="rounded bg-black/20 px-1">REC</span>}
        {r.reverse && <span title="反轉">⇆</span>}
        {r.pitch !== 0 && <span>{r.pitch > 0 ? `+${r.pitch}` : r.pitch}st</span>}
        {r.cleanup && <span title="人聲清理">✧</span>}
        {r.comment && <span title={r.comment}>💬</span>}
        {r.muted && <span>🔇</span>}
      </div>

      <Waveform region={r} zoom={zoom} view={view} x={x} width={w} height={h - 16} color={color} />

      {/* Fades: the dark area is what the fade removes, drawn along the chosen curve */}
      <svg className="pointer-events-none absolute inset-x-0 top-4 bottom-0 z-[5]" width={w} height={h - 16} preserveAspectRatio="none">
        {r.fadeIn > 0 && <path d={fadeAreaPath(r.fadeInShape, r.fadeIn * zoom, h - 16, 'in')} fill="rgba(0,0,0,0.45)" />}
        {r.fadeOut > 0 && <path d={fadeAreaPath(r.fadeOutShape, r.fadeOut * zoom, h - 16, 'out', w)} fill="rgba(0,0,0,0.45)" />}
        {/* Clip volume: the band from the top is how much was taken off (live while dragging ═); a boost shows an amber line */}
        {r.gain < 0.995 && (
          <>
            <rect x={0} y={0} width={w} height={(1 - r.gain) * (h - 16)} fill="rgba(48,209,88,0.30)" data-gain-shade />
            <line x1={0} x2={w} y1={(1 - r.gain) * (h - 16)} y2={(1 - r.gain) * (h - 16)} stroke="rgba(120,255,160,0.85)" strokeWidth={1.5} />
            {(1 - r.gain) * (h - 16) > 16 && (
              <text x={6} y={(1 - r.gain) * (h - 16) - 5} fontSize={11} fontWeight={700} fill="rgba(255,255,255,0.9)" className="font-mono">
                {dbLabel(r.gain)}
              </text>
            )}
          </>
        )}
        {r.gain > 1.005 && (
          <>
            <line x1={0} x2={w} y1={1} y2={1} stroke="rgba(255,214,10,0.9)" strokeWidth={2} data-gain-boost />
            <text x={6} y={14} fontSize={11} fontWeight={700} fill="rgba(255,214,10,0.95)" className="font-mono">
              {dbLabel(r.gain)}
            </text>
          </>
        )}
      </svg>

      {/* Volume automation */}
      {(automationMode || r.automation.length > 0) && (
        <svg
          className={`absolute inset-0 z-[6] ${automationMode ? 'cursor-crosshair' : 'pointer-events-none'}`}
          width={w}
          height={h}
          onClick={automationMode ? onAddNode : undefined}
          data-automation={r.id}
        >
          <path d={line} fill="none" stroke={automationMode ? '#ffd60a' : 'rgba(255,214,10,0.55)'} strokeWidth={automationMode ? 2 : 1.25} data-region-curve />
          {automationMode && r.automation.length >= 2 && (
            <CurveLayer
              points={r.automation}
              geometry={geometry}
              color="#ffd60a"
              picked={seg}
              onPick={onPickSeg}
              onGrab={(e, index, what, svg) => onCurveGrab(e, index, what, svg)}
              onReset={onCurveReset}
            />
          )}
          {automationMode &&
            r.automation.map((p, i) => (
              <circle
                key={i}
                cx={p.t * zoom}
                cy={autoY(p.v)}
                r={pickedNode === i ? 6.5 : 5}
                fill="#ffd60a"
                stroke={pickedNode === i ? '#fff' : '#000'}
                strokeWidth={pickedNode === i ? 2.5 : 1.5}
                className="cursor-grab"
                onClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => onNodeStart(e, i, (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect())}
                onDoubleClick={(e) => {
                  e.stopPropagation()
                  onRemoveNode(i)
                }}
                onContextMenu={(e) => onNodeMenu(i, e)}
                data-node={i}
                data-picked={pickedNode === i ? '1' : undefined}
              >
                <title>{`${(r.start + p.t).toFixed(2)}s · ${dbLabel(p.v)}（右鍵編輯 · Delete 刪除）`}</title>
              </circle>
            ))}
        </svg>
      )}

      {seg != null && (
        <CurveToolbar
          points={r.automation}
          index={seg}
          geometry={geometry}
          onChange={(next, label, pick) => {
            onCurveChange(next, label)
            onPickSeg(pick)
          }}
          compact
          // On the name bar, above the automation area, so it never covers a handle.
          style={{ left: Math.min(w - 80, Math.max(80, ((r.automation[seg].t + r.automation[seg + 1].t) / 2) * zoom)), top: 0 }}
        />
      )}

      {/* Edit nodes of the selected clip: ◤ fade in · ✥ move · ═ volume · ◥ fade out · ‖ trim · 🔊 mute · ↺ undo (hold a fade node for its curve) */}
      {selected && !automationMode && (
        <div className="absolute inset-0 z-[9]" data-clip-nodes>
          {(() => {
            const node = 'absolute flex touch-none items-center justify-center rounded-full border border-black/70 bg-[#6b7873]/90 text-white shadow-md select-none h-7 w-7 text-[13px] pointer-coarse:h-10 pointer-coarse:w-10 pointer-coarse:text-lg'
            const compact = w < 120
            return (
              <>
                {/* Volume: drag ═ down for quieter, up for louder */}
                <div
                  className={`${node} top-1 left-1/2 -translate-x-1/2 cursor-ns-resize`}
                  onPointerDown={onGainStart}
                  aria-label="上下拖曳調整音量"
                  title="上下拖曳調整片段音量"
                  data-clip-volume
                >
                  ═
                </div>
                {/* Trim */}
                <div className={`${node} top-1/2 left-0.5 -translate-y-1/2 cursor-ew-resize`} onPointerDown={(e) => onEdgeStart(e, 'trim-l')} title="拖曳修剪片頭" data-trim="l">
                  ‖
                </div>
                <div className={`${node} top-1/2 right-0.5 -translate-y-1/2 cursor-ew-resize`} onPointerDown={(e) => onEdgeStart(e, 'trim-r')} title="拖曳修剪片尾" data-trim="r">
                  ‖
                </div>
                {!compact && (
                  <>
                    {/* Move: grab ✥ (or the clip itself) and drag, in time and across tracks */}
                    <div
                      className={`${node} top-1 left-9 cursor-grab pointer-coarse:left-[3.1rem]`}
                      onPointerDown={(e) => onMoveStart(e, true)}
                      aria-label="拖曳移動片段"
                      title="拖曳移動片段（時間與跨軌道）"
                      data-region-grip
                    >
                      ✥
                    </div>
                    {/* Fades (long-press or right-click: curve) */}
                    <div className={`${node} top-1 left-0.5 cursor-ew-resize`} onPointerDown={(e) => onEdgeStart(e, 'fade-in')} onContextMenu={(e) => onShape('in', e)} title="拖曳設定淡入 · 長按選曲線" data-fade="in">
                      ◤
                    </div>
                    <div className={`${node} top-1 right-0.5 cursor-ew-resize`} onPointerDown={(e) => onEdgeStart(e, 'fade-out')} onContextMenu={(e) => onShape('out', e)} title="拖曳設定淡出 · 長按選曲線" data-fade="out">
                      ◥
                    </div>
                    <button type="button" data-haptic="tap" className={`${node} bottom-1 left-0.5 cursor-pointer`} onPointerDown={(e) => e.stopPropagation()} onClick={onToggleMute} aria-label={r.muted ? '取消靜音' : '靜音'} aria-pressed={r.muted} title="靜音 / 取消靜音" data-clip-mute>
                      {r.muted ? '🔇' : '🔊'}
                    </button>
                    <button type="button" data-haptic="tap" disabled={!canUndo} className={`${node} right-0.5 bottom-1 cursor-pointer disabled:opacity-35`} onPointerDown={(e) => e.stopPropagation()} onClick={onUndo} aria-label="復原此片段的上一步編輯" title="復原此片段的上一步（最多 10 步）" data-clip-undo>
                      ↺
                    </button>
                  </>
                )}
              </>
            )
          })()}
        </div>
      )}
    </div>
  )
}

/** Draws only the visible part of a region's waveform (regions can be far wider than a canvas allows). */
function Waveform({ region: r, zoom, view, x, width, height, color }: { region: StudioRegion; zoom: number; view: { left: number; width: number }; x: number; width: number; height: number; color: string }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [buffer, setBuffer] = useState<AudioBuffer | null>(null)
  const [failed, setFailed] = useState(false)
  const key = `${r.url}|${r.reverse}|${r.pitch}|${r.cleanup}`
  useEffect(() => {
    let alive = true
    regionBuffer(r).then(
      (b) => alive && setBuffer(b),
      () => alive && setFailed(true),
    )
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key covers the fields regionBuffer reads
  }, [key])

  // Visible slice of the region, in region-local pixels (with a margin so short scrolls don't flash).
  const margin = 200
  const sliceStart = Math.max(0, view.left - margin - x)
  const sliceEnd = Math.min(width, view.left + view.width + margin - x)
  const sliceW = Math.max(0, Math.ceil(sliceEnd - sliceStart))

  useEffect(() => {
    const c = canvas.current
    if (!c || !buffer || sliceW <= 0) return
    const dpr = window.devicePixelRatio || 1
    c.width = Math.ceil(sliceW * dpr)
    c.height = Math.ceil(height * dpr)
    const g = c.getContext('2d')!
    g.scale(dpr, dpr)
    g.clearRect(0, 0, sliceW, height)
    const peaks = peaksOf(buffer)
    const perSecond = buffer.sampleRate / PEAK_RESOLUTION
    const startInBuffer = bufferOffset(r, buffer)
    const mid = height / 2
    const scale = mid * 0.92 * Math.min(1.6, r.gain)
    g.fillStyle = color
    for (let px = 0; px < sliceW; px++) {
      const t0 = (sliceStart + px) / zoom
      const a = Math.floor((startInBuffer + t0) * perSecond)
      const b = Math.max(a + 1, Math.floor((startInBuffer + t0 + 1 / zoom) * perSecond))
      let lo = 0
      let hi = 0
      for (let i = a; i < b && i * 2 + 1 < peaks.length; i++) {
        if (peaks[i * 2] < lo) lo = peaks[i * 2]
        if (peaks[i * 2 + 1] > hi) hi = peaks[i * 2 + 1]
      }
      const top = mid - hi * scale
      g.fillRect(px, top, 1, Math.max(1, mid - lo * scale - top))
    }
  }, [buffer, sliceStart, sliceW, height, zoom, color, r.offset, r.duration, r.gain, r.reverse, r])

  if (failed) return <div className="absolute inset-x-0 top-4 bottom-0 flex items-center justify-center text-[10px] text-panic/80">無法載入音檔</div>
  if (!buffer)
    return (
      <div className="absolute inset-x-0 top-4 bottom-0 flex items-center justify-center text-[10px] text-white/40">
        <span className="mr-1 h-2.5 w-2.5 animate-spin rounded-full border border-white/30 border-t-white/80" />
        {r.pitch || r.reverse || r.cleanup ? '處理中…' : '載入中…'}
      </div>
    )
  return <canvas ref={canvas} className="pointer-events-none absolute top-4" style={{ left: sliceStart, width: sliceW, height }} data-waveform />
}

/* ---------- one track automation lane ---------- */

function AutomationLaneRow({
  track,
  param,
  points,
  zoom,
  view,
  width,
  playhead,
  onAdd,
  onNodeStart,
  onHide,
  snapTime,
  pickedNode,
  onNodeMenu,
  pickedSeg,
  onPickSeg,
  onCurveGrab,
  onCurveReset,
}: {
  track: StudioTrack
  param: TrackParam
  points: StudioPoint[]
  zoom: number
  view: { left: number; width: number }
  width: number
  playhead: number
  onAdd: (points: StudioPoint[], label: string) => void
  onNodeStart: (e: PointerEvent, index: number, points: StudioPoint[], lane: DOMRect) => void
  onHide: () => void
  snapTime: (t: number) => number
  pickedNode: number | null
  onNodeMenu: (index: number, e: ReactMouseEvent) => void
  /** The picked curve segment (index of its first node), showing its Bézier handles. */
  pickedSeg: number | null
  onPickSeg: (index: number | null) => void
  onCurveGrab: (e: PointerEvent, index: number, what: CurveGrab, points: StudioPoint[], svg: DOMRect) => void
  onCurveReset: (index: number, points: StudioPoint[]) => void
}) {
  const info = PARAM_INFO[param]
  // Segments are drawn as the exact SVG cubics they're evaluated as (crisp at any zoom).
  const geometry: CurveGeometry = { X: (t) => t * zoom, Y: (v) => autoY(param, v), range: info, def: 'smooth' }
  const line = points.length ? curvePath(points, curveSegmentsOf(points, geometry), geometry, 0, width) : `M0,${autoY(param, info.default)} L${width},${autoY(param, info.default)}`
  const area = `${line} L${width},${AUTO_H} L0,${AUTO_H} Z`
  const current = laneValueAt(points, playhead, param)
  const seg = pickedSeg != null && points[pickedSeg + 1] ? pickedSeg : null

  return (
    <div className="flex" style={{ height: AUTO_H }} data-auto-lane={`${track.id}:${param}`}>
      <div className="sticky left-0 z-20 flex shrink-0 flex-col justify-center gap-1 border-r border-b border-line bg-[#141414] py-1 pr-2 pl-5" style={{ width: 'var(--header-w)' }}>
        <div className="flex items-center gap-1.5">
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: info.color }} />
          <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-white/80">{info.label}</span>
          <button type="button" onClick={onHide} className="h-5 w-5 shrink-0 rounded text-[10px] text-white/35 hover:bg-white/10 hover:text-white" aria-label={`隱藏 ${info.label} 自動化`} title="隱藏此自動化軌（節點保留）">
            ✕
          </button>
        </div>
        <div className="flex items-center gap-1 text-[10px] text-white/45">
          <span className="font-mono tabular" data-auto-value>
            {paramLabel(param, current)}
          </span>
          <span className="ml-auto">{points.length} 個節點</span>
          {points.length > 0 && (
            <button type="button" onClick={() => onAdd([], '清除自動化')} className="rounded px-1 text-white/40 hover:bg-white/10 hover:text-white">
              清除
            </button>
          )}
        </div>
        {seg != null ? (
          <CurveToolbar
            points={points}
            index={seg}
            geometry={geometry}
            compact
            onChange={(pts, label, pick) => {
              onAdd(pts, label)
              onPickSeg(pick)
            }}
          />
        ) : (
          <div className="truncate text-[9px] text-white/30">{points.length >= 2 ? '◇ 拖曳線段中點彎曲 · 點一下出現控制柄' : '點軌道新增節點（兩個以上可彎曲）'}</div>
        )}
      </div>
      <div className="relative shrink-0 border-b border-line bg-[#0c0c0c]" style={{ width }}>
        <svg
          className="absolute inset-0 cursor-crosshair overflow-visible"
          width={width}
          height={AUTO_H}
          onPointerDown={(e) => {
            // Click on the empty lane (not a node or curve part) adds a node there.
            if (e.button !== 0 || (e.target as Element).closest('[data-auto-node], [data-curve-ui]')) return
            e.stopPropagation()
            onPickSeg(null)
            const rect = e.currentTarget.getBoundingClientRect()
            const t = Math.round(snapTime((e.clientX - rect.left) / zoom) * 1000) / 1000
            const next = [...points.filter((p) => Math.abs(p.t - t) > 0.005), { t, v: autoValue(param, e.clientY - rect.top) }].sort((a, b) => a.t - b.t)
            onAdd(next, '新增自動化節點')
          }}
          data-auto-svg
        >
          <line x1={0} x2={width} y1={autoY(param, info.default)} y2={autoY(param, info.default)} stroke="rgba(255,255,255,0.12)" strokeDasharray="4 4" />
          {/* Scale hints at the visible left edge: what the top and bottom of the lane mean. */}
          <text x={view.left + 6} y={12} fontSize={9} fill="rgba(255,255,255,0.35)">
            {param === 'volume' ? '+3.5 dB' : param === 'pan' ? 'R 右' : '20 kHz'}
          </text>
          <text x={view.left + 6} y={AUTO_H - 4} fontSize={9} fill="rgba(255,255,255,0.35)">
            {param === 'volume' ? '−∞' : param === 'pan' ? 'L 左' : '20 Hz'}
          </text>
          <path d={area} fill={info.color} opacity={points.length ? 0.12 : 0.04} />
          <path d={line} fill="none" stroke={info.color} strokeWidth={points.length ? 2 : 1} opacity={points.length ? 1 : 0.4} data-auto-curve />
          <CurveLayer
            points={points}
            geometry={geometry}
            color={info.color}
            picked={seg}
            onPick={onPickSeg}
            onGrab={(e, index, what, svg) => onCurveGrab(e, index, what, points, svg)}
            onReset={(index) => onCurveReset(index, points)}
          />
          {points.map((p, i) => (
            <circle
              key={i}
              cx={p.t * zoom}
              cy={autoY(param, p.v)}
              r={pickedNode === i ? 6.5 : 5}
              fill={info.color}
              stroke={pickedNode === i ? '#fff' : '#000'}
              strokeWidth={pickedNode === i ? 2.5 : 1.5}
              className="cursor-grab"
              onPointerDown={(e) => onNodeStart(e, i, points, (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect())}
              onDoubleClick={(e) => {
                e.stopPropagation()
                onAdd(points.filter((_, j) => j !== i), '刪除自動化節點')
              }}
              onContextMenu={(e) => onNodeMenu(i, e)}
              data-auto-node={i}
              data-picked={pickedNode === i ? '1' : undefined}
            >
              <title>{`${p.t.toFixed(2)}s · ${paramLabel(param, p.v)}（右鍵編輯 · Delete 或雙擊刪除）`}</title>
            </circle>
          ))}
        </svg>
      </div>
    </div>
  )
}
