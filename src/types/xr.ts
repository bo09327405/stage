/*
 * Audience XR experience (cue type AUDIENCE_XR): the scene a cue puts on the audience's phones / headsets.
 * Stored on the cue as `xr` (plain JSON, see normalizeXr); rendered with Three.js by services/xrStage.ts,
 * edited in components/xr/XrEditor.tsx and played by components/xr/XrPlayer.tsx.
 *
 * Pure (no imports), so node's test runner can load it directly.
 *
 * Conventions: metres; right-handed, Y up, the audience stands at the origin looking down −Z;
 * angles in degrees; yaw turns right (clockwise seen from above), pitch looks up.
 */

export type XrMode = '360_pano' | 'vr_stage' | 'mr_passthrough'

export const XR_MODES: XrMode[] = ['360_pano', 'vr_stage', 'mr_passthrough']

export const XR_MODE_LABELS: Record<XrMode, string> = {
  '360_pano': '360° 全景',
  vr_stage: '3D 虛擬舞台',
  mr_passthrough: 'AR / MR 透視',
}

export const XR_MODE_HINTS: Record<XrMode, string> = {
  '360_pano': '全景圖或全景影片，觀眾在中心環視',
  vr_stage: '匯入 .glb / .gltf 模型佈置的 3D 空間',
  mr_passthrough: '開啟後鏡頭，把 3D 模型疊在劇場現場',
}

export interface XrVec3 {
  x: number
  y: number
  z: number
}

export type XrLoopMode = 'loop' | 'once' | 'pingpong'

export const XR_LOOP_LABELS: Record<XrLoopMode, string> = {
  loop: '循環',
  once: '播一次（停在最後）',
  pingpong: '來回',
}

/** What an object is: a 3D model, a flat picture / video screen, or an empty group that only holds children. */
export type XrObjectKind = 'model' | 'image' | 'video' | 'group'

export const XR_KIND_ICONS: Record<XrObjectKind, string> = { model: '🧊', image: '🖼', video: '🎞', group: '📁' }

/** Look of an object, on top of what the model's own materials say. */
export interface XrMaterial {
  /** 0–1; multiplies the material's own opacity. */
  opacity: number
  /** Colour tint (#rrggbb), multiplied with the base colour; #ffffff = unchanged. */
  color: string
  /** 0–1, or null to keep what the model was authored with. */
  metalness: number | null
  roughness: number | null
}

/** When things happen, in seconds into the cue (after its Pre-Wait) — the same moment on every device. */
export interface XrTimeline {
  /** The object appears at this time (0 = from the start). */
  showAt: number
  /** …and disappears at this time (0 = never). */
  hideAt: number
  /** Its animation clip starts at this time. */
  animationAt: number
  /** Glide from its position to `to`, starting at `start` and taking `duration` seconds. */
  move: { enabled: boolean; to: XrVec3; start: number; duration: number }
}

export type XrTrigger = 'click' | 'gaze'
export type XrAction = 'audio' | 'dialog' | 'toggle' | 'animation' | 'next_cue'

export const XR_TRIGGER_LABELS: Record<XrTrigger, string> = { click: '觀眾點擊', gaze: '觀眾注視 1.5 秒' }
export const XR_ACTION_LABELS: Record<XrAction, string> = {
  audio: '播放音訊',
  dialog: '顯示對話框',
  toggle: '顯示 / 隱藏物件',
  animation: '播放動畫片段',
  next_cue: '執行下一個 Cue（GO）',
}

/** "When the audience does X to this object, do Y." Everything but next_cue happens on that viewer's device only. */
export interface XrInteraction {
  id: string
  trigger: XrTrigger
  action: XrAction
  /** audio: the sound file. */
  url: string
  /** dialog: the message. animation: the clip name. */
  text: string
  /** toggle: the object to show / hide ('' = this object). */
  targetId: string
  /** Fire only the first time (per viewer). */
  once: boolean
}

/** One thing placed in the scene. */
export interface XrObject {
  id: string
  name: string
  kind: XrObjectKind
  /** Parent object ('' = the scene itself); position / rotation / scale are relative to it. */
  parentId: string
  /** model: .glb / .gltf · image / video: the picture — R2 through this server, or any CORS-readable URL. Empty for groups. */
  url: string
  visible: boolean
  position: XrVec3
  /** Euler angles in degrees, applied X → Y → Z. */
  rotation: XrVec3
  scale: XrVec3
  /** Name of the GLTF animation clip to play; '' = none. */
  animation: string
  animationLoop: XrLoopMode
  /** Playback rate (1 = as authored). */
  animationSpeed: number
  material: XrMaterial
  timeline: XrTimeline
  interactions: XrInteraction[]
}

export const DEFAULT_XR_MATERIAL: XrMaterial = { opacity: 1, color: '#ffffff', metalness: null, roughness: null }
export const isDefaultMaterial = (m: XrMaterial) => m.opacity === 1 && m.color.toLowerCase() === '#ffffff' && m.metalness == null && m.roughness == null
export const newXrTimeline = (): XrTimeline => ({ showAt: 0, hideAt: 0, animationAt: 0, move: { enabled: false, to: { x: 0, y: 0, z: -3 }, start: 0, duration: 3 } })
export const newXrInteraction = (): XrInteraction => ({ id: Math.random().toString(36).slice(2, 10), trigger: 'click', action: 'dialog', url: '', text: '', targetId: '', once: false })

/** The 360° backdrop: an equirectangular picture or video. */
export interface XrPano {
  url: string
  kind: 'image' | 'video'
  /** Video: start over at the end (otherwise it holds its last frame). */
  loop: boolean
  /** Turns the panorama around the audience, degrees. */
  yaw: number
}

export interface XrLight {
  intensity: number
  /** Colour temperature in kelvin (1000–12000; 6500 = neutral white). */
  kelvin: number
}

export interface XrDirectionalLight extends XrLight {
  /** Compass direction the light comes from, degrees (0 = from the front, 90 = from the right). */
  azimuth: number
  /** Height above the horizon, degrees. */
  elevation: number
}

export interface XrCamera {
  /** Where the audience faces when the experience starts. */
  yaw: number
  pitch: number
  /** Vertical field of view of the Magic Window, degrees. */
  fov: number
  /** Eye height above the floor, metres (Magic Window; a headset reports its own). */
  height: number
}

export interface XrScene {
  version: 1
  mode: XrMode
  pano: XrPano
  objects: XrObject[]
  camera: XrCamera
  ambient: XrLight
  directional: XrDirectionalLight
  /** Backdrop colour of the virtual stage when it has no panorama. */
  background: string
  /** Let phones look around by moving (gyroscope); dragging always works. */
  gyro: boolean
}

export const XR_MAX_OBJECTS = 48
export const XR_MAX_INTERACTIONS = 8

const vec = (x = 0, y = 0, z = 0): XrVec3 => ({ x, y, z })

export const DEFAULT_XR_CAMERA: XrCamera = { yaw: 0, pitch: 0, fov: 70, height: 1.6 }
export const DEFAULT_XR_AMBIENT: XrLight = { intensity: 1, kelvin: 6500 }
export const DEFAULT_XR_DIRECTIONAL: XrDirectionalLight = { intensity: 1.5, kelvin: 5500, azimuth: 30, elevation: 50 }

export function newXrScene(mode: XrMode = '360_pano'): XrScene {
  return {
    version: 1,
    mode,
    pano: { url: '', kind: 'image', loop: true, yaw: 0 },
    objects: [],
    camera: { ...DEFAULT_XR_CAMERA },
    ambient: { ...DEFAULT_XR_AMBIENT },
    directional: { ...DEFAULT_XR_DIRECTIONAL },
    background: '#0b0d12',
    gyro: true,
  }
}

const newId = () => Math.random().toString(36).slice(2, 10)

/** A new object 3 m in front of the audience: models stand on the floor, screens hang at eye height. */
export function newXrObject(url: string, name: string, kind: XrObjectKind = 'model'): XrObject {
  return {
    id: newId(),
    name: name.replace(/\.[a-z0-9]{2,5}$/i, '') || (kind === 'group' ? '群組' : '物件'),
    kind,
    parentId: '',
    url: kind === 'group' ? '' : url,
    visible: true,
    position: kind === 'group' ? vec() : vec(0, kind === 'model' ? 0 : 1.5, -3),
    rotation: vec(),
    scale: vec(1, 1, 1),
    animation: '',
    animationLoop: 'loop',
    animationSpeed: 1,
    material: { ...DEFAULT_XR_MATERIAL },
    timeline: newXrTimeline(),
    interactions: [],
  }
}

const num = (v: unknown, fallback: number, min = -Infinity, max = Infinity) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}
const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback)
const oneOf = <T extends string>(v: unknown, list: readonly T[], fallback: T): T => (list.includes(v as T) ? (v as T) : fallback)
const normVec = (raw: unknown, fallback: XrVec3, min = -Infinity, max = Infinity): XrVec3 => {
  const r = (raw ?? {}) as Partial<XrVec3>
  return { x: num(r.x, fallback.x, min, max), y: num(r.y, fallback.y, min, max), z: num(r.z, fallback.z, min, max) }
}

/** Is this address a panorama video (by extension)? */
export const isPanoVideoUrl = (url: string) => /\.(mp4|m4v|mov|webm)(?:$|[?#])/i.test(url)
/** Is this file name / address a GLTF model? */
export const isModelUrl = (url: string) => /\.(glb|gltf)(?:$|[?#])/i.test(url)

/**
 * Repair what the database hands back (it drops empty arrays, zero-length strings stay, arrays may come
 * back as objects) and clamp every number to a range the renderer can take. null stays null.
 */
export function normalizeXr(raw: unknown): XrScene | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const base = newXrScene()
  const pano = (r.pano ?? {}) as Record<string, unknown>
  const panoUrl = str(pano.url)
  const cam = (r.camera ?? {}) as Record<string, unknown>
  const amb = (r.ambient ?? {}) as Record<string, unknown>
  const dir = (r.directional ?? {}) as Record<string, unknown>
  const seen = new Set<string>()
  const objects = Object.values((r.objects ?? {}) as Record<string, unknown>)
    .filter((o): o is Record<string, unknown> => !!o && typeof o === 'object' && ((o as { kind?: unknown }).kind === 'group' || (typeof (o as { url?: unknown }).url === 'string' && !!(o as { url: string }).url)))
    .slice(0, XR_MAX_OBJECTS)
    .map((o): XrObject => {
      let id = str(o.id) || newId()
      while (seen.has(id)) id = newId()
      seen.add(id)
      const kind = oneOf(o.kind, ['model', 'image', 'video', 'group'] as const, 'model')
      const mat = (o.material ?? {}) as Record<string, unknown>
      const tl = (o.timeline ?? {}) as Record<string, unknown>
      const mv = (tl.move ?? {}) as Record<string, unknown>
      const unit = (v: unknown) => (v == null || v === '' ? null : num(v, 0, 0, 1))
      return {
        id,
        name: str(o.name, '物件'),
        kind,
        parentId: str(o.parentId),
        url: kind === 'group' ? '' : str(o.url),
        visible: o.visible !== false,
        position: normVec(o.position, vec(), -1000, 1000),
        rotation: normVec(o.rotation, vec(), -3600, 3600),
        scale: normVec(o.scale, vec(1, 1, 1), 0.001, 1000),
        animation: str(o.animation),
        animationLoop: oneOf(o.animationLoop, ['loop', 'once', 'pingpong'] as const, 'loop'),
        animationSpeed: num(o.animationSpeed, 1, 0, 10),
        material: { opacity: num(mat.opacity, 1, 0, 1), color: /^#[0-9a-f]{6}$/i.test(str(mat.color)) ? str(mat.color) : '#ffffff', metalness: unit(mat.metalness), roughness: unit(mat.roughness) },
        timeline: {
          showAt: num(tl.showAt, 0, 0, 36000),
          hideAt: num(tl.hideAt, 0, 0, 36000),
          animationAt: num(tl.animationAt, 0, 0, 36000),
          move: { enabled: mv.enabled === true, to: normVec(mv.to, vec(0, 0, -3), -1000, 1000), start: num(mv.start, 0, 0, 36000), duration: num(mv.duration, 3, 0, 3600) },
        },
        interactions: Object.values((o.interactions ?? {}) as Record<string, unknown>)
          .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
          .slice(0, XR_MAX_INTERACTIONS)
          .map((x) => ({
            id: str(x.id) || newId(),
            trigger: oneOf(x.trigger, ['click', 'gaze'] as const, 'click'),
            action: oneOf(x.action, ['audio', 'dialog', 'toggle', 'animation', 'next_cue'] as const, 'dialog'),
            url: str(x.url),
            text: str(x.text),
            targetId: str(x.targetId),
            once: x.once === true,
          })),
      }
    })
  // A parent must exist and must not lead back to the object itself.
  const byId = new Map(objects.map((o) => [o.id, o]))
  for (const o of objects) {
    const seenUp = new Set([o.id])
    let up = o.parentId
    while (up) {
      const parent = byId.get(up)
      if (!parent || seenUp.has(up)) {
        o.parentId = ''
        break
      }
      seenUp.add(up)
      up = parent.parentId
    }
  }
  return {
    version: 1,
    mode: oneOf(r.mode, XR_MODES, base.mode),
    pano: {
      url: panoUrl,
      kind: oneOf(pano.kind, ['image', 'video'] as const, isPanoVideoUrl(panoUrl) ? 'video' : 'image'),
      loop: pano.loop !== false,
      yaw: num(pano.yaw, 0, -360, 360),
    },
    objects,
    camera: {
      yaw: num(cam.yaw, 0, -360, 360),
      pitch: num(cam.pitch, 0, -89, 89),
      fov: num(cam.fov, base.camera.fov, 30, 110),
      height: num(cam.height, base.camera.height, 0, 20),
    },
    ambient: { intensity: num(amb.intensity, base.ambient.intensity, 0, 10), kelvin: num(amb.kelvin, base.ambient.kelvin, 1000, 12000) },
    directional: {
      intensity: num(dir.intensity, base.directional.intensity, 0, 20),
      kelvin: num(dir.kelvin, base.directional.kelvin, 1000, 12000),
      azimuth: num(dir.azimuth, base.directional.azimuth, -360, 360),
      elevation: num(dir.elevation, base.directional.elevation, -90, 90),
    },
    background: /^#[0-9a-f]{6}$/i.test(str(r.background)) ? str(r.background) : base.background,
    gyro: r.gyro !== false,
  }
}

/**
 * The scene an XR cue plays: the library scene it is bound to (when that still exists), otherwise the copy
 * stored on the cue itself — a cue-only scene, or the last version of a library scene that was deleted since.
 */
export function resolveXrScene(embedded: XrScene | null, sceneId: string, library: Record<string, XrScene> | null | undefined): XrScene | null {
  return (sceneId && library?.[sceneId]) || embedded
}

/** Does this scene show its panorama? (Passthrough never does: the room is the backdrop.) */
export const xrShowsPano = (scene: XrScene) => scene.mode !== 'mr_passthrough' && !!scene.pano.url

/** Objects the audience can ever see: the visible ones, and hidden ones an interaction can switch on. */
export function xrPlayable(scene: XrScene): XrObject[] {
  const switchable = new Set(scene.objects.flatMap((o) => o.interactions.filter((i) => i.action === 'toggle').map((i) => i.targetId || o.id)))
  return scene.objects.filter((o) => o.visible || switchable.has(o.id))
}

/** The object and everything under it (ids), for deleting / duplicating a branch. */
export function xrBranch(objects: XrObject[], id: string): string[] {
  const out = [id]
  for (let i = 0; i < out.length; i++) for (const o of objects) if (o.parentId === out[i] && !out.includes(o.id)) out.push(o.id)
  return out
}

/** Every file the scene needs, for preloading: distinct model addresses, screen pictures / videos and the panorama. */
export function xrAssets(scene: XrScene | null | undefined): { models: string[]; screens: { url: string; kind: 'image' | 'video' }[]; pano: { url: string; kind: 'image' | 'video' } | null } {
  if (!scene) return { models: [], screens: [], pano: null }
  const playable = xrPlayable(scene).filter((o) => o.url)
  const screens = new Map(playable.filter((o) => o.kind === 'image' || o.kind === 'video').map((o) => [`${o.kind}:${o.url}`, { url: o.url, kind: o.kind as 'image' | 'video' }]))
  return {
    models: [...new Set(playable.filter((o) => o.kind === 'model').map((o) => o.url))],
    screens: [...screens.values()],
    pano: xrShowsPano(scene) ? { url: scene.pano.url, kind: scene.pano.kind } : null,
  }
}

/** Is the object on stage `elapsed` seconds into the cue, by its timeline alone? */
export const xrOnStage = (t: XrTimeline, elapsed: number) => elapsed >= t.showAt && (t.hideAt <= 0 || elapsed < t.hideAt)

/** Where a timeline move has brought the object `elapsed` seconds into the cue (eased in and out). */
export function xrMovedPosition(from: XrVec3, t: XrTimeline, elapsed: number): XrVec3 {
  if (!t.move.enabled) return from
  const raw = t.move.duration > 0 ? (elapsed - t.move.start) / t.move.duration : elapsed >= t.move.start ? 1 : 0
  const k = Math.min(1, Math.max(0, raw))
  const e = k * k * (3 - 2 * k)
  return { x: from.x + (t.move.to.x - from.x) * e, y: from.y + (t.move.to.y - from.y) * e, z: from.z + (t.move.to.z - from.z) * e }
}

/** Why the scene can't be saved yet, or null when it has what its mode needs. */
export function xrProblem(scene: XrScene | null): string | null {
  if (!scene) return '請先設定 XR 場景'
  if (scene.mode === '360_pano' && !scene.pano.url) return '360° 全景模式需要一張全景圖或一支全景影片'
  if (scene.mode !== '360_pano' && !scene.objects.some((o) => o.kind !== 'group')) return `${XR_MODE_LABELS[scene.mode]}模式至少需要一個 3D 模型或畫面`
  return null
}

/** Black-body colour of a temperature in kelvin, as linear-ish 0–1 RGB (Tanner Helland's fit). */
export function kelvinToRgb(kelvin: number): [number, number, number] {
  const t = Math.min(40000, Math.max(1000, kelvin)) / 100
  const clamp = (v: number) => Math.min(255, Math.max(0, v)) / 255
  const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592)
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492)
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307
  return [clamp(r), clamp(g), clamp(b)]
}

/** Unit vector pointing from the scene towards a light at this compass direction and height. */
export function lightDirection(azimuth: number, elevation: number): XrVec3 {
  const a = (azimuth * Math.PI) / 180
  const e = (elevation * Math.PI) / 180
  // The audience looks down −Z, so a light "from the front" sits on their side (+Z) and shines onto what they see.
  return { x: Math.sin(a) * Math.cos(e), y: Math.sin(e), z: Math.cos(a) * Math.cos(e) }
}

/**
 * Where a panorama video should be `elapsed` seconds into the cue, so every phone shows the same frame.
 * A looping video wraps; a one-shot holds just before its end.
 */
export function panoVideoTime(elapsed: number, duration: number, loop: boolean): number {
  const t = Math.max(0, elapsed)
  if (!(duration > 0)) return t
  return loop ? t % duration : Math.min(t, Math.max(0, duration - 0.05))
}

/** Where an animation clip is `elapsed` seconds into the cue (same on every device). */
export function animationTime(elapsed: number, duration: number, loop: XrLoopMode, speed = 1): number {
  const t = Math.max(0, elapsed) * Math.max(0, speed)
  if (!(duration > 0)) return 0
  if (loop === 'once') return Math.min(t, duration)
  if (loop === 'pingpong') {
    const phase = t % (duration * 2)
    return phase <= duration ? phase : duration * 2 - phase
  }
  return t % duration
}

/** Wrap an angle into −180…180. */
export const wrapDegrees = (deg: number) => ((((deg + 180) % 360) + 360) % 360) - 180
