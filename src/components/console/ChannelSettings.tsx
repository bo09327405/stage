import { useState } from 'react'
import type { PresenceEntry } from '../../services/presence'
import { MAX_CHANNELS, channelColor, channelIds, channelLabel, type ChannelConfig } from '../../types/channels'
import { BottomSheet } from '../ui/BottomSheet'
import { useSafetyConfirm } from '../ui/SafetyConfirm'

/**
 * Admin settings for the audience channel groups: how many groups (or none), whether audience may switch
 * groups themselves, and a reset that sends every device back to the group picker. Each of these changes
 * what the live audience sees, so each one goes through the show-safety confirmation first.
 */
export function ChannelSettings({
  open,
  onClose,
  config,
  audience,
  admin,
  onChange,
  onAssign,
}: {
  open: boolean
  onClose: () => void
  config: ChannelConfig
  /** Audience devices connected now (with the group each one is in). */
  audience: PresenceEntry[]
  admin: boolean
  onChange: (changes: Partial<Omit<ChannelConfig, 'assign'>> & { assign?: null }) => Promise<void>
  /** Place devices in groups by hand: audience code → channel_n, or null to hand control back to the device. */
  onAssign: (changes: Record<string, string | null>) => Promise<void>
}) {
  const online = audience.length
  const [safety, confirm] = useSafetyConfirm()
  const [error, setError] = useState<string | null>(null)
  const apply = async (changes: Partial<Omit<ChannelConfig, 'assign'>> & { assign?: null }) => {
    try {
      setError(null)
      await onChange(changes)
    } catch (err) {
      setError((err as Error).message)
    }
  }
  const people = online > 0 ? `目前有 ${online} 台觀眾裝置在線，` : ''

  const setCount = async (count: number) => {
    if (count === config.count) return
    const ok = await confirm({
      title: count === 0 ? '改為不分組？' : `改為分成 ${count} 組？`,
      detail: (
        <>
          {people}變更後每台觀眾裝置<b className="text-white">需要重新選擇組別</b>，已選的組別會被清除；各 Cue 依「目標頻道」播放的對象也會立刻改變。
        </>
      ),
    })
    if (ok) await apply({ count, epoch: config.epoch + 1, assign: null })
  }

  const reset = async () => {
    const ok = await confirm({
      title: '重設所有觀眾的組別？',
      detail: <>{people}所有觀眾手機會立刻跳回「選擇組別」畫面，必須重新加入才收得到導引與聲音。</>,
      confirmLabel: '確認重設 (Reset)',
    })
    if (ok) await apply({ epoch: config.epoch + 1, assign: null })
  }

  const groups = channelIds(config.count)
  const assignOne = async (audienceId: string, channel: string) => {
    try {
      setError(null)
      await onAssign({ [audienceId]: channel || null })
      navigator.vibrate?.(10)
    } catch (err) {
      setError((err as Error).message)
    }
  }
  const distribute = async () => {
    const ok = await confirm({
      title: '平均分配所有在線觀眾？',
      detail: (
        <>
          目前在線的 <b className="text-white">{online} 台</b>觀眾裝置會依序平均分到 Ch 1 – Ch {config.count}，<b className="text-white">立刻覆蓋</b>他們原本的組別；之後他們無法自行換組，直到你取消指派。
        </>
      ),
      confirmLabel: '確認分配 (Assign)',
    })
    if (!ok) return
    await onAssign(Object.fromEntries(audience.map((a, i) => [a.audienceId, groups[i % groups.length]]))).catch((err: Error) => setError(err.message))
  }
  const clearAssign = async () => {
    const ok = await confirm({
      title: '取消所有指派？',
      detail: <>所有手動指派的觀眾會回到自己選的組別（沒選過的會被要求重新選擇）。</>,
      confirmLabel: '確認取消指派',
    })
    if (ok) await onAssign(Object.fromEntries(Object.keys(config.assign).map((k) => [k, null]))).catch((err: Error) => setError(err.message))
  }

  const toggleOpen = async () => {
    const next = !config.open
    const ok = await confirm({
      title: next ? '解鎖觀眾自行換組？' : '鎖定觀眾組別？',
      detail: next ? (
        <>{people}解鎖後，觀眾可以在自己的手機上隨時更換組別，這會改變他們收到的 Cue 與廣播。</>
      ) : (
        <>{people}鎖定後，觀眾只能在選擇組別後的 10 分鐘內自行更正選錯的組別；超過後要換組只能由你「重設」。</>
      ),
      confirmLabel: next ? '確認解鎖 (Unlock)' : '確認鎖定 (Lock)',
    })
    if (ok) await apply({ open: next })
  }

  return (
    <>
      <BottomSheet open={open} onClose={onClose} title="觀眾分組設定" subtitle="Ch 1 – Ch 10 · 只有管理員可變更">
        {!admin && <p className="rounded-lg bg-standby/10 px-3 py-2 text-xs text-standby">只有管理員可以變更分組設定。</p>}
        <div>
          <div className="mb-2 text-[11px] font-semibold tracking-widest text-white/50 uppercase">分組模式</div>
          <div className="grid grid-cols-4 gap-2" data-channel-count>
            {[0, ...Array.from({ length: MAX_CHANNELS - 1 }, (_, i) => i + 2)].map((n) => (
              <button
                key={n}
                type="button"
                disabled={!admin}
                onClick={() => void setCount(n)}
                className={`min-h-12 rounded-xl border text-sm font-semibold transition disabled:opacity-40 ${
                  config.count === n ? 'border-accent bg-accent text-white' : 'border-line bg-white/[0.04] text-white/75 active:bg-white/10'
                }`}
                data-count-option={n}
              >
                {n === 0 ? 'ALL 不分組' : `${n} 組`}
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-white/40">
            {config.count === 0 ? '所有觀眾一起收到所有 Cue。' : `觀眾加入時選擇 Ch 1 – Ch ${config.count}；Cue 可指定只播給某幾組。`}
          </p>
        </div>

        {config.count > 0 && (
          <>
            <button
              type="button"
              disabled={!admin}
              onClick={() => void toggleOpen()}
              className={`flex min-h-14 w-full items-center justify-between rounded-xl border px-4 text-left disabled:opacity-40 ${config.open ? 'border-standby/60 bg-standby/10' : 'border-line bg-white/[0.04]'}`}
              aria-pressed={config.open}
              data-channel-unlock
            >
              <span>
                <span className="block text-sm font-semibold">{config.open ? '🔓 觀眾可自行換組' : '🔒 觀眾組別已鎖定'}</span>
                <span className="block text-xs text-white/45">點一下切換（會先要求確認）</span>
              </span>
              <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${config.open ? 'bg-standby text-black' : 'bg-white/10 text-white/60'}`}>{config.open ? '已解鎖' : '已鎖定'}</span>
            </button>
            <button
              type="button"
              disabled={!admin}
              onClick={() => void reset()}
              className="min-h-12 w-full rounded-xl bg-panic/15 text-sm font-semibold text-panic disabled:opacity-40 active:bg-panic/25"
              data-channel-reset
            >
              ⟲ 重設所有觀眾的組別
            </button>
          </>
        )}
        {config.count > 0 && (
          <div data-assign-audience>
            <div className="mb-2 flex items-baseline justify-between">
              <span className="text-[11px] font-semibold tracking-widest text-white/50 uppercase">指派觀眾到分組</span>
              <span className="text-[11px] text-white/35">{online} 台在線 · 已指派 {Object.keys(config.assign).length}</span>
            </div>
            {audience.length === 0 ? (
              <p className="rounded-lg bg-white/[0.03] p-3 text-xs text-white/35">目前沒有觀眾連線。觀眾進入後會出現在這裡，你就能直接把他們放進指定組別。</p>
            ) : (
              <ul className="max-h-64 space-y-1.5 overflow-y-auto">
                {audience.map((a) => {
                  const assigned = config.assign[a.audienceId] ?? ''
                  return (
                    <li key={a.audienceId} className="flex min-h-12 items-center gap-2 rounded-xl bg-white/[0.04] px-3" data-assign-row={a.audienceId}>
                      <span className="font-mono text-sm font-bold tracking-[0.15em] text-white/80">{a.audienceId}</span>
                      <span className="min-w-0 flex-1 truncate text-[11px]" style={{ color: a.channel ? channelColor(a.channel) : undefined }}>
                        {a.channel ? channelLabel(a.channel) : '尚未選組'}
                        {assigned ? ' 📌' : ''}
                      </span>
                      <select
                        value={assigned}
                        disabled={!admin}
                        onChange={(e) => void assignOne(a.audienceId, e.target.value)}
                        aria-label={`指派 ${a.audienceId} 的組別`}
                        className="min-h-10 rounded-lg border border-white/10 bg-black/40 px-2 text-xs text-white disabled:opacity-40"
                      >
                        <option value="">自己選擇</option>
                        {groups.map((g) => (
                          <option key={g} value={g}>
                            指派到 {channelLabel(g)}
                          </option>
                        ))}
                      </select>
                    </li>
                  )
                })}
              </ul>
            )}
            <div className="mt-2 grid grid-cols-2 gap-2">
              <button type="button" disabled={!admin || audience.length === 0} onClick={() => void distribute()} className="min-h-11 rounded-xl bg-accent/20 text-xs font-semibold text-[#64a8ff] disabled:opacity-40" data-assign-distribute>
                平均分配在線觀眾
              </button>
              <button type="button" disabled={!admin || Object.keys(config.assign).length === 0} onClick={() => void clearAssign()} className="min-h-11 rounded-xl bg-white/10 text-xs font-semibold text-white/70 disabled:opacity-40" data-assign-clear>
                取消所有指派
              </button>
            </div>
          </div>
        )}
        {error && <p className="text-xs text-panic">{error}</p>}
      </BottomSheet>
      {safety}
    </>
  )
}
