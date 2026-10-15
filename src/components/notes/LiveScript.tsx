import { useCueMonitorState } from '../../hooks/useCueMonitorState'
import type { useTheatreEngine } from '../../hooks/useTheatreEngine'
import type { Cue } from '../../types/cue'
import { useMemo } from 'react'
import { NotionView } from './NotionView'
import { MarkedText, ScriptView } from './ScriptView'

const ignore = () => {}

/** ScriptView bound to the show: cue points light up as cues run, and tapping one puts it on standby. */
export function LiveScript({
  engine,
  cues,
  text,
  fontScale,
  follow,
  interactive = true,
  empty,
}: {
  engine: ReturnType<typeof useTheatreEngine>
  cues: Cue[]
  text: string
  fontScale?: number
  follow?: boolean
  interactive?: boolean
  empty?: string
}) {
  const { instances, standby } = useCueMonitorState(engine)
  const activeIds = new Set(instances.filter((i) => i.stopAt == null).map((i) => i.cue.id))
  return (
    <ScriptView
      text={text}
      cues={cues}
      activeIds={activeIds}
      standbyId={standby?.id ?? null}
      fontScale={fontScale}
      follow={follow}
      onCueTap={interactive ? (cue: Cue) => engine.standby(cue).catch(ignore) : undefined}
      empty={empty}
    />
  )
}

/**
 * A public Notion page bound to the show: "Q3" anywhere in the page becomes a live cue chip
 * (tap = standby), and with `follow` the standby cue's chip is kept in view.
 */
export function LiveNotion({
  engine,
  cues,
  url,
  fontScale,
  follow = false,
  interactive = true,
  compact = false,
  refreshSignal = 0,
}: {
  engine: ReturnType<typeof useTheatreEngine>
  cues: Cue[]
  url: string
  fontScale?: number
  follow?: boolean
  interactive?: boolean
  compact?: boolean
  refreshSignal?: number
}) {
  const { instances, standby } = useCueMonitorState(engine)
  const byNumber = useMemo(() => new Map(cues.map((c) => [c.cueNumber, c])), [cues])
  const activeIds = new Set(instances.filter((i) => i.stopAt == null).map((i) => i.cue.id))
  const standbyId = standby?.id ?? null
  const onCueTap = interactive ? (cue: Cue) => engine.standby(cue).catch(ignore) : undefined
  return (
    <NotionView
      url={url}
      fontScale={fontScale}
      compact={compact}
      followCueId={follow ? standbyId : null}
      refreshSignal={refreshSignal}
      renderText={(text) => <MarkedText text={text} byNumber={byNumber} activeIds={activeIds} standbyId={standbyId} onCueTap={onCueTap} />}
    />
  )
}
