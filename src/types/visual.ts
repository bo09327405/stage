/*
 * Non-destructive visual editing of an image / video cue: layers, masks, colour grading and special effects.
 * Everything lives in the cue's JSON (Cue.visual); the media files themselves are never changed — an AI cut-out or
 * an erased copy is saved as a NEW file and referenced, with the original kept so it can be restored.
 */

export type BlendMode = 'normal' | 'multiply' | 'screen' | 'overlay' | 'add' | 'darken' | 'lighten' | 'difference' | 'softlight'

export const BLEND_MODES: { id: BlendMode; label: string; code: number }[] = [
  { id: 'normal', label: 'Normal 正常', code: 0 },
  { id: 'multiply', label: 'Multiply 色彩增值', code: 1 },
  { id: 'screen', label: 'Screen 濾色', code: 2 },
  { id: 'overlay', label: 'Overlay 覆蓋', code: 3 },
  { id: 'add', label: 'Add 線性加亮', code: 4 },
  { id: 'darken', label: 'Darken 變暗', code: 5 },
  { id: 'lighten', label: 'Lighten 變亮', code: 6 },
  { id: 'difference', label: 'Difference 差異', code: 7 },
  { id: 'softlight', label: 'Soft Light 柔光', code: 8 },
]
export const blendCode = (mode: BlendMode) => BLEND_MODES.find((b) => b.id === mode)?.code ?? 0

/** Colour controls, each −100 … +100 (0 = untouched). */
export interface Adjustments {
  exposure: number
  brightness: number
  contrast: number
  saturation: number
  /** Cool (−) … warm (+). */
  temperature: number
  /** Green (−) … magenta (+). */
  tint: number
  highlights: number
  shadows: number
}
export const ADJUSTMENT_KEYS: { key: keyof Adjustments; label: string }[] = [
  { key: 'exposure', label: '曝光 Exposure' },
  { key: 'brightness', label: '明暗 Brightness' },
  { key: 'contrast', label: '對比度 Contrast' },
  { key: 'saturation', label: '飽和度 Saturation' },
  { key: 'temperature', label: '色溫 Temperature' },
  { key: 'tint', label: '色調 Tint' },
  { key: 'highlights', label: '高光 Highlights' },
  { key: 'shadows', label: '陰影 Shadows' },
]
export const NO_ADJUST: Adjustments = { exposure: 0, brightness: 0, contrast: 0, saturation: 0, temperature: 0, tint: 0, highlights: 0, shadows: 0 }

/** Stage effects, each 0 … 100. */
export interface FxSettings {
  grain: number
  glow: number
  film: number
  vignette: number
  glitch: number
}
export const FX_KEYS: { key: keyof FxSettings; label: string }[] = [
  { key: 'grain', label: '動態噪點 Grain' },
  { key: 'glow', label: '輝光 Glow' },
  { key: 'film', label: '復古膠片 Film' },
  { key: 'vignette', label: '暗角 Vignette' },
  { key: 'glitch', label: '故障藝術 Glitch' },
]
export const NO_FX: FxSettings = { grain: 0, glow: 0, film: 0, vignette: 0, glitch: 0 }

export type MaskType = 'rect' | 'ellipse' | 'polygon' | 'linear' | 'radial'
export const MASK_LABELS: Record<MaskType, string> = {
  rect: '▭ 矩形',
  ellipse: '◯ 圓形',
  polygon: '⬠ 多邊形',
  linear: '◨ 線性漸層',
  radial: '◉ 徑向漸層',
}

/** A mask in the layer's own normalised space (0,0 = top-left of the layer, 1,1 = bottom-right). */
export interface LayerMask {
  type: MaskType
  invert: boolean
  /** Soft edge, 0 … 100. */
  feather: number
  /** rect / ellipse: centre and size. */
  x: number
  y: number
  w: number
  h: number
  /** polygon: up to 8 corners. */
  points: [number, number][]
  /** linear: direction (degrees) and where the fade sits across the layer (0 … 1). */
  angle: number
  position: number
  /** radial: radius (0 … 1; the centre is x, y). */
  radius: number
}

export const MAX_POLYGON_POINTS = 8

export function defaultMask(type: MaskType): LayerMask {
  return {
    type,
    invert: false,
    feather: type === 'linear' || type === 'radial' ? 50 : 10,
    x: 0.5,
    y: 0.5,
    w: 0.7,
    h: 0.7,
    points: [
      [0.5, 0.1],
      [0.9, 0.5],
      [0.5, 0.9],
      [0.1, 0.5],
    ],
    angle: 90,
    position: 0.5,
    radius: 0.4,
  }
}

export interface VisualLayer {
  id: string
  name: string
  kind: 'media' | 'color'
  /** media: the image / video address. */
  src: string
  mediaKind: 'image' | 'video'
  /** After an AI cut-out / erase: where the untouched file is (so the edit can be undone). */
  originalSrc: string
  /** color: #rrggbb. */
  color: string
  visible: boolean
  locked: boolean
  /** 0 … 1. */
  opacity: number
  blend: BlendMode
  /** Centre on the stage, 0 … 1 (0.5, 0.5 = middle). */
  x: number
  y: number
  /** 1 = as large as fits the stage; 0.1 … 4. */
  scale: number
  /** Degrees. */
  rotation: number
  mask: LayerMask | null
  adjust: Adjustments
  /** Video: live AI cut-out of the person (re-computed on the device for every frame). */
  cutout: boolean
  /** Video: address of a painted mask (white = fill in from the surroundings, e.g. a logo or a wire); '' = none. */
  heal: string
}

/** The cue's own media, as the bottom layer: same controls, but no source of its own (unless edited). */
export type BaseLayer = Omit<VisualLayer, 'id' | 'name' | 'kind' | 'color' | 'mediaKind'> & { /** An edited copy replaces the cue media when set. */ src: string }

export interface CueVisual {
  base: BaseLayer
  /** Above the base, bottom to top. */
  layers: VisualLayer[]
  /** Whole-picture grading and effects. */
  adjust: Adjustments
  fx: FxSettings
}

export const newBase = (): BaseLayer => ({
  src: '',
  originalSrc: '',
  visible: true,
  locked: false,
  opacity: 1,
  blend: 'normal',
  x: 0.5,
  y: 0.5,
  scale: 1,
  rotation: 0,
  mask: null,
  adjust: { ...NO_ADJUST },
  cutout: false,
  heal: '',
})

export const newVisual = (): CueVisual => ({ base: newBase(), layers: [], adjust: { ...NO_ADJUST }, fx: { ...NO_FX } })

export function newLayer(kind: 'media' | 'color', init: Partial<VisualLayer> = {}): VisualLayer {
  return {
    id: `l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    name: kind === 'color' ? '純色層' : '圖層',
    kind,
    src: '',
    mediaKind: 'image',
    originalSrc: '',
    color: '#000000',
    visible: true,
    locked: false,
    opacity: 1,
    blend: 'normal',
    x: 0.5,
    y: 0.5,
    scale: 1,
    rotation: 0,
    mask: null,
    adjust: { ...NO_ADJUST },
    cutout: false,
    heal: '',
    ...init,
  }
}

const num = (v: unknown, d: number, lo: number, hi: number) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d
}
const adj = (raw: Partial<Adjustments> | undefined): Adjustments =>
  Object.fromEntries(Object.keys(NO_ADJUST).map((k) => [k, num(raw?.[k as keyof Adjustments], 0, -100, 100)])) as unknown as Adjustments
const fx = (raw: Partial<FxSettings> | undefined): FxSettings =>
  Object.fromEntries(Object.keys(NO_FX).map((k) => [k, num(raw?.[k as keyof FxSettings], 0, 0, 100)])) as unknown as FxSettings

function normalizeMask(raw: Partial<LayerMask> | null | undefined): LayerMask | null {
  if (!raw || !(raw.type && raw.type in MASK_LABELS)) return null
  const d = defaultMask(raw.type)
  // RTDB hands arrays back as objects (and drops empty ones).
  const points = (Object.values(raw.points ?? {}) as unknown[])
    .map((p) => (Array.isArray(p) ? p : Object.values((p ?? {}) as object)) as number[])
    .filter((p) => p.length >= 2)
    .slice(0, MAX_POLYGON_POINTS)
    .map((p) => [num(p[0], 0.5, -0.5, 1.5), num(p[1], 0.5, -0.5, 1.5)] as [number, number])
  return {
    type: raw.type,
    invert: raw.invert === true,
    feather: num(raw.feather, d.feather, 0, 100),
    x: num(raw.x, d.x, -0.5, 1.5),
    y: num(raw.y, d.y, -0.5, 1.5),
    w: num(raw.w, d.w, 0.01, 3),
    h: num(raw.h, d.h, 0.01, 3),
    points: points.length >= 3 ? points : d.points,
    angle: num(raw.angle, d.angle, -360, 360),
    position: num(raw.position, d.position, -0.5, 1.5),
    radius: num(raw.radius, d.radius, 0.01, 3),
  }
}

function normalizeLayerCommon(raw: Partial<VisualLayer> | undefined) {
  return {
    src: typeof raw?.src === 'string' ? raw.src : '',
    originalSrc: typeof raw?.originalSrc === 'string' ? raw.originalSrc : '',
    visible: raw?.visible !== false,
    locked: raw?.locked === true,
    opacity: num(raw?.opacity, 1, 0, 1),
    blend: (BLEND_MODES.some((b) => b.id === raw?.blend) ? raw!.blend : 'normal') as BlendMode,
    x: num(raw?.x, 0.5, -1, 2),
    y: num(raw?.y, 0.5, -1, 2),
    scale: num(raw?.scale, 1, 0.05, 8),
    rotation: num(raw?.rotation, 0, -360, 360),
    mask: normalizeMask(raw?.mask),
    adjust: adj(raw?.adjust),
    cutout: raw?.cutout === true,
    heal: typeof raw?.heal === 'string' ? raw.heal : '',
  }
}

/** A stored (possibly partial) visual → a complete one; null stays null. */
export function normalizeVisual(raw: Partial<CueVisual> | null | undefined): CueVisual | null {
  if (!raw || typeof raw !== 'object') return null
  const layers = (Object.values(raw.layers ?? {}) as Partial<VisualLayer>[])
    .filter((l) => l && typeof l === 'object')
    .map((l) => ({
      ...normalizeLayerCommon(l),
      id: typeof l.id === 'string' && l.id ? l.id : `l${Math.random().toString(36).slice(2, 8)}`,
      name: typeof l.name === 'string' ? l.name : '圖層',
      kind: (l.kind === 'color' ? 'color' : 'media') as 'media' | 'color',
      mediaKind: (l.mediaKind === 'video' ? 'video' : 'image') as 'image' | 'video',
      color: typeof l.color === 'string' && /^#[0-9a-f]{6}$/i.test(l.color) ? l.color : '#000000',
    }))
  return { base: normalizeLayerCommon(raw.base), layers, adjust: adj(raw.adjust), fx: fx(raw.fx) }
}

const adjusted = (a: Adjustments) => Object.values(a).some((v) => v !== 0)
const fxOn = (f: FxSettings) => Object.values(f).some((v) => v !== 0)

/** Does this visual change anything? (If not, the cue uses the plain, cheapest display path.) */
export function hasVisualEdits(v: CueVisual | null | undefined): v is CueVisual {
  if (!v) return false
  const b = v.base
  return (
    v.layers.some((l) => l.visible) ||
    adjusted(v.adjust) ||
    fxOn(v.fx) ||
    !!b.src ||
    b.cutout ||
    !!b.heal ||
    !!b.mask ||
    b.opacity < 1 ||
    b.blend !== 'normal' ||
    b.x !== 0.5 ||
    b.y !== 0.5 ||
    b.scale !== 1 ||
    b.rotation !== 0 ||
    adjusted(b.adjust) ||
    !b.visible
  )
}

/* ---------- looks: one-tap grading + effect combinations ---------- */

export interface Look {
  id: string
  label: string
  adjust: Partial<Adjustments>
  fx: Partial<FxSettings>
}
export const LOOKS: Look[] = [
  { id: 'blackout', label: '🎭 劇場暗場', adjust: { exposure: -25, contrast: 20, saturation: -15, shadows: -20 }, fx: { vignette: 55 } },
  { id: 'moon', label: '🌙 月光冷調', adjust: { temperature: -40, tint: 5, exposure: -10, saturation: -10, highlights: -10 }, fx: { vignette: 30, glow: 15 } },
  { id: 'candle', label: '🕯 燭光暖調', adjust: { temperature: 45, exposure: -5, contrast: 8, saturation: 5 }, fx: { glow: 28, vignette: 38 } },
  { id: 'film', label: '🎞 復古膠片', adjust: { contrast: 10, saturation: -20, temperature: 12 }, fx: { film: 70, grain: 40, vignette: 25 } },
  { id: 'glitch', label: '⚡ 故障藝術', adjust: { contrast: 15, saturation: 10 }, fx: { glitch: 55, grain: 15 } },
]
