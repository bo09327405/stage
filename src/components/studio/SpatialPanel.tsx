import { useEffect, useMemo, useRef } from 'react'
import { useSpatialProbe } from '../../hooks/useSpatialProbe'
import { firstRegionOf, regionSound } from '../../studio/audition'
import { decodeIamfUrl } from '../../studio/iamfDecoder'
import { normalizeIamfSource } from '../../types/spatialAudio'
import type { StudioPlayer } from '../../studio/player'
import { sortedTracks, type StudioProject, type StudioTrack } from '../../types/studio'
import type { SpatialFormat } from '../../types/spatialAudio'
import { AmbisonicsEditor } from './AmbisonicsEditor'
import { IamfEditor } from './IamfEditor'
import { Section } from './Inspector'
import { SpatialFormatBar } from './SpatialFormatBar'
import { TrajectoryPanel } from './TrajectoryPanel'

/**
 * Inspector tab "空間": the spatial treatment of the selected track — standard stereo, a trajectory (HRTF), an
 * Ambisonics soundfield or an Eclipsa (IAMF) mix — with the file's own header read for hints.
 */
export function SpatialPanel({
  studio,
  track,
  player,
  onTrack,
}: {
  studio: StudioProject
  track: StudioTrack | null
  player: StudioPlayer
  onTrack: (track: StudioTrack, patch: Partial<StudioTrack>, label: string) => void
}) {
  const region = track ? firstRegionOf(studio, track) : undefined
  const { probe, loading, error, reload } = useSpatialProbe(region?.url)
  // An Eclipsa track learns its mix presentations from the file as soon as they are read.
  useEffect(() => {
    if (!track || track.format !== 'eclipsa_iamf' || !probe?.iamf) return
    const next = normalizeIamfSource(probe.iamf)
    if (JSON.stringify(next) === JSON.stringify(track.iamfConfig.source) || JSON.stringify(next) === written.current) return
    written.current = JSON.stringify(next)
    onTrack(track, { iamfConfig: { ...track.iamfConfig, source: probe.iamf } }, `「${track.name}」讀取 IAMF 檔案資訊`)
  }, [probe, track, onTrack])
  const written = useRef('')
  const busCandidates = useMemo(() => (track ? sortedTracks(studio).filter((t) => t.id !== track.id && t.format === 'trajectory_binaural') : []), [studio, track])

  if (!track) return <p className="px-4 py-3 text-xs text-white/35">選取一個音軌以設定空間音訊</p>

  const setFormat = (format: SpatialFormat) =>
    onTrack(track, { format, trajectoryConfig: { ...track.trajectoryConfig, enabled: format === 'trajectory_binaural' } }, `「${track.name}」空間格式：${format}`)

  return (
    <div data-spatial-panel>
      <SpatialFormatBar title={track.name} format={track.format} onFormat={setFormat} probe={probe} probing={loading} probeError={error} />

      {track.format === 'standard' && <p className="px-4 py-3 text-xs leading-relaxed text-white/35">一般音軌：單聲道或立體聲，使用聲相旋鈕定位。選上方的格式可以把它變成 3D 軌跡、Ambisonics 聲場或 Eclipsa 混音。</p>}

      {track.format === 'trajectory_binaural' && <TrajectoryPanel studio={studio} track={track} player={player} onTrack={onTrack} />}

      {track.format === 'ambisonics' && (
        <AmbisonicsEditor
          title={track.name}
          resetKey={track.id}
          value={track.ambisonicsConfig}
          onSave={(next, label) => onTrack(track, { ambisonicsConfig: next }, `「${track.name}」${label}`)}
          channels={probe?.channels ?? null}
          durationSec={probe?.durationSec ?? region?.sourceDuration ?? null}
          audition={{
            context: () => player.context,
            output: () => player.output(),
            buffer: async () => (region ? regionSound(player.context, region) : null),
            hasOwnSound: !!region,
          }}
          liveRenderer={() => (player.playing ? player.ambiRenderer(track.id) : null)}
          bus={({ draft, commit }) =>
            busCandidates.length === 0 ? (
              <p className="text-[11px] leading-relaxed text-white/35">還沒有「軌跡雙耳」格式的音軌。把音軌改成軌跡雙耳並畫好路徑後，就能在這裡把它編碼進聲場。</p>
            ) : (
              <>
                <p className="text-[11px] leading-relaxed text-white/40">勾選的音軌不再用自己的 HRTF 定位，而是依它的軌跡編碼成 1 階 Ambisonics，和這個聲場一起旋轉、一起解碼。</p>
                {busCandidates.map((t) => {
                  const on = draft.busInputs.includes(t.id)
                  return (
                    <label key={t.id} className="flex min-h-8 items-center gap-2 text-xs text-white/70">
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={(e) => commit({ ...draft, busInputs: e.target.checked ? [...draft.busInputs, t.id] : draft.busInputs.filter((id) => id !== t.id) }, e.target.checked ? `「${t.name}」編碼進聲場` : `「${t.name}」移出聲場`)}
                      />
                      <span className="h-2.5 w-2.5 rounded-full" style={{ background: t.color }} />
                      <span className="flex-1 truncate">{t.name}</span>
                    </label>
                  )
                })}
              </>
            )
          }
        />
      )}

      {track.format === 'eclipsa_iamf' && (
        <IamfEditor
          title={track.name}
          resetKey={track.id}
          value={track.iamfConfig}
          onSave={(next, label) => onTrack(track, { iamfConfig: next }, `「${track.name}」${label}`)}
          probing={loading}
          audition={region ? { context: () => player.context, output: () => player.output(), decode: (cfg) => decodeIamfUrl(region.url, cfg) } : undefined}
          note={probe?.iamf ? undefined : probe && !loading ? 'Eclipsa 檔案的描述資料讀不到；請確認檔案是 IAMF（.iamf 或內含 IAMF 的 MP4 / M4A）' : undefined}
          onProbe={
            region
              ? () => {
                  reload()
                  if (probe?.iamf) onTrack(track, { iamfConfig: { ...track.iamfConfig, source: probe.iamf } }, `「${track.name}」更新 IAMF 檔案資訊`)
                }
              : undefined
          }
        />
      )}

      {!region && track.format !== 'standard' && track.format !== 'trajectory_binaural' && (
        <Section title="提示">
          <p className="text-[11px] text-white/40">這個音軌還沒有音檔：把 {track.format === 'ambisonics' ? '多聲道 .wav / .ogg' : '.iamf / .mp4 / .m4a'} 拖到時間軸（或到「素材」上傳），就會自動讀取格式。</p>
        </Section>
      )}
    </div>
  )
}
