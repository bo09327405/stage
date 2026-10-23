/*
 * Live VJ: a clip grid (decks), three mixer layers with blend modes and an A/B crossfader, and
 * real-time effect chains (per layer and on the master). The same VjMix describes the live
 * performance (showState/vj) and the snapshot stored in a VJ cue (Cue.vj).
 *
 * This file has no imports on purpose: it is pure data + logic, shared by the WebGL renderer, the
 * UI, the MIDI mapper and the tests.
 */

export type VjPlayMode = 'loop' | 'oneshot' | 'hold'
export const VJ_PLAY_MODES: { id: VjPlayMode; label: string }[] = [
  { id: 'loop', label: '迴圈 Loop' },
  { id: 'oneshot', label: '單次 One-Shot' },
  { id: 'hold', label: '停在最後畫格 Hold' },
]

/** A cell of a deck: one image or video with its own playback settings. */
export interface VjClip {
  id: string
  name: string
  src: string
  mediaKind: 'image' | 'video'
  playMode: VjPlayMode
  /** 0.1 … 4. */
  speed: number
  /** Play the video's own sound (audience output only; the console preview stays silent). */
  audio: boolean
}

export const VJ_SPEED_RANGE: [number, number] = [0.1, 4]

export interface VjDeck {
  id: string
  name: string
  cols: number
  rows: number
  order: number
  /** Keyed by slot ("col,row"). */
  clips: Record<string, VjClip>
}

export const VJ_GRID_LIMITS = { cols: [1, 8], rows: [1, 8] } as const
export const slotKey = (col: number, row: number) => `${col},${row}`

export function newClip(init: Partial<VjClip> = {}): VjClip {
  return {
    id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    name: '',
    src: '',
    mediaKind: 'video',
    playMode: 'loop',
    speed: 1,
    audio: false,
    ...init,
  }
}

export const newDeck = (name: string, order = 0): Omit<VjDeck, 'id'> => ({ name, cols: 4, rows: 4, order, clips: {} })

/* ---------- blend modes ---------- */

export type VjBlend = 'normal' | 'add' | 'multiply' | 'screen' | 'overlay' | 'difference'
/** `code` is the index the shader switches on. */
export const VJ_BLENDS: { id: VjBlend; label: string; code: number }[] = [
  { id: 'normal', label: 'Normal 正常', code: 0 },
  { id: 'add', label: 'Add 疊加亮', code: 1 },
  { id: 'multiply', label: 'Multiply 色彩增殖', code: 2 },
  { id: 'screen', label: 'Screen 濾色', code: 3 },
  { id: 'overlay', label: 'Overlay 覆疊', code: 4 },
  { id: 'difference', label: 'Difference 差值', code: 5 },
]
export const vjBlendCode = (mode: VjBlend) => VJ_BLENDS.find((b) => b.id === mode)?.code ?? 0

/* ---------- effects ---------- */

export type VjFxType = 'glitch' | 'strobe' | 'hue' | 'blur' | 'glow' | 'mirror' | 'kaleido'

export interface VjFxParamDef {
  key: string
  label: string
  /** Display range: the stored value is always 0 … 1, mapped onto [min, max]. */
  min: number
  max: number
  unit?: string
  /** Whole numbers only (e.g. kaleidoscope segments). */
  step?: number
  default: number
}

export interface VjFxDef {
  type: VjFxType
  label: string
  params: VjFxParamDef[]
  /** Shader index. */
  code: number
}

export const VJ_FX: VjFxDef[] = [
  {
    type: 'glitch',
    label: 'Glitch 故障 / 雜訊',
    code: 1,
    params: [
      { key: 'amount', label: '強度', min: 0, max: 100, unit: '%', default: 0.5 },
      { key: 'speed', label: '速度', min: 1, max: 30, unit: 'Hz', default: 0.3 },
    ],
  },
  {
    type: 'strobe',
    label: 'Strobe 閃爍 / 頻閃',
    code: 2,
    params: [
      { key: 'rate', label: '頻率', min: 0.5, max: 30, unit: 'Hz', default: 0.3 },
      { key: 'depth', label: '深度', min: 0, max: 100, unit: '%', default: 1 },
      { key: 'white', label: '白閃（0 = 黑閃）', min: 0, max: 1, step: 1, default: 0 },
    ],
  },
  {
    type: 'hue',
    label: 'Hue 色相旋轉 / 色彩偏移',
    code: 3,
    params: [
      { key: 'shift', label: '色相', min: 0, max: 360, unit: '°', default: 0.25 },
      { key: 'spin', label: '自動旋轉', min: 0, max: 360, unit: '°/s', default: 0 },
      { key: 'sat', label: '飽和度', min: 0, max: 200, unit: '%', default: 0.5 },
    ],
  },
  {
    type: 'blur',
    label: 'Blur 模糊',
    code: 4,
    params: [{ key: 'radius', label: '半徑', min: 0, max: 60, unit: 'px', default: 0.3 }],
  },
  {
    type: 'glow',
    label: 'Glow 暈光',
    code: 5,
    params: [
      { key: 'amount', label: '強度', min: 0, max: 300, unit: '%', default: 0.4 },
      { key: 'radius', label: '範圍', min: 2, max: 60, unit: 'px', default: 0.4 },
      { key: 'threshold', label: '門檻', min: 0, max: 100, unit: '%', default: 0.5 },
    ],
  },
  {
    type: 'mirror',
    label: 'Mirror 鏡射',
    code: 6,
    params: [
      { key: 'x', label: '左右鏡射', min: 0, max: 1, step: 1, default: 1 },
      { key: 'y', label: '上下鏡射', min: 0, max: 1, step: 1, default: 0 },
    ],
  },
  {
    type: 'kaleido',
    label: 'Kaleidoscope 萬花筒',
    code: 7,
    params: [
      { key: 'segments', label: '分割數', min: 2, max: 16, step: 1, default: 0.3 },
      { key: 'angle', label: '角度', min: 0, max: 360, unit: '°', default: 0 },
      { key: 'spin', label: '自動旋轉', min: -180, max: 180, unit: '°/s', default: 0.5 },
    ],
  },
]

export const fxDef = (type: VjFxType) => VJ_FX.find((f) => f.type === type) ?? VJ_FX[0]

export interface VjFx {
  id: string
  type: VjFxType
  enabled: boolean
  /** Normalised 0 … 1 per param key. */
  params: Record<string, number>
}

export function newFx(type: VjFxType): VjFx {
  const def = fxDef(type)
  return {
    id: `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    type,
    enabled: true,
    params: Object.fromEntries(def.params.map((p) => [p.key, p.default])),
  }
}

/** A normalised param (0 … 1) in its display unit. */
export function fxParamValue(def: VjFxParamDef, normalised: number): number {
  const raw = def.min + clamp01(normalised) * (def.max - def.min)
  return def.step ? Math.round(raw / def.step) * def.step : raw
}

/** The four floats a shader receives for an effect (param order = definition order, display units). */
export function fxUniform(fx: VjFx): [number, number, number, number] {
  const def = fxDef(fx.type)
  const out: [number, number, number, number] = [0, 0, 0, 0]
  def.params.slice(0, 4).forEach((p, i) => {
    out[i] = fxParamValue(p, fx.params[p.key] ?? p.default)
  })
  return out
}

/* ---------- the mix ---------- */

export const VJ_LAYER_COUNT = 3

/** Which side of the A/B crossfader a layer sits on; 'thru' ignores the crossfader. */
export type VjSide = 'thru' | 'A' | 'B'

export interface VjLayer {
  clip: VjClip | null
  /** Server ms when the clip was triggered; 0 = when the cue / output starts. */
  startedAt: number
  /** 0 … 1. */
  opacity: number
  blend: VjBlend
  side: VjSide
  fx: VjFx[]
}

export interface VjMix {
  /** The live output is on stage (live performance only; ignored inside a cue). */
  live: boolean
  layers: VjLayer[]
  /** 0 = all A, 1 = all B. */
  crossfader: number
  masterFx: VjFx[]
  /** 0 … 1, scales the whole picture. */
  master: number
}

export const newLayer = (): VjLayer => ({ clip: null, startedAt: 0, opacity: 1, blend: 'normal', side: 'thru', fx: [] })

export const newMix = (): VjMix => ({
  live: false,
  layers: Array.from({ length: VJ_LAYER_COUNT }, newLayer),
  crossfader: 0,
  masterFx: [],
  master: 1,
})

/* ---------- normalising what comes out of the database ---------- */

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))
const num = (v: unknown, d: number, lo: number, hi: number) => {
  const n = Number(v)
  return v == null || v === '' || !Number.isFinite(n) ? d : Math.min(hi, Math.max(lo, n))
}
const str = (v: unknown) => (typeof v === 'string' ? v : '')

export function normalizeClip(raw: Partial<VjClip> | null | undefined): VjClip | null {
  if (!raw || typeof raw !== 'object' || !str(raw.src)) return null
  return {
    id: str(raw.id) || `c${Math.random().toString(36).slice(2, 8)}`,
    name: str(raw.name),
    src: str(raw.src),
    mediaKind: raw.mediaKind === 'image' ? 'image' : 'video',
    playMode: VJ_PLAY_MODES.some((m) => m.id === raw.playMode) ? (raw.playMode as VjPlayMode) : 'loop',
    speed: num(raw.speed, 1, VJ_SPEED_RANGE[0], VJ_SPEED_RANGE[1]),
    audio: raw.audio === true,
  }
}

export function normalizeFx(raw: unknown): VjFx[] {
  // RTDB hands arrays back as objects (and drops empty ones).
  return (Object.values((raw ?? {}) as object) as Partial<VjFx>[])
    .filter((f) => f && typeof f === 'object' && VJ_FX.some((d) => d.type === f.type))
    .map((f) => {
      const def = fxDef(f.type!)
      return {
        id: str(f.id) || `f${Math.random().toString(36).slice(2, 8)}`,
        type: def.type,
        enabled: f.enabled !== false,
        params: Object.fromEntries(def.params.map((p) => [p.key, num(f.params?.[p.key], p.default, 0, 1)])),
      }
    })
}

export function normalizeMix(raw: Partial<VjMix> | null | undefined): VjMix | null {
  if (!raw || typeof raw !== 'object') return null
  const base = newMix()
  // Stored as an object keyed by index once RTDB has dropped empty slots.
  const stored = raw.layers && typeof raw.layers === 'object' ? (raw.layers as unknown as Record<string, Partial<VjLayer>>) : {}
  const layers = base.layers.map((def, i): VjLayer => {
    const l = stored[i]
    if (!l || typeof l !== 'object') return def
    return {
      clip: normalizeClip(l.clip),
      startedAt: num(l.startedAt, 0, 0, Number.MAX_SAFE_INTEGER),
      opacity: num(l.opacity, 1, 0, 1),
      blend: VJ_BLENDS.some((b) => b.id === l.blend) ? (l.blend as VjBlend) : 'normal',
      side: l.side === 'A' || l.side === 'B' ? l.side : 'thru',
      fx: normalizeFx(l.fx),
    }
  })
  return {
    live: raw.live === true,
    layers,
    crossfader: num(raw.crossfader, 0, 0, 1),
    masterFx: normalizeFx(raw.masterFx),
    master: num(raw.master, 1, 0, 1),
  }
}

/** Decks as stored (clips keyed by slot; a deck record may lack empty children). */
export function normalizeDeck(id: string, raw: Partial<VjDeck> | null | undefined): VjDeck {
  const clips: Record<string, VjClip> = {}
  for (const [slot, c] of Object.entries((raw?.clips ?? {}) as Record<string, Partial<VjClip>>)) {
    const clip = normalizeClip(c)
    if (clip) clips[slot] = clip
  }
  return {
    id,
    name: str(raw?.name) || '未命名 Deck',
    cols: Math.round(num(raw?.cols, 4, VJ_GRID_LIMITS.cols[0], VJ_GRID_LIMITS.cols[1])),
    rows: Math.round(num(raw?.rows, 4, VJ_GRID_LIMITS.rows[0], VJ_GRID_LIMITS.rows[1])),
    order: num(raw?.order, 0, -1e9, 1e15),
    clips,
  }
}

/* ---------- composing ---------- */

/** How much of a layer reaches the picture: its fader, shaped by the crossfader for A / B layers. */
export function layerGain(layer: Pick<VjLayer, 'opacity' | 'side'>, crossfader: number): number {
  const x = clamp01(crossfader)
  const side = layer.side === 'A' ? 1 - x : layer.side === 'B' ? x : 1
  return clamp01(layer.opacity) * side
}

/** A layer takes part in the picture at all (a clip, some level, some fade). */
export const layerActive = (layer: VjLayer, crossfader: number) => !!layer.clip && layerGain(layer, crossfader) > 0.0005

/**
 * Where a clip should be, `elapsed` seconds after it was triggered.
 *  · position — seconds into the file to show (always within [0, duration]);
 *  · ended — a one-shot that has run its course: nothing is shown any more.
 * An unknown duration (0) plays on at `elapsed × speed` and never ends.
 */
export function clipPosition(clip: Pick<VjClip, 'playMode' | 'speed'>, elapsed: number, duration: number): { position: number; ended: boolean } {
  const t = Math.max(0, elapsed) * clip.speed
  if (!(duration > 0)) return { position: t, ended: false }
  switch (clip.playMode) {
    case 'oneshot':
      return t >= duration ? { position: duration, ended: true } : { position: t, ended: false }
    case 'hold':
      // A hair before the end, so the last real frame stays on screen.
      return { position: Math.min(t, Math.max(0, duration - 0.04)), ended: false }
    default:
      return { position: t % duration, ended: false }
  }
}

/* ---------- mix edits (pure: each returns a new mix) ---------- */

const mapLayer = (mix: VjMix, i: number, f: (l: VjLayer) => VjLayer): VjMix =>
  i < 0 || i >= mix.layers.length ? mix : { ...mix, layers: mix.layers.map((l, n) => (n === i ? f(l) : l)) }

export const triggerClip = (mix: VjMix, layer: number, clip: VjClip, at: number): VjMix => mapLayer(mix, layer, (l) => ({ ...l, clip, startedAt: at }))
export const clearLayer = (mix: VjMix, layer: number): VjMix => mapLayer(mix, layer, (l) => ({ ...l, clip: null, startedAt: 0 }))
export const patchLayer = (mix: VjMix, layer: number, patch: Partial<VjLayer>): VjMix => mapLayer(mix, layer, (l) => ({ ...l, ...patch }))

/** Where an effect lives: on a layer (0-based) or on the master. */
export type VjFxScope = number | 'master'

function mapFx(mix: VjMix, scope: VjFxScope, f: (fx: VjFx[]) => VjFx[]): VjMix {
  return scope === 'master' ? { ...mix, masterFx: f(mix.masterFx) } : mapLayer(mix, scope, (l) => ({ ...l, fx: f(l.fx) }))
}
export const fxList = (mix: VjMix, scope: VjFxScope) => (scope === 'master' ? mix.masterFx : (mix.layers[scope]?.fx ?? []))
export const addFx = (mix: VjMix, scope: VjFxScope, type: VjFxType): VjMix => mapFx(mix, scope, (list) => [...list, newFx(type)])
export const removeFx = (mix: VjMix, scope: VjFxScope, id: string): VjMix => mapFx(mix, scope, (list) => list.filter((f) => f.id !== id))
export const patchFx = (mix: VjMix, scope: VjFxScope, id: string, patch: Partial<Pick<VjFx, 'enabled'>> & { params?: Record<string, number> }): VjMix =>
  mapFx(mix, scope, (list) =>
    list.map((f) => (f.id === id ? { ...f, ...(patch.enabled != null ? { enabled: patch.enabled } : {}), params: { ...f.params, ...(patch.params ?? {}) } } : f)),
  )
export const moveFx = (mix: VjMix, scope: VjFxScope, id: string, dir: -1 | 1): VjMix =>
  mapFx(mix, scope, (list) => {
    const i = list.findIndex((f) => f.id === id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= list.length) return list
    const next = [...list]
    ;[next[i], next[j]] = [next[j], next[i]]
    return next
  })

/** Find an effect anywhere in the mix. */
export function findFx(mix: VjMix, id: string): { scope: VjFxScope; fx: VjFx } | null {
  const m = mix.masterFx.find((f) => f.id === id)
  if (m) return { scope: 'master', fx: m }
  for (let i = 0; i < mix.layers.length; i++) {
    const fx = mix.layers[i].fx.find((f) => f.id === id)
    if (fx) return { scope: i, fx }
  }
  return null
}

/* ---------- controller targets (what MIDI / OSC can drive) ---------- */

/**
 * Stable names for everything a hardware controller can move:
 *   layer.N.opacity · layer.N.clear · crossfader · master · live
 *   fx.{fxId}.{param} · fx.{fxId}.enabled
 *   clip.{deckId}.{slot}          (trigger; plays on the selected layer)
 */
export type VjTargetKind = 'continuous' | 'trigger'
export const targetKind = (target: string): VjTargetKind =>
  /^(layer\.\d+\.opacity|crossfader|master|fx\.[^.]+\.(?!enabled$).+)$/.test(target) ? 'continuous' : 'trigger'

/**
 * Apply a controller value (0 … 1) to a mix. Continuous targets follow the value; triggers act when
 * the value is "pressed" (≥ 0.5). `resolveClip` finds a clip for `clip.*` targets. Returns the same
 * mix object when nothing changed.
 */
export function applyTarget(
  mix: VjMix,
  target: string,
  value: number,
  ctx: { now: number; selectedLayer: number; resolveClip: (deckId: string, slot: string) => VjClip | null },
): VjMix {
  const v = clamp01(value)
  let m: RegExpMatchArray | null
  if ((m = target.match(/^layer\.(\d+)\.opacity$/))) return patchLayer(mix, Number(m[1]) - 1, { opacity: v })
  if ((m = target.match(/^layer\.(\d+)\.clear$/))) return v >= 0.5 ? clearLayer(mix, Number(m[1]) - 1) : mix
  if (target === 'crossfader') return { ...mix, crossfader: v }
  if (target === 'master') return { ...mix, master: v }
  if (target === 'live') return v >= 0.5 ? { ...mix, live: !mix.live } : mix
  if ((m = target.match(/^fx\.([^.]+)\.(.+)$/))) {
    const found = findFx(mix, m[1])
    if (!found) return mix
    if (m[2] === 'enabled') return v >= 0.5 ? patchFx(mix, found.scope, m[1], { enabled: !found.fx.enabled }) : mix
    return patchFx(mix, found.scope, m[1], { params: { [m[2]]: v } })
  }
  if ((m = target.match(/^clip\.([^.]+)\.(.+)$/))) {
    if (v < 0.5) return mix
    const clip = ctx.resolveClip(m[1], m[2])
    return clip ? triggerClip(mix, ctx.selectedLayer, clip, ctx.now) : mix
  }
  return mix
}

/** Default OSC addresses, no learning needed: /vj/layer/1/opacity 0.5, /vj/xfade 1, /vj/clip/{deck}/{col}/{row} … */
export function oscTarget(address: string): string | null {
  const parts = address.split('/').filter(Boolean)
  if (parts[0] !== 'vj') return null
  if (parts[1] === 'layer' && /^\d+$/.test(parts[2] ?? '') && (parts[3] === 'opacity' || parts[3] === 'clear')) return `layer.${parts[2]}.${parts[3]}`
  if (parts[1] === 'xfade' || parts[1] === 'crossfader') return 'crossfader'
  if (parts[1] === 'master') return 'master'
  if (parts[1] === 'live') return 'live'
  return null
}
