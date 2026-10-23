import { motion } from 'motion/react'
import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import type { useTheatreEngine } from '../../hooks/useTheatreEngine'
import type { VjController } from '../../hooks/useVjController'
import { useMidi } from '../../services/midi'
import { createDeck, deleteDeck, patchClip, renameDeck, resizeDeck, setClip } from '../../services/vjDecks'
import type { ProjectMedia } from '../../services/mediaLibrary'
import { VJ_GRID_LIMITS, VJ_PLAY_MODES, VJ_SPEED_RANGE, newClip, slotKey, type VjClip, type VjDeck, type VjPlayMode } from '../../types/vj'
import { InboxPickerModal } from '../console/InboxPickerModal'
import { VjMixer } from './VjMixer'
import { LearnButton } from './VjParam'
import { VjStage } from './VjStage'

const PLAY_ICON: Record<VjPlayMode, string> = { loop: '🔁', oneshot: '①', hold: '⏸' }

/**
 * Live VJ deck: clip grids, the layer mixer with blend modes and A/B crossfader, effect chains, a monitor,
 * and MIDI / OSC mapping. The mix on this panel is what the audience screens show while "上舞台" is on.
 */
export function VjDeckPanel({
  projectId,
  projectName,
  decks,
  ctl,
  engine,
  onClose,
}: {
  projectId: string
  projectName: string
  decks: VjDeck[] | null
  ctl: VjController
  engine: ReturnType<typeof useTheatreEngine>
  onClose: () => void
}) {
  const [deckId, setDeckId] = useState<string | null>(null)
  const [editSlot, setEditSlot] = useState<string | null>(null)
  const [pickSlot, setPickSlot] = useState<string | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const [stageError, setStageError] = useState<string | null>(null)
  const midi = useMidi()

  const deck = decks?.find((d) => d.id === deckId) ?? decks?.[0] ?? null
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !pickSlot) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, pickSlot])

  /** Which layers are playing which slot, for the highlight on the grid. */
  const playing = useMemo(() => {
    const map = new Map<string, number[]>()
    if (!deck) return map
    ctl.mix.layers.forEach((l, i) => {
      if (!l.clip) return
      for (const [slot, c] of Object.entries(deck.clips)) if (c.id === l.clip.id) map.set(slot, [...(map.get(slot) ?? []), i + 1])
    })
    return map
  }, [deck, ctl.mix.layers])

  const pick = (media: ProjectMedia) => {
    if (!deck || !pickSlot) return
    if (media.kind === 'audio') {
      setHint('VJ 素材只能是影片或圖片')
      return
    }
    setHint(null)
    const existing = deck.clips[pickSlot]
    void setClip(projectId, deck.id, pickSlot, newClip({ ...(existing ? { playMode: existing.playMode, speed: existing.speed, audio: existing.audio } : {}), name: media.name.replace(/\.[^.]+$/, ''), src: media.url, mediaKind: media.kind === 'image' ? 'image' : 'video' }))
    setPickSlot(null)
  }

  const editing = deck && editSlot ? deck.clips[editSlot] : undefined

  return (
    <motion.div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-2 backdrop-blur-sm sm:p-4" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <motion.div
        initial={{ scale: 0.97, y: 12 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.97, y: 12 }}
        transition={{ type: 'spring', stiffness: 450, damping: 35 }}
        onClick={(e) => e.stopPropagation()}
        className="flex h-full max-h-[960px] w-full max-w-[1400px] flex-col overflow-hidden rounded-2xl border border-line bg-panel/95 shadow-2xl backdrop-blur-2xl"
        role="dialog"
        aria-label="VJ Deck"
        data-vj-panel
      >
        <header className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
          <div className="mr-2">
            <div className="text-[11px] font-semibold tracking-widest text-white/40 uppercase">Live VJ</div>
            <h2 className="text-lg leading-tight font-semibold">🎬 VJ Deck · 視覺導控</h2>
          </div>
          <button
            type="button"
            onClick={() => ctl.update((m) => ({ ...m, live: !m.live }))}
            className={`min-h-10 rounded-lg px-4 text-sm font-semibold transition ${ctl.mix.live ? 'bg-panic text-white' : 'bg-go text-black hover:brightness-110'}`}
            aria-pressed={ctl.mix.live}
            data-vj-live
          >
            {ctl.mix.live ? '● 上舞台中 · 點擊下台' : '▶ 上舞台'}
          </button>
          <LearnButton target="live" ctl={ctl} />
          <button type="button" onClick={ctl.blackout} className="min-h-10 rounded-lg bg-white/[0.08] px-3 text-sm text-white/80 hover:bg-white/15" title="清空所有圖層並下台">
            全部清除
          </button>
          <div className="ml-auto flex flex-wrap items-center gap-2 text-[11px] text-white/45">
            <span title={midi.inputs.map((i) => i.name).join('、') || '尚未偵測到 MIDI 輸入'}>
              🎹 {midi.status === 'unsupported' ? '此瀏覽器不支援 Web MIDI' : midi.status === 'denied' ? 'MIDI 被拒絕' : midi.inputs.length ? `${midi.inputs.length} 個輸入` : '無 MIDI 輸入'}
            </span>
            {midi.status !== 'ready' && midi.status !== 'unsupported' && (
              <button type="button" onClick={midi.connect} className="rounded-md bg-white/[0.08] px-2 py-1 hover:bg-white/15">
                連接 MIDI
              </button>
            )}
            <span>{ctl.mappings.length} 個對應</span>
            {ctl.mappings.length > 0 && (
              <button type="button" onClick={ctl.clearMappings} className="rounded-md px-2 py-1 hover:bg-white/10 hover:text-white">
                清除對應
              </button>
            )}
          </div>
          <button type="button" onClick={onClose} className="flex h-10 w-10 items-center justify-center rounded-lg text-white/40 hover:bg-white/10 hover:text-white" aria-label="關閉">
            ✕
          </button>
        </header>

        {ctl.learning && (
          <div className="border-b border-standby/30 bg-standby/10 px-4 py-1.5 text-xs text-standby">
            MIDI Learn：正在等待「{ctl.learning}」的訊號 — 轉動旋鈕、按下按鈕，或傳送 OSC。
            <button type="button" onClick={ctl.stopLearn} className="ml-3 underline">
              取消
            </button>
          </div>
        )}

        <div className="grid min-h-0 flex-1 gap-0 lg:grid-cols-[minmax(0,1fr)_380px]">
          {/* Decks + grid */}
          <section className="flex min-h-0 flex-col overflow-y-auto border-b border-line p-4 lg:border-r lg:border-b-0">
            <div className="mb-3 flex flex-wrap items-center gap-1.5" role="tablist">
              {decks?.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  role="tab"
                  aria-selected={d.id === deck?.id}
                  onClick={() => {
                    setDeckId(d.id)
                    setEditSlot(null)
                  }}
                  className={`min-h-9 rounded-lg px-3 text-sm ${d.id === deck?.id ? 'bg-accent text-white' : 'bg-white/[0.06] text-white/60 hover:text-white'}`}
                >
                  {d.name}
                </button>
              ))}
              <button
                type="button"
                onClick={async () => {
                  const name = window.prompt('新 Deck 名稱', `Deck ${(decks?.length ?? 0) + 1}`)
                  if (name == null) return
                  const id = await createDeck(projectId, name, Date.now())
                  if (id) setDeckId(id)
                }}
                className="min-h-9 rounded-lg border border-dashed border-white/20 px-3 text-sm text-white/50 hover:border-accent/60 hover:text-white"
              >
                ＋ Deck
              </button>
            </div>

            {decks && decks.length === 0 && <p className="rounded-xl bg-white/[0.03] p-6 text-center text-sm text-white/40">還沒有 Deck。按「＋ Deck」建立一個素材格狀面板，再把影片或圖片指派到格子裡。</p>}

            {deck && (
              <>
                <div className="mb-3 flex flex-wrap items-center gap-3 text-xs text-white/50">
                  <button
                    type="button"
                    onClick={() => {
                      const name = window.prompt('Deck 名稱', deck.name)
                      if (name) void renameDeck(projectId, deck.id, name)
                    }}
                    className="rounded-md bg-white/[0.06] px-2 py-1 hover:bg-white/15"
                  >
                    ✎ 改名
                  </button>
                  <label className="flex items-center gap-1">
                    欄
                    <input type="number" min={VJ_GRID_LIMITS.cols[0]} max={VJ_GRID_LIMITS.cols[1]} value={deck.cols} onChange={(e) => void resizeDeck(projectId, deck.id, Number(e.target.value), deck.rows)} className="w-14 rounded-md border border-line bg-black/40 px-1.5 py-1 text-white" />
                  </label>
                  <label className="flex items-center gap-1">
                    行
                    <input type="number" min={VJ_GRID_LIMITS.rows[0]} max={VJ_GRID_LIMITS.rows[1]} value={deck.rows} onChange={(e) => void resizeDeck(projectId, deck.id, deck.cols, Number(e.target.value))} className="w-14 rounded-md border border-line bg-black/40 px-1.5 py-1 text-white" />
                  </label>
                  <span className="text-white/35">點擊格子播放到 Layer {ctl.selectedLayer + 1} · ✎ 設定</span>
                  <button
                    type="button"
                    onClick={() => {
                      if (window.confirm(`刪除 Deck「${deck.name}」與其中所有格子？`)) {
                        void deleteDeck(projectId, deck.id)
                        setDeckId(null)
                      }
                    }}
                    className="ml-auto rounded-md px-2 py-1 text-white/40 hover:bg-panic/20 hover:text-panic"
                  >
                    刪除 Deck
                  </button>
                </div>

                <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${deck.cols}, minmax(0, 1fr))` }} data-vj-grid>
                  {Array.from({ length: deck.cols * deck.rows }, (_, n) => {
                    const col = n % deck.cols
                    const row = Math.floor(n / deck.cols)
                    const slot = slotKey(col, row)
                    const clip = deck.clips[slot]
                    const on = playing.get(slot)
                    return (
                      <div key={slot} className="group relative aspect-video" data-vj-slot={slot}>
                        <button
                          type="button"
                          onClick={() => (clip ? ctl.triggerSlot(deck.id, slot) : setPickSlot(slot))}
                          className={`flex h-full w-full flex-col items-center justify-center gap-0.5 overflow-hidden rounded-lg border px-1 text-center transition active:scale-[0.97] ${
                            clip ? (on ? 'border-go bg-go/20' : 'border-line bg-raised hover:border-accent/70') : 'border-dashed border-white/12 bg-black/20 text-white/20 hover:border-accent/50 hover:text-white/50'
                          }`}
                          title={clip ? `${clip.name}（${clip.playMode} · ${clip.speed}×）` : '空格子：點擊指派素材'}
                        >
                          {clip ? (
                            <>
                              <span className="text-lg leading-none">{clip.mediaKind === 'image' ? '🖼' : '▶'}</span>
                              <span className="line-clamp-2 w-full text-[11px] leading-tight break-words">{clip.name || '（未命名）'}</span>
                            </>
                          ) : (
                            <span className="text-xl">＋</span>
                          )}
                        </button>
                        {clip && (
                          <>
                            <span className="pointer-events-none absolute top-1 left-1.5 text-[10px] text-white/50">{PLAY_ICON[clip.playMode]}</span>
                            {on && <span className="pointer-events-none absolute right-1.5 bottom-1 rounded bg-go px-1 text-[10px] font-bold text-black">L{on.join('·')}</span>}
                            <button type="button" onClick={() => setEditSlot(editSlot === slot ? null : slot)} className={`absolute top-0.5 right-0.5 h-6 w-6 rounded text-[11px] ${editSlot === slot ? 'bg-accent text-white' : 'text-white/40 opacity-0 group-hover:opacity-100 hover:bg-white/15 pointer-coarse:opacity-100'}`} aria-label="設定這個格子">
                              ✎
                            </button>
                          </>
                        )}
                      </div>
                    )
                  })}
                </div>

                {editing && editSlot && (
                  <ClipSettings
                    key={editing.id}
                    clip={editing}
                    target={`clip.${deck.id}.${editSlot}`}
                    ctl={ctl}
                    onPatch={(patch) => void patchClip(projectId, deck.id, editSlot, patch)}
                    onReplace={() => setPickSlot(editSlot)}
                    onRemove={() => {
                      void setClip(projectId, deck.id, editSlot, null)
                      setEditSlot(null)
                    }}
                  />
                )}
                {hint && <p className="mt-3 text-xs text-standby">{hint}</p>}
              </>
            )}

            <p className="mt-auto pt-4 text-[11px] leading-relaxed text-white/30">
              OSC 預設位址（不需學習）：/vj/layer/1/opacity 0~1 · /vj/layer/1/clear · /vj/xfade 0~1 · /vj/master 0~1 · /vj/live。其餘參數按各滑桿旁的「M」進行 MIDI / OSC Learn。
            </p>
          </section>

          {/* Monitor + mixer */}
          <aside className="flex min-h-0 flex-col gap-3 overflow-y-auto p-4">
            <div className="relative aspect-video w-full shrink-0 overflow-hidden rounded-xl border border-line bg-black">
              <VjStage mix={ctl.mix} clock={engine.serverNow} mode="preview" onError={setStageError} />
              <span className={`pointer-events-none absolute top-2 left-2 rounded px-1.5 py-0.5 text-[10px] font-bold ${ctl.mix.live ? 'bg-panic text-white' : 'bg-black/60 text-white/60'}`}>{ctl.mix.live ? 'LIVE' : 'PREVIEW'}</span>
              {stageError && <p className="absolute inset-0 flex items-center justify-center bg-black/80 p-4 text-center text-xs text-standby">{stageError}</p>}
            </div>
            <VjMixer mix={ctl.mix} onChange={ctl.update} ctl={ctl} />
          </aside>
        </div>

        <InboxPickerModal open={pickSlot != null} projectId={projectId} projectName={projectName} uploads={[]} cues={[]} onPick={() => {}} onPickMedia={pick} onClose={() => setPickSlot(null)} />
      </motion.div>
    </motion.div>
  )
}

function ClipSettings({ clip, target, ctl, onPatch, onReplace, onRemove }: { clip: VjClip; target: string; ctl: VjController; onPatch: (patch: Partial<Pick<VjClip, 'name' | 'playMode' | 'speed' | 'audio'>>) => void; onReplace: () => void; onRemove: () => void }) {
  const [name, setName] = useState(clip.name)
  return (
    <div className="mt-3 rounded-xl border border-accent/40 bg-black/30 p-3" data-vj-clip-settings>
      <div className="mb-2 flex items-center gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name !== clip.name && onPatch({ name })}
          className="min-w-0 flex-1 rounded-md border border-line bg-black/40 px-2 py-1.5 text-sm text-white outline-none focus:border-accent/80"
          aria-label="素材名稱"
        />
        <LearnButton target={target} ctl={ctl} />
        <button type="button" onClick={onReplace} className="rounded-md bg-white/[0.08] px-2 py-1.5 text-xs hover:bg-white/15">
          更換檔案
        </button>
        <button type="button" onClick={onRemove} className="rounded-md px-2 py-1.5 text-xs text-white/40 hover:bg-panic/20 hover:text-panic">
          移除
        </button>
      </div>
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr]">
        <div>
          <div className="mb-1 text-[11px] text-white/45">播放模式</div>
          <div className="flex overflow-hidden rounded-md border border-line" role="group">
            {VJ_PLAY_MODES.map((m) => (
              <button key={m.id} type="button" onClick={() => onPatch({ playMode: m.id })} aria-pressed={clip.playMode === m.id} className={`flex-1 px-1.5 py-1.5 text-[11px] ${clip.playMode === m.id ? 'bg-accent text-white' : 'bg-black/30 text-white/55 hover:text-white'}`} title={clip.mediaKind === 'image' ? '圖片不受播放模式影響' : undefined}>
                {m.label}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div className="mb-1 flex justify-between text-[11px] text-white/45">
            <span>播放速度</span>
            <span className="font-mono">{clip.speed.toFixed(2)}×</span>
          </div>
          <input type="range" min={VJ_SPEED_RANGE[0]} max={VJ_SPEED_RANGE[1]} step={0.05} value={clip.speed} onChange={(e) => onPatch({ speed: Number(e.target.value) })} className="fader h-5 w-full" style={{ '--fader-pct': `${((clip.speed - VJ_SPEED_RANGE[0]) / (VJ_SPEED_RANGE[1] - VJ_SPEED_RANGE[0])) * 100}%` } as CSSProperties} aria-label="播放速度" />
        </div>
      </div>
      {clip.mediaKind === 'video' && (
        <label className="mt-2 flex items-center gap-2 text-xs text-white/60">
          <input type="checkbox" checked={clip.audio} onChange={(e) => onPatch({ audio: e.target.checked })} />
          播放影片聲音（只在觀眾端輸出；控台預覽保持靜音）
        </label>
      )}
    </div>
  )
}
