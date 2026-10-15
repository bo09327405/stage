import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import type { Cue } from '../../types/cue'

/** "Q3", "q12.5", "[Q4]" … anywhere in a line marks a cue point. */
const MARKER = /\bQ(\d+(?:\.\d+)?)\b/gi

interface ScriptViewProps {
  text: string
  cues: Cue[]
  /** Cue ids running now (green) and the standby cue (yellow). */
  activeIds: Set<string>
  standbyId: string | null
  /** Text size multiplier. */
  fontScale?: number
  /** Keep the line of the standby (or else running) cue in view. */
  follow?: boolean
  /** Tapping a cue marker; absent = markers are not clickable. */
  onCueTap?: (cue: Cue) => void
  empty?: ReactNode
}

/**
 * Script / notes text with live cue points: every "Q<number>" becomes a chip coloured by the cue's
 * state, its line is highlighted, and the view can scroll itself to the next cue to call.
 * "# …" lines are headings, "角色：台詞" lines show the speaker in bold.
 */
export function ScriptView({ text, cues, activeIds, standbyId, fontScale = 1, follow = false, onCueTap, empty }: ScriptViewProps) {
  const byNumber = useMemo(() => new Map(cues.map((c) => [c.cueNumber, c])), [cues])
  const lines = useMemo(() => text.split('\n'), [text])
  const box = useRef<HTMLDivElement>(null)

  const lineCues = (line: string) => [...line.matchAll(MARKER)].map((m) => byNumber.get(Number(m[1]))).filter((c): c is Cue => !!c)
  // The line to keep in view: the standby cue's, else a running cue's.
  const standbyLine = standbyId ? lines.findIndex((l) => lineCues(l).some((c) => c.id === standbyId)) : -1
  const target = standbyLine >= 0 ? standbyLine : lines.findIndex((l) => lineCues(l).some((c) => activeIds.has(c.id)))

  // Scroll inside this box only (never the page) so the target line sits in the upper third.
  useEffect(() => {
    if (!follow || target < 0 || !box.current) return
    const row = box.current.querySelector<HTMLElement>(`[data-line="${target}"]`)
    if (row) box.current.scrollTo({ top: row.offsetTop - box.current.clientHeight / 3, behavior: 'smooth' })
  }, [follow, target])

  if (!text.trim()) return <div className="p-3 text-sm text-white/35">{empty ?? '（尚無內容）'}</div>

  return (
    <div
      ref={box}
      className="relative h-full overflow-y-auto overscroll-contain px-3 py-2 leading-relaxed break-words touch-pan-y"
      style={{ fontSize: `calc(0.9rem * ${fontScale})` }}
      data-script-view
    >
      {lines.map((line, i) => {
        const marked = lineCues(line)
        const isActive = marked.some((c) => activeIds.has(c.id))
        const isStandby = marked.some((c) => c.id === standbyId)
        const heading = line.startsWith('#')
        const speaker = !heading ? /^([^：:\s]{1,12})[：:]/.exec(line) : null
        return (
          <div
            key={i}
            data-line={i}
            className={`relative min-h-[1.5em] rounded px-2 whitespace-pre-wrap ${
              isActive ? 'bg-go/10' : isStandby ? 'bg-standby/10' : ''
            } ${heading ? 'mt-2 font-bold text-white' : 'text-white/80'}`}
          >
            {(isActive || isStandby) && <span className={`absolute inset-y-0.5 left-0 w-0.5 rounded ${isActive ? 'bg-go' : 'bg-standby'}`} />}
            {speaker ? (
              <>
                <b className="text-white">{speaker[0]}</b>
                <MarkedText text={line.slice(speaker[0].length)} byNumber={byNumber} activeIds={activeIds} standbyId={standbyId} onCueTap={onCueTap} />
              </>
            ) : (
              <MarkedText
                text={heading ? line.replace(/^#+\s*/, '') : line}
                byNumber={byNumber}
                activeIds={activeIds}
                standbyId={standbyId}
                onCueTap={onCueTap}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

export interface MarkerProps {
  byNumber: Map<number, Cue>
  activeIds: Set<string>
  standbyId: string | null
  onCueTap?: (cue: Cue) => void
}

/** Text with every "Q<number>" that names a cue turned into a live chip (green running, yellow standby). */
export function MarkedText({ text: line, byNumber, activeIds, standbyId, onCueTap }: MarkerProps & { text: string }) {
  const out: ReactNode[] = []
  let last = 0
  for (const m of line.matchAll(MARKER)) {
    const cue = byNumber.get(Number(m[1]))
    out.push(line.slice(last, m.index))
    last = m.index + m[0].length
    if (!cue) {
      out.push(m[0])
      continue
    }
    const tone = activeIds.has(cue.id)
      ? 'bg-go text-black'
      : cue.id === standbyId
        ? 'bg-standby text-black'
        : 'border border-accent/60 text-accent'
    out.push(
      <button
        key={m.index}
        type="button"
        disabled={!onCueTap}
        onClick={() => onCueTap?.(cue)}
        className={`mx-0.5 inline-flex items-center rounded px-1 align-baseline font-mono text-[0.85em] font-bold ${tone} ${onCueTap ? 'cursor-pointer hover:brightness-125' : 'cursor-default'}`}
        title={`Q${cue.cueNumber} ${cue.title}${onCueTap ? '（點擊設為 Standby）' : ''}`}
        data-script-cue={cue.id}
      >
        Q{cue.cueNumber}
      </button>,
    )
  }
  out.push(line.slice(last))
  return <>{out}</>
}
