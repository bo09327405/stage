import { useState } from 'react'
import { loadSpatialBuffer } from '../../services/spatialStage'
import type { TrajectoryConfig } from '../../types/trajectory'
import { TrajectoryEditor } from '../studio/TrajectoryEditor'

/** One quiet AudioContext for auditioning in the console (the cue editor has no mixer of its own). */
let auditionCtx: AudioContext | null = null
const context = () => (auditionCtx ??= new AudioContext())

/**
 * An audio cue's 3D placement: a collapsed bar that opens the trajectory editor (viewport, path, timing, acoustics,
 * head tracking). The cue's own file is what the audition plays; audience phones play it through the same HRTF chain.
 * Opened on demand, so the WebGL viewport only exists while it is being used.
 */
export function CueTrajectory({ title, url, value, onChange }: { title: string; url: string; value: TrajectoryConfig; onChange: (next: TrajectoryConfig) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-white/[0.02]" data-cue-trajectory>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex min-h-11 w-full items-center gap-2 px-3 text-left text-sm font-semibold text-white/80 hover:bg-white/[0.04]">
        <span aria-hidden>🎧</span>
        <span className="flex-1">3D 空間聲音軌跡 · 雙耳 HRTF</span>
        <span className={`rounded-md px-2 py-0.5 text-[10px] ${value.enabled ? 'bg-accent text-white' : 'bg-white/10 text-white/45'}`}>{value.enabled ? '已啟用' : '未啟用'}</span>
        <span className="text-white/40">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <TrajectoryEditor
          title={title || 'Cue'}
          color="#4dabf7"
          resetKey={url}
          value={value}
          onSave={(next) => onChange(next)}
          audition={{
            context,
            output: () => context().destination,
            buffer: () => loadSpatialBuffer(url),
            hasOwnSound: !!url,
          }}
        />
      )}
    </div>
  )
}
