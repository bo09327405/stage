import { useCallback, useEffect, useState } from 'react'
import { enrichIamfSource } from '../studio/iamfDecoder'
import { probeSpatialUrl, type SpatialProbe } from '../studio/spatialProbe'

const cache = new Map<string, SpatialProbe>()

/**
 * What the file behind `url` is (channels, Ambisonics, IAMF contents), read from its header: a few megabytes at most.
 * Cached per URL; `reload()` reads it again.
 */
export function useSpatialProbe(url: string | null | undefined) {
  const [state, setState] = useState<{ url: string; probe: SpatialProbe | null; error: string | null } | null>(null)
  const [loadingUrl, setLoadingUrl] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (!url) return
    const cached = nonce === 0 ? cache.get(url) : undefined
    if (cached) {
      setState({ url, probe: cached, error: null })
      return
    }
    const ctl = new AbortController()
    setLoadingUrl(url)
    probeSpatialUrl(url, ctl.signal)
      // An Eclipsa file: the decoder adds what the header alone does not say (the range each element may be trimmed within).
      .then(async (probe) => (probe.iamf ? { ...probe, iamf: await enrichIamfSource(url, probe.iamf) } : probe))
      .then(
      (probe) => {
        cache.set(url, probe)
        if (!ctl.signal.aborted) setState({ url, probe, error: null })
      },
      (err: Error) => !ctl.signal.aborted && setState({ url, probe: null, error: err.message }),
    ).finally(() => !ctl.signal.aborted && setLoadingUrl((u) => (u === url ? null : u)))
    return () => ctl.abort()
  }, [url, nonce])

  const reload = useCallback(() => setNonce((n) => n + 1), [])
  const current = state && state.url === url ? state : null
  return { probe: current?.probe ?? null, error: current?.error ?? null, loading: !!url && loadingUrl === url, reload }
}
