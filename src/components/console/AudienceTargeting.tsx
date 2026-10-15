import { useState } from 'react'
import type { TargetMode } from '../../types/cue'
import { Label, Segmented, fieldClass } from '../ui/controls'

interface AudienceTargetingProps {
  mode: TargetMode
  ids: string[]
  /** Audience codes connected right now. */
  online: string[]
  onChange: (mode: TargetMode, ids: string[]) => void
}

const normalizeCode = (s: string) => s.trim().toUpperCase().replace(/[^0-9A-Z]/g, '')

/** "Broadcast to everyone" vs "send to specific audience codes", with quick picks from who's online. */
export function AudienceTargeting({ mode, ids, online, onChange }: AudienceTargetingProps) {
  const [input, setInput] = useState('')

  const toggle = (id: string) => onChange('selected', ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id])
  const addTyped = () => {
    const codes = input.split(/[\s,，、]+/).map(normalizeCode).filter(Boolean)
    if (codes.length === 0) return
    onChange('selected', [...new Set([...ids, ...codes])])
    setInput('')
  }

  const offlineSelected = ids.filter((id) => !online.includes(id))

  return (
    <div className="space-y-5">
      <div>
        <Label>派發對象</Label>
        <Segmented<TargetMode>
          columns={2}
          value={mode}
          onChange={(m) => onChange(m, ids)}
          options={[
            { id: 'all', label: '📢 廣播給所有人' },
            { id: 'selected', label: '🎯 指定觀眾', description: ids.length ? `${ids.length} 位` : undefined },
          ]}
        />
      </div>

      {mode === 'selected' && (
        <>
          <div>
            <Label hint={`${online.length} 位在線`}>在線觀眾（點選加入）</Label>
            {online.length === 0 ? (
              <p className="rounded-lg bg-white/[0.03] p-3 text-xs text-white/35">
                目前沒有觀眾連線到此版本。觀眾端需「上線」此版本後才會出現。
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {online.map((id) => {
                  const on = ids.includes(id)
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => toggle(id)}
                      className={`min-h-11 min-w-16 rounded-lg border px-3 font-mono text-sm font-semibold tracking-widest transition ${
                        on ? 'border-go bg-go/20 text-go' : 'border-line bg-black/30 text-white/60'
                      }`}
                    >
                      {id}
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          <div>
            <Label>手動輸入識別碼</Label>
            <div className="flex gap-2">
              <input
                className={`${fieldClass} font-mono tracking-widest uppercase`}
                placeholder="例如 K7Q2, M3XA"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addTyped())}
              />
              <button
                type="button"
                onClick={addTyped}
                className="min-h-11 shrink-0 rounded-lg bg-white/[0.08] px-4 text-sm text-white/80 active:bg-white/20"
              >
                加入
              </button>
            </div>
          </div>

          {offlineSelected.length > 0 && (
            <div>
              <Label>已指定（目前離線）</Label>
              <div className="flex flex-wrap gap-2">
                {offlineSelected.map((id) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => toggle(id)}
                    className="min-h-11 rounded-lg border border-dashed border-white/20 px-3 font-mono text-sm tracking-widest text-white/50"
                    title="點擊移除"
                  >
                    {id} ✕
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
