import type { Adjustments } from '../types/visual'
import { NO_ADJUST } from '../types/visual'

/*
 * Pixel tools for the visual editor: Auto Enhance (measures the picture and suggests colour settings), the Magic
 * Eraser (fills painted-over areas from their surroundings) and AI cut-out (person segmentation with MediaPipe, a
 * small model that runs on the device). They never change a file: the callers save results as NEW files.
 */

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('無法讀取這張圖片（網址失效，或對方網站不允許跨網站讀取）'))
    img.src = url
  })
}

/* ---------- Auto Enhance ---------- */

/** Suggested adjustments from RGBA pixels: brings the average brightness to about 45 %, lifts flat contrast, evens out a colour cast. */
export function autoEnhanceFromPixels(data: Uint8ClampedArray | Uint8Array): Adjustments {
  let n = 0
  let r = 0
  let g = 0
  let b = 0
  let sumL = 0
  let sumL2 = 0
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 8) continue
    const pr = data[i] / 255
    const pg = data[i + 1] / 255
    const pb = data[i + 2] / 255
    const l = 0.2126 * pr + 0.7152 * pg + 0.0722 * pb
    r += pr
    g += pg
    b += pb
    sumL += l
    sumL2 += l * l
    n++
  }
  if (n === 0) return { ...NO_ADJUST }
  const mean = sumL / n
  const std = Math.sqrt(Math.max(0, sumL2 / n - mean * mean))
  const [ar, ag, ab] = [r / n, g / n, b / n]
  const stops = Math.log2(0.45 / Math.max(0.02, mean))
  return {
    ...NO_ADJUST,
    exposure: Math.round(clamp(stops * 50, -60, 60)),
    contrast: Math.round(std < 0.2 ? ((0.2 - std) / 0.2) * 40 : std > 0.32 ? -((std - 0.32) / 0.2) * 30 : 0),
    saturation: 8,
    temperature: Math.round(clamp((ab - ar) * 250, -40, 40)),
    tint: Math.round(clamp((ag - (ar + ab) / 2) * 250, -30, 30)),
  }
}

export function autoEnhance(img: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement): Adjustments {
  const canvas = document.createElement('canvas')
  canvas.width = 96
  canvas.height = 96
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(img, 0, 0, 96, 96)
  return autoEnhanceFromPixels(ctx.getImageData(0, 0, 96, 96).data)
}

/* ---------- Magic Eraser: pull-push inpainting ---------- */

interface Level {
  w: number
  h: number
  rgb: Float32Array
  wt: Float32Array
}

/**
 * Fill the pixels where `mask` is 1 from the surrounding picture: the known colours are averaged into smaller and
 * smaller copies (pull), then spread back over the holes (push), with a little noise matched to the picture's own
 * texture so the patch doesn't look plastic. Good for dust, wires, small props and text; large objects smear.
 */
export function inpaint(image: ImageData, mask: Uint8Array): ImageData {
  const { width: w, height: h, data } = image
  const base: Level = { w, h, rgb: new Float32Array(w * h * 3), wt: new Float32Array(w * h) }
  for (let i = 0; i < w * h; i++) {
    if (mask[i]) continue
    base.rgb[i * 3] = data[i * 4]
    base.rgb[i * 3 + 1] = data[i * 4 + 1]
    base.rgb[i * 3 + 2] = data[i * 4 + 2]
    base.wt[i] = 1
  }
  // Pull: each coarser pixel is the weighted average of its 2×2 block.
  const levels: Level[] = [base]
  while (levels[levels.length - 1].w > 2 || levels[levels.length - 1].h > 2) {
    const f = levels[levels.length - 1]
    const cw = Math.max(1, Math.ceil(f.w / 2))
    const ch = Math.max(1, Math.ceil(f.h / 2))
    const c: Level = { w: cw, h: ch, rgb: new Float32Array(cw * ch * 3), wt: new Float32Array(cw * ch) }
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        let sw = 0
        let sr = 0
        let sg = 0
        let sb = 0
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const fx = x * 2 + dx
            const fy = y * 2 + dy
            if (fx >= f.w || fy >= f.h) continue
            const j = fy * f.w + fx
            const wj = f.wt[j]
            sw += wj
            sr += f.rgb[j * 3] * wj
            sg += f.rgb[j * 3 + 1] * wj
            sb += f.rgb[j * 3 + 2] * wj
          }
        }
        const k = y * cw + x
        if (sw > 0) {
          c.rgb[k * 3] = sr / sw
          c.rgb[k * 3 + 1] = sg / sw
          c.rgb[k * 3 + 2] = sb / sw
        }
        c.wt[k] = Math.min(1, sw / 4)
      }
    }
    levels.push(c)
  }
  // Push: from the coarsest level down, fill what is still unknown from the level above (bilinear).
  for (let li = levels.length - 2; li >= 0; li--) {
    const f = levels[li]
    const c = levels[li + 1]
    for (let y = 0; y < f.h; y++) {
      for (let x = 0; x < f.w; x++) {
        const j = y * f.w + x
        const wj = f.wt[j]
        if (wj >= 1) continue
        const sx = clamp((x + 0.5) / 2 - 0.5, 0, c.w - 1)
        const sy = clamp((y + 0.5) / 2 - 0.5, 0, c.h - 1)
        const x0 = Math.floor(sx)
        const y0 = Math.floor(sy)
        const x1 = Math.min(c.w - 1, x0 + 1)
        const y1 = Math.min(c.h - 1, y0 + 1)
        const tx = sx - x0
        const ty = sy - y0
        for (let ch = 0; ch < 3; ch++) {
          const v00 = c.rgb[(y0 * c.w + x0) * 3 + ch]
          const v10 = c.rgb[(y0 * c.w + x1) * 3 + ch]
          const v01 = c.rgb[(y1 * c.w + x0) * 3 + ch]
          const v11 = c.rgb[(y1 * c.w + x1) * 3 + ch]
          const up = (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty
          f.rgb[j * 3 + ch] = f.rgb[j * 3 + ch] * wj + up * (1 - wj)
        }
        f.wt[j] = 1
      }
    }
  }
  // Texture: how rough is the known picture? (mean difference to its 1-pixel neighbour)
  let rough = 0
  let count = 0
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w - 1; x += 2) {
      const i = y * w + x
      if (mask[i] || mask[i + 1]) continue
      rough += Math.abs(data[i * 4 + 1] - data[(i + 1) * 4 + 1])
      count++
    }
  }
  const noise = count ? clamp((rough / count) * 0.8, 0, 14) : 0
  const out = new ImageData(new Uint8ClampedArray(data), w, h)
  let seed = 1234567
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 4294967296 - 0.5
  }
  for (let i = 0; i < w * h; i++) {
    if (!mask[i]) continue
    const n = rand() * 2 * noise
    out.data[i * 4] = clamp(base.rgb[i * 3] + n, 0, 255)
    out.data[i * 4 + 1] = clamp(base.rgb[i * 3 + 1] + n, 0, 255)
    out.data[i * 4 + 2] = clamp(base.rgb[i * 3 + 2] + n, 0, 255)
    out.data[i * 4 + 3] = 255
  }
  return out
}

/** The painted strokes (an RGBA canvas, alpha > 0 = painted) as a 0/1 mask, grown by `grow` pixels so the fill covers the object's edge. */
export function maskFromPaint(paint: ImageData, grow = 2): Uint8Array {
  const { width: w, height: h, data } = paint
  let mask = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) mask[i] = data[i * 4 + 3] > 40 ? 1 : 0
  for (let pass = 0; pass < grow; pass++) {
    const next = mask.slice()
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        if (mask[i]) continue
        if ((x > 0 && mask[i - 1]) || (x < w - 1 && mask[i + 1]) || (y > 0 && mask[i - w]) || (y < h - 1 && mask[i + w])) next[i] = 1
      }
    }
    mask = next
  }
  return mask
}

/* ---------- AI cut-out ---------- */

const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm'
type Segmenter = { segment: (img: HTMLImageElement) => { confidenceMasks?: { width: number; height: number; getAsFloat32Array: () => Float32Array; close?: () => void }[]; close?: () => void } }
let segmenter: Promise<Segmenter> | null = null

function loadSegmenter(): Promise<Segmenter> {
  segmenter ??= (async () => {
    const { FilesetResolver, ImageSegmenter } = await import('@mediapipe/tasks-vision')
    const fileset = await FilesetResolver.forVisionTasks(WASM)
    return (await ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: `${import.meta.env.BASE_URL}models/selfie_segmenter.tflite` },
      runningMode: 'IMAGE',
      outputConfidenceMasks: true,
      outputCategoryMask: false,
    })) as unknown as Segmenter
  })().catch((err) => {
    segmenter = null
    throw new Error(`無法載入去背模型（需要網路連線）：${(err as Error).message}`)
  })
  return segmenter
}

/**
 * Remove the background of a picture of people (the model finds the person): returns a PNG with a transparent
 * background, at most `maxSide` pixels on the long edge. Runs on this device.
 */
export async function removeBackground(img: HTMLImageElement, maxSide = 1600): Promise<Blob> {
  const seg = await loadSegmenter()
  const result = seg.segment(img)
  const masks = result.confidenceMasks ?? []
  // One mask = the person; two = [background, person].
  const m = masks.length >= 2 ? masks[1] : masks[0]
  if (!m) throw new Error('沒有偵測到主體')
  const probs = m.getAsFloat32Array()
  const [mw, mh] = [m.width, m.height]
  result.close?.()

  const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight))
  const w = Math.max(1, Math.round(img.naturalWidth * k))
  const h = Math.max(1, Math.round(img.naturalHeight * k))
  // The mask is small (256 px): scale it up smoothly as an alpha image, then sharpen the edge.
  const small = document.createElement('canvas')
  small.width = mw
  small.height = mh
  const sctx = small.getContext('2d')!
  const sdata = sctx.createImageData(mw, mh)
  for (let i = 0; i < mw * mh; i++) {
    const a = clamp((probs[i] - 0.35) / 0.3, 0, 1) // soft threshold: 0.35 → 0, 0.65 → 1
    sdata.data[i * 4 + 3] = Math.round(a * 255)
  }
  sctx.putImageData(sdata, 0, 0)
  const out = document.createElement('canvas')
  out.width = w
  out.height = h
  const ctx = out.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(img, 0, 0, w, h)
  const pic = ctx.getImageData(0, 0, w, h)
  const alpha = document.createElement('canvas')
  alpha.width = w
  alpha.height = h
  const actx = alpha.getContext('2d', { willReadFrequently: true })!
  actx.imageSmoothingEnabled = true
  actx.imageSmoothingQuality = 'high'
  actx.drawImage(small, 0, 0, w, h)
  const a = actx.getImageData(0, 0, w, h).data
  for (let i = 0; i < w * h; i++) pic.data[i * 4 + 3] = a[i * 4 + 3]
  ctx.putImageData(pic, 0, 0)
  return await new Promise<Blob>((resolve, reject) => out.toBlob((b) => (b ? resolve(b) : reject(new Error('無法產生去背圖片'))), 'image/png'))
}

/** One frame of a video (at `time` seconds, default the middle) as a canvas, at most `maxSide` pixels on the long edge. */
export function grabVideoFrame(url: string, time?: number, maxSide = 1280): Promise<{ canvas: HTMLCanvasElement; duration: number }> {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video')
    v.crossOrigin = 'anonymous'
    v.muted = true
    v.playsInline = true
    v.preload = 'auto'
    const fail = () => reject(new Error('無法讀取這支影片的畫面（網址失效，或對方網站不允許跨網站讀取）'))
    v.onerror = fail
    v.onloadedmetadata = () => {
      const target = time ?? (Number.isFinite(v.duration) ? v.duration / 2 : 0)
      v.onseeked = () => {
        const k = Math.min(1, maxSide / Math.max(v.videoWidth, v.videoHeight))
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(v.videoWidth * k))
        canvas.height = Math.max(1, Math.round(v.videoHeight * k))
        canvas.getContext('2d')!.drawImage(v, 0, 0, canvas.width, canvas.height)
        resolve({ canvas, duration: Number.isFinite(v.duration) ? v.duration : 0 })
        v.removeAttribute('src')
        v.load()
      }
      v.currentTime = Math.max(0, Math.min(target, (Number.isFinite(v.duration) ? v.duration : target) - 0.05))
    }
    v.src = url
  })
}
