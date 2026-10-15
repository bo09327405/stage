import { useEffect, useRef, type PointerEvent } from 'react'
import { LONG_PRESS_MS, curveSegments, type CurveGeometry, type CurveGrab } from '../../studio/curveGeometry'
import { presetHandles, segmentMid, shapeOf, splitSegment, withShape } from '../../studio/curves'
import type { StudioPoint } from '../../types/studio'

/*
 * The curve-editing layer shared by track automation lanes and region volume automation:
 *
 *   · every segment gets a bend grip at its middle — drag it up / down to curve the segment
 *   · tap the grip or the line to pick the segment: its two Bézier handles and a shape toolbar appear
 *   · drag a handle (mouse, pen or finger) to shape the curve freely
 *   · double-click or long-press a segment, grip or handle to reset it (custom → default, smooth ⇄ linear)
 *
 * Dragging is run by the parent's pointer gesture (it owns drafts and commits); this layer only
 * draws and reports where gestures start.
 */


export function CurveLayer({
  points,
  geometry: g,
  color,
  picked,
  onPick,
  onGrab,
  onReset,
}: {
  points: StudioPoint[]
  geometry: CurveGeometry
  color: string
  /** Picked segment (index of its first node) — shows its handles. */
  picked: number | null
  onPick: (index: number) => void
  /** A drag starts on a segment's grip or one of its handles. */
  onGrab: (e: PointerEvent<SVGElement>, index: number, what: CurveGrab, svg: DOMRect) => void
  onReset: (index: number) => void
}) {
  const segs = curveSegments(points, g)
  const sel = picked != null ? segs[picked] : undefined
  const svgRect = (el: Element) => ((el as SVGElement).ownerSVGElement ?? (el as SVGSVGElement)).getBoundingClientRect()

  // Long press on a segment line resets it (the grip and handles long-press through the parent's gesture).
  const press = useRef<{ timer: number; x: number; y: number } | null>(null)
  const cancelPress = () => {
    if (press.current) window.clearTimeout(press.current.timer)
    press.current = null
  }
  useEffect(() => cancelPress, [])

  // A finger that lands on a curve part drags it instead of scrolling (CSS touch-action isn't
  // honoured on SVG shapes, and React's touch listeners are passive).
  const layer = useRef<SVGGElement>(null)
  useEffect(() => {
    const el = layer.current
    if (!el) return
    const claim = (e: TouchEvent) => {
      if (e.touches.length === 1) e.preventDefault()
    }
    el.addEventListener('touchstart', claim, { passive: false })
    return () => el.removeEventListener('touchstart', claim)
  }, [])

  return (
    <g ref={layer} data-curve-ui>
      {sel && <path d={sel.d} fill="none" stroke="#fff" strokeWidth={2.5} opacity={0.9} pointerEvents="none" />}
      {/* Wide invisible strokes: tap a segment to pick it. */}
      {segs.map((sg, i) => (
        <path
          key={`hit${i}`}
          d={sg.d}
          fill="none"
          stroke="transparent"
          strokeWidth={14}
          className="cursor-pointer"
          onPointerDown={(e) => {
            if (e.button !== 0) return
            e.stopPropagation()
            onPick(i)
            cancelPress()
            press.current = {
              x: e.clientX,
              y: e.clientY,
              timer: window.setTimeout(() => {
                press.current = null
                onReset(i)
                navigator.vibrate?.(15)
              }, LONG_PRESS_MS),
            }
          }}
          onPointerMove={(e) => {
            if (press.current && Math.hypot(e.clientX - press.current.x, e.clientY - press.current.y) > 5) cancelPress()
          }}
          onPointerUp={cancelPress}
          onPointerCancel={cancelPress}
          onPointerLeave={cancelPress}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => {
            e.stopPropagation()
            cancelPress()
            onReset(i)
          }}
          data-auto-seg={i}
        >
          <title>點一下顯示貝茲控制柄 · 雙擊或長按：重設（平滑 ⇄ 直線）</title>
        </path>
      ))}
      {/* Bend grips at the middle of every segment. */}
      {segs.map((sg, i) => {
        const m = segmentMid(sg.c)
        const shape = shapeOf(sg.a, g.def)
        return (
          <g key={`grip${i}`} data-auto-grip={i} data-shape={shape}>
            <rect
              x={g.X(m.t) - 4.5}
              y={g.Y(m.v) - 4.5}
              width={9}
              height={9}
              transform={`rotate(45 ${g.X(m.t)} ${g.Y(m.v)})`}
              fill={picked === i || shape === 'bezier' ? color : '#0c0c0c'}
              stroke={picked === i ? '#fff' : color}
              strokeWidth={1.5}
              pointerEvents="none"
            />
            <circle
              cx={g.X(m.t)}
              cy={g.Y(m.v)}
              r={13}
              fill="transparent"
              className="cursor-ns-resize"
              onPointerDown={(e) => {
                if (e.button !== 0) return
                e.stopPropagation()
                onPick(i)
                onGrab(e, i, 'grip', svgRect(e.currentTarget))
              }}
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => {
                e.stopPropagation()
                onReset(i)
              }}
              data-auto-grip-hit={i}
            >
              <title>上下拖曳：彎曲這段曲線 · 點一下：顯示貝茲控制柄 · 雙擊或長按：重設</title>
            </circle>
          </g>
        )
      })}
      {sel &&
        picked != null &&
        ([1, 2] as const).map((which) => {
          const hx = g.X(which === 1 ? sel.c.t1 : sel.c.t2)
          const hy = g.Y(which === 1 ? sel.c.v1 : sel.c.v2)
          const ax = g.X(which === 1 ? sel.a.t : sel.b.t)
          const ay = g.Y(which === 1 ? sel.a.v : sel.b.v)
          return (
            <g key={`h${which}`} data-auto-handle={which}>
              <line x1={ax} y1={ay} x2={hx} y2={hy} stroke="rgba(255,255,255,0.7)" strokeWidth={1} strokeDasharray="3 2" pointerEvents="none" />
              <circle cx={hx} cy={hy} r={5} fill="#fff" stroke={color} strokeWidth={2} pointerEvents="none" />
              {/* Big transparent target for fingers. */}
              <circle
                cx={hx}
                cy={hy}
                r={15}
                fill="transparent"
                className="cursor-move"
                onPointerDown={(e) => {
                  if (e.button !== 0) return
                  e.stopPropagation()
                  onGrab(e, picked, which, svgRect(e.currentTarget))
                }}
                onClick={(e) => e.stopPropagation()}
                onDoubleClick={(e) => {
                  e.stopPropagation()
                  onReset(picked)
                }}
                data-auto-handle-hit={which}
              >
                <title>拖曳控制柄調整曲率 · 雙擊或長按重設</title>
              </circle>
            </g>
          )
        })}
    </g>
  )
}

/** Shape buttons for the picked segment: 直線 / 平滑 / 貝茲 / ＋節點. */
export function CurveToolbar({
  points,
  index,
  geometry: g,
  onChange,
  style,
  compact = false,
}: {
  points: StudioPoint[]
  index: number
  geometry: CurveGeometry
  onChange: (points: StudioPoint[], label: string, pick: number | null) => void
  /** Absolute placement (inside a region); omitted = inline (in a lane header). */
  style?: React.CSSProperties
  compact?: boolean
}) {
  const a = points[index]
  const b = points[index + 1]
  if (!a || !b) return null
  const shape = shapeOf(a, g.def)
  const set = (p: StudioPoint, label: string) => onChange(points.map((q, i) => (i === index ? p : q)), label, index)
  const button = (label: string, active: boolean, onClick: () => void, id: string, title: string) => (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      onPointerDown={(e) => e.stopPropagation()}
      className={`${compact ? 'h-4 px-1 text-[9px] leading-none' : 'h-5 px-1.5 text-[10px]'} rounded font-semibold whitespace-nowrap ${active ? 'bg-white/20 text-white' : 'text-white/60 hover:bg-white/10 hover:text-white'}`}
      title={title}
      data-seg-shape={id}
    >
      {label}
    </button>
  )
  return (
    <div
      className={`flex items-center gap-0.5 rounded-md border border-white/15 bg-[#1e1e1e]/95 shadow-lg ${style ? 'absolute z-30 -translate-x-1/2' : 'w-fit'} ${compact ? 'p-0' : 'p-0.5'}`}
      style={style}
      onPointerDown={(e) => e.stopPropagation()}
      data-seg-toolbar
    >
      {button('直線', shape === 'linear', () => set(withShape(a, 'linear', g.def), '自動化曲線改為直線'), 'linear', '直線（線性）')}
      {button('平滑', shape === 'smooth', () => set(withShape(a, 'smooth', g.def), '自動化曲線改為平滑'), 'smooth', '標準平滑曲線（ease-in-out）')}
      {button(
        '貝茲',
        shape === 'bezier',
        () => set({ ...a, curve: 'bezier', h: shape === 'bezier' ? a.h! : { ...presetHandles('linear', a, b, g.range), y1: 0.2, y2: -0.2 } }, '自動化曲線改為貝茲'),
        'bezier',
        '貝茲曲線：拖曳兩個白色控制柄調整',
      )}
      <span className="mx-0.5 h-4 w-px bg-white/15" />
      {button(
        '＋節點',
        false,
        () => {
          const [first, mid] = splitSegment(a, b, (a.t + b.t) / 2, g.range, g.def)
          onChange([...points.slice(0, index), first, mid, ...points.slice(index + 1)], '在曲線上新增節點', null)
        },
        'split',
        '在這段曲線的中間加一個節點（形狀不變）',
      )}
    </div>
  )
}
