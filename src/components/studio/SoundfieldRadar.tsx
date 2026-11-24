import { useEffect, useRef } from 'react'
import { applyMatrix3, fieldRotation, foaPowerToward, transpose3, type Rotation } from '../../types/spatialAudio'

const BINS = 48

/**
 * Soundfield Energy Radar: where the sound of a first-order soundfield comes from, after the rotation — a top view
 * (front up, left / right, back down) and a side view (front right, above / below), each a ring of wedges that grow
 * with the energy in that direction (cardioid beams steered from the W, Y, Z, X statistics).
 * `getCov` returns the 4×4 covariance (row-major, W Y Z X) or null while nothing plays.
 */
export function SoundfieldRadar({ getCov, rotation }: { getCov: () => Float64Array | null; rotation: Rotation }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const latest = useRef({ getCov, rotation })
  useEffect(() => {
    latest.current = { getCov, rotation }
  })

  useEffect(() => {
    const c = canvas.current
    if (!c) return
    const g = c.getContext('2d')!
    const smooth = { top: new Float32Array(BINS), side: new Float32Array(BINS) }
    let peak = 1e-9
    let raf = 0
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const dpr = window.devicePixelRatio || 1
      const w = c.clientWidth
      const h = c.clientHeight
      if (c.width !== Math.round(w * dpr)) {
        c.width = Math.round(w * dpr)
        c.height = Math.round(h * dpr)
      }
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.clearRect(0, 0, w, h)
      const { getCov: cov, rotation: rot } = latest.current
      const m = transpose3(fieldRotation(rot)) // displayed direction → direction in the file's field
      const data = cov()
      const raw = { top: new Float32Array(BINS), side: new Float32Array(BINS) }
      if (data) {
        for (let i = 0; i < BINS; i++) {
          const a = (i / BINS) * Math.PI * 2
          // top view: 0 = front, clockwise towards the right; side view: 0 = front, towards up
          raw.top[i] = foaPowerToward(data, applyMatrix3(m, { x: Math.sin(a), y: 0, z: -Math.cos(a) }))
          raw.side[i] = foaPowerToward(data, applyMatrix3(m, { x: 0, y: Math.sin(a), z: -Math.cos(a) }))
        }
        const max = Math.max(...raw.top, ...raw.side)
        peak = Math.max(max, peak * 0.995)
      }
      for (let i = 0; i < BINS; i++) {
        smooth.top[i] += (raw.top[i] - smooth.top[i]) * 0.3
        smooth.side[i] += (raw.side[i] - smooth.side[i]) * 0.3
      }
      const panel = (cx: number, cy: number, r: number, values: Float32Array, label: string, marks: [string, number, number][]) => {
        g.strokeStyle = 'rgba(255,255,255,0.10)'
        g.lineWidth = 1
        for (const k of [0.33, 0.66, 1]) {
          g.beginPath()
          g.arc(cx, cy, r * k, 0, Math.PI * 2)
          g.stroke()
        }
        g.beginPath()
        g.moveTo(cx - r, cy)
        g.lineTo(cx + r, cy)
        g.moveTo(cx, cy - r)
        g.lineTo(cx, cy + r)
        g.stroke()
        for (let i = 0; i < BINS; i++) {
          const level = Math.sqrt(Math.min(1, values[i] / peak))
          if (level < 0.02) continue
          const a = (i / BINS) * Math.PI * 2
          const half = Math.PI / BINS
          // angle 0 = front: up in the top view, right in the side view
          const base = label === 'top' ? a - Math.PI / 2 : -a
          g.beginPath()
          g.moveTo(cx, cy)
          g.arc(cx, cy, r * level, base - half, base + half)
          g.closePath()
          g.fillStyle = `hsla(${210 - level * 170}, 90%, ${45 + level * 15}%, ${0.35 + level * 0.55})`
          g.fill()
        }
        g.fillStyle = 'rgba(255,255,255,0.45)'
        g.font = '10px sans-serif'
        g.textAlign = 'center'
        g.textBaseline = 'middle'
        for (const [t, dx, dy] of marks) g.fillText(t, cx + dx * (r + 9), cy + dy * (r + 9))
        // the listener
        g.fillStyle = '#e8e8ee'
        g.beginPath()
        g.arc(cx, cy, 3, 0, Math.PI * 2)
        g.fill()
      }
      const r = Math.min(w / 4 - 14, h / 2 - 14)
      panel(w / 4, h / 2, r, smooth.top, 'top', [['前', 0, -1], ['後', 0, 1], ['左', -1, 0], ['右', 1, 0]])
      panel((w * 3) / 4, h / 2, r, smooth.side, 'side', [['前', 1, 0], ['後', -1, 0], ['上', 0, -1], ['下', 0, 1]])
      if (!data) {
        g.fillStyle = 'rgba(255,255,255,0.35)'
        g.font = '11px sans-serif'
        g.textAlign = 'center'
        g.fillText('播放後顯示聲能分布', w / 2, h - 6)
      }
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])

  return <canvas ref={canvas} className="h-[150px] w-full rounded-lg bg-black/50" data-soundfield-radar />
}
