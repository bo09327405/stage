import { useEffect, useMemo, useState } from 'react'
import { autoEnhance, grabVideoFrame, loadImage, removeBackground } from '../../services/imageTools'
import type { StoredFile } from '../../services/storage'
import type { Cue } from '../../types/cue'
import {
  ADJUSTMENT_KEYS,
  BLEND_MODES,
  FX_KEYS,
  LOOKS,
  MASK_LABELS,
  MAX_POLYGON_POINTS,
  NO_ADJUST,
  NO_FX,
  defaultMask,
  hasVisualEdits,
  newLayer,
  newVisual,
  type Adjustments,
  type BaseLayer,
  type BlendMode,
  type CueVisual,
  type LayerMask,
  type MaskType,
  type VisualLayer,
} from '../../types/visual'
import { LayeredStage } from '../audience/LayeredStage'
import { BottomSheet } from '../ui/BottomSheet'
import { MagicEraser } from './MagicEraser'

type Draft = Omit<Cue, 'id'>
type Target = BaseLayer | VisualLayer

/** A labelled, finger-sized slider. Double-tap / double-click resets it. */
function Slider({ label, value, min, max, step = 1, reset = 0, unit = '', onChange }: { label: string; value: number; min: number; max: number; step?: number; reset?: number; unit?: string; onChange: (v: number) => void }) {
  return (
    <label className="block" onDoubleClick={() => onChange(reset)}>
      <span className="flex items-baseline justify-between text-[11px] text-white/50">
        <span>{label}</span>
        <span className="font-mono tabular text-white/70">
          {Number.isInteger(value) ? value : value.toFixed(2)}
          {unit}
        </span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="h-9 w-full accent-[#0a84ff]" />
    </label>
  )
}

const row = 'flex min-h-11 items-center gap-1.5 rounded-xl border px-2 text-sm'

/**
 * The visual editor of an image / video cue: live GPU preview, layer panel (order, visibility, lock, opacity, blend
 * mode), masks, AI cut-out, Magic Eraser, colour grading, one-tap looks and stage effects. Nothing here modifies the
 * media: every setting is stored in the cue (Cue.visual), cut-outs and erased pictures are saved as new files.
 */
export function VisualEditor({ draft, onChange, saveFile }: { draft: Draft; onChange: (visual: CueVisual | null) => void; saveFile: (file: File) => Promise<StoredFile> }) {
  const visual = useMemo(() => draft.visual ?? newVisual(), [draft.visual])
  const [selected, setSelected] = useState<'base' | string>('base')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [eraser, setEraser] = useState(false)
  const [heal, setHeal] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [showGlobal, setShowGlobal] = useState(false)

  // Back to "no visual settings" when nothing is changed any more.
  const commit = (next: CueVisual) => onChange(next.layers.length > 0 || Boolean(hasVisualEdits(next)) ? next : null)
  const layer = selected === 'base' ? null : (visual.layers.find((l) => l.id === selected) ?? null)
  const target: Target = layer ?? visual.base
  const locked = target.locked
  const isBase = selected === 'base' || !layer
  const isVideo = isBase ? draft.type === 'VIDEO' && !visual.base.src : layer?.kind === 'media' && layer.mediaKind === 'video'
  const targetSrc = isBase ? visual.base.src || draft.targetUrl : (layer?.src ?? '')

  const patchTarget = (changes: Partial<VisualLayer>) => {
    if (selected === 'base' || !layer) commit({ ...visual, base: { ...visual.base, ...(changes as Partial<BaseLayer>) } })
    else commit({ ...visual, layers: visual.layers.map((l) => (l.id === layer.id ? { ...l, ...changes } : l)) })
  }
  const patchAdjust = (key: keyof Adjustments, v: number) => patchTarget({ adjust: { ...target.adjust, [key]: v } })
  const patchMask = (changes: Partial<LayerMask>) => target.mask && patchTarget({ mask: { ...target.mask, ...changes } })

  const move = (id: string, delta: 1 | -1) => {
    const i = visual.layers.findIndex((l) => l.id === id)
    const j = i + delta
    if (i < 0 || j < 0 || j >= visual.layers.length) return
    const layers = [...visual.layers]
    ;[layers[i], layers[j]] = [layers[j], layers[i]]
    commit({ ...visual, layers })
  }

  const run = async (name: string, job: () => Promise<void>) => {
    setBusy(name)
    setError(null)
    try {
      await job()
      navigator.vibrate?.(15)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  // A new picture replaces the target's source; the first untouched one is kept for "restore".
  const replaceSource = (url: string) => {
    const original = (isBase ? visual.base.originalSrc : (layer?.originalSrc ?? '')) || targetSrc
    patchTarget({ src: url, originalSrc: original })
  }

  const addMedia = (file: File | undefined) =>
    file &&
    run('add', async () => {
      const result = await saveFile(file)
      const l = newLayer('media', { name: file.name.replace(/\.[^.]+$/, '').slice(0, 24) || '圖層', src: result.secure_url, mediaKind: file.type.startsWith('video/') ? 'video' : 'image' })
      commit({ ...visual, layers: [...visual.layers, l] })
      setSelected(l.id)
    })

  const cutout = () =>
    run('cutout', async () => {
      if (!targetSrc) throw new Error('這一層沒有圖片')
      const png = await removeBackground(await loadImage(targetSrc))
      const result = await saveFile(new File([png], `cutout-${Date.now().toString(36)}.png`, { type: 'image/png' }))
      replaceSource(result.secure_url)
    })

  // Auto Enhance measures the picture — for a video, a frame from its middle.
  const enhance = () =>
    run('enhance', async () => {
      patchTarget({ adjust: autoEnhance(isVideo ? (await grabVideoFrame(targetSrc, undefined, 160)).canvas : await loadImage(targetSrc)) })
    })

  return (
    <div className="space-y-4" data-visual-editor>
      <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-line bg-black">
        <LayeredStage cue={draft as unknown as Cue} visual={visual} mode="editor" onError={setPreviewError} />
        {previewError && <div className="absolute inset-x-3 bottom-3 rounded-lg bg-black/80 p-2 text-center text-xs text-standby" data-preview-error>預覽無法顯示：{previewError}</div>}
        {busy && <div className="absolute inset-0 flex items-center justify-center bg-black/60 text-sm text-white/80">{{ add: '上傳中…', cutout: 'AI 去背中…（第一次需下載模型）', enhance: '分析畫面…' }[busy] ?? '處理中…'}</div>}
      </div>
      <p className="text-[11px] leading-relaxed text-white/35">所有設定只記錄在 Cue 裡，原始檔案不會被修改；GPU 即時繪製，舞台預覽與觀眾端畫面一致。</p>

      {/* Looks */}
      <div>
        <div className="mb-1.5 text-[11px] font-semibold tracking-widest text-white/50 uppercase">一鍵風格</div>
        <div className="flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <button type="button" onClick={() => void enhance()} disabled={!!busy || !targetSrc} className="min-h-11 shrink-0 rounded-full bg-accent px-4 text-xs font-bold text-white disabled:opacity-40" data-auto-enhance>
            ✨ 智慧平衡
          </button>
          {LOOKS.map((l) => (
            <button
              key={l.id}
              type="button"
              onClick={() => commit({ ...visual, adjust: { ...NO_ADJUST, ...l.adjust }, fx: { ...NO_FX, ...l.fx } })}
              className="min-h-11 shrink-0 rounded-full border border-white/15 bg-white/[0.05] px-4 text-xs font-semibold whitespace-nowrap text-white/75 active:bg-white/15"
              data-look={l.id}
            >
              {l.label}
            </button>
          ))}
          <button type="button" onClick={() => commit({ ...visual, adjust: { ...NO_ADJUST }, fx: { ...NO_FX } })} className="min-h-11 shrink-0 rounded-full bg-white/10 px-4 text-xs text-white/60">
            ↺ 重設風格
          </button>
        </div>
      </div>

      {/* Layers: top of the list = top of the picture */}
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[11px] font-semibold tracking-widest text-white/50 uppercase">圖層 Layers</span>
          <span className="text-[11px] text-white/30">上層在上</span>
        </div>
        <ul className="space-y-1" data-layer-list>
          {[...visual.layers].reverse().map((l) => (
            <li key={l.id} className={`${row} ${selected === l.id ? 'border-accent bg-accent/10' : 'border-line bg-white/[0.03]'}`} data-layer={l.id}>
              <button type="button" aria-label={l.visible ? '隱藏圖層' : '顯示圖層'} onClick={() => commit({ ...visual, layers: visual.layers.map((x) => (x.id === l.id ? { ...x, visible: !x.visible } : x)) })} className="h-10 w-9 shrink-0 text-base">
                {l.visible ? '👁' : '◌'}
              </button>
              <button type="button" aria-label={l.locked ? '解除鎖定' : '鎖定'} onClick={() => commit({ ...visual, layers: visual.layers.map((x) => (x.id === l.id ? { ...x, locked: !x.locked } : x)) })} className="h-10 w-9 shrink-0 text-sm">
                {l.locked ? '🔒' : '🔓'}
              </button>
              <button type="button" onClick={() => setSelected(l.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                {l.kind === 'color' ? <span className="h-6 w-6 shrink-0 rounded border border-white/20" style={{ background: l.color }} /> : <span className="shrink-0 text-xs">{l.mediaKind === 'video' ? '🎬' : '🖼'}</span>}
                <span className={`truncate ${l.visible ? 'text-white' : 'text-white/35'}`}>{l.name}</span>
                {l.mask && <span className="shrink-0 rounded bg-white/10 px-1 text-[9px] text-white/60">遮罩</span>}
              </button>
              <button type="button" aria-label="上移" onClick={() => move(l.id, 1)} className="h-10 w-9 shrink-0 text-white/60">
                ▲
              </button>
              <button type="button" aria-label="下移" onClick={() => move(l.id, -1)} className="h-10 w-9 shrink-0 text-white/60">
                ▼
              </button>
              <button
                type="button"
                aria-label="刪除圖層"
                disabled={l.locked}
                onClick={() => {
                  commit({ ...visual, layers: visual.layers.filter((x) => x.id !== l.id) })
                  if (selected === l.id) setSelected('base')
                }}
                className="h-10 w-9 shrink-0 text-panic disabled:opacity-30"
              >
                🗑
              </button>
            </li>
          ))}
          <li className={`${row} ${selected === 'base' ? 'border-accent bg-accent/10' : 'border-line bg-white/[0.03]'}`} data-layer="base">
            <button type="button" aria-label="顯示或隱藏背景" onClick={() => commit({ ...visual, base: { ...visual.base, visible: !visual.base.visible } })} className="h-10 w-9 shrink-0 text-base">
              {visual.base.visible ? '👁' : '◌'}
            </button>
            <button type="button" aria-label="鎖定" onClick={() => commit({ ...visual, base: { ...visual.base, locked: !visual.base.locked } })} className="h-10 w-9 shrink-0 text-sm">
              {visual.base.locked ? '🔒' : '🔓'}
            </button>
            <button type="button" onClick={() => setSelected('base')} className="flex min-w-0 flex-1 items-center gap-2 text-left">
              <span className="shrink-0 text-xs">{draft.type === 'VIDEO' ? '🎬' : '🖼'}</span>
              <span className="truncate text-white">背景（Cue 媒體）</span>
            </button>
          </li>
        </ul>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <label className="flex min-h-11 cursor-pointer items-center justify-center rounded-xl border border-dashed border-white/25 text-xs font-medium text-white/75 active:bg-white/10">
            ＋ 圖片／影片圖層
            <input type="file" accept="image/*,video/*" className="hidden" onChange={(e) => { void addMedia(e.target.files?.[0]); e.target.value = '' }} data-add-layer-file />
          </label>
          <button
            type="button"
            onClick={() => {
              const l = newLayer('color', { name: '純色層', color: '#000000', opacity: 0.5 })
              commit({ ...visual, layers: [...visual.layers, l] })
              setSelected(l.id)
            }}
            className="min-h-11 rounded-xl border border-dashed border-white/25 text-xs font-medium text-white/75 active:bg-white/10"
            data-add-color-layer
          >
            ＋ 純色層（疊色／暗角）
          </button>
        </div>
      </div>

      {/* Properties of the selected layer */}
      <div className="space-y-3 rounded-xl border border-line bg-white/[0.03] p-3" data-layer-props>
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold tracking-widest text-white/50 uppercase">屬性</span>
          {layer && !locked && (
            <input value={layer.name} onChange={(e) => patchTarget({ name: e.target.value })} className="min-h-9 min-w-0 flex-1 rounded-lg border border-line bg-black/30 px-2 text-sm text-white" aria-label="圖層名稱" />
          )}
          {!layer && <span className="text-sm text-white/70">背景（Cue 媒體）</span>}
          {locked && <span className="ml-auto text-xs text-standby">🔒 已鎖定</span>}
        </div>
        <fieldset disabled={locked} className="space-y-3 disabled:opacity-50">
          {layer?.kind === 'color' && (
            <label className="flex items-center gap-3 text-xs text-white/55">
              顏色
              <input type="color" value={layer.color} onChange={(e) => patchTarget({ color: e.target.value })} className="h-10 w-14 rounded border border-line bg-transparent" />
            </label>
          )}
          <Slider label="透明度 Opacity" value={Math.round(target.opacity * 100)} min={0} max={100} reset={100} unit="%" onChange={(v) => patchTarget({ opacity: v / 100 })} />
          <label className="block">
            <span className="mb-1 block text-[11px] text-white/50">混合模式 Blend</span>
            <select value={target.blend} onChange={(e) => patchTarget({ blend: e.target.value as BlendMode })} className="min-h-11 w-full rounded-lg border border-line bg-black/30 px-2 text-xs text-white" data-blend>
              {BLEND_MODES.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label}
                </option>
              ))}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-x-4">
            <Slider label="水平位置 X" value={Math.round(target.x * 100)} min={-50} max={150} reset={50} unit="%" onChange={(v) => patchTarget({ x: v / 100 })} />
            <Slider label="垂直位置 Y" value={Math.round(target.y * 100)} min={-50} max={150} reset={50} unit="%" onChange={(v) => patchTarget({ y: v / 100 })} />
            <Slider label="縮放 Scale" value={Math.round(target.scale * 100)} min={10} max={400} reset={100} unit="%" onChange={(v) => patchTarget({ scale: v / 100 })} />
            <Slider label="旋轉 Rotate" value={Math.round(target.rotation)} min={-180} max={180} reset={0} unit="°" onChange={(v) => patchTarget({ rotation: v })} />
          </div>

          {/* Mask */}
          <div className="space-y-2" data-mask-editor>
            <div className="text-[11px] font-semibold tracking-widest text-white/50 uppercase">遮罩 Mask</div>
            <div className="flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <button type="button" onClick={() => patchTarget({ mask: null })} className={`min-h-10 shrink-0 rounded-full border px-3 text-xs font-semibold ${!target.mask ? 'border-white bg-white text-black' : 'border-white/15 text-white/65'}`}>
                無
              </button>
              {(Object.keys(MASK_LABELS) as MaskType[]).map((t) => (
                <button key={t} type="button" onClick={() => patchTarget({ mask: target.mask?.type === t ? target.mask : defaultMask(t) })} className={`min-h-10 shrink-0 rounded-full border px-3 text-xs font-semibold whitespace-nowrap ${target.mask?.type === t ? 'border-accent bg-accent text-white' : 'border-white/15 text-white/65'}`} data-mask-type={t}>
                  {MASK_LABELS[t]}
                </button>
              ))}
            </div>
            {target.mask && (
              <div className="space-y-1">
                <button type="button" onClick={() => patchMask({ invert: !target.mask!.invert })} aria-pressed={target.mask.invert} className={`min-h-10 w-full rounded-lg border text-xs font-semibold ${target.mask.invert ? 'border-standby bg-standby/15 text-standby' : 'border-line text-white/60'}`} data-mask-invert>
                  ⇄ 反轉遮罩 {target.mask.invert ? '（已反轉）' : ''}
                </button>
                <Slider label="羽化邊緣 Feather" value={Math.round(target.mask.feather)} min={0} max={100} reset={10} onChange={(v) => patchMask({ feather: v })} />
                {(target.mask.type === 'rect' || target.mask.type === 'ellipse') && (
                  <div className="grid grid-cols-2 gap-x-4">
                    <Slider label="中心 X" value={Math.round(target.mask.x * 100)} min={0} max={100} reset={50} unit="%" onChange={(v) => patchMask({ x: v / 100 })} />
                    <Slider label="中心 Y" value={Math.round(target.mask.y * 100)} min={0} max={100} reset={50} unit="%" onChange={(v) => patchMask({ y: v / 100 })} />
                    <Slider label="寬度" value={Math.round(target.mask.w * 100)} min={1} max={200} reset={70} unit="%" onChange={(v) => patchMask({ w: v / 100 })} />
                    <Slider label="高度" value={Math.round(target.mask.h * 100)} min={1} max={200} reset={70} unit="%" onChange={(v) => patchMask({ h: v / 100 })} />
                  </div>
                )}
                {target.mask.type === 'radial' && (
                  <div className="grid grid-cols-2 gap-x-4">
                    <Slider label="中心 X" value={Math.round(target.mask.x * 100)} min={0} max={100} reset={50} unit="%" onChange={(v) => patchMask({ x: v / 100 })} />
                    <Slider label="中心 Y" value={Math.round(target.mask.y * 100)} min={0} max={100} reset={50} unit="%" onChange={(v) => patchMask({ y: v / 100 })} />
                    <Slider label="半徑" value={Math.round(target.mask.radius * 100)} min={1} max={150} reset={40} unit="%" onChange={(v) => patchMask({ radius: v / 100 })} />
                  </div>
                )}
                {target.mask.type === 'linear' && (
                  <div className="grid grid-cols-2 gap-x-4">
                    <Slider label="方向" value={Math.round(target.mask.angle)} min={-180} max={180} reset={90} unit="°" onChange={(v) => patchMask({ angle: v })} />
                    <Slider label="位置" value={Math.round(target.mask.position * 100)} min={0} max={100} reset={50} unit="%" onChange={(v) => patchMask({ position: v / 100 })} />
                  </div>
                )}
                {target.mask.type === 'polygon' && (
                  <div className="space-y-1">
                    {target.mask.points.map((p, i) => (
                      <div key={i} className="grid grid-cols-[auto_1fr_1fr_auto] items-end gap-x-3">
                        <span className="pb-2 font-mono text-xs text-white/40">{i + 1}</span>
                        <Slider label="X" value={Math.round(p[0] * 100)} min={0} max={100} reset={50} unit="%" onChange={(v) => patchMask({ points: target.mask!.points.map((q, j) => (j === i ? [v / 100, q[1]] : q)) as [number, number][] })} />
                        <Slider label="Y" value={Math.round(p[1] * 100)} min={0} max={100} reset={50} unit="%" onChange={(v) => patchMask({ points: target.mask!.points.map((q, j) => (j === i ? [q[0], v / 100] : q)) as [number, number][] })} />
                        <button type="button" disabled={target.mask!.points.length <= 3} onClick={() => patchMask({ points: target.mask!.points.filter((_, j) => j !== i) })} className="h-9 w-9 text-panic disabled:opacity-30" aria-label="刪除頂點">
                          ✕
                        </button>
                      </div>
                    ))}
                    <button type="button" disabled={target.mask.points.length >= MAX_POLYGON_POINTS} onClick={() => patchMask({ points: [...target.mask!.points, [0.5, 0.5]] })} className="min-h-10 w-full rounded-lg bg-white/[0.06] text-xs text-white/70 disabled:opacity-40">
                      ＋ 新增頂點（最多 {MAX_POLYGON_POINTS} 個）
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Colour of this layer */}
          <details className="rounded-lg bg-black/20">
            <summary className="flex min-h-11 cursor-pointer items-center px-3 text-xs font-medium text-white/65">🎨 這一層的調色</summary>
            <div className="space-y-1 px-3 pb-3">
              {ADJUSTMENT_KEYS.map((a) => (
                <Slider key={a.key} label={a.label} value={target.adjust[a.key]} min={-100} max={100} onChange={(v) => patchAdjust(a.key, v)} />
              ))}
            </div>
          </details>

          {/* AI / retouch tools */}
          {isVideo ? (
            <div className="space-y-2" data-video-tools>
              <button
                type="button"
                onClick={() => patchTarget({ cutout: !target.cutout })}
                aria-pressed={target.cutout}
                className={`flex min-h-12 w-full items-center justify-between rounded-xl border px-3 text-left text-sm font-semibold ${target.cutout ? 'border-accent bg-accent/15 text-white' : 'border-line text-white/70'}`}
                data-video-cutout
              >
                <span>✂ 即時 AI 去背（人像）</span>
                <span className="text-xs">{target.cutout ? '開啟' : '關閉'}</span>
              </button>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" disabled={!!busy || !targetSrc} onClick={() => setHeal(true)} className="min-h-11 rounded-xl bg-accent/20 text-xs font-semibold text-[#64a8ff] disabled:opacity-40" data-open-heal>
                  🧽 區域修補{target.heal ? '（已設定）' : ''}
                </button>
                <button type="button" disabled={!target.heal} onClick={() => patchTarget({ heal: '' })} className="min-h-11 rounded-xl bg-white/[0.06] text-xs text-white/70 disabled:opacity-40">
                  清除修補
                </button>
              </div>
              <p className="text-[11px] leading-relaxed text-white/35">影片的去背與修補是播放時在每台裝置上即時運算（人像去背每秒約 20 次、手機較耗電）；影片檔不會被修改。修補只適合固定位置的小範圍，例如標誌或電線。</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <button type="button" disabled={!!busy || !targetSrc} onClick={() => void cutout()} className="min-h-11 rounded-xl bg-accent/20 text-xs font-semibold text-[#64a8ff] disabled:opacity-40" data-ai-cutout>
                ✂ AI 魔法去背
              </button>
              <button type="button" disabled={!!busy || !targetSrc} onClick={() => setEraser(true)} className="min-h-11 rounded-xl bg-accent/20 text-xs font-semibold text-[#64a8ff] disabled:opacity-40" data-open-eraser>
                🧽 魔法橡皮擦
              </button>
            </div>
          )}
          {(isBase ? visual.base.originalSrc : layer?.originalSrc) && (
            <button type="button" onClick={() => patchTarget({ src: isBase ? '' : (layer?.originalSrc ?? ''), originalSrc: '' })} className="min-h-10 w-full rounded-lg bg-white/10 text-xs font-semibold text-white/75" data-restore-original>
              ↩ 還原成原圖（取消去背／擦除）
            </button>
          )}
          {layer?.kind === 'media' && (
            <div className="grid grid-cols-1 gap-2">
              <button type="button" onClick={() => void enhance()} disabled={!!busy} className="min-h-10 rounded-lg bg-white/[0.06] text-xs text-white/70 disabled:opacity-40">
                ✨ 這一層：智慧平衡
              </button>
            </div>
          )}
        </fieldset>
      </div>

      {/* Whole picture */}
      <div className="rounded-xl border border-line bg-white/[0.03]">
        <button type="button" onClick={() => setShowGlobal(!showGlobal)} aria-expanded={showGlobal} className="flex min-h-12 w-full items-center justify-between px-3 text-sm font-semibold text-white/80">
          <span>🎛 整體調色與舞台特效</span>
          <span className="text-xs text-white/40">{showGlobal ? '收合' : '展開'}</span>
        </button>
        {showGlobal && (
          <div className="space-y-1 border-t border-line px-3 py-3" data-global-grade>
            {ADJUSTMENT_KEYS.map((a) => (
              <Slider key={a.key} label={a.label} value={visual.adjust[a.key]} min={-100} max={100} onChange={(v) => commit({ ...visual, adjust: { ...visual.adjust, [a.key]: v } })} />
            ))}
            <div className="pt-2 text-[11px] font-semibold tracking-widest text-white/50 uppercase">特效 FX</div>
            {FX_KEYS.map((f) => (
              <Slider key={f.key} label={f.label} value={visual.fx[f.key]} min={0} max={100} onChange={(v) => commit({ ...visual, fx: { ...visual.fx, [f.key]: v } })} />
            ))}
          </div>
        )}
      </div>

      {error && <p className="text-xs leading-relaxed text-panic">{error}</p>}
      {draft.visual && (
        <button type="button" onClick={() => onChange(null)} className="min-h-11 w-full rounded-xl bg-panic/15 text-sm font-semibold text-panic" data-visual-reset>
          重設全部視覺設定
        </button>
      )}

      <BottomSheet open={heal} onClose={() => setHeal(false)} title="🧽 影片區域修補" subtitle="在一格畫面上塗出要消除的固定位置">
        {heal && targetSrc && (
          <VideoHeal
            src={targetSrc}
            onClose={() => setHeal(false)}
            onDone={async (png) => {
              const result = await saveFile(new File([png], `heal-${Date.now().toString(36)}.png`, { type: 'image/png' }))
              patchTarget({ heal: result.secure_url })
            }}
          />
        )}
      </BottomSheet>
      <BottomSheet open={eraser} onClose={() => setEraser(false)} title="🧽 魔法橡皮擦" subtitle="塗抹要移除的東西">
        {eraser && targetSrc && (
          <MagicEraser
            src={targetSrc}
            onClose={() => setEraser(false)}
            onDone={async (png) => {
              const result = await saveFile(new File([png], `erased-${Date.now().toString(36)}.png`, { type: 'image/png' }))
              replaceSource(result.secure_url)
            }}
          />
        )}
      </BottomSheet>
    </div>
  )
}

/** Pick a frame of the video, then paint the fixed spot to fill in (stored as a mask picture). */
function VideoHeal({ src, onDone, onClose }: { src: string; onDone: (png: Blob) => Promise<void>; onClose: () => void }) {
  const [frame, setFrame] = useState<string | null>(null)
  const [duration, setDuration] = useState(0)
  const [time, setTime] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setFrame(null)
    grabVideoFrame(src, time ?? undefined)
      .then(({ canvas, duration: d }) => {
        if (!alive) return
        setDuration(d)
        setFrame(canvas.toDataURL('image/jpeg', 0.92))
      })
      .catch((err: Error) => alive && setError(err.message))
    return () => {
      alive = false
    }
  }, [src, time])

  if (error) return <p className="text-xs text-panic">{error}</p>
  return (
    <div className="space-y-3">
      {duration > 0 && (
        <label className="flex items-center gap-3 text-xs text-white/55">
          畫面時間
          <input type="range" min={0} max={Math.max(0.1, duration)} step={0.1} defaultValue={duration / 2} onPointerUp={(e) => setTime(Number((e.target as HTMLInputElement).value))} onKeyUp={(e) => setTime(Number((e.target as HTMLInputElement).value))} className="h-8 flex-1 accent-[#0a84ff]" />
        </label>
      )}
      {frame ? <MagicEraser key={frame} src={frame} mode="mask" onDone={onDone} onClose={onClose} /> : <p className="py-8 text-center text-sm text-white/45">讀取影片畫面中…</p>}
    </div>
  )
}
