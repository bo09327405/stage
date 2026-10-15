import { motion } from 'motion/react'
import { AFTER_START_TEMPLATES, applyTemplate, detectTemplate } from '../../types/afterStart'
import { cueRunLength, fadeOutStartsAt, type Cue, type FollowMode } from '../../types/cue'
import { formatPrecise } from '../../hooks/useServerNow'
import { Label, NumberField, Segmented, Toggle } from '../ui/controls'

type Draft = Omit<Cue, 'id'>
type FlowChanges = Partial<Draft>

type LoopMode = 'off' | 'infinite' | 'fixed'

/** "After this cue starts": six Go Button templates plus the advanced flow parameters. */
export function AfterStartPanel({ draft, media, onChange }: { draft: Draft; media: boolean; onChange: (changes: FlowChanges) => void }) {
  const current = detectTemplate(draft)
  const length = cueRunLength(draft as Cue)
  const fadeStart = fadeOutStartsAt(draft as Cue)
  const loopMode: LoopMode = !draft.loop ? 'off' : draft.loopCount > 0 ? 'fixed' : 'infinite'

  // When (seconds after this cue starts) the next cue is GO'd automatically.
  const nextAt =
    draft.followMode === 'autoContinue'
      ? draft.postWaitTime
      : draft.followMode === 'autoFollow' && Number.isFinite(fadeStart)
        ? fadeStart + draft.postWaitTime
        : null

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <div className="flex items-baseline justify-between">
          <h3 className="text-xs font-semibold tracking-wider text-white/60">AFTER THIS CUE STARTS</h3>
          <span className="text-[11px] text-white/35">{current ? '範本' : '自訂組合'}</span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {AFTER_START_TEMPLATES.map((t) => {
            const active = current === t.id
            return (
              <motion.button
                key={t.id}
                type="button"
                whileTap={{ scale: 0.97 }}
                onClick={() => onChange(applyTemplate(t.id, draft))}
                className={`relative min-h-20 overflow-hidden rounded-xl border p-3 text-left transition pointer-coarse:min-h-24 ${
                  active ? 'border-go bg-go/[0.12]' : 'border-line bg-black/30 hover:border-white/25'
                }`}
              >
                {active && (
                  <motion.span layoutId="after-start-active" className="absolute inset-0 rounded-xl ring-1 ring-go/70" />
                )}
                <span className="relative block text-base leading-none">{t.icon}</span>
                <span className={`relative mt-1.5 block text-xs font-semibold ${active ? 'text-go' : 'text-white'}`}>{t.title}</span>
                <span className="relative mt-0.5 block text-[10px] leading-snug text-white/45">{t.description}</span>
              </motion.button>
            )
          })}
        </div>
      </section>

      <FlowTimeline draft={draft} length={length} fadeStart={fadeStart} nextAt={nextAt} />

      <section className="space-y-4">
        <h3 className="text-xs font-semibold tracking-wider text-white/60">進階參數</h3>

        {media && (
          <div className="space-y-3">
            <div>
              <Label>Loop</Label>
              <Segmented<LoopMode>
                value={loopMode}
                onChange={(m) =>
                  onChange(
                    m === 'off'
                      ? { loop: false, loopCount: 0, fadeOnNextGo: false }
                      : m === 'infinite'
                        ? { loop: true, loopCount: 0 }
                        : { loop: true, loopCount: Math.max(2, draft.loopCount) },
                  )
                }
                options={[
                  { id: 'off', label: 'OFF' },
                  { id: 'infinite', label: 'ON ∞' },
                  { id: 'fixed', label: 'FIXED', description: '指定次數' },
                ]}
              />
            </div>
            {loopMode === 'fixed' && (
              <NumberField
                label="播放次數"
                suffix="次"
                step={1}
                stepperStep={1}
                min={1}
                value={draft.loopCount}
                onChange={(v) => onChange({ loopCount: Math.max(1, Math.round(v)) })}
              />
            )}
          </div>
        )}

        <NumberField
          label="Fade Out Time"
          hint={formatPrecise(draft.fadeOutTime)}
          step={0.001}
          value={draft.fadeOutTime}
          onChange={(v) => onChange({ fadeOutTime: Math.round(v * 1000) / 1000 })}
        />

        <NumberField
          label="自動淡出時間點"
          hint={draft.autoStopAfter > 0 ? `${formatPrecise(draft.autoStopAfter)} 開始淡出` : '0 = 於結尾前淡出'}
          step={0.001}
          value={draft.autoStopAfter}
          onChange={(v) => onChange({ autoStopAfter: Math.round(v * 1000) / 1000 })}
        />

        <Toggle
          label="下一次 GO 時淡出"
          description="其他 Cue 被 GO 時，此 Cue 以 Fade Out Time 淡出（循環背景音常用）"
          checked={draft.fadeOnNextGo}
          onChange={(v) => onChange({ fadeOnNextGo: v })}
        />

        <div>
          <Label>Auto-follow</Label>
          <Segmented<FollowMode>
            value={draft.followMode}
            onChange={(m) => onChange({ followMode: m })}
            options={[
              { id: 'none', label: '關閉', description: '等待手動 GO' },
              { id: 'autoContinue', label: '開始後', description: '自此 Cue 開始計時' },
              { id: 'autoFollow', label: '淡出時', description: '自淡出開始計時' },
            ]}
          />
        </div>
        {draft.followMode !== 'none' && (
          <NumberField
            label="Post Wait Time"
            hint={formatPrecise(draft.postWaitTime)}
            step={0.001}
            value={draft.postWaitTime}
            onChange={(v) => onChange({ postWaitTime: Math.round(v * 1000) / 1000 })}
          />
        )}
        {draft.followMode === 'autoFollow' && !Number.isFinite(fadeStart) && (
          <p className="rounded-lg bg-standby/10 p-3 text-xs text-standby">
            此 Cue 會一直播放（無限循環或沒有固定長度），永遠不會開始淡出，因此不會自動接續。請設定「自動淡出時間點」或改用循環範本。
          </p>
        )}

        <NumberField
          label="Prevent GO"
          hint="觸發後鎖定 GO 的秒數，防止連按"
          value={draft.preventGoDuration}
          onChange={(v) => onChange({ preventGoDuration: v })}
        />

        <dl className="grid grid-cols-2 gap-2 text-xs">
          <div className="rounded-lg bg-white/[0.03] px-3 py-2.5">
            <dt className="text-white/40">總執行長度</dt>
            <dd className="font-mono text-white/85 tabular">{formatPrecise(length)}</dd>
          </div>
          <div className="rounded-lg bg-white/[0.03] px-3 py-2.5">
            <dt className="text-white/40">下一個 Cue</dt>
            <dd className="font-mono text-white/85 tabular">
              {nextAt != null ? `+${formatPrecise(nextAt)}` : draft.fadeOnNextGo ? '手動 GO 時' : '手動 GO'}
            </dd>
          </div>
        </dl>
      </section>
    </div>
  )
}

/**
 * Two-lane timeline: this cue (with its fade-out ramp, or a loop that runs until the next GO)
 * and where the next cue starts.
 */
function FlowTimeline({ draft, length, fadeStart, nextAt }: { draft: Draft; length: number; fadeStart: number; nextAt: number | null }) {
  const W = 300
  const finite = Number.isFinite(length)
  // For endless cues, picture the next GO a little way in.
  const nextGoAt = draft.fadeOnNextGo ? (finite ? Math.min(length * 0.6, length) : 12) : null
  const thisEnd = finite ? length : nextGoAt != null ? nextGoAt + draft.fadeOutTime : 20
  const nextStart = nextAt ?? nextGoAt
  const span = Math.max(thisEnd, (nextStart ?? 0) + 6, 1) * 1.08
  const x = (s: number) => (s / span) * W
  const rampFrom = nextGoAt != null && draft.fadeOnNextGo ? nextGoAt : finite && draft.fadeOutTime > 0 ? fadeStart : null

  return (
    <div className="rounded-xl border border-line bg-black/40 p-3">
      <svg viewBox={`0 0 ${W} 74`} className="h-20 w-full" preserveAspectRatio="none" aria-label="流程時間軸">
        {/* this cue */}
        <text x={2} y={9} fontSize={8} fill="rgba(255,255,255,0.45)">此 Cue</text>
        {rampFrom != null ? (
          <>
            <rect x={0} y={13} width={x(rampFrom)} height={16} rx={3} fill="#30d158" opacity={0.75} />
            <polygon
              points={`${x(rampFrom)},13 ${x(rampFrom + draft.fadeOutTime)},29 ${x(rampFrom)},29`}
              fill="#30d158"
              opacity={0.45}
            />
          </>
        ) : (
          <rect x={0} y={13} width={x(thisEnd)} height={16} rx={3} fill="#30d158" opacity={0.75} />
        )}
        {draft.loop && (
          <text x={4} y={25} fontSize={9} fill="#000" fontWeight={700}>
            {draft.loopCount > 0 ? `⟳ ×${draft.loopCount}` : '⟳ ∞'}
          </text>
        )}
        {!finite && !draft.fadeOnNextGo && (
          <text x={W - 4} y={25} fontSize={9} textAnchor="end" fill="rgba(255,255,255,0.6)">∞ →</text>
        )}

        {/* next cue */}
        <text x={2} y={45} fontSize={8} fill="rgba(255,255,255,0.45)">下一個</text>
        {nextStart != null ? (
          <>
            <line x1={x(nextStart)} y1={10} x2={x(nextStart)} y2={68} stroke="#ffd60a" strokeWidth={1} strokeDasharray="2 2" />
            <rect x={x(nextStart)} y={49} width={W - x(nextStart)} height={16} rx={3} fill="#0a84ff" opacity={0.7} />
            {/* Near the right edge the label sits left of the marker instead of being squeezed. */}
            <text
              x={x(nextStart) > W * 0.65 ? x(nextStart) - 3 : x(nextStart) + 3}
              y={60}
              fontSize={8}
              fill="#fff"
              textAnchor={x(nextStart) > W * 0.65 ? 'end' : 'start'}
            >
              {nextAt != null ? `自動 GO +${nextStart.toFixed(1)}s` : '下一次 GO'}
            </text>
          </>
        ) : (
          <text x={x(thisEnd) + 4} y={60} fontSize={8} fill="rgba(255,255,255,0.4)">
            停止，等待手動 GO
          </text>
        )}
      </svg>
    </div>
  )
}
