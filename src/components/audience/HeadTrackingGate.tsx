import { useEffect, useState } from 'react'
import { stageAudio } from '../../services/audioEngine'
import { headTracker, headTrackingNeedsTap, type HeadPermission } from '../../services/headTracking'

/**
 * Offers the gyroscope as the head while a sound that follows the head is playing: iOS needs a tap for the permission,
 * Android starts by itself. Shows a small "對正" button while it runs (the way the phone points becomes the stage front).
 * Nothing is shown when no playing sound wants it.
 */
export function HeadTrackingGate() {
  const [wanted, setWanted] = useState(false)
  const [state, setState] = useState<HeadPermission | 'idle'>('idle')

  useEffect(() => {
    stageAudio.onHeadWanted = setWanted
    return () => {
      stageAudio.onHeadWanted = () => {}
      headTracker.stop()
    }
  }, [])

  useEffect(() => {
    if (!wanted) {
      headTracker.stop()
      return
    }
    // Android and desktop browsers need no permission: start at once.
    if (!headTrackingNeedsTap() && state === 'idle') void headTracker.start().then(setState)
  }, [wanted, state])

  if (!wanted) return null
  const running = headTracker.active
  if (state === 'unsupported') return null
  if (state === 'denied')
    return <div className="absolute bottom-[max(3.5rem,env(safe-area-inset-bottom))] left-3 z-20 rounded-full bg-black/70 px-3 py-1.5 text-[11px] text-white/60">頭部追蹤未開啟（沒有取得動作感測權限）</div>
  if (!running)
    return (
      <button
        type="button"
        onClick={() => void headTracker.start().then(setState)}
        className="absolute bottom-[max(3.5rem,env(safe-area-inset-bottom))] left-3 z-20 rounded-full bg-white px-4 py-2 text-xs font-semibold text-black shadow-lg"
        data-head-tracking-start
      >
        🎧 開啟頭部追蹤
      </button>
    )
  return (
    <button
      type="button"
      onClick={() => headTracker.recentre()}
      className="absolute bottom-[max(3.5rem,env(safe-area-inset-bottom))] left-3 z-20 rounded-full bg-black/70 px-3 py-1.5 text-[11px] text-white/80 backdrop-blur"
      title="把手機現在指的方向當成舞台正前方"
      data-head-tracking-recentre
    >
      🎧 頭部追蹤中 · 點一下對正
    </button>
  )
}
