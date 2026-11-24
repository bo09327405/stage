import { useMemo } from 'react'
import { bufferOffset, regionBuffer } from '../../studio/audio'
import type { StudioPlayer } from '../../studio/player'
import { effectiveTrajectory, trackPathOrigin } from '../../studio/spatial'
import { sortedTracks, type StudioProject, type StudioRegion, type StudioTrack } from '../../types/studio'
import { normalizeTrajectory, type TrajectoryConfig } from '../../types/trajectory'
import { TrajectoryEditor } from './TrajectoryEditor'

/** The part of a region the audition loops: its trimmed stretch of the processed source. */
async function regionSound(ctx: AudioContext, region: StudioRegion): Promise<AudioBuffer> {
  const buf = await regionBuffer(region)
  const from = Math.min(buf.length - 1, Math.round(bufferOffset(region, buf) * buf.sampleRate))
  const len = Math.max(1, Math.min(buf.length - from, Math.round(region.duration * buf.sampleRate)))
  const out = ctx.createBuffer(buf.numberOfChannels, len, buf.sampleRate)
  for (let c = 0; c < buf.numberOfChannels; c++) out.copyToChannel(buf.getChannelData(c).subarray(from, from + len), c)
  return out
}

/**
 * Inspector tab "空間": a studio track's 3D sound trajectory (the editor itself is shared with the cue editor). This
 * adds what only a studio has: the track's own audio for the audition, the transport as the path clock, and
 * the group of tracks that chase the same path.
 */
export function TrajectoryPanel({
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
  const trackId = track?.id ?? ''
  const followers = useMemo(() => sortedTracks(studio).filter((t) => t.id !== trackId && t.trajectoryConfig.enabled && t.trajectoryConfig.pathSourceTrackId === trackId), [studio, trackId])
  const extraDots = useMemo(() => followers.map((f) => ({ color: f.color, cfg: effectiveTrajectory(studio, f) })), [followers, studio])
  const resolve = useMemo(() => (track ? (cfg: TrajectoryConfig) => effectiveTrajectory(studio, { ...track, trajectoryConfig: cfg }) : undefined), [studio, track])

  if (!track) return <p className="px-4 py-3 text-xs text-white/35">選取一個音軌以設定 3D 空間軌跡</p>

  const firstRegion = () =>
    Object.values(studio.regions)
      .filter((r) => r.trackId === track.id && !r.muted)
      .sort((a, b) => a.start - b.start)[0]
  const followedTrack = track.trajectoryConfig.pathSourceTrackId ? studio.tracks[track.trajectoryConfig.pathSourceTrackId] : undefined

  const setFollow = (tr: StudioTrack, follow: boolean) => {
    const base = tr.trajectoryConfig
    const n = followers.length + (follow ? 1 : 0)
    const phase = follow ? (followers.length + 1) / (n + 1) : 0
    const next = normalizeTrajectory({ ...base, enabled: follow ? true : base.enabled, pathSourceTrackId: follow ? track.id : '', playback: { ...base.playback, phaseOffset: phase } })
    onTrack(tr, { trajectoryConfig: next }, follow ? `「${tr.name}」跟隨「${track.name}」的路徑` : `「${tr.name}」取消跟隨路徑`)
  }
  const others = sortedTracks(studio).filter((t) => t.id !== track.id && (!t.trajectoryConfig.pathSourceTrackId || t.trajectoryConfig.pathSourceTrackId === track.id))

  return (
    <TrajectoryEditor
      title={track.name}
      color={track.color}
      resetKey={track.id}
      value={track.trajectoryConfig}
      onSave={(next, label) => onTrack(track, { trajectoryConfig: next }, `「${track.name}」${label}`)}
      resolve={resolve}
      followedName={followedTrack?.name}
      extraDots={extraDots}
      audition={{
        context: () => player.context,
        output: () => player.output(),
        buffer: async () => {
          const region = firstRegion()
          return region ? regionSound(player.context, region) : null
        },
        hasOwnSound: !!firstRegion(),
      }}
      clock={() => (player.playing ? Math.max(0, player.position() - trackPathOrigin(studio, track.id)) : null)}
      group={({ draft, commit }) =>
        followedTrack ? (
          <button type="button" onClick={() => commit({ ...draft, pathSourceTrackId: '' }, '取消跟隨路徑')} className="min-h-8 rounded-md bg-white/[0.07] px-2.5 text-[11px] text-white/70 hover:bg-white/14">
            停止跟隨「{followedTrack.name}」，改用自己的路徑
          </button>
        ) : (
          <>
            <p className="text-[11px] text-white/40">勾選要追逐這條路徑的音軌；它們會依序錯開相位（例如 4 個聲源相隔 0.25 環繞包圍）。</p>
            {others.length === 0 && <p className="text-[11px] text-white/30">沒有其他音軌</p>}
            {others.map((t) => {
              const on = t.trajectoryConfig.pathSourceTrackId === track.id
              return (
                <label key={t.id} className="flex min-h-8 items-center gap-2 text-xs text-white/70">
                  <input type="checkbox" checked={on} onChange={(e) => setFollow(t, e.target.checked)} />
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: t.color }} />
                  <span className="flex-1 truncate">{t.name}</span>
                  {on && <span className="font-mono text-[10px] text-white/45">相位 {t.trajectoryConfig.playback.phaseOffset.toFixed(2)}</span>}
                </label>
              )
            })}
            {followers.length > 0 && (
              <button
                type="button"
                className="min-h-8 rounded-md bg-white/[0.07] px-2.5 text-[11px] font-semibold text-white/70 hover:bg-white/14"
                title="這條路徑與所有跟隨它的音軌，相位平均分配"
                onClick={() => {
                  const n = followers.length + 1
                  followers.forEach((f, i) =>
                    onTrack(f, { trajectoryConfig: normalizeTrajectory({ ...f.trajectoryConfig, playback: { ...f.trajectoryConfig.playback, phaseOffset: (i + 1) / n } }) }, `「${f.name}」路徑相位`),
                  )
                  commit({ ...draft, playback: { ...draft.playback, phaseOffset: 0 } }, '路徑相位 0')
                }}
              >
                均分相位（{followers.length + 1} 個聲源）
              </button>
            )}
          </>
        )
      }
    />
  )
}
