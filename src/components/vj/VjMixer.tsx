import type { ReactNode } from 'react'
import type { VjController } from '../../hooks/useVjController'
import { VJ_BLENDS, patchLayer, type VjBlend, type VjMix, type VjSide } from '../../types/vj'
import { VjFxChain } from './VjFxChain'
import { LearnButton, VjParam } from './VjParam'

const SIDES: { id: VjSide; label: string; hint: string }[] = [
  { id: 'A', label: 'A', hint: '接在推桿 A 側' },
  { id: 'thru', label: 'Thru', hint: '不受推桿影響' },
  { id: 'B', label: 'B', hint: '接在推桿 B 側' },
]

/**
 * Three layers (opacity, blend mode, A/B side, effects), the A/B crossfader and the master (level + effects).
 * Used by the live VJ panel (with a controller: layer selection and MIDI Learn) and by the VJ cue editor.
 */
export function VjMixer({
  mix,
  onChange,
  ctl,
  clipControl,
}: {
  mix: VjMix
  onChange: (fn: (m: VjMix) => VjMix) => void
  ctl?: VjController
  /** Replaces the clip label of a layer (the cue editor picks clips from a list). */
  clipControl?: (layer: number) => ReactNode
}) {
  return (
    <div className="space-y-2" data-vj-mixer>
      {mix.layers.map((layer, i) => {
        const selected = ctl?.selectedLayer === i
        return (
          <section key={i} className={`rounded-xl border bg-black/25 p-2.5 ${selected ? 'border-accent/70' : 'border-line'}`} data-vj-layer={i + 1}>
            <div className="mb-1.5 flex items-center gap-2">
              <button
                type="button"
                onClick={() => ctl?.setSelectedLayer(i)}
                disabled={!ctl}
                className={`h-6 shrink-0 rounded-md px-2 text-[11px] font-semibold ${selected ? 'bg-accent text-white' : 'bg-white/[0.08] text-white/70'} ${ctl ? 'hover:bg-accent/70' : ''}`}
                title={ctl ? '選為目標圖層：之後點擊素材格會播在這一層' : undefined}
              >
                Layer {i + 1}
              </button>
              <div className="min-w-0 flex-1 truncate text-xs text-white/80">
                {clipControl ? clipControl(i) : layer.clip ? (layer.clip.name || '（未命名）') : <span className="text-white/30">— 空 —</span>}
              </div>
              {!clipControl && layer.clip && (
                <button type="button" onClick={() => onChange((m) => patchLayer(m, i, { clip: null, startedAt: 0 }))} className="h-6 rounded px-1.5 text-[11px] text-white/40 hover:bg-white/10 hover:text-white" title="清空這一層">
                  清除
                </button>
              )}
              {ctl && <LearnButton target={`layer.${i + 1}.clear`} ctl={ctl} />}
            </div>
            <VjParam
              label="透明度"
              value={layer.opacity}
              display={`${Math.round(layer.opacity * 100)}%`}
              onChange={(v) => onChange((m) => patchLayer(m, i, { opacity: v }))}
              target={ctl ? `layer.${i + 1}.opacity` : undefined}
              ctl={ctl}
              fill="#30d158"
            />
            <div className="mt-1.5 flex items-center gap-2">
              <select
                value={layer.blend}
                onChange={(e) => onChange((m) => patchLayer(m, i, { blend: e.target.value as VjBlend }))}
                className="min-w-0 flex-1 rounded-md border border-line bg-black/40 px-1.5 py-1 text-[11px] text-white outline-none focus:border-accent/80"
                aria-label={`Layer ${i + 1} 混合模式`}
              >
                {VJ_BLENDS.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label}
                  </option>
                ))}
              </select>
              <div className="flex shrink-0 overflow-hidden rounded-md border border-line" role="group" aria-label="推桿側">
                {SIDES.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    title={s.hint}
                    onClick={() => onChange((m) => patchLayer(m, i, { side: s.id }))}
                    className={`px-2 py-1 text-[11px] ${layer.side === s.id ? 'bg-accent text-white' : 'bg-black/30 text-white/50 hover:text-white'}`}
                    aria-pressed={layer.side === s.id}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
            <details className="mt-1.5">
              <summary className="cursor-pointer text-[11px] text-white/50 select-none hover:text-white/80">特效鏈 FX{layer.fx.length ? `（${layer.fx.length}）` : ''}</summary>
              <div className="mt-1.5">
                <VjFxChain mix={mix} scope={i} onChange={onChange} ctl={ctl} />
              </div>
            </details>
          </section>
        )
      })}

      <section className="rounded-xl border border-line bg-black/25 p-2.5" data-vj-master>
        <div className="mb-1 flex items-center justify-between text-[11px] font-semibold text-white/60">
          <span>A</span>
          <span className="tracking-widest text-white/40">CROSSFADER</span>
          <span>B</span>
        </div>
        <VjParam label="推桿" value={mix.crossfader} display={`${Math.round(mix.crossfader * 100)}%`} onChange={(v) => onChange((m) => ({ ...m, crossfader: v }))} target={ctl ? 'crossfader' : undefined} ctl={ctl} fill="#ffd60a" />
        <div className="mt-1.5">
          <VjParam label="Master" value={mix.master} display={`${Math.round(mix.master * 100)}%`} onChange={(v) => onChange((m) => ({ ...m, master: v }))} target={ctl ? 'master' : undefined} ctl={ctl} fill="#f5f5f7" />
        </div>
        <details className="mt-1.5">
          <summary className="cursor-pointer text-[11px] text-white/50 select-none hover:text-white/80">Master 特效鏈{mix.masterFx.length ? `（${mix.masterFx.length}）` : ''}</summary>
          <div className="mt-1.5">
            <VjFxChain mix={mix} scope="master" onChange={onChange} ctl={ctl} />
          </div>
        </details>
      </section>
    </div>
  )
}
