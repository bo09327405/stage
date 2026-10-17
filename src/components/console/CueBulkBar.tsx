import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'
import { FOLLOW_MODE_LABELS, STOP_OTHERS_LABELS, type Cue, type FollowMode, type StopOthersMode } from '../../types/cue'
import { renumber } from '../../utils/cueNumbering'
import { Label, NumberField, Segmented, fieldClass } from '../ui/controls'
import { AudienceTargeting } from './AudienceTargeting'

interface CueBulkBarProps {
  cues: Cue[]
  checked: Set<string>
  onCheckedChange: (ids: Set<string>) => void
  onlineAudience: string[]
  updateCues: (ids: string[], changes: Partial<Omit<Cue, 'id'>>) => Promise<void>
  removeCues: (ids: string[]) => Promise<void>
  setCueNumbers: (numbers: Record<string, number>) => Promise<void>
  /**
   * Phone layout: instead of the bar over the list, a bar pinned to the bottom of the screen. It starts
   * as one "編輯" button; in edit mode a tap on a cue ticks it, and the bar offers batch edit / delete.
   */
  bottom?: { editing: boolean; onEditingChange: (editing: boolean) => void }
}

/** Toolbar over the cue list while cues are multi-selected: select all / clear / edit / renumber / delete. */
export function CueBulkBar({ cues, checked, onCheckedChange, onlineAudience, updateCues, removeCues, setCueNumbers, bottom }: CueBulkBarProps) {
  const [dialog, setDialog] = useState<'edit' | 'renumber' | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // In cue-list order, ignoring ids that were deleted elsewhere.
  const ids = cues.filter((c) => checked.has(c.id)).map((c) => c.id)
  const count = ids.length

  const run = async (job: () => Promise<void>) => {
    try {
      await job()
      setError(null)
      return true
    } catch (err) {
      setError((err as Error).message)
      return false
    }
  }

  const btn = 'min-h-9 rounded-lg px-3 text-xs font-medium whitespace-nowrap transition pointer-coarse:min-h-11'

  const exitEditing = () => {
    onCheckedChange(new Set())
    setConfirmDelete(false)
    bottom?.onEditingChange(false)
  }
  const tall = 'min-h-12 rounded-xl px-4 text-sm font-semibold whitespace-nowrap transition active:scale-[0.97] disabled:opacity-35'

  return (
    <>
      {bottom && (
        <div
          className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-[#161618]/95 px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom,0px))] backdrop-blur-xl"
          data-bulk-bottom
        >
          {!bottom.editing ? (
            <button className={`${tall} w-full bg-white/[0.09] text-white`} onClick={() => bottom.onEditingChange(true)} data-bulk-enter>
              ✎ 編輯
            </button>
          ) : (
            <>
              <div className="mb-2 flex items-center gap-2">
                <span className="text-sm font-semibold text-white">{count > 0 ? `已選 ${count} 個 Cue` : '點選要編輯的 Cue'}</span>
                <span className="flex-1" />
                <button className="min-h-10 rounded-lg px-3 text-xs text-white/70 active:bg-white/10" onClick={() => onCheckedChange(new Set(cues.map((c) => c.id)))}>
                  全選
                </button>
                <button className="min-h-10 rounded-lg px-3 text-xs text-white/70 active:bg-white/10" onClick={() => onCheckedChange(new Set())} disabled={count === 0}>
                  取消選取
                </button>
              </div>
              <div className="flex gap-2">
                <button className={`${tall} flex-1 bg-accent text-white`} disabled={count === 0} onClick={() => setDialog('edit')} data-bulk-edit>
                  ✎ 批次編輯
                </button>
                {confirmDelete ? (
                  <button
                    className={`${tall} flex-1 bg-panic text-white`}
                    onClick={async () => {
                      if (await run(() => removeCues(ids))) onCheckedChange(new Set())
                      setConfirmDelete(false)
                    }}
                  >
                    確定刪除 {count} 個
                  </button>
                ) : (
                  <button className={`${tall} flex-1 bg-panic/20 text-panic`} disabled={count === 0} onClick={() => setConfirmDelete(true)} data-bulk-delete>
                    🗑 刪除
                  </button>
                )}
                <button className={`${tall} bg-white/[0.09] text-white`} onClick={confirmDelete ? () => setConfirmDelete(false) : exitEditing}>
                  {confirmDelete ? '取消' : '完成'}
                </button>
              </div>
              {error && <p className="mt-1 text-xs text-panic">{error}</p>}
            </>
          )}
        </div>
      )}
      <AnimatePresence>
        {!bottom && count > 0 && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden px-3"
            data-bulk-bar
          >
            <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-accent/40 bg-accent/10 p-1.5 pl-3">
              <span className="mr-1 text-xs font-semibold text-white">已選 {count} 個</span>
              <button className={`${btn} bg-white/[0.07] text-white/70 hover:bg-white/15`} onClick={() => onCheckedChange(new Set(cues.map((c) => c.id)))}>
                全選
              </button>
              <button className={`${btn} bg-white/[0.07] text-white/70 hover:bg-white/15`} onClick={() => onCheckedChange(new Set())}>
                取消選取
              </button>
              <span className="flex-1" />
              <button className={`${btn} bg-accent text-white hover:bg-accent/80`} onClick={() => setDialog('edit')}>
                ✎ 批次編輯
              </button>
              <button className={`${btn} bg-white/[0.07] text-white/70 hover:bg-white/15`} onClick={() => setDialog('renumber')}>
                # 重新編號
              </button>
              {confirmDelete ? (
                <span className="flex items-center gap-1">
                  <button
                    className={`${btn} bg-panic text-white`}
                    onClick={async () => {
                      if (await run(() => removeCues(ids))) onCheckedChange(new Set())
                      setConfirmDelete(false)
                    }}
                  >
                    確定刪除 {count} 個
                  </button>
                  <button className={`${btn} text-white/50 hover:bg-white/10`} onClick={() => setConfirmDelete(false)}>
                    取消
                  </button>
                </span>
              ) : (
                <button className={`${btn} text-panic hover:bg-panic/20`} onClick={() => setConfirmDelete(true)}>
                  🗑 批次刪除
                </button>
              )}
            </div>
            {error && <p className="mt-1 text-xs text-panic">{error}</p>}
          </motion.div>
        )}
      </AnimatePresence>

      {dialog === 'edit' && (
        <BulkEditDialog
          count={count}
          sample={cues.find((c) => c.id === ids[0])}
          groups={[...new Set(cues.map((c) => c.group).filter(Boolean))]}
          onlineAudience={onlineAudience}
          onClose={() => setDialog(null)}
          onApply={async (changes) => {
            if (await run(() => updateCues(ids, changes))) setDialog(null)
          }}
        />
      )}
      {dialog === 'renumber' && (
        <RenumberDialog
          count={count}
          start={cues.find((c) => c.id === ids[0])?.cueNumber ?? 1}
          onClose={() => setDialog(null)}
          onApply={async (start, step) => {
            if (await run(() => setCueNumbers(renumber(ids, start, step)))) setDialog(null)
          }}
        />
      )}
    </>
  )
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 backdrop-blur-sm sm:items-center" onClick={onClose}>
      <motion.div
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[90dvh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-2xl"
        role="dialog"
        aria-label={title}
      >
        <header className="flex items-center justify-between border-b border-line px-5 py-3">
          <h2 className="text-sm font-semibold text-white">{title}</h2>
          <button onClick={onClose} className="h-9 w-9 rounded-lg text-white/50 hover:bg-white/10" aria-label="關閉">
            ✕
          </button>
        </header>
        {children}
      </motion.div>
    </div>
  )
}

type BulkFields = Pick<Cue, 'fadeInTime' | 'fadeOutTime' | 'volume' | 'preWaitTime' | 'followMode' | 'stopOthers' | 'group' | 'targetMode' | 'targetIds'>
type FieldKey = 'fadeInTime' | 'fadeOutTime' | 'volume' | 'preWaitTime' | 'followMode' | 'stopOthers' | 'group' | 'target'

/** Each field has an "apply" box; only ticked fields are written to every selected cue. */
function BulkEditDialog({
  count,
  sample,
  groups,
  onlineAudience,
  onClose,
  onApply,
}: {
  count: number
  sample: Cue | undefined
  groups: string[]
  onlineAudience: string[]
  onClose: () => void
  onApply: (changes: Partial<BulkFields>) => Promise<void>
}) {
  const [values, setValues] = useState<BulkFields>({
    fadeInTime: sample?.fadeInTime ?? 0,
    fadeOutTime: sample?.fadeOutTime ?? 0,
    volume: sample?.volume ?? 1,
    preWaitTime: sample?.preWaitTime ?? 0,
    followMode: sample?.followMode ?? 'none',
    stopOthers: sample?.stopOthers ?? 'none',
    group: sample?.group ?? '',
    targetMode: sample?.targetMode ?? 'all',
    targetIds: sample?.targetIds ?? [],
  })
  const [on, setOn] = useState<Set<FieldKey>>(new Set())
  const [busy, setBusy] = useState(false)
  const set = <K extends keyof BulkFields>(key: K, value: BulkFields[K], field: FieldKey) => {
    setValues((v) => ({ ...v, [key]: value }))
    // Touching a field ticks it.
    setOn((s) => new Set(s).add(field))
  }
  const toggle = (field: FieldKey) =>
    setOn((s) => {
      const n = new Set(s)
      if (n.has(field)) n.delete(field)
      else n.add(field)
      return n
    })

  const changes: Partial<BulkFields> = {}
  for (const f of on) {
    if (f === 'target') {
      changes.targetMode = values.targetMode
      changes.targetIds = values.targetMode === 'all' ? [] : values.targetIds
    } else {
      ;(changes as Record<string, unknown>)[f] = values[f]
    }
  }
  const invalidTarget = on.has('target') && values.targetMode === 'selected' && values.targetIds.length === 0

  const Row = ({ field, children }: { field: FieldKey; children: React.ReactNode }) => (
    <div className={`flex gap-3 rounded-xl border p-3 transition ${on.has(field) ? 'border-accent/50 bg-accent/[0.06]' : 'border-line'}`} data-bulk-field={field}>
      <input
        type="checkbox"
        checked={on.has(field)}
        onChange={() => toggle(field)}
        className="mt-1 h-5 w-5 shrink-0 cursor-pointer accent-[#0a84ff]"
        aria-label={`套用 ${field}`}
      />
      <div className={`min-w-0 flex-1 ${on.has(field) ? '' : 'opacity-60'}`}>{children}</div>
    </div>
  )

  return (
    <Modal title={`批次編輯 ${count} 個 Cue`} onClose={onClose}>
      <div className="flex-1 space-y-2 overflow-y-auto p-4">
        <p className="text-xs text-white/40">勾選要套用的欄位（修改欄位時會自動勾選）。未勾選的欄位保持各 Cue 原值。</p>
        {Row({
          field: 'fadeInTime',
          children: <NumberField label="淡入時間" value={values.fadeInTime} onChange={(v) => set('fadeInTime', v, 'fadeInTime')} />,
        })}
        {Row({
          field: 'fadeOutTime',
          children: <NumberField label="淡出時間" value={values.fadeOutTime} onChange={(v) => set('fadeOutTime', v, 'fadeOutTime')} />,
        })}
        {Row({
          field: 'volume',
          children: (
            <NumberField
              label="音量"
              suffix="%"
              step={1}
              stepperStep={5}
              max={100}
              value={Math.round(values.volume * 100)}
              onChange={(v) => set('volume', v / 100, 'volume')}
            />
          ),
        })}
        {Row({
          field: 'preWaitTime',
          children: <NumberField label="Pre-Wait" value={values.preWaitTime} onChange={(v) => set('preWaitTime', v, 'preWaitTime')} />,
        })}
        {Row({
          field: 'followMode',
          children: (
            <>
              <Label>接續模式</Label>
              <Segmented<FollowMode>
                options={(Object.keys(FOLLOW_MODE_LABELS) as FollowMode[]).map((id) => ({ id, label: FOLLOW_MODE_LABELS[id] }))}
                value={values.followMode}
                onChange={(v) => set('followMode', v, 'followMode')}
              />
            </>
          ),
        })}
        {Row({
          field: 'stopOthers',
          children: (
            <>
              <Label>對其他 Cue</Label>
              <Segmented<StopOthersMode>
                options={(Object.keys(STOP_OTHERS_LABELS) as StopOthersMode[]).map((id) => ({ id, label: STOP_OTHERS_LABELS[id] }))}
                value={values.stopOthers}
                onChange={(v) => set('stopOthers', v, 'stopOthers')}
              />
            </>
          ),
        })}
        {Row({
          field: 'group',
          children: (
            <>
              <Label hint="留空 = 移除群組">群組標籤</Label>
              <input
                className={fieldClass}
                list="bulk-groups"
                placeholder="（無）"
                value={values.group}
                onChange={(e) => set('group', e.target.value, 'group')}
                data-field="群組標籤"
              />
              <datalist id="bulk-groups">
                {groups.map((g) => (
                  <option key={g} value={g} />
                ))}
              </datalist>
            </>
          ),
        })}
        {Row({
          field: 'target',
          children: (
            <>
              <Label>輸出 / 派發對象</Label>
              <AudienceTargeting
                mode={values.targetMode}
                ids={values.targetIds}
                online={onlineAudience}
                onChange={(mode, ids) => {
                  setValues((v) => ({ ...v, targetMode: mode, targetIds: ids }))
                  setOn((s) => new Set(s).add('target'))
                }}
              />
            </>
          ),
        })}
      </div>
      <footer className="flex items-center gap-2 border-t border-line px-5 py-3">
        {invalidTarget && <span className="text-xs text-panic">請至少選擇一位觀眾</span>}
        <span className="flex-1" />
        <button onClick={onClose} className="min-h-10 rounded-lg px-4 text-sm text-white/60 hover:bg-white/10">
          取消
        </button>
        <button
          disabled={on.size === 0 || invalidTarget || busy}
          onClick={async () => {
            setBusy(true)
            await onApply(changes)
            setBusy(false)
          }}
          className="min-h-10 rounded-lg bg-accent px-4 text-sm font-semibold text-white disabled:opacity-40"
        >
          套用到 {count} 個 Cue{on.size ? `（${on.size} 個欄位）` : ''}
        </button>
      </footer>
    </Modal>
  )
}

function RenumberDialog({ count, start: initialStart, onClose, onApply }: { count: number; start: number; onClose: () => void; onApply: (start: number, step: number) => Promise<void> }) {
  const [start, setStart] = useState(initialStart)
  const [step, setStep] = useState(1)
  const last = Math.round((start + step * (count - 1)) * 1000) / 1000
  return (
    <Modal title={`重新編號 ${count} 個 Cue`} onClose={onClose}>
      <div className="grid grid-cols-2 gap-3 p-5">
        <NumberField label="起始編號" suffix="" step={0.1} value={start} onChange={setStart} />
        <NumberField label="間隔" suffix="" step={0.1} stepperStep={0.5} min={0.01} value={step} onChange={setStep} />
        <p className="col-span-2 text-xs text-white/40">
          依目前列表順序編為 {start} → {last}。若與未選取的 Cue 編號交錯，列表順序會跟著改變。
        </p>
      </div>
      <footer className="flex justify-end gap-2 border-t border-line px-5 py-3">
        <button onClick={onClose} className="min-h-10 rounded-lg px-4 text-sm text-white/60 hover:bg-white/10">
          取消
        </button>
        <button onClick={() => onApply(start, step)} className="min-h-10 rounded-lg bg-accent px-4 text-sm font-semibold text-white">
          重新編號
        </button>
      </footer>
    </Modal>
  )
}
