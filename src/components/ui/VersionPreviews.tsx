type Json = Record<string, unknown>
const rec = (v: unknown): Record<string, Json> => (v && typeof v === 'object' ? (v as Record<string, Json>) : {})

/** Preview of a saved DAW Studio version: tracks and their region counts. */
export function StudioVersionPreview({ state }: { state: Json }) {
  const studio = rec(state.studio)
  const tracks = Object.entries(rec(studio.tracks)).sort(([, a], [, b]) => Number(a.order ?? 0) - Number(b.order ?? 0))
  const regions = Object.values(rec(studio.regions))
  return (
    <div className="space-y-1">
      <p className="text-white/50">
        「{String(state.name ?? '')}」· {tracks.length} 軌 · {regions.length} 片段 · {Object.keys(rec(studio.sections)).length} 個區段 · 長度 {Number(state.length ?? 0).toFixed(1)} 秒
      </p>
      <ul className="space-y-0.5">
        {tracks.map(([id, t]) => (
          <li key={id} className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full" style={{ background: String(t.color ?? '#888') }} />
            <span className="truncate">{String(t.name ?? '')}</span>
            <span className="ml-auto text-white/35">{regions.filter((r) => r.trackId === id).length} 片段</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Preview of a saved Set Cue version: the cue list of the version being edited. */
export function SetCueVersionPreview({ state, versionId }: { state: Json; versionId: string }) {
  const versions = rec(rec(state.data).versions)
  const meta = rec(rec(state.project).versions)
  const cues = Object.values(rec(versions[versionId]?.cueList)).sort((a, b) => Number(a.cueNumber) - Number(b.cueNumber))
  return (
    <div className="space-y-1">
      <p className="text-white/50">
        「{String(rec(state.project).name ?? '')}」· {Object.keys(meta).length} 個版本 · 此版本 {cues.length} 個 Cue · {Object.keys(rec(versions[versionId]?.hits)).length} 個 Hits
      </p>
      <ul className="space-y-0.5">
        {cues.map((c) => (
          <li key={String(c.id)} className="flex gap-2">
            <span className="w-8 shrink-0 text-right font-mono text-white/40">Q{String(c.cueNumber)}</span>
            <span className="truncate">{String(c.title ?? '')}</span>
            <span className="ml-auto shrink-0 text-white/30">{String(c.type ?? '')}</span>
          </li>
        ))}
        {cues.length === 0 && <li className="text-white/35">（這個版本沒有 Cue）</li>}
      </ul>
    </div>
  )
}
