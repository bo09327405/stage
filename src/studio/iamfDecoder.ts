import type { IamfConfig } from '../types/spatialAudio'
import type { StudioRegion } from '../types/studio'
import { SAMPLE_RATE } from './audio'

/*
 * The IAMF (Eclipsa Audio) decoder seam. Browsers cannot decode IAMF, so playback needs a libiamf WebAssembly
 * build behind an AudioWorklet (not part of this app yet). Until it is installed, an IAMF region is silent in the
 * studio mix — its descriptors can still be read and edited (mix presentation, element gains) — and `status()` says
 * why, so the interface can tell the designer instead of failing.
 */

export interface IamfDecoderStatus {
  available: boolean
  reason: string
}

export const iamfDecoderStatus = (): IamfDecoderStatus => ({
  available: false,
  reason: '尚未安裝 libiamf（WebAssembly）解碼器：目前可解析檔案內容與編輯混音設定，但還不能試聽或播放',
})

let warned = false

/** The binaural stereo of an IAMF region for the given settings; silent until a decoder is installed. */
export async function iamfRegionBuffer(region: Pick<StudioRegion, 'sourceDuration' | 'duration'>, _config: IamfConfig): Promise<AudioBuffer> {
  if (!warned) {
    warned = true
    console.warn(iamfDecoderStatus().reason)
  }
  const seconds = Math.max(0.1, region.sourceDuration || region.duration)
  return new AudioBuffer({ numberOfChannels: 2, length: Math.ceil(seconds * SAMPLE_RATE), sampleRate: SAMPLE_RATE })
}
