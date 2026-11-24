import { SPATIAL_FORMATS, type SpatialFormat } from '../../types/spatialAudio'
import type { SpatialProbe } from '../../studio/spatialProbe'
import { Section } from './Inspector'

const FORMAT_LABEL = Object.fromEntries(SPATIAL_FORMATS.map((f) => [f.id, f.label])) as Record<SpatialFormat, string>

/** One line on what the file is, from its header. */
function probeSummary(p: SpatialProbe): string {
  const bits: string[] = []
  if (p.container !== 'unknown') bits.push(`${p.container.toUpperCase()}${p.codec ? ` · ${p.codec}` : ''}`)
  if (p.channels) bits.push(`${p.channels} 聲道`)
  if (p.sampleRate) bits.push(`${Math.round(p.sampleRate / 100) / 10} kHz`)
  if (p.ambisonics) bits.push(`Ambisonics ${p.ambisonics.order} 階（${p.ambisonics.channelLayout === 'FUMA' ? 'FuMa' : 'AmbiX'}${p.ambisonics.certain ? '' : '，推測'}）`)
  if (p.iamf) bits.push(`IAMF：${p.iamf.mixes.length} 個混音版本 / ${p.iamf.elements.length} 個元素`)
  return bits.join(' · ')
}

/**
 * The format switch (standard / trajectory / Ambisonics / Eclipsa) with what the file's header says: a suggestion
 * to switch when the file looks like a soundfield or an IAMF mix.
 */
export function SpatialFormatBar({
  title,
  format,
  onFormat,
  probe,
  probing,
  probeError,
}: {
  title: string
  format: SpatialFormat
  onFormat: (format: SpatialFormat) => void
  probe?: SpatialProbe | null
  probing?: boolean
  probeError?: string | null
}) {
  const suggest = probe && probe.suggestedFormat !== format && probe.suggestedFormat !== 'standard' ? probe.suggestedFormat : null
  return (
    <Section title={`空間音訊格式 · ${title}`}>
      <div className="grid grid-cols-2 gap-1" role="tablist">
        {SPATIAL_FORMATS.map((f) => (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={format === f.id}
            title={f.hint}
            onClick={() => format !== f.id && onFormat(f.id)}
            className={`min-h-9 rounded-md px-1.5 text-[11px] font-semibold ${format === f.id ? 'bg-accent text-white' : 'bg-white/[0.06] text-white/55 hover:text-white/85'}`}
            data-spatial-format={f.id}
          >
            {f.label}
          </button>
        ))}
      </div>
      <p className="text-[10px] leading-relaxed text-white/35">{SPATIAL_FORMATS.find((f) => f.id === format)?.hint}</p>
      {probing && <p className="text-[11px] text-white/40">讀取檔案資訊…</p>}
      {probeError && <p className="text-[11px] text-amber-300/80">讀不到檔案資訊：{probeError}</p>}
      {probe && !probing && (
        <div className="space-y-1 rounded-md bg-white/[0.05] px-2.5 py-2 text-[11px] text-white/60" data-spatial-probe>
          <div>{probeSummary(probe) || '無法辨識檔案格式'}</div>
          {probe.notes.map((n) => (
            <div key={n} className="text-amber-200/80">
              {n}
            </div>
          ))}
          {suggest && (
            <button type="button" onClick={() => onFormat(suggest)} className="mt-1 rounded-md bg-accent px-2.5 py-1 text-[11px] font-semibold text-white">
              偵測到可能是 {FORMAT_LABEL[suggest]}，改用這個格式
            </button>
          )}
        </div>
      )}
    </Section>
  )
}
