import { useState } from 'react'
import type { VjController } from '../../hooks/useVjController'
import { VJ_FX, addFx, fxDef, fxList, fxParamValue, moveFx, patchFx, removeFx, type VjFxScope, type VjFxType, type VjMix } from '../../types/vj'
import { LearnButton, VjParam } from './VjParam'

/** An effect chain (per layer or master): add, reorder, switch off, remove, and ride every parameter live. */
export function VjFxChain({
  mix,
  scope,
  onChange,
  ctl,
}: {
  mix: VjMix
  scope: VjFxScope
  onChange: (fn: (m: VjMix) => VjMix) => void
  /** The live panel passes its controller so parameters can be MIDI-mapped. */
  ctl?: VjController
}) {
  const list = fxList(mix, scope)
  const [adding, setAdding] = useState(false)
  return (
    <div className="space-y-1.5" data-vj-fx-chain={scope}>
      {list.map((fx, i) => {
        const def = fxDef(fx.type)
        return (
          <div key={fx.id} className={`rounded-lg border bg-black/30 p-2 ${fx.enabled ? 'border-line' : 'border-line opacity-55'}`} data-vj-fx={fx.type}>
            <div className="mb-1 flex items-center gap-1">
              <button
                type="button"
                onClick={() => onChange((m) => patchFx(m, scope, fx.id, { enabled: !fx.enabled }))}
                className={`h-5 w-5 shrink-0 rounded-full border text-[9px] ${fx.enabled ? 'border-go bg-go/30 text-go' : 'border-white/25 text-white/30'}`}
                title={fx.enabled ? '關閉此特效' : '開啟此特效'}
                aria-pressed={fx.enabled}
              >
                {fx.enabled ? '●' : '○'}
              </button>
              <span className="min-w-0 flex-1 truncate text-xs font-medium">{def.label}</span>
              {ctl && <LearnButton target={`fx.${fx.id}.enabled`} ctl={ctl} />}
              <button type="button" disabled={i === 0} onClick={() => onChange((m) => moveFx(m, scope, fx.id, -1))} className="h-6 w-6 rounded text-xs text-white/40 hover:bg-white/10 disabled:opacity-20" title="往前（先套用）">
                ↑
              </button>
              <button type="button" disabled={i === list.length - 1} onClick={() => onChange((m) => moveFx(m, scope, fx.id, 1))} className="h-6 w-6 rounded text-xs text-white/40 hover:bg-white/10 disabled:opacity-20" title="往後">
                ↓
              </button>
              <button type="button" onClick={() => onChange((m) => removeFx(m, scope, fx.id))} className="h-6 w-6 rounded text-xs text-white/40 hover:bg-white/10 hover:text-panic" title="移除特效">
                ✕
              </button>
            </div>
            <div className="space-y-1">
              {def.params.map((p) => {
                const v = fx.params[p.key] ?? p.default
                const shown = fxParamValue(p, v)
                return (
                  <VjParam
                    key={p.key}
                    label={p.label}
                    value={v}
                    display={`${Number.isInteger(shown) ? shown : shown.toFixed(1)}${p.unit ?? ''}`}
                    onChange={(n) => onChange((m) => patchFx(m, scope, fx.id, { params: { [p.key]: p.step ? Math.round(n * ((p.max - p.min) / p.step)) / ((p.max - p.min) / p.step) : n } }))}
                    target={ctl ? `fx.${fx.id}.${p.key}` : undefined}
                    ctl={ctl}
                    fill="#0a84ff"
                  />
                )
              })}
            </div>
          </div>
        )
      })}
      {adding ? (
        <div className="grid grid-cols-2 gap-1">
          {VJ_FX.map((f) => (
            <button
              key={f.type}
              type="button"
              onClick={() => {
                onChange((m) => addFx(m, scope, f.type as VjFxType))
                setAdding(false)
              }}
              className="rounded-md bg-white/[0.06] px-2 py-1.5 text-left text-[11px] text-white/80 hover:bg-accent hover:text-white"
            >
              {f.label}
            </button>
          ))}
        </div>
      ) : (
        <button type="button" onClick={() => setAdding(true)} className="w-full rounded-md border border-dashed border-white/15 py-1 text-[11px] text-white/45 hover:border-accent/60 hover:text-white">
          ＋ 加入特效
        </button>
      )}
    </div>
  )
}
