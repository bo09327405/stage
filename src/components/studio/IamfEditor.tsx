import { useEffect, useRef, useState } from 'react'
import { iamfDecoderStatus } from '../../studio/iamfDecoder'
import { ELEMENT_GAIN_RANGE, activeMix, elementKey, normalizeIamf, type IamfConfig } from '../../types/spatialAudio'
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
}

/**
 * Eclipsa Audio (IAMF) editor: which mix presentation of the file to render (one file can carry several mixes — e.g.
 * an ambience version and a dialogue-forward version), a gain trim for each audio element of that mix, and head tracking.
 * Listening needs the IAMF decoder; without it the settings are still saved and applied once it is installed.
 */
export function IamfEditor({ title, resetKey, value, onSave, onProbe, probing, note }: IamfEditorProps) {
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
  }

  const decoder = iamfDecoderStatus()
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
        {!decoder.available && <p className="rounded-md bg-amber-500/15 px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-200">{decoder.reason}。設定會先存下來，解碼器安裝後即生效。</p>}
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
          {mix.elements.map((el) => (
            <div key={el.id} data-iamf-element={el.id}>
              <Slider
                label={`${el.name}（#${el.id}）`}
                value={gainOf(el.id)}
                min={ELEMENT_GAIN_RANGE.min}
                max={ELEMENT_GAIN_RANGE.max}
                step={0.5}
                display={`${db(el.defaultGainDb + gainOf(el.id))}${gainOf(el.id) ? `（${db(gainOf(el.id))}）` : ''}`}
                reset={0}
                onChange={(v) => preview(normalizeIamf(setGain(el.id, v)))}
                onCommit={(v) => commit(setGain(el.id, v), `元素「${el.name}」增益`)}
                accent="#bf5af2"
              />
              <div className="mt-0.5 text-[10px] text-white/30">混音預設 {db(el.defaultGainDb)} ＋ 微調</div>
            </div>
          ))}
          {Object.keys(draft.elementGainOverrides).length > 0 && (
            <button type="button" onClick={() => commit({ ...draftRef.current, elementGainOverrides: {} }, '重設元素增益')} className="text-[11px] text-white/40 hover:text-white">
              全部重設
            </button>
          )}
        </Section>
      )}

      <Section title="試聽">
        <button type="button" disabled title={decoder.available ? '' : decoder.reason} className="min-h-8 rounded-md bg-white/[0.07] px-3 text-[11px] font-semibold text-white/70 disabled:opacity-35">
          ▶ 試聽這個混音版本
        </button>
        <p className="text-[10px] leading-relaxed text-white/35">{decoder.available ? '用目前選的混音版本與元素增益即時渲染成雙耳。' : '需要 IAMF 解碼器才能試聽。'}</p>
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
        <p className="text-[10px] leading-relaxed text-white/35">觀眾開啟陀螺儀或進入 XR 時，聲場隨頭部朝向旋轉。</p>
      </Section>
    </div>
  )
}
