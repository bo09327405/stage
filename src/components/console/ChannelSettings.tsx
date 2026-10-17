import { useState } from 'react'
import { MAX_CHANNELS, type ChannelConfig } from '../../types/channels'
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
  online,
  admin,
  onChange,
}: {
  open: boolean
  onClose: () => void
  config: ChannelConfig
  /** Audience devices connected now (for the warning text). */
  online: number
  admin: boolean
  onChange: (changes: Partial<ChannelConfig>) => Promise<void>
}) {
  const [safety, confirm] = useSafetyConfirm()
  const [error, setError] = useState<string | null>(null)
  const apply = async (changes: Partial<ChannelConfig>) => {
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
    if (ok) await apply({ count, epoch: config.epoch + 1 })
  }

  const reset = async () => {
    const ok = await confirm({
      title: '重設所有觀眾的組別？',
      detail: <>{people}所有觀眾手機會立刻跳回「選擇組別」畫面，必須重新加入才收得到導引與聲音。</>,
      confirmLabel: '確認重設 (Reset)',
    })
    if (ok) await apply({ epoch: config.epoch + 1 })
  }

  const toggleOpen = async () => {
    const next = !config.open
    const ok = await confirm({
      title: next ? '解鎖觀眾自行換組？' : '鎖定觀眾組別？',
      detail: next ? (
        <>{people}解鎖後，觀眾可以在自己的手機上隨時更換組別，這會改變他們收到的 Cue 與廣播。</>
      ) : (
        <>{people}鎖定後觀眾無法自行換組；要換組只能由你「重設」。</>
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
        {error && <p className="text-xs text-panic">{error}</p>}
      </BottomSheet>
      {safety}
    </>
  )
}
