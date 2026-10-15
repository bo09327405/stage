import { AnimatePresence, Reorder, motion, useDragControls } from 'motion/react'
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { removeGlobalTrigger, reorderGlobalTriggers, saveGlobalTrigger } from '../../services/triggers'
import type { GlobalTrigger } from '../../types/trigger'
import { ActionPicker } from '../ui/ActionPicker'
import { TriggerMatchEditor } from '../ui/TriggerMatchEditor'

/**
 * Global Profile rules as a sortable list. Drag a card by its ☰ handle (finger or mouse — Pointer
 * Events, so it works on tablets where HTML5 drag-and-drop doesn't), or focus the handle and use
 * ↑/↓. The new order is written to Firebase when the card is dropped.
 */
export function TriggerRuleList({ projectId, triggers }: { projectId: string; triggers: GlobalTrigger[] }) {
  // Local order while dragging; otherwise follow Firebase (which other devices may change).
  const [draft, setDraftState] = useState<string[] | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const byId = new Map(triggers.map((t) => [t.id, t]))
  const liveIds = triggers.map((t) => t.id)
  const order = draft ? draft.filter((id) => byId.has(id)) : liveIds

  // The order as of the latest reorder event, readable from the pointer-up listener.
  const draftRef = useRef<string[] | null>(null)
  const liveRef = useRef(liveIds)
  useEffect(() => {
    liveRef.current = liveIds
  })
  const setDraft = (ids: string[] | null) => {
    draftRef.current = ids
    setDraftState(ids)
  }

  const persist = async (ids: string[]) => {
    if (ids.join() === liveRef.current.join()) return setDraft(null)
    try {
      await reorderGlobalTriggers(projectId, ids)
      setError(null)
    } catch (err) {
      setError(`排序未能儲存：${(err as Error).message}`)
    } finally {
      // Firebase's echo now carries the same order, so hand back to the live list.
      setDraft(null)
    }
  }

  /**
   * Begin a handle drag. The drop is detected with a window pointer-up/cancel listener rather than
   * the animation library's drag-end callback, so the new order is always saved exactly once.
   */
  const beginDrag = (id: string) => {
    setDraggingId(id)
    setDraft(order)
    const end = () => {
      window.removeEventListener('pointerup', end, true)
      window.removeEventListener('pointercancel', end, true)
      setDraggingId(null)
      persist(draftRef.current ?? liveRef.current)
    }
    window.addEventListener('pointerup', end, true)
    window.addEventListener('pointercancel', end, true)
  }

  const move = (id: string, delta: number) => {
    const ids = [...order]
    const from = ids.indexOf(id)
    const to = from + delta
    if (from < 0 || to < 0 || to >= ids.length) return
    ids.splice(to, 0, ...ids.splice(from, 1))
    setDraft(ids)
    persist(ids)
  }

  return (
    <>
      {error && <p className="rounded-lg bg-panic/15 px-3 py-2 text-xs text-panic">{error}</p>}
      <Reorder.Group axis="y" values={order} onReorder={setDraft} className="space-y-3">
        <AnimatePresence initial={false}>
          {order.map((id, index) => {
            const t = byId.get(id)
            return t ? (
              <RuleCard
                key={id}
                trigger={t}
                index={index}
                count={order.length}
                projectId={projectId}
                dragging={draggingId === id}
                otherDragging={draggingId !== null && draggingId !== id}
                onBeginDrag={() => beginDrag(id)}
                onMove={(delta) => move(id, delta)}
              />
            ) : null
          })}
        </AnimatePresence>
      </Reorder.Group>
    </>
  )
}

function RuleCard({
  trigger: t,
  index,
  count,
  projectId,
  dragging,
  otherDragging,
  onBeginDrag,
  onMove,
}: {
  trigger: GlobalTrigger
  index: number
  count: number
  projectId: string
  dragging: boolean
  otherDragging: boolean
  onBeginDrag: () => void
  onMove: (delta: number) => void
}) {
  // Only the handle starts a drag, so the fields inside the card stay editable.
  const controls = useDragControls()

  const startDrag = (e: PointerEvent) => {
    e.preventDefault()
    onBeginDrag()
    controls.start(e)
  }
  const onHandleKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      onMove(e.key === 'ArrowUp' ? -1 : 1)
    }
  }

  return (
    <Reorder.Item
      value={t.id}
      dragListener={false}
      dragControls={controls}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: -20 }}
      whileDrag={{ scale: 1.02, zIndex: 10, boxShadow: '0 24px 48px -12px rgba(0,0,0,0.8)' }}
      className={`relative flex gap-3 rounded-xl border bg-[#151515] p-4 pl-2 transition-[border-color,opacity] ${
        dragging ? 'border-accent ring-2 ring-accent/50' : 'border-line'
      } ${!t.enabled && !dragging ? 'opacity-50' : ''} ${otherDragging ? 'opacity-80' : ''}`}
    >
      {/* Drag handle + position */}
      <div className="flex w-9 shrink-0 flex-col items-center gap-1.5 pt-6">
        <button
          type="button"
          onPointerDown={startDrag}
          onKeyDown={onHandleKey}
          className={`flex h-12 w-9 touch-none items-center justify-center rounded-lg text-lg select-none ${
            dragging ? 'cursor-grabbing bg-accent text-white' : 'cursor-grab bg-white/[0.05] text-white/45 hover:bg-white/10 hover:text-white/80'
          }`}
          aria-label={`拖曳排序：第 ${index + 1} 條，共 ${count} 條（也可用 ↑/↓ 鍵）`}
          title="拖曳以調整順序（或聚焦後按 ↑ / ↓）"
        >
          ☰
        </button>
        <span className={`font-mono text-[11px] tabular ${dragging ? 'text-accent' : 'text-white/35'}`}>#{index + 1}</span>
      </div>

      <div className="grid min-w-0 flex-1 gap-4 lg:grid-cols-[minmax(19rem,1.4fr)_auto_minmax(12rem,1fr)] lg:items-start">
        <div className="min-w-0">
          <div className="mb-2 text-[11px] font-semibold tracking-wider text-white/40 uppercase">當收到</div>
          <TriggerMatchEditor match={t.match} onChange={(match) => saveGlobalTrigger(projectId, { ...t, match }).catch(() => {})} />
        </div>
        <div className="hidden pt-9 text-xl text-white/25 lg:block">→</div>
        <div className="min-w-0 space-y-2">
          <div className="mb-2 text-[11px] font-semibold tracking-wider text-white/40 uppercase">執行動作</div>
          <ActionPicker value={t.action} onChange={(action) => saveGlobalTrigger(projectId, { ...t, action }).catch(() => {})} />
          <div className="flex gap-2">
            <button
              onClick={() => saveGlobalTrigger(projectId, { ...t, enabled: !t.enabled }).catch(() => {})}
              className={`min-h-10 flex-1 rounded-lg px-3 text-xs font-semibold whitespace-nowrap ${t.enabled ? 'bg-go/15 text-go' : 'bg-white/10 text-white/50'}`}
            >
              {t.enabled ? '● 啟用中' : '○ 已停用'}
            </button>
            <button
              onClick={() => removeGlobalTrigger(projectId, t.id).catch(() => {})}
              className="min-h-10 rounded-lg px-3 text-xs whitespace-nowrap text-white/35 hover:bg-panic/20 hover:text-panic"
            >
              刪除
            </button>
          </div>
        </div>
      </div>

      {dragging && (
        <motion.span
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          className="pointer-events-none absolute -top-3 right-4 rounded-full bg-accent px-2.5 py-0.5 text-[11px] font-semibold text-white shadow-lg"
        >
          放開即放到第 {index + 1} 條
        </motion.span>
      )}
    </Reorder.Item>
  )
}
