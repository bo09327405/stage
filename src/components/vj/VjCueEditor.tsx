import { useEffect, useMemo, useRef, useState } from 'react'
import { useVjDecks } from '../../services/vjDecks'
import { latestLiveVjMix } from '../../services/vjLive'
import { newMix, patchLayer, type VjClip, type VjMix } from '../../types/vj'
import { VjMixer } from './VjMixer'
import { VjStage } from './VjStage'

/** Layers of a snapshot start with the cue, not at the time they were captured. */
const rewind = (mix: VjMix): VjMix => ({ ...mix, live: false, layers: mix.layers.map((l) => ({ ...l, startedAt: 0 })) })

/**
 * The 🎬 VJ cue: which clip each layer plays, with blend modes, the A/B crossfader and effects. The cue stores a
 * snapshot of the clips, so it plays on any device without reading the decks.
 */
export function VjCueEditor({ projectId, value, onChange }: { projectId: string; value: VjMix | null; onChange: (mix: VjMix) => void }) {
  const decks = useVjDecks(projectId)
  const mix = value ?? newMix()
  const [run, setRun] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [captured, setCaptured] = useState<string | null>(null)
  const started = useRef(Date.now())
  // A new VJ cue starts from an empty mix.
  useEffect(() => {
    if (!value) onChange(newMix())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const options = useMemo(
    () =>
      (decks ?? []).flatMap((d) =>
        Object.entries(d.clips)
          .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
          .map(([slot, clip]) => ({ key: `${d.id}|${slot}`, label: `${d.name} · ${clip.name || slot}`, clip })),
      ),
    [decks],
  )
  const keyOf = (clip: VjClip | null) => (clip ? (options.find((o) => o.clip.id === clip.id || o.clip.src === clip.src)?.key ?? 'custom') : '')

  const change = (fn: (m: VjMix) => VjMix) => onChange(fn(mix))

  return (
    <div className="space-y-4" data-vj-cue-editor>
      <p className="text-xs leading-relaxed text-white/45">為每一層指定一個 Deck 素材，調整透明度、混合模式、A/B 推桿與特效。Cue 開始時所有素材同步開始播放。</p>

      <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-line bg-black">
        <VjStage key={run} mix={mix} clock={Date.now} origin={started.current} mode="preview" onError={setError} />
        {error && <p className="absolute inset-0 flex items-center justify-center bg-black/80 p-4 text-center text-xs text-standby">{error}</p>}
        <button
          type="button"
          onClick={() => {
            started.current = Date.now()
            setRun((n) => n + 1)
          }}
          className="absolute top-2 right-2 rounded-md bg-black/60 px-2 py-1 text-[11px] text-white/70 hover:bg-black/80 hover:text-white"
        >
          ↻ 重新播放預覽
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => {
            const live = latestLiveVjMix()
            if (live) {
              onChange(rewind(live))
              setCaptured('已擷取目前即時混音')
            } else setCaptured('目前沒有即時混音（請先開啟 VJ Deck）')
          }}
          className="rounded-lg bg-white/[0.08] px-3 py-2 text-xs text-white/80 hover:bg-white/15"
        >
          📷 擷取目前即時混音
        </button>
        {captured && <span className="text-[11px] text-white/45">{captured}</span>}
      </div>

      {decks && options.length === 0 && <p className="rounded-lg bg-white/[0.03] p-3 text-xs text-white/45">還沒有 Deck 素材。先在控台上方的「🎬 VJ」建立 Deck 並指派影片或圖片。</p>}

      <VjMixer
        mix={mix}
        onChange={change}
        clipControl={(i) => (
          <select
            value={keyOf(mix.layers[i].clip)}
            onChange={(e) => {
              const clip = options.find((o) => o.key === e.target.value)?.clip ?? null
              if (e.target.value !== 'custom') change((m) => patchLayer(m, i, { clip, startedAt: 0 }))
            }}
            className="w-full rounded-md border border-line bg-black/40 px-1.5 py-1 text-[11px] text-white outline-none focus:border-accent/80"
            aria-label={`Layer ${i + 1} 素材`}
          >
            <option value="">— 空 —</option>
            {mix.layers[i].clip && keyOf(mix.layers[i].clip) === 'custom' && <option value="custom">{mix.layers[i].clip?.name || '（擷取的素材）'}</option>}
            {options.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </select>
        )}
      />
    </div>
  )
}
