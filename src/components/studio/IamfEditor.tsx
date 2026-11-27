import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { checkIamfDecoder, iamfDecoderStatus, subscribeIamfStatus } from '../../studio/iamfDecoder'
import { activeMix, elementKey, normalizeIamf, type IamfConfig } from '../../types/spatialAudio'
import { Section, Slider } from './Inspector'

const db = (v: number) => `${v > 0 ? '+' : ''}${(Math.round(v * 10) / 10).toFixed(1)} dB`
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

export interface IamfEditorProps {
  title: string
  resetKey: string
  value: IamfConfig
  onSave: (next: IamfConfig, label: string) => void
  /** Re-read the file's header (after the file changed, or when it was never read). */
  onProbe?: () => void
  probing?: boolean
  /** What the last probe said that the designer should know. */
  note?: string
  /** Listen to the file with the current mix presentation and element gains (decoded by the IAMF decoder). */
  audition?: {
    context: () => AudioContext
    output: () => AudioNode
    /** Decode the file with these settings to binaural stereo. */
    decode: (config: IamfConfig) => Promise<AudioBuffer>
  }
}

/**
 * Eclipsa Audio (IAMF) editor: which mix presentation of the file to render (one file can carry several mixes — e.g.
 * an ambience version and a dialogue-forward version), a gain trim for each audio element of that mix, and head tracking.
 * Listening needs the IAMF decoder; without it the settings are still saved and applied once it is installed.
 */
export function IamfEditor({ title, resetKey, value, onSave, onProbe, probing, note, audition }: IamfEditorProps) {
  const [draft, setDraft] = useState<IamfConfig>(value)
  const draftRef = useRef(draft)
  const [gesture, setGesture] = useState(false)
  useEffect(() => {
    draftRef.current = draft
  })
  const storedKey = `${resetKey}:${JSON.stringify(value)}`
  const [syncedKey, setSyncedKey] = useState(storedKey)
  if (syncedKey !== storedKey && !gesture) {
    setSyncedKey(storedKey)
    setDraft(value)
  }
  const preview = (next: IamfConfig) => {
    setGesture(true)
    draftRef.current = next
    setDraft(next)
  }
  const commit = (next: IamfConfig, label: string) => {
    setGesture(false)
    const clean = normalizeIamf(next)
    draftRef.current = clean
    setDraft(clean)
    onSave(clean, label)
    // Listening: a different mix or gain is a different decode — carry on with the new one.
    if (auditioning && (clean.mixPresentationId !== draft.mixPresentationId || JSON.stringify(clean.elementGainOverrides) !== JSON.stringify(draft.elementGainOverrides))) void startAudition(clean)
  }

  const decoder = useSyncExternalStore(subscribeIamfStatus, iamfDecoderStatus)
  useEffect(() => {
    void checkIamfDecoder()
  }, [])

  /* ---------- audition: decode with the current settings and loop it ---------- */
  const [auditioning, setAuditioning] = useState(false)
  const [busy, setBusy] = useState(false)
  const [auditionNote, setAuditionNote] = useState('')
  const player = useRef<{ src: AudioBufferSourceNode; gain: GainNode } | null>(null)
  const startToken = useRef(0)
  const stopAudition = () => {
    startToken.current++
    try {
      player.current?.src.stop()
    } catch {
      // never started
    }
    player.current?.src.disconnect()
    player.current?.gain.disconnect()
    player.current = null
    setAuditioning(false)
  }
  const startAudition = async (config: IamfConfig) => {
    if (!audition) return
    const token = ++startToken.current
    setBusy(true)
    setAuditionNote('')
    try {
      const ctx = audition.context()
      await ctx.resume()
      const buffer = await audition.decode(config)
      if (token !== startToken.current) return
      player.current?.src.stop()
      const gain = new GainNode(ctx, { gain: 0.8 })
      const src = new AudioBufferSourceNode(ctx, { buffer, loop: true })
      src.connect(gain).connect(audition.output())
      src.start()
      player.current = { src, gain }
      setAuditioning(true)
    } catch (err) {
      setAuditionNote(`無法試聽：${(err as Error).message}`)
    } finally {
      if (token === startToken.current) setBusy(false)
    }
  }
  useEffect(() => () => stopAudition(), [resetKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const src = draft.source
  const mix = activeMix(draft)
  const gainOf = (id: number) => draft.elementGainOverrides[elementKey(id)] ?? 0
  const setGain = (id: number, v: number) => {
    const gains = { ...draftRef.current.elementGainOverrides }
    if (Math.abs(v) < 0.05) delete gains[elementKey(id)]
    else gains[elementKey(id)] = Math.round(v * 10) / 10
    return { ...draftRef.current, elementGainOverrides: gains }
  }

  return (
    <div data-iamf-panel>
      <Section
        title={`Eclipsa Audio (IAMF) · ${title}`}
        right={
          onProbe && (
            <button type="button" onClick={onProbe} disabled={probing} className="text-[11px] text-white/40 hover:text-white disabled:opacity-40">
              {probing ? '讀取中…' : '重新讀取檔案資訊'}
            </button>
          )
        }
      >
        {!decoder.available && <p className="rounded-md bg-amber-500/15 px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-200">{decoder.reason}。設定會先存下來。</p>}
        {src ? (
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
            <dt className="text-white/40">編碼</dt>
            <dd className="text-right font-mono text-white/80">{src.codecs.join(' + ') || '—'}</dd>
            <dt className="text-white/40">Profile</dt>
            <dd className="text-right font-mono text-white/80">
              {src.primaryProfile}
              {src.additionalProfile !== src.primaryProfile ? ` / ${src.additionalProfile}` : ''}
            </dd>
            <dt className="text-white/40">音訊元素</dt>
            <dd className="text-right font-mono text-white/80">{src.elements.length}</dd>
            <dt className="text-white/40">混音版本</dt>
            <dd className="text-right font-mono text-white/80">{src.mixes.length}</dd>
            {src.durationSec != null && (
              <>
                <dt className="text-white/40">長度</dt>
                <dd className="text-right font-mono text-white/80">{mmss(src.durationSec)}</dd>
              </>
            )}
          </dl>
        ) : (
          <p className="text-[11px] leading-relaxed text-white/45">還沒有讀到檔案內容。上傳 .iamf、.mp4 或 .m4a 後會自動解析；也可以按右上角重新讀取。</p>
        )}
        {note && <p className="text-[11px] text-amber-300/80">{note}</p>}
      </Section>

      {src && src.mixes.length > 0 && (
        <Section title="混音版本 Mix Presentation">
          <select
            value={mix?.id ?? ''}
            onChange={(e) => commit({ ...draftRef.current, mixPresentationId: Number(e.target.value) }, '切換混音版本')}
            className="w-full rounded-lg border border-white/15 bg-black/40 px-2.5 py-2 text-xs text-white outline-none focus:border-accent"
            aria-label="Mix Presentation"
            data-iamf-mix
          >
            {src.mixes.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
                {m.language ? ` · ${m.language}` : ''}（#{m.id}，{m.elements.length} 個元素）
              </option>
            ))}
          </select>
          <p className="text-[10px] leading-relaxed text-white/35">同一份檔案可以含多個混音版本（例如環境音版、旁白強調版）；這裡選的版本會用來渲染，Studio 與觀眾端一致。</p>
        </Section>
      )}

      {mix && (
        <Section title="音訊元素增益 Audio Elements">
          {mix.elements.length === 0 && <p className="text-[11px] text-white/40">這個混音版本沒有可調的元素。</p>}
          {mix.elements.map((el) =>
            el.gainRange ? (
              <div key={el.id} data-iamf-element={el.id}>
                <Slider
                  label={`${el.name}（#${el.id}）`}
                  value={Math.min(el.gainRange.max, Math.max(el.gainRange.min, gainOf(el.id)))}
                  min={el.gainRange.min}
                  max={el.gainRange.max}
                  step={0.5}
                  display={`${db(el.defaultGainDb + gainOf(el.id))}${gainOf(el.id) ? `（${db(gainOf(el.id))}）` : ''}`}
                  reset={0}
                  onChange={(v) => preview(normalizeIamf(setGain(el.id, v)))}
                  onCommit={(v) => commit(setGain(el.id, v), `元素「${el.name}」增益`)}
                  accent="#bf5af2"
                />
                <div className="mt-0.5 text-[10px] text-white/30">
                  混音預設 {db(el.defaultGainDb)}；檔案允許微調 {db(el.gainRange.min)} ~ {db(el.gainRange.max)}
                </div>
              </div>
            ) : (
              <div key={el.id} data-iamf-element={el.id} className="flex items-center justify-between gap-2 rounded-md bg-white/[0.04] px-2.5 py-2 text-[11px]">
                <span className="text-white/70">
                  {el.name}（#{el.id}）
                </span>
                <span className="text-right text-white/35">{db(el.defaultGainDb)} · 檔案未開放增益微調</span>
              </div>
            ),
          )}
          {Object.keys(draft.elementGainOverrides).length > 0 && (
            <button type="button" onClick={() => commit({ ...draftRef.current, elementGainOverrides: {} }, '重設元素增益')} className="text-[11px] text-white/40 hover:text-white">
              全部重設
            </button>
          )}
        </Section>
      )}

      <Section title="試聽">
        <button
          type="button"
          disabled={!audition || !decoder.available || busy}
          onClick={() => (auditioning ? stopAudition() : void startAudition(draftRef.current))}
          aria-pressed={auditioning}
          title={decoder.available ? '' : decoder.reason}
          className={`min-h-8 rounded-md px-3 text-[11px] font-semibold disabled:opacity-35 ${auditioning ? 'bg-accent text-white' : 'bg-white/[0.07] text-white/70 hover:bg-white/14'}`}
          data-iamf-audition
        >
          {busy ? '解碼中…' : auditioning ? '■ 停止' : '▶ 試聽這個混音版本'}
        </button>
        <p className="text-[10px] leading-relaxed text-white/35">用目前選的混音版本與元素增益渲染成雙耳，循環播放；切換版本時會重新解碼。</p>
        {auditionNote && <p className="text-[11px] text-amber-300/80">{auditionNote}</p>}
      </Section>

      <Section title="觀眾端 · 頭部追蹤">
        <button
          type="button"
          aria-pressed={draft.bindHeadTracking}
          onClick={() => commit({ ...draftRef.current, bindHeadTracking: !draft.bindHeadTracking }, draft.bindHeadTracking ? '關閉頭部追蹤' : '開啟頭部追蹤')}
          className={`min-h-8 rounded-md px-3 text-[11px] font-semibold ${draft.bindHeadTracking ? 'bg-accent text-white' : 'bg-white/[0.07] text-white/70 hover:bg-white/14'}`}
        >
          {draft.bindHeadTracking ? '✓ 跟隨觀眾轉頭' : '固定朝向舞台'}
        </button>
        <p className="text-[10px] leading-relaxed text-white/35">
          開啟後，觀眾端會邊播邊解碼，聲音隨手機陀螺儀或 XR 視角轉動，轉頭後聲音留在原本的方位（反應約 0.15 秒）。這比預先解碼更吃效能；瀏覽器不支援即時解碼時，會自動改用固定朝向的版本。Studio 裡的試聽不含頭部追蹤。
        </p>
      </Section>
    </div>
  )
}
