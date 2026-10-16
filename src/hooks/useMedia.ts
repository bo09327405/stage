import { useEffect, useState } from 'react'

/** Live `matchMedia` result (false where it doesn't exist). */
export function useMedia(query: string) {
  const [matches, setMatches] = useState(() => typeof matchMedia === 'function' && matchMedia(query).matches)
  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const mq = matchMedia(query)
    const update = () => setMatches(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [query])
  return matches
}

/** A touch device (finger / pen): Set Cue switches from click-to-edit to tap-to-select + long-press-to-edit. */
export const useCoarsePointer = () => useMedia('(pointer: coarse)')

/** A phone or portrait tablet: Set Cue uses the stacked Go Button layout (the 3-column one needs ≥ 1024 px). */
export const useGoButtonLayout = () => useMedia('(pointer: coarse) and (max-width: 1023px)')
