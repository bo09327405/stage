import { useEffect, useState } from 'react'
import { useSpatialProbe } from '../../hooks/useSpatialProbe'
import { loadSpatialBuffer } from '../../services/spatialStage'
import type { SpatialProbe } from '../../studio/spatialProbe'
import { SPATIAL_FORMATS, type AmbisonicsConfig, type IamfConfig, type SpatialFormat } from '../../types/spatialAudio'
import type { TrajectoryConfig } from '../../types/trajectory'
import { AmbisonicsEditor } from '../studio/AmbisonicsEditor'
import { IamfEditor } from '../studio/IamfEditor'
import { SpatialFormatBar } from '../studio/SpatialFormatBar'
import { TrajectoryEditor } from '../studio/TrajectoryEditor'

/** One quiet AudioContext for auditioning in the console (the cue editor has no mixer of its own). */
let auditionCtx: AudioContext | null = null
const context = () => (auditionCtx ??= new AudioContext())

export interface CueSpatialValue {
  format: SpatialFormat
  trajectoryConfig: TrajectoryConfig
  ambisonicsConfig: AmbisonicsConfig
  iamfConfig: IamfConfig
}

/**
 * An audio cue's spatial treatment: a collapsed bar that opens the format switch and the editor of the chosen format
 * (3D trajectory, Ambisonics rotation, Eclipsa mix presentation). The cue's own file is what the audition plays; audience
 * phones play it through the same chains. Opened on demand, so the WebGL viewport only exists while it is being used.
 */
export function CueSpatial({
  title,
  url,
  value,
  onChange,
  onProbed,
}: {
  title: string
  url: string
  value: CueSpatialValue
  onChange: (patch: Partial<CueSpatialValue>) => void
  /** The file's header was read (the editor can fill in what it learns, e.g. the length of an IAMF file). */
  onProbed?: (probe: SpatialProbe) => void
}) {
  const [open, setOpen] = useState(false)
  const { probe, loading, error, reload } = useSpatialProbe(open ? url : null)
  useEffect(() => {
    if (probe) onProbed?.(probe)
  }, [probe, onProbed])
  // An Eclipsa cue learns its mix presentations from the file as soon as they are read.
  useEffect(() => {
    if (value.format === 'eclipsa_iamf' && probe?.iamf && !value.iamfConfig.source) onChange({ iamfConfig: { ...value.iamfConfig, source: probe.iamf } })
  }, [probe, value.format, value.iamfConfig, onChange])

  const setFormat = (format: SpatialFormat) => onChange({ format, trajectoryConfig: { ...value.trajectoryConfig, enabled: format === 'trajectory_binaural' } })
  const audition = {
    context,
    output: () => context().destination,
    buffer: () => loadSpatialBuffer(url),
    hasOwnSound: !!url,
  }
  const label = SPATIAL_FORMATS.find((f) => f.id === value.format)?.label ?? ''

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-white/[0.02]" data-cue-spatial>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex min-h-11 w-full items-center gap-2 px-3 text-left text-sm font-semibold text-white/80 hover:bg-white/[0.04]">
        <span aria-hidden>🎧</span>
        <span className="flex-1">空間音訊 · 3D / Ambisonics / Eclipsa</span>
        <span className={`rounded-md px-2 py-0.5 text-[10px] ${value.format !== 'standard' ? 'bg-accent text-white' : 'bg-white/10 text-white/45'}`}>{value.format === 'standard' ? '一般' : label}</span>
        <span className="text-white/40">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div>
          <SpatialFormatBar title={title || 'Cue'} format={value.format} onFormat={setFormat} probe={probe} probing={loading} probeError={error} />
          {value.format === 'trajectory_binaural' && (
            <TrajectoryEditor
              title={title || 'Cue'}
              color="#4dabf7"
              resetKey={url}
              value={value.trajectoryConfig}
              onSave={(next) => onChange({ trajectoryConfig: next, format: next.enabled ? 'trajectory_binaural' : 'standard' })}
              audition={audition}
            />
          )}
          {value.format === 'ambisonics' && (
            <AmbisonicsEditor
              title={title || 'Cue'}
              resetKey={url}
              value={value.ambisonicsConfig}
              onSave={(next) => onChange({ ambisonicsConfig: next })}
              channels={probe?.channels ?? null}
              durationSec={probe?.durationSec ?? null}
              audition={audition}
            />
          )}
          {value.format === 'eclipsa_iamf' && (
            <IamfEditor
              title={title || 'Cue'}
              resetKey={url}
              value={value.iamfConfig}
              onSave={(next) => onChange({ iamfConfig: next })}
              probing={loading}
              onProbe={() => {
                reload()
                if (probe?.iamf) onChange({ iamfConfig: { ...value.iamfConfig, source: probe.iamf } })
              }}
              note={probe && !probe.iamf && !loading ? '讀不到 IAMF 描述資料；請確認檔案是 .iamf 或內含 IAMF 的 MP4 / M4A' : undefined}
            />
          )}
          {value.format === 'standard' && <p className="px-4 py-3 text-xs leading-relaxed text-white/35">一般音訊：單聲道或立體聲。選上方格式，把這個 Cue 變成 3D 軌跡、Ambisonics 聲場或 Eclipsa 混音。</p>}
        </div>
      )}
    </div>
  )
}
