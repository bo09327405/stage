import type { StudioProject, StudioRegion, StudioTrack } from '../types/studio'
import { bufferOffset, regionBuffer } from './audio'

/** The part of a region an audition loops: its trimmed stretch of the processed source, all channels kept. */
export async function regionSound(ctx: BaseAudioContext, region: StudioRegion): Promise<AudioBuffer> {
  const buf = await regionBuffer(region)
  const from = Math.min(buf.length - 1, Math.round(bufferOffset(region, buf) * buf.sampleRate))
  const len = Math.max(1, Math.min(buf.length - from, Math.round(region.duration * buf.sampleRate)))
  const out = ctx.createBuffer(buf.numberOfChannels, len, buf.sampleRate)
  for (let c = 0; c < buf.numberOfChannels; c++) out.copyToChannel(buf.getChannelData(c).subarray(from, from + len), c)
  return out
}

/** A track's first region that makes sound (earliest start). */
export const firstRegionOf = (studio: StudioProject, track: StudioTrack): StudioRegion | undefined =>
  Object.values(studio.regions)
    .filter((r) => r.trackId === track.id && !r.muted)
    .sort((a, b) => a.start - b.start)[0]
