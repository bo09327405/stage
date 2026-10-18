import { useEffect, useRef, useState } from 'react'
import { inpaint, loadImage, maskFromPaint } from '../../services/imageTools'

const MAX_SIDE = 1600

/**
 * Magic Object Eraser: paint over what should disappear (dust, a wire, a prop, a stray mark); the area is filled in
 * from its surroundings. The result is saved as a new picture — the original file stays untouched and can be restored.
 */
export function MagicEraser({ src, mode = 'inpaint', onDone, onClose }: { src: string; /** 'mask': don't fill, hand back the painted area as a black-and-white mask (used for video: it is filled live, frame by frame). */ mode?: 'inpaint' | 'mask'; onDone: (png: Blob) => Promise<void>; onClose: () => void }) {
  const stage = useRef<HTMLCanvasElement>(null)
  const paint = useRef<HTMLCanvasElement>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [brush, setBrush] = useState(24)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [painted, setPainted] = useState(false)
  const drawing = useRef<{ id: number; x: number; y: number } | null>(null)

  useEffect(() => {
    let alive = true
    loadImage(src)
      .then((img) => {
        if (!alive) return
        imageRef.current = img
        const k = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight))
        setSize({ w: Math.round(img.naturalWidth * k), h: Math.round(img.naturalHeight * k) })
      })
      .catch((err: Error) => alive && setError(err.message))
    return () => {
      alive = false
    }
  }, [src])

  useEffect(() => {
    const img = imageRef.current
    if (!img || !size.w || !stage.current || !paint.current) return
    stage.current.width = paint.current.width = size.w
    stage.current.height = paint.current.height = size.h
    stage.current.getContext('2d')!.drawImage(img, 0, 0, size.w, size.h)
  }, [size])

  const at = (e: React.PointerEvent) => {
    const r = paint.current!.getBoundingClientRect()
    return { x: ((e.clientX - r.left) / r.width) * size.w, y: ((e.clientY - r.top) / r.height) * size.h }
  }
  const dot = (x: number, y: number, fromX = x, fromY = y) => {
    const ctx = paint.current!.getContext('2d')!
    // Brush size is in screen pixels of the shown picture: convert to picture pixels.
    const scale = size.w / paint.current!.getBoundingClientRect().width
    ctx.strokeStyle = ctx.fillStyle = 'rgba(255,60,60,0.75)'
    ctx.lineWidth = brush * scale
    ctx.lineCap = ctx.lineJoin = 'round'
    ctx.beginPath()
    ctx.moveTo(fromX, fromY)
    ctx.lineTo(x, y)
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(x, y, (brush * scale) / 2, 0, Math.PI * 2)
    ctx.fill()
    setPainted(true)
  }

  const apply = async () => {
    const img = imageRef.current
    if (!img || !paint.current) return
    setBusy(true)
    setError(null)
    try {
      const work = document.createElement('canvas')
      work.width = size.w
      work.height = size.h
      const ctx = work.getContext('2d', { willReadFrequently: true })!
      ctx.drawImage(img, 0, 0, size.w, size.h)
      const pic = ctx.getImageData(0, 0, size.w, size.h)
      const strokes = paint.current.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, size.w, size.h)
      if (mode === 'mask') {
        // White where painted (grown a little so the fill covers the edge), black elsewhere.
        const m = maskFromPaint(strokes, 4)
        const out = ctx.createImageData(size.w, size.h)
        for (let i = 0; i < size.w * size.h; i++) {
          const v = m[i] ? 255 : 0
          out.data[i * 4] = out.data[i * 4 + 1] = out.data[i * 4 + 2] = v
          out.data[i * 4 + 3] = 255
        }
        ctx.putImageData(out, 0, 0)
      } else {
        ctx.putImageData(inpaint(pic, maskFromPaint(strokes, 2)), 0, 0)
      }
      const blob = await new Promise<Blob>((resolve, reject) => work.toBlob((b) => (b ? resolve(b) : reject(new Error('無法產生圖片'))), 'image/png'))
      await onDone(blob)
      onClose()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3" data-magic-eraser>
      <p className="text-xs leading-relaxed text-white/55">{mode === 'mask' ? '在這個畫面上，把要消除的固定位置塗紅（例如浮水印、標誌、電線）。播放時，每一格畫面都會即時用周圍的內容補起來，影片檔不會被修改。只適合不會移動的小範圍。' : '用手指或滑鼠把不要的東西塗紅，按「擦除」就會用周圍的畫面填補。適合灰塵、電線、小道具、雜訊與文字；很大的物體填補後會比較模糊。'}</p>
      <div className="relative mx-auto w-full overflow-hidden rounded-xl bg-black" style={{ aspectRatio: size.w && size.h ? `${size.w} / ${size.h}` : '16 / 9', maxHeight: '55dvh' }}>
        <canvas ref={stage} className="absolute inset-0 h-full w-full" />
        <canvas
          ref={paint}
          className="absolute inset-0 h-full w-full touch-none"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId)
            const p = at(e)
            drawing.current = { id: e.pointerId, ...p }
            dot(p.x, p.y)
          }}
          onPointerMove={(e) => {
            const d = drawing.current
            if (!d || d.id !== e.pointerId) return
            const p = at(e)
            dot(p.x, p.y, d.x, d.y)
            drawing.current = { id: e.pointerId, ...p }
          }}
          onPointerUp={() => (drawing.current = null)}
          onPointerCancel={() => (drawing.current = null)}
          data-eraser-paint
        />
      </div>
      <label className="flex items-center gap-3 text-xs text-white/55">
        筆刷大小
        <input type="range" min={6} max={80} value={brush} onChange={(e) => setBrush(Number(e.target.value))} className="h-8 flex-1 accent-[#0a84ff]" />
        <span className="w-8 font-mono">{brush}</span>
      </label>
      {error && <p className="text-xs text-panic">{error}</p>}
      <div className="grid grid-cols-3 gap-2">
        <button
          type="button"
          onClick={() => {
            paint.current?.getContext('2d')?.clearRect(0, 0, size.w, size.h)
            setPainted(false)
          }}
          className="min-h-12 rounded-xl bg-white/10 text-sm font-semibold text-white/80"
        >
          清除筆刷
        </button>
        <button type="button" onClick={onClose} className="min-h-12 rounded-xl bg-white/10 text-sm font-semibold text-white/80">
          取消
        </button>
        <button type="button" disabled={!painted || busy} onClick={() => void apply()} className="min-h-12 rounded-xl bg-accent text-sm font-bold text-white disabled:opacity-40" data-eraser-apply>
          {busy ? '處理中…' : mode === 'mask' ? '儲存修補範圍' : '擦除'}
        </button>
      </div>
    </div>
  )
}
