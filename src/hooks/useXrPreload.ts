import { useEffect } from 'react'
import { activeList, cueTargets, type ShowState } from '../types/cue'
import { xrAssets } from '../types/xr'

/**
 * Downloads the files of the XR cues this device is about to show, ahead of time: the STANDBY cue and any XR
 * cue that has been fired but is still in its Pre-Wait. Only cues aimed at this device's code and group count,
 * so other channels never fetch (or hold in memory) a scene they won't see.
 *
 * The files are held while the cue stays next; the player takes them over at GO (services/xrAssets.ts), and
 * they are freed once neither holds them.
 */
export function useXrPreload(showState: ShowState, audienceId: string, channel: string | null) {
  const cues = [showState.standbyCue, ...activeList(showState).filter((a) => a.stopAt == null).map((a) => a.cue)].filter(
    (cue) => cue?.type === 'AUDIENCE_XR' && cue.xr && cueTargets(cue, audienceId, channel),
  )
  const wanted = cues.map((cue) => xrAssets(cue!.xr))
  const models = [...new Set(wanted.flatMap((w) => w.models))].sort()
  // Panoramas and picture / video screens load the same way.
  const panos = [...new Map(wanted.flatMap((w) => [...w.screens, ...(w.pano ? [w.pano] : [])].map((p) => [`${p.kind}:${p.url}`, p] as const))).values()]
  const key = models.length || panos.length ? JSON.stringify({ models, panos }) : ''

  useEffect(() => {
    if (!key) return
    const { models, panos } = JSON.parse(key) as { models: string[]; panos: { url: string; kind: 'image' | 'video' }[] }
    let cancelled = false
    let release = () => {}
    // Three.js is only fetched by devices that actually get an XR cue.
    void import('../services/xrAssets').then(({ acquireModel, acquirePano }) => {
      if (cancelled) return
      const leases = [...models.map((url) => acquireModel(url)), ...panos.map((p) => acquirePano(p.url, p.kind))]
      leases.forEach((l) => l.promise.catch(() => {}))
      release = () => leases.forEach((l) => l.release())
    })
    return () => {
      cancelled = true
      release()
    }
  }, [key])
}
