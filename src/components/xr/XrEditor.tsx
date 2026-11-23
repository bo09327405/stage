import { useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useDefaultMedia, useProjectMedia, type ProjectMedia } from '../../services/mediaLibrary'
import type { AudienceUpload, Cue } from '../../types/cue'
import {
  XR_ACTION_LABELS,
  XR_KIND_ICONS,
  XR_LOOP_LABELS,
  XR_MAX_INTERACTIONS,
  XR_MAX_OBJECTS,
  XR_MODES,
  XR_MODE_HINTS,
  XR_MODE_LABELS,
  XR_TRIGGER_LABELS,
  isPanoVideoUrl,
  newXrInteraction,
  newXrObject,
  xrBranch,
  type XrAction,
  type XrInteraction,
  type XrLoopMode,
  type XrMode,
  type XrObject,
  type XrObjectKind,
  type XrScene,
  type XrTrigger,
  type XrVec3,
} from '../../types/xr'
import { InboxPickerModal } from '../console/InboxPickerModal'
import { MediaUploadButton } from '../ui/MediaUploadButton'
import XrPlayer from './XrPlayer'
import { XR_ASSET_MIME, XrViewport, type XrAssetDrop, type XrCameraPreset, type XrTool, type XrViewMode, type XrViewportHandle } from './XrViewport'

const TOOLS: { id: XrTool; label: string; hint: string }[] = [
  { id: 'translate', label: '✥ 移動', hint: '拖曳箭頭移動物件' },
  { id: 'rotate', label: '⟳ 旋轉', hint: '拖曳圓環旋轉物件' },
  { id: 'scale', label: '⤢ 縮放', hint: '拖曳方塊縮放物件（中心方塊 = 等比）' },
]
const CAMERAS: { id: XrCameraPreset; label: string }[] = [
  { id: 'persp', label: '透視' },
  { id: 'top', label: '頂視' },
  { id: 'front', label: '正視' },
]

type AssetTab = 'model' | 'pano' | 'av' | 'image'
const ASSET_TABS: { id: AssetTab; label: string; accept: string; hint: string }[] = [
  { id: 'model', label: '🧊 3D 模型', accept: '.glb,.gltf,model/gltf-binary,model/gltf+json', hint: '拖到視口或點一下加入場景' },
  { id: 'pano', label: '🌐 360 全景', accept: 'image/jpeg,image/png,video/mp4,.jpg,.jpeg,.png,.mp4', hint: '點一下設為這個場景的全景' },
  { id: 'av', label: '🎞 影片 / 音訊', accept: 'video/mp4,audio/*,.mp4,.mp3,.wav,.m4a', hint: '影片：拖入成為虛擬螢幕 · 音訊：點一下綁到選取物件' },
  { id: 'image', label: '🖼 2D 貼圖 / UI', accept: 'image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp', hint: '拖到視口或點一下成為平面圖片' },
]

const inputClass = 'h-8 w-full min-w-0 rounded-md border border-line bg-black/40 px-2 text-xs text-white outline-none focus:border-accent/80 pointer-coarse:h-10 pointer-coarse:text-sm'
const buttonClass = 'flex min-h-8 items-center justify-center gap-1 rounded-md border border-line bg-white/[0.04] px-2.5 text-[11px] font-medium text-white/75 hover:bg-white/10 hover:text-white disabled:opacity-40 pointer-coarse:min-h-10'
const segment = (on: boolean, accent = false) => `min-h-7 rounded px-2 text-[11px] font-medium ${on ? (accent ? 'bg-accent/30 text-white' : 'bg-white/15 text-white') : 'text-white/50 hover:text-white/80'}`

/** A small numeric field: commits while typing when the text is a number, and tidies itself on blur. */
function Num({ label, value, onChange, step = 0.1, min, max, suffix, title }: { label: string; value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number; suffix?: string; title?: string }) {
  const [text, setText] = useState(String(value))
  const [seen, setSeen] = useState(value)
  if (value !== seen) {
    setSeen(value)
    setText(String(value))
  }
  const clamp = (n: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n))
  return (
    <label className="block min-w-0" title={title}>
      <span className="mb-1 flex items-baseline justify-between text-[10px] tracking-wide text-white/45">
        <span>{label}</span>
        {suffix && <span className="text-white/25">{suffix}</span>}
      </span>
      <input
        className={`${inputClass} font-mono tabular`}
        type="number"
        inputMode="decimal"
        step={step}
        min={min}
        max={max}
        value={text}
        aria-label={label}
        onChange={(e) => {
          setText(e.target.value)
          const n = Number(e.target.value)
          if (e.target.value.trim() !== '' && Number.isFinite(n)) {
            const next = clamp(n)
            setSeen(next)
            onChange(next)
          }
        }}
        onBlur={() => setText(String(value))}
      />
    </label>
  )
}

function Vec({ label, value, onChange, step, min, suffix }: { label: string; value: XrVec3; onChange: (v: XrVec3) => void; step?: number; min?: number; suffix?: string }) {
  return (
    <div>
      <span className="mb-1 flex items-baseline justify-between text-[11px] font-medium text-white/60">
        <span>{label}</span>
        {suffix && <span className="text-[10px] font-normal text-white/30">{suffix}</span>}
      </span>
      <div className="grid grid-cols-3 gap-1.5">
        {(['x', 'y', 'z'] as const).map((axis) => (
          <Num key={axis} label={axis.toUpperCase()} value={value[axis]} step={step} min={min} onChange={(v) => onChange({ ...value, [axis]: v })} />
        ))}
      </div>
    </div>
  )
}

function Section({ title, hint, children, id }: { title: string; hint?: string; children: ReactNode; id?: string }) {
  return (
    <section className="space-y-3 rounded-xl border border-line bg-white/[0.03] p-3" data-xr-section={id}>
      <h4 className="flex items-baseline justify-between gap-2 text-xs font-semibold tracking-wide text-white/70">
        <span className="truncate">{title}</span>
        {hint && <span className="shrink-0 text-[10px] font-normal text-white/35">{hint}</span>}
      </h4>
      {children}
    </section>
  )
}

function Slider({ label, value, min, max, step, onChange, format }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; format?: (v: number) => string }) {
  return (
    <label className="block">
      <span className="mb-1 flex justify-between text-[10px] text-white/45">
        <span>{label}</span>
        <span className="font-mono text-white/60">{format ? format(value) : value.toFixed(2)}</span>
      </span>
      <input type="range" className="h-5 w-full accent-white" min={min} max={max} step={step} value={value} aria-label={label} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  )
}

/** Intensity slider + colour temperature (kelvin) on a warm → cool track. */
function LightFields({ intensity, kelvin, maxIntensity, onChange }: { intensity: number; kelvin: number; maxIntensity: number; onChange: (changes: { intensity?: number; kelvin?: number }) => void }) {
  return (
    <div className="space-y-2">
      <Slider label="強度" value={intensity} min={0} max={maxIntensity} step={0.05} onChange={(v) => onChange({ intensity: v })} />
      <label className="block">
        <span className="mb-1 flex justify-between text-[10px] text-white/45">
          <span>色溫</span>
          <span className="font-mono text-white/60">{Math.round(kelvin)} K</span>
        </span>
        <input
          type="range"
          className="h-2 w-full cursor-pointer appearance-none rounded-full"
          style={{ background: 'linear-gradient(90deg,#ff8a2b,#ffd9a8 35%,#ffffff 55%,#cfe0ff)' }}
          min={2000}
          max={10000}
          step={100}
          value={kelvin}
          aria-label="色溫"
          onChange={(e) => onChange({ kelvin: Number(e.target.value) })}
        />
      </label>
    </div>
  )
}

/**
 * XR 實境編輯區: visual authoring of an XR scene — a 3D viewport with move / rotate / scale gizmos, grid snapping
 * and top / front views; a hierarchy tree (multi-select, rename, groups, hide, delete); an inspector (transform,
 * material, lights, animation, timeline, interactions); a cloud asset library on R2 with drag-and-drop spawning;
 * and a preview mode that plays the scene exactly as the audience gets it. The whole scene is one JSON value.
 */
export default function XrEditor({
  value,
  onChange,
  onTitle,
  projectId,
  projectName,
  inbox,
  allCues,
  uploadFolder,
  uploadShared,
  layout = 'inline',
}: {
  value: XrScene
  onChange: (scene: XrScene) => void
  /** A file was added: its name, for cues that have no title yet. */
  onTitle?: (name: string) => void
  projectId: string
  projectName: string
  inbox: AudienceUpload[] | null
  allCues: Cue[]
  /** R2 folder uploads go to (this project's, or the shared Default one). */
  uploadFolder: string
  uploadShared: boolean
  /** 'inline': inside the cue editor column (can expand over the window). 'workspace': fills its parent (the XR workspace). */
  layout?: 'inline' | 'workspace'
}) {
  const scene = value
  /** Selected object ids; the last one is the "primary" (gizmo, inspector). Empty = the scene itself. */
  const [selection, setSelection] = useState<string[]>([])
  const [tool, setTool] = useState<XrTool>('translate')
  // A panorama is edited from the inside; a stage from the outside.
  const [view, setView] = useState<XrViewMode>(scene.mode === '360_pano' && scene.objects.length === 0 ? 'pov' : 'orbit')
  const [playing, setPlaying] = useState(true)
  const [snap, setSnap] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const workspace = layout === 'workspace'
  const wide = expanded || workspace
  const [picker, setPicker] = useState<null | 'model' | 'image' | 'video'>(null)
  const [uniform, setUniform] = useState(true)
  const [clips, setClips] = useState<Record<string, string[]>>({})
  const [sizes, setSizes] = useState<Record<string, XrVec3 | null>>({})
  const [renaming, setRenaming] = useState<string | null>(null)
  const [assetTab, setAssetTab] = useState<AssetTab>('model')
  const [note, setNote] = useState<string | null>(null)
  /** Preview mode: the scene plays as the audience gets it (gizmos locked); `t0` restarts its clock. */
  const [preview, setPreview] = useState<{ t0: number } | null>(null)
  const viewport = useRef<XrViewportHandle>(null)

  const objects = scene.objects
  const selectedId = selection.length ? selection[selection.length - 1] : null
  const selected = objects.find((o) => o.id === selectedId) ?? null
  const patch = (changes: Partial<XrScene>) => onChange({ ...scene, ...changes })
  const patchObject = (id: string, changes: Partial<XrObject>) => patch({ objects: objects.map((o) => (o.id === id ? { ...o, ...changes } : o)) })
  const measure = (id: string) => window.setTimeout(() => setSizes((s) => ({ ...s, [id]: viewport.current?.sizeOf(id) ?? null })), 50)
  const full = objects.length >= XR_MAX_OBJECTS

  const select = (id: string | null, additive = false) => {
    if (!id) return setSelection([])
    setSelection((cur) => (additive ? (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]) : [id]))
  }

  const setMode = (mode: XrMode) => {
    patch({ mode })
    setView(mode === '360_pano' && objects.length === 0 ? 'pov' : 'orbit')
  }

  const addObject = (kind: XrObjectKind, url: string, name: string, at?: XrVec3) => {
    if (full) return setNote(`每個場景最多 ${XR_MAX_OBJECTS} 個物件`)
    const object = newXrObject(url, name, kind)
    if (at) object.position = { x: at.x, y: object.position.y, z: at.z }
    patch({ objects: [...objects, object] })
    setSelection([object.id])
    if (kind !== 'group') {
      setView('orbit')
      onTitle?.(object.name)
    }
  }
  const setPano = (url: string, name: string, video: boolean) => {
    patch({ pano: { ...scene.pano, url, kind: video ? 'video' : 'image' } })
    onTitle?.(name.replace(/\.[^.]+$/, ''))
  }

  // — hierarchy operations (on the whole selection) —
  const removeSelected = () => {
    const gone = new Set(selection.flatMap((id) => xrBranch(objects, id)))
    patch({ objects: objects.filter((o) => !gone.has(o.id)) })
    setSelection([])
  }
  const duplicateSelected = () => {
    const copies = selection
      .map((id) => objects.find((o) => o.id === id))
      .filter((o): o is XrObject => !!o)
      .slice(0, XR_MAX_OBJECTS - objects.length)
      // Same settings, half a metre to the side so the copy doesn't hide the original.
      .map((o) => ({ ...structuredClone(o), id: newXrObject('', '').id, name: `${o.name} 副本`, position: { ...o.position, x: o.position.x + 0.5 }, interactions: o.interactions.map((i) => ({ ...i, id: newXrInteraction().id })) }))
    if (!copies.length) return
    patch({ objects: [...objects, ...copies] })
    setSelection(copies.map((c) => c.id))
  }
  const groupSelected = () => {
    if (full) return setNote(`每個場景最多 ${XR_MAX_OBJECTS} 個物件`)
    const group = newXrObject('', `群組 ${objects.filter((o) => o.kind === 'group').length + 1}`, 'group')
    // Only the topmost selected objects move into the group; their children follow them.
    const chosen = new Set(selection)
    const tops = selection.filter((id) => !chosen.has(objects.find((o) => o.id === id)?.parentId ?? ''))
    group.parentId = tops.length ? (objects.find((o) => o.id === tops[0])?.parentId ?? '') : ''
    patch({ objects: [...objects.map((o) => (tops.includes(o.id) ? { ...o, parentId: group.id } : o)), group] })
    setSelection([group.id])
  }
  const setParent = (ids: string[], parentId: string) => {
    // Never under itself or one of its own children.
    const blocked = new Set(ids.flatMap((id) => xrBranch(objects, id)))
    if (parentId && blocked.has(parentId)) return setNote('不能把物件放進它自己或它的子物件底下')
    patch({ objects: objects.map((o) => (ids.includes(o.id) ? { ...o, parentId } : o)) })
  }

  const setScale = (next: XrVec3) => {
    if (!selected) return
    if (uniform) {
      // Keep the proportions: whichever axis was typed drives the other two.
      const axis = (['x', 'y', 'z'] as const).find((a) => next[a] !== selected.scale[a])
      if (axis && selected.scale[axis] > 0) {
        const k = next[axis] / selected.scale[axis]
        const r = (v: number) => Math.round(Math.max(0.001, v * k) * 1000) / 1000
        next = { x: r(selected.scale.x), y: r(selected.scale.y), z: r(selected.scale.z) }
      }
    }
    patchObject(selected.id, { scale: next })
    measure(selected.id)
  }

  // — asset library (this project's files and the shared Default folder, both on R2) —
  const projectLibrary = useProjectMedia(projectId)
  // A library that can't be read (no access) counts as empty rather than loading forever.
  const projectMedia = projectLibrary.media ?? (projectLibrary.error ? [] : null)
  const sharedMedia = useDefaultMedia().media
  const library = [...(projectMedia ?? []), ...(sharedMedia ?? [])].filter((m, i, all) => m.storage === 'r2' && all.findIndex((x) => x.url === m.url) === i)
  const inTab = (m: ProjectMedia, tab: AssetTab) => (tab === 'model' ? m.kind === 'model' : tab === 'pano' ? m.kind === 'image' || m.kind === 'video' : tab === 'av' ? m.kind === 'video' || m.kind === 'audio' : m.kind === 'image')
  const tabAssets = library.filter((m) => inTab(m, assetTab))
  const audioAssets = library.filter((m) => m.kind === 'audio')
  const dropOf = (m: ProjectMedia): XrAssetDrop | null => (assetTab === 'pano' || m.kind === 'audio' ? null : { url: m.url, name: m.name, kind: m.kind === 'model' ? 'model' : m.kind === 'video' ? 'video' : 'image' })
  const placeAsset = (m: ProjectMedia) => {
    setNote(null)
    if (assetTab === 'pano') return setPano(m.url, m.name, m.kind === 'video')
    if (m.kind === 'audio') {
      if (!selected) return setNote('先選取一個物件，再點音訊，就會加上「點擊時播放這段音訊」的互動')
      if (selected.interactions.length >= XR_MAX_INTERACTIONS) return setNote(`每個物件最多 ${XR_MAX_INTERACTIONS} 個互動`)
      patchObject(selected.id, { interactions: [...selected.interactions, { ...newXrInteraction(), action: 'audio', url: m.url }] })
      return setNote(`已在「${selected.name}」加上：點擊 → 播放「${m.name}」`)
    }
    const drop = dropOf(m)
    if (drop) addObject(drop.kind, drop.url, drop.name)
  }

  const pickMedia = (m: ProjectMedia) => {
    if (picker === 'model') addObject('model', m.url, m.name)
    else setPano(m.url, m.name, m.kind === 'video')
  }

  const selectedClips = selected ? (clips[selected.id] ?? []) : []
  const selectedSize = selected ? sizes[selected.id] : null
  const patchInteraction = (id: string, changes: Partial<XrInteraction>) => selected && patchObject(selected.id, { interactions: selected.interactions.map((i) => (i.id === id ? { ...i, ...changes } : i)) })

  /* ---------- viewport ---------- */

  const viewportPane = (
    <div className={`flex min-h-0 flex-col gap-2 ${wide ? 'flex-1' : ''}`} data-xr-viewport-pane>
      <div className="flex flex-wrap items-center gap-1.5">
        {preview ? (
          <>
            <span className="rounded-md bg-go/20 px-2.5 py-1.5 text-[11px] font-semibold text-go">▶ 預覽中 · 觀眾視角</span>
            <button type="button" onClick={() => setPreview({ t0: performance.now() })} className={`${buttonClass} min-h-7`} title="從 Cue 開始的那一刻重播（時間軸與互動都重來）" data-xr-preview-restart>
              ↺ 重新開始
            </button>
            <span className="text-[10px] text-white/40">拖曳或轉動手機環視 · 點擊 / 注視物件測試互動</span>
          </>
        ) : (
          <>
            <div className="flex rounded-md bg-black/40 p-0.5" role="group" aria-label="預覽視角">
              {(
                [
                  ['orbit', '🎥 場景'],
                  ['pov', '👁 觀眾視角'],
                ] as const
              ).map(([id, label]) => (
                <button key={id} type="button" onClick={() => setView(id)} aria-pressed={view === id} className={segment(view === id)} data-xr-view={id}>
                  {label}
                </button>
              ))}
            </div>
            {view === 'orbit' && (
              <>
                <div className="flex rounded-md bg-black/40 p-0.5" role="group" aria-label="Gizmo 工具">
                  {TOOLS.map((t) => (
                    <button key={t.id} type="button" onClick={() => setTool(t.id)} aria-pressed={tool === t.id} title={t.hint} className={segment(tool === t.id, true)} data-xr-tool={t.id}>
                      {t.label}
                    </button>
                  ))}
                </div>
                <button type="button" onClick={() => setSnap((s) => !s)} aria-pressed={snap} className={`${buttonClass} min-h-7 ${snap ? 'border-accent/60 bg-accent/20 text-white' : ''}`} title="網格對齊：移動 0.25 m、旋轉 15°、縮放 0.1 倍" data-xr-snap>
                  🧲 對齊
                </button>
                <div className="flex rounded-md bg-black/40 p-0.5" role="group" aria-label="鏡頭視圖">
                  {CAMERAS.map((c) => (
                    <button key={c.id} type="button" onClick={() => viewport.current?.setCamera(c.id)} className={segment(false)} data-xr-camera-preset={c.id}>
                      {c.label}
                    </button>
                  ))}
                </div>
                <button type="button" onClick={() => viewport.current?.focus(selectedId)} className={`${buttonClass} min-h-7`} title="把鏡頭對準選取的物件（沒選取時為全部物件）" data-xr-focus>
                  🎯 對焦
                </button>
              </>
            )}
            <button type="button" onClick={() => setPlaying((p) => !p)} aria-pressed={playing} className={`${buttonClass} min-h-7`} title="編輯時是否播放動畫與影片" data-xr-play>
              {playing ? '⏸ 動畫' : '▶ 動畫'}
            </button>
          </>
        )}
        <button
          type="button"
          onClick={() => setPreview((p) => (p ? null : { t0: performance.now() }))}
          aria-pressed={!!preview}
          className={`${buttonClass} ml-auto min-h-7 ${preview ? 'border-go/60 bg-go/20 text-go' : 'border-accent/50 bg-accent/10 text-accent'}`}
          title="鎖定編輯控制器，以觀眾視角測試時間軸與互動"
          data-xr-preview
        >
          {preview ? '✎ 回到編輯' : '▶ 預覽'}
        </button>
        {!workspace && (
          <button type="button" onClick={() => setExpanded((x) => !x)} className={`${buttonClass} min-h-7`} data-xr-expand>
            {expanded ? '✕ 收合' : '⛶ 放大編輯'}
          </button>
        )}
      </div>
      <div className={`overflow-hidden rounded-lg ${wide ? 'min-h-0 flex-1' : 'aspect-[4/3] w-full'}`}>
        {preview ? (
          <div className="h-full w-full bg-black" data-xr-preview-stage>
            <XrPlayer key={preview.t0} scene={scene} clock={() => (performance.now() - preview.t0) / 1000} mode="audience" interactive />
          </div>
        ) : (
          <XrViewport
            scene={scene}
            selectedId={selectedId}
            tool={tool}
            view={view}
            playing={playing}
            snap={snap}
            onSelect={select}
            onTransform={(id, t) => {
              patchObject(id, t)
              if (tool === 'scale') measure(id)
            }}
            onModel={(id, names) => {
              setClips((c) => ({ ...c, [id]: names }))
              measure(id)
            }}
            onDropAsset={(asset, at) => addObject(asset.kind, asset.url, asset.name, at)}
            handle={viewport}
          />
        )}
      </div>
      {!preview && (
        <p className="text-[10px] leading-relaxed text-white/35">
          {view === 'orbit' ? '拖曳旋轉 · 滾輪縮放 · 右鍵（或雙指）平移 · 點物件選取（Shift 多選）· 從素材庫拖入生成。黃色人形 = 觀眾，三色軸 = 舞台原點 (0,0,0)。' : '拖曳環視 · 滾輪縮放（只影響預覽）。轉到想要的方向後按「設為初始視角」。'}
        </p>
      )}
      {!preview && view === 'pov' && (
        <button
          type="button"
          onClick={() => {
            const v = viewport.current?.currentView()
            if (!v) return
            patch({ camera: { ...scene.camera, yaw: v.yaw, pitch: v.pitch } })
            viewport.current?.resetView()
          }}
          className={`${buttonClass} border-accent/50 bg-accent/10 text-accent`}
          data-xr-capture-view
        >
          📌 把目前方向設為初始視角
        </button>
      )}
    </div>
  )

  /* ---------- hierarchy ---------- */

  const rows: { object: XrObject; depth: number }[] = []
  const walk = (parentId: string, depth: number) => {
    for (const o of objects) {
      if (o.parentId !== parentId) continue
      rows.push({ object: o, depth })
      walk(o.id, depth + 1)
    }
  }
  walk('', 0)

  const hierarchy = (
    <Section title="場景物件樹" hint={`${objects.length} / ${XR_MAX_OBJECTS}`} id="hierarchy">
      <div className="flex flex-wrap gap-1">
        <button type="button" onClick={groupSelected} disabled={full} className={buttonClass} title={selection.length ? '把選取的物件放進一個新群組' : '新增空群組'} data-xr-group>
          📁 {selection.length ? '群組化' : '新群組'}
        </button>
        <button type="button" onClick={() => setParent(selection, '')} disabled={!selection.some((id) => objects.find((o) => o.id === id)?.parentId)} className={buttonClass} title="把選取的物件移回場景最上層" data-xr-ungroup>
          ⇱ 移出
        </button>
        <button type="button" onClick={duplicateSelected} disabled={!selection.length || full} className={buttonClass} data-xr-duplicate>
          ⧉ 複製
        </button>
        <button type="button" onClick={removeSelected} disabled={!selection.length} className={`${buttonClass} hover:!text-panic`} title="刪除選取的物件（連同子物件；檔案仍在素材庫）" data-xr-delete>
          ✕ 刪除{selection.length > 1 ? ` ${selection.length}` : ''}
        </button>
      </div>
      <ul className="space-y-0.5" data-xr-object-list>
        <li>
          <button type="button" onClick={() => setSelection([])} className={`flex min-h-8 w-full items-center gap-1.5 rounded-lg border px-2 text-left text-xs ${selection.length === 0 ? 'border-accent bg-accent/10 text-white' : 'border-transparent bg-black/30 text-white/70 hover:bg-white/[0.06]'}`} data-xr-scene-row>
            🎬 場景設定
            <span className="ml-auto truncate text-[10px] text-white/35">模式 · 全景 · 視角 · 燈光</span>
          </button>
        </li>
        {rows.map(({ object: o, depth }) => {
          const on = selection.includes(o.id)
          return (
            <li key={o.id} className={`flex items-center gap-0.5 rounded-lg border pr-1 ${on ? (o.id === selectedId ? 'border-accent bg-accent/10' : 'border-accent/40 bg-accent/5') : 'border-transparent bg-black/30 hover:bg-white/[0.06]'}`} style={{ marginLeft: depth * 14 }} data-xr-object={o.id} data-xr-depth={depth}>
              <button type="button" onClick={() => patchObject(o.id, { visible: !o.visible })} className="flex h-8 w-7 shrink-0 items-center justify-center text-sm" aria-label={o.visible ? `隱藏 ${o.name}` : `顯示 ${o.name}`} aria-pressed={o.visible} title={o.visible ? '觀眾看得到（點一下隱藏）' : '已隱藏（互動可再把它打開）'}>
                <span className={o.visible ? '' : 'opacity-25'}>👁</span>
              </button>
              {renaming === o.id ? (
                <input
                  autoFocus
                  defaultValue={o.name}
                  aria-label="物件名稱"
                  className={`${inputClass} h-7 flex-1`}
                  onBlur={(e) => {
                    patchObject(o.id, { name: e.target.value.trim() || o.name })
                    setRenaming(null)
                  }}
                  onKeyDown={(e) => (e.key === 'Enter' || e.key === 'Escape') && (e.target as HTMLInputElement).blur()}
                />
              ) : (
                <button type="button" onClick={(e) => select(o.id, e.shiftKey || e.metaKey || e.ctrlKey)} onDoubleClick={() => setRenaming(o.id)} className={`min-h-8 min-w-0 flex-1 truncate text-left text-xs ${o.visible ? 'text-white/85' : 'text-white/35'}`} title="點一下選取（Shift / ⌘ 多選）· 點兩下重新命名">
                  {XR_KIND_ICONS[o.kind]} {o.name}
                  {o.interactions.length > 0 && <span className="ml-1 text-[10px] text-standby">⚡{o.interactions.length}</span>}
                </button>
              )}
              <button type="button" onClick={() => setRenaming(o.id)} className="flex h-8 w-6 shrink-0 items-center justify-center text-[11px] text-white/35 hover:text-white" aria-label={`重新命名 ${o.name}`} title="重新命名">
                ✎
              </button>
            </li>
          )
        })}
      </ul>
      {objects.length === 0 && <p className="rounded-lg bg-black/30 p-3 text-center text-[11px] leading-relaxed text-white/35">還沒有物件。從素材庫拖曳或點選 3D 模型、圖片、影片加入場景。</p>}
    </Section>
  )

  /* ---------- asset library ---------- */

  const tab = ASSET_TABS.find((t) => t.id === assetTab)!
  const assets = (
    <Section title="雲端素材庫" hint="Cloudflare R2 · 專案 + Default 共用" id="assets">
      <div className="grid grid-cols-2 gap-1" role="tablist" aria-label="素材分類">
        {ASSET_TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={assetTab === t.id} onClick={() => setAssetTab(t.id)} className={`min-h-8 rounded-md text-[11px] font-medium ${assetTab === t.id ? 'bg-white/15 text-white' : 'bg-black/30 text-white/50 hover:text-white/80'}`} data-xr-asset-tab={t.id}>
            {t.label}
          </button>
        ))}
      </div>
      <p className="text-[10px] text-white/35">{tab.hint}</p>
      {projectMedia === null ? (
        <p className="p-3 text-center text-[11px] text-white/35">載入素材庫…</p>
      ) : tabAssets.length === 0 ? (
        <p className="rounded-lg bg-black/30 p-3 text-center text-[11px] text-white/35">這個分類還沒有檔案，請用下方按鈕上傳。</p>
      ) : (
        <ul className="grid max-h-56 grid-cols-3 gap-1.5 overflow-y-auto pr-0.5" data-xr-asset-list>
          {tabAssets.map((m) => {
            const drop = dropOf(m)
            return (
              <li key={m.id}>
                <button
                  type="button"
                  draggable={!!drop}
                  onDragStart={(e) => {
                    if (!drop) return
                    e.dataTransfer.setData(XR_ASSET_MIME, JSON.stringify(drop))
                    e.dataTransfer.effectAllowed = 'copy'
                  }}
                  onClick={() => placeAsset(m)}
                  className={`block w-full overflow-hidden rounded-lg border border-line bg-black/30 text-left hover:ring-1 hover:ring-accent ${drop ? 'cursor-grab active:cursor-grabbing' : ''}`}
                  title={m.name}
                  data-xr-asset={m.kind}
                >
                  {m.kind === 'image' ? <img src={m.url} alt="" loading="lazy" draggable={false} className="aspect-square w-full bg-black object-cover" /> : <span className="flex aspect-square w-full items-center justify-center text-2xl">{m.kind === 'model' ? '🧊' : m.kind === 'video' ? '🎞' : '♪'}</span>}
                  <span className="block truncate px-1.5 py-1 text-[10px] text-white/70">{m.name}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
      <MediaUploadButton
        accept={tab.accept}
        folder={uploadFolder}
        library={{ projectId, source: 'cue', shared: uploadShared }}
        label={`上傳到 R2${uploadShared ? '（Default 共用）' : ''}`}
        onUploaded={(result, file) => {
          const video = file.type.startsWith('video/') || isPanoVideoUrl(file.name)
          if (assetTab === 'pano') setPano(result.secure_url, file.name, video)
          else if (assetTab === 'model') addObject('model', result.secure_url, file.name)
          else if (assetTab === 'image') addObject('image', result.secure_url, file.name)
          else if (video) addObject('video', result.secure_url, file.name)
          else setNote(`已上傳「${file.name}」：選取物件後在音訊分類點它，或在「互動」裡選用`)
        }}
      />
      {assetTab === 'model' && <p className="text-[10px] leading-relaxed text-white/35">建議 .glb（單一檔案，可用 Draco / Meshopt 壓縮）；.gltf 需為內嵌資源的單一檔案。手機端每個模型建議 10 MB 以內。</p>}
      {note && (
        <p className="rounded-md bg-standby/10 px-2 py-1.5 text-[11px] leading-relaxed text-standby" data-xr-note>
          {note}
        </p>
      )}
    </Section>
  )

  /* ---------- inspector ---------- */

  const sceneInspector = (
    <>
      <Section title="體驗模式" id="mode">
        <div className="grid grid-cols-3 gap-1.5" role="group" aria-label="體驗模式">
          {XR_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setMode(mode)}
              aria-pressed={scene.mode === mode}
              className={`flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-lg border px-1 text-center text-[11px] font-medium ${scene.mode === mode ? 'border-accent bg-accent/15 text-white' : 'border-line bg-black/30 text-white/50 hover:text-white/80'}`}
              data-xr-mode-option={mode}
            >
              <span>{XR_MODE_LABELS[mode]}</span>
              <span className="font-mono text-[9px] font-normal text-white/35">{mode}</span>
            </button>
          ))}
        </div>
        <p className="text-[11px] leading-relaxed text-white/40">{XR_MODE_HINTS[scene.mode]}。</p>
      </Section>

      {scene.mode !== 'mr_passthrough' && (
        <Section title="360° 全景" hint={scene.mode === 'vr_stage' ? '選填：當作天空 / 背景' : '等距長方（2:1）圖片或影片'} id="pano">
          <input
            className={`${inputClass} font-mono`}
            placeholder="全景圖 / 影片的 R2 路徑或網址"
            aria-label="全景素材 URL"
            spellCheck={false}
            value={scene.pano.url}
            onChange={(e) => patch({ pano: { ...scene.pano, url: e.target.value.trim(), kind: isPanoVideoUrl(e.target.value) ? 'video' : 'image' } })}
            data-xr-pano-url
          />
          <div className="grid grid-cols-2 gap-1.5">
            <button type="button" onClick={() => setPicker('image')} className={buttonClass} data-xr-pick="image">
              📁 選全景圖
            </button>
            <button type="button" onClick={() => setPicker('video')} className={buttonClass} data-xr-pick="video">
              📁 選全景影片
            </button>
          </div>
          {scene.pano.url && (
            <div className="grid grid-cols-2 items-end gap-2">
              <Num label="全景水平旋轉" suffix="°" step={5} min={-360} max={360} value={scene.pano.yaw} onChange={(yaw) => patch({ pano: { ...scene.pano, yaw } })} />
              {scene.pano.kind === 'video' ? (
                <button type="button" onClick={() => patch({ pano: { ...scene.pano, loop: !scene.pano.loop } })} aria-pressed={scene.pano.loop} className={buttonClass}>
                  {scene.pano.loop ? '🔁 循環播放' : '➡ 播一次後停在最後'}
                </button>
              ) : (
                <button type="button" onClick={() => patch({ pano: { ...scene.pano, url: '' } })} className={buttonClass}>
                  移除全景
                </button>
              )}
            </div>
          )}
          {scene.pano.kind === 'video' && scene.pano.url && <p className="text-[10px] leading-relaxed text-white/35">全景影片靜音播放並對齊演出時鐘（所有手機同一格）；聲音請另用音訊 Cue 同時 GO。</p>}
        </Section>
      )}

      <Section title="初始視角" hint="觀眾進入時面向的方向" id="camera">
        <div className="grid grid-cols-2 gap-2">
          <Num label="水平 Yaw" suffix="° 右為正" step={5} min={-360} max={360} value={scene.camera.yaw} onChange={(yaw) => patch({ camera: { ...scene.camera, yaw } })} />
          <Num label="俯仰 Pitch" suffix="° 上為正" step={5} min={-89} max={89} value={scene.camera.pitch} onChange={(pitch) => patch({ camera: { ...scene.camera, pitch } })} />
          <Num label="視野 FOV" suffix="°" step={5} min={30} max={110} value={scene.camera.fov} onChange={(fov) => patch({ camera: { ...scene.camera, fov } })} />
          <Num label="眼睛高度" suffix="m" step={0.1} min={0} max={20} value={scene.camera.height} onChange={(height) => patch({ camera: { ...scene.camera, height } })} />
        </div>
        <button type="button" onClick={() => patch({ gyro: !scene.gyro })} aria-pressed={scene.gyro} className={`${buttonClass} w-full`} data-xr-gyro-toggle>
          {scene.gyro ? '📱 手機陀螺儀體感轉動：開啟' : '✋ 只用手指滑動環視（陀螺儀關閉）'}
        </button>
      </Section>

      <Section title="燈光" id="lights">
        <div className="space-y-3">
          <div>
            <span className="mb-1.5 block text-[11px] font-medium text-white/60">環境光 Ambient</span>
            <LightFields intensity={scene.ambient.intensity} kelvin={scene.ambient.kelvin} maxIntensity={3} onChange={(c) => patch({ ambient: { ...scene.ambient, ...c } })} />
          </div>
          <div className="border-t border-line pt-3">
            <span className="mb-1.5 block text-[11px] font-medium text-white/60">方向光 Directional</span>
            <LightFields intensity={scene.directional.intensity} kelvin={scene.directional.kelvin} maxIntensity={6} onChange={(c) => patch({ directional: { ...scene.directional, ...c } })} />
            <div className="mt-2 grid grid-cols-2 gap-2">
              <Num label="方位" suffix="° 0 = 正面" step={15} min={-360} max={360} value={scene.directional.azimuth} onChange={(azimuth) => patch({ directional: { ...scene.directional, azimuth } })} />
              <Num label="仰角" suffix="°" step={5} min={-90} max={90} value={scene.directional.elevation} onChange={(elevation) => patch({ directional: { ...scene.directional, elevation } })} />
            </div>
          </div>
          {scene.mode === 'vr_stage' && !scene.pano.url && (
            <label className="flex items-center justify-between border-t border-line pt-3 text-[11px] text-white/60">
              背景顏色
              <input type="color" value={scene.background} onChange={(e) => patch({ background: e.target.value })} className="h-8 w-14 cursor-pointer rounded border border-line bg-transparent" aria-label="背景顏色" />
            </label>
          )}
        </div>
      </Section>

      <Section title="場景 JSON" hint="整個場景就是這一份資料" id="json">
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(JSON.stringify(scene, null, 2)).then(
              () => setNote('已複製場景 JSON 到剪貼簿'),
              () => setNote('無法使用剪貼簿'),
            )
          }}
          className={`${buttonClass} w-full`}
          data-xr-copy-json
        >
          ⧉ 複製場景 JSON（{objects.length} 個物件 · {objects.reduce((n, o) => n + o.interactions.length, 0)} 個互動）
        </button>
      </Section>
    </>
  )

  const objectInspector = selected && (
    <>
      <Section title={`${XR_KIND_ICONS[selected.kind]} ${selected.name}`} hint={selection.length > 1 ? `已選 ${selection.length} 個（編輯最後選的）` : selectedSize ? `約 ${selectedSize.x} × ${selectedSize.y} × ${selectedSize.z} m` : undefined} id="transform">
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="mb-1 block text-[10px] text-white/45">名稱</span>
            <input className={inputClass} value={selected.name} aria-label="物件名稱" onChange={(e) => patchObject(selected.id, { name: e.target.value })} />
          </label>
          <label className="block">
            <span className="mb-1 block text-[10px] text-white/45">上層（Parent）</span>
            <select className={inputClass} value={selected.parentId} aria-label="上層物件" onChange={(e) => setParent([selected.id], e.target.value)} data-xr-parent>
              <option value="">（場景最上層）</option>
              {objects
                .filter((o) => !xrBranch(objects, selected.id).includes(o.id))
                .map((o) => (
                  <option key={o.id} value={o.id}>
                    {XR_KIND_ICONS[o.kind]} {o.name}
                  </option>
                ))}
            </select>
          </label>
        </div>
        <Vec label="位置 Position" suffix={selected.parentId ? '公尺 · 相對於上層' : '公尺 · 觀眾在原點，前方為 −Z'} step={0.1} value={selected.position} onChange={(position) => patchObject(selected.id, { position })} />
        <Vec label="旋轉 Rotation" suffix="度" step={5} value={selected.rotation} onChange={(rotation) => patchObject(selected.id, { rotation })} />
        <div>
          <Vec label="縮放 Scale" suffix="倍" step={0.1} min={0.001} value={selected.scale} onChange={setScale} />
          <div className="mt-1.5 flex gap-1.5">
            <button type="button" onClick={() => setUniform((u) => !u)} aria-pressed={uniform} className={`${buttonClass} flex-1`} data-xr-uniform>
              {uniform ? '🔗 等比縮放' : '⛓ 各軸獨立'}
            </button>
            <button
              type="button"
              onClick={() => {
                patchObject(selected.id, { position: selected.kind === 'group' || selected.parentId ? { x: 0, y: 0, z: 0 } : { x: 0, y: selected.kind === 'model' ? 0 : 1.5, z: -3 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } })
                measure(selected.id)
              }}
              className={`${buttonClass} flex-1`}
            >
              ↺ 重設變換
            </button>
          </div>
        </div>
      </Section>

      {selected.kind !== 'group' && (
        <Section title="材質與外觀" hint={selected.kind === 'model' ? '疊加在模型原本的材質上' : undefined} id="material">
          <Slider label="透明度 Opacity" value={selected.material.opacity} min={0} max={1} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onChange={(opacity) => patchObject(selected.id, { material: { ...selected.material, opacity } })} />
          <label className="flex items-center justify-between text-[11px] text-white/60">
            基礎顏色 Color Tint
            <span className="flex items-center gap-2">
              <span className="font-mono text-[10px] text-white/40">{selected.material.color}</span>
              <input type="color" value={selected.material.color} onChange={(e) => patchObject(selected.id, { material: { ...selected.material, color: e.target.value } })} className="h-8 w-14 cursor-pointer rounded border border-line bg-transparent" aria-label="基礎顏色" data-xr-tint />
            </span>
          </label>
          {selected.kind === 'model' &&
            (['metalness', 'roughness'] as const).map((key) => {
              const v = selected.material[key]
              return (
                <div key={key} className="flex items-end gap-2">
                  <div className={`flex-1 ${v == null ? 'opacity-40' : ''}`}>
                    <Slider label={key === 'metalness' ? '金屬度 Metalness' : '粗糙度 Roughness'} value={v ?? 0.5} min={0} max={1} step={0.01} onChange={(n) => patchObject(selected.id, { material: { ...selected.material, [key]: n } })} />
                  </div>
                  <button type="button" onClick={() => patchObject(selected.id, { material: { ...selected.material, [key]: v == null ? 0.5 : null } })} aria-pressed={v != null} className={`${buttonClass} mb-0.5 w-16 shrink-0`} title="關閉 = 沿用模型原本的數值" data-xr-material-toggle={key}>
                    {v == null ? '原始值' : '覆寫中'}
                  </button>
                </div>
              )
            })}
        </Section>
      )}

      {selected.kind === 'model' && (
        <Section title="動畫控制" hint="GLTF Animations" id="animation">
          {selectedClips.length === 0 ? (
            <p className="text-[11px] text-white/35">{selected.animation ? `已設定片段「${selected.animation}」（模型載入後確認）` : '這個模型沒有內含動畫片段。'}</p>
          ) : (
            <>
              <select className={inputClass} value={selected.animation} aria-label="預設動畫片段" onChange={(e) => patchObject(selected.id, { animation: e.target.value })} data-xr-clip>
                <option value="">不播放（靜止）</option>
                {selectedClips.map((name) => (
                  <option key={name} value={name}>
                    {name || '（未命名片段）'}
                  </option>
                ))}
              </select>
              {selected.animation && (
                <div className="grid grid-cols-[1fr_5.5rem] items-end gap-2">
                  <label className="block">
                    <span className="mb-1 block text-[10px] text-white/45">循環</span>
                    <select className={inputClass} value={selected.animationLoop} aria-label="循環設定" onChange={(e) => patchObject(selected.id, { animationLoop: e.target.value as XrLoopMode })} data-xr-loop>
                      {(Object.keys(XR_LOOP_LABELS) as XrLoopMode[]).map((m) => (
                        <option key={m} value={m}>
                          {XR_LOOP_LABELS[m]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Num label="速度" suffix="×" step={0.1} min={0} max={10} value={selected.animationSpeed} onChange={(animationSpeed) => patchObject(selected.id, { animationSpeed })} />
                </div>
              )}
            </>
          )}
        </Section>
      )}

      <Section title="時間軸" hint="Cue 開始（Pre-Wait 之後）起算的秒數" id="timeline">
        <div className="grid grid-cols-3 gap-2">
          <Num label="出現" suffix="s" step={0.5} min={0} value={selected.timeline.showAt} onChange={(showAt) => patchObject(selected.id, { timeline: { ...selected.timeline, showAt } })} />
          <Num label="隱藏" suffix="0 = 不隱藏" step={0.5} min={0} value={selected.timeline.hideAt} onChange={(hideAt) => patchObject(selected.id, { timeline: { ...selected.timeline, hideAt } })} />
          <Num label="動畫開始" suffix="s" step={0.5} min={0} value={selected.timeline.animationAt} onChange={(animationAt) => patchObject(selected.id, { timeline: { ...selected.timeline, animationAt } })} />
        </div>
        <button type="button" onClick={() => patchObject(selected.id, { timeline: { ...selected.timeline, move: { ...selected.timeline.move, enabled: !selected.timeline.move.enabled, to: selected.timeline.move.enabled ? selected.timeline.move.to : { ...selected.position } } } })} aria-pressed={selected.timeline.move.enabled} className={`${buttonClass} w-full`} data-xr-move-toggle>
          {selected.timeline.move.enabled ? '➡ 位移：開啟' : '＋ 加入位移（從目前位置滑到另一點）'}
        </button>
        {selected.timeline.move.enabled && (
          <>
            <Vec label="位移終點" suffix="公尺" step={0.1} value={selected.timeline.move.to} onChange={(to) => patchObject(selected.id, { timeline: { ...selected.timeline, move: { ...selected.timeline.move, to } } })} />
            <div className="grid grid-cols-2 gap-2">
              <Num label="開始" suffix="s" step={0.5} min={0} value={selected.timeline.move.start} onChange={(start) => patchObject(selected.id, { timeline: { ...selected.timeline, move: { ...selected.timeline.move, start } } })} />
              <Num label="歷時" suffix="s" step={0.5} min={0} value={selected.timeline.move.duration} onChange={(duration) => patchObject(selected.id, { timeline: { ...selected.timeline, move: { ...selected.timeline.move, duration } } })} />
            </div>
          </>
        )}
        <p className="text-[10px] leading-relaxed text-white/35">所有裝置依演出時鐘同步；編輯時物件一律顯示在原位，按「▶ 預覽」看時間軸效果。</p>
      </Section>

      <Section title="互動" hint={`${selected.interactions.length} / ${XR_MAX_INTERACTIONS}`} id="interactions">
        {selected.interactions.map((it, index) => (
          <div key={it.id} className="space-y-2 rounded-lg border border-line bg-black/30 p-2" data-xr-interaction={it.action}>
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-white/40">{index + 1}. 當</span>
              <select className={`${inputClass} flex-1`} value={it.trigger} aria-label="觸發方式" onChange={(e) => patchInteraction(it.id, { trigger: e.target.value as XrTrigger })}>
                {(Object.keys(XR_TRIGGER_LABELS) as XrTrigger[]).map((t) => (
                  <option key={t} value={t}>
                    {XR_TRIGGER_LABELS[t]}
                  </option>
                ))}
              </select>
              <button type="button" onClick={() => patchObject(selected.id, { interactions: selected.interactions.filter((x) => x.id !== it.id) })} className="flex h-8 w-7 shrink-0 items-center justify-center text-xs text-white/40 hover:text-panic" aria-label="移除互動">
                ✕
              </button>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-white/40">→</span>
              <select className={`${inputClass} flex-1`} value={it.action} aria-label="動作" onChange={(e) => patchInteraction(it.id, { action: e.target.value as XrAction })} data-xr-action>
                {(Object.keys(XR_ACTION_LABELS) as XrAction[]).map((a) => (
                  <option key={a} value={a}>
                    {XR_ACTION_LABELS[a]}
                  </option>
                ))}
              </select>
            </div>
            {it.action === 'audio' && (
              <>
                <select className={inputClass} value={audioAssets.some((m) => m.url === it.url) ? it.url : ''} aria-label="音訊檔" onChange={(e) => patchInteraction(it.id, { url: e.target.value })}>
                  <option value="">{it.url && !audioAssets.some((m) => m.url === it.url) ? '（自訂網址）' : '選擇素材庫的音訊…'}</option>
                  {audioAssets.map((m) => (
                    <option key={m.id} value={m.url}>
                      ♪ {m.name}
                    </option>
                  ))}
                </select>
                <input className={`${inputClass} font-mono`} placeholder="或貼上音訊的 R2 路徑 / 網址" value={it.url} aria-label="音訊網址" spellCheck={false} onChange={(e) => patchInteraction(it.id, { url: e.target.value.trim() })} />
              </>
            )}
            {it.action === 'dialog' && <textarea className={`${inputClass} h-auto py-1.5`} rows={2} placeholder="對話框文字" value={it.text} aria-label="對話框文字" onChange={(e) => patchInteraction(it.id, { text: e.target.value })} />}
            {it.action === 'toggle' && (
              <select className={inputClass} value={it.targetId} aria-label="要顯示 / 隱藏的物件" onChange={(e) => patchInteraction(it.id, { targetId: e.target.value })}>
                <option value="">這個物件自己</option>
                {objects
                  .filter((o) => o.id !== selected.id)
                  .map((o) => (
                    <option key={o.id} value={o.id}>
                      {XR_KIND_ICONS[o.kind]} {o.name}
                    </option>
                  ))}
              </select>
            )}
            {it.action === 'animation' &&
              (selectedClips.length ? (
                <select className={inputClass} value={it.text} aria-label="動畫片段" onChange={(e) => patchInteraction(it.id, { text: e.target.value })}>
                  <option value="">選擇片段…</option>
                  {selectedClips.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              ) : (
                <p className="text-[10px] text-white/35">這個物件沒有動畫片段。</p>
              ))}
            {it.action === 'next_cue' && <p className="text-[10px] leading-relaxed text-standby/80">第一位觸發的觀眾會讓控台自動按下 GO（需有一台控台開著）。任何拿到觀眾網址的人都能觸發，請只用在劇情需要的地方。</p>}
            <label className="flex items-center gap-1.5 text-[10px] text-white/50">
              <input type="checkbox" checked={it.once} onChange={(e) => patchInteraction(it.id, { once: e.target.checked })} />
              每位觀眾只觸發一次
            </label>
          </div>
        ))}
        <button type="button" onClick={() => patchObject(selected.id, { interactions: [...selected.interactions, newXrInteraction()] })} disabled={selected.interactions.length >= XR_MAX_INTERACTIONS} className={`${buttonClass} w-full`} data-xr-add-interaction>
          ＋ 新增互動（當觀眾… → 就…）
        </button>
        <p className="text-[10px] leading-relaxed text-white/35">群組上的互動，點到它底下任何物件都算。除了「執行下一個 Cue」，其餘動作只發生在該觀眾自己的裝置上。</p>
      </Section>
    </>
  )

  const inspector = (
    <div className="space-y-3" data-xr-inspector={selected ? 'object' : 'scene'}>
      {selected ? objectInspector : sceneInspector}
    </div>
  )

  const pickerModal = (
    <InboxPickerModal
      open={picker !== null}
      projectId={projectId}
      projectName={projectName}
      uploads={inbox}
      cues={allCues}
      lockKind={picker ?? undefined}
      onPick={(upload) => picker !== 'model' && setPano(upload.url, upload.publicId.split('/').pop() ?? 'pano', upload.kind === 'video')}
      onPickMedia={pickMedia}
      onClose={() => setPicker(null)}
    />
  )

  // Wide: library + tree on the left, viewport in the middle, inspector on the right (like a 3D authoring tool).
  const wideLayout = (
    <div className="grid h-full min-h-0 grid-cols-1 gap-3 overflow-y-auto lg:grid-cols-[17rem_minmax(0,1fr)_21rem] lg:overflow-hidden" data-xr-editor={workspace ? 'workspace' : 'expanded'}>
      <div className="order-2 space-y-3 lg:order-1 lg:overflow-y-auto lg:pr-1">
        {hierarchy}
        {assets}
      </div>
      <div className="order-1 flex min-h-[55dvh] flex-col lg:order-2 lg:min-h-0">{viewportPane}</div>
      <div className="order-3 lg:overflow-y-auto lg:pr-1">{inspector}</div>
    </div>
  )

  if (workspace)
    return (
      <>
        {wideLayout}
        {pickerModal}
      </>
    )

  if (expanded) {
    // A wide workspace over the whole window (rendered into <body>: the cue editor column is transformed).
    return (
      <>
        <p className="rounded-lg bg-white/[0.03] p-4 text-center text-xs text-white/45">XR 編輯區已放大顯示。</p>
        {createPortal(
          <div className="fixed inset-0 z-40 flex flex-col bg-[#101114] text-white" role="dialog" aria-label="XR 實境編輯區">
            <header className="flex items-center justify-between border-b border-line px-4 py-2.5">
              <span className="text-sm font-semibold">🥽 XR 實境編輯區</span>
              <span className="text-[11px] text-white/40">變更會留在 Cue 草稿，記得回到 Cue 面板按「儲存」</span>
            </header>
            <div className="min-h-0 flex-1 p-3">{wideLayout}</div>
          </div>,
          document.body,
        )}
        {pickerModal}
      </>
    )
  }

  return (
    <div className="space-y-3" data-xr-editor="inline">
      {viewportPane}
      {hierarchy}
      {inspector}
      {assets}
      {pickerModal}
    </div>
  )
}
