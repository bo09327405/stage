import { useEffect, useRef, useState } from 'react'
import { useStudioList, type StudioSummary } from '../../services/studio'
import { studioMixUrl } from '../../studio/cueMix'
import { timecode } from '../../studio/format'

/**
 * Choose a DAW Studio project as an AUDIO cue's source. The cue then plays the studio's live mix
 * (rendered on each device at GO) — later edits in the studio are heard without exporting.
 */
export function StudioBinding({ projectId, value, onChange }: { projectId: string; value: string; onChange: (studio: StudioSummary) => void }) {
  const list = useStudioList(projectId)
  const [preview, setPreview] = useState<{ id: string; state: 'rendering' | 'playing' | 'error'; message?: string } | null>(null)
  const audio = useRef<HTMLAudioElement | null>(null)
  useEffect(() => () => audio.current?.pause(), [])
  const version = new URLSearchParams(location.search).get('version') ?? ''
  const href = (id: string) => `?role=studio&project=${projectId}&version=${version}&studio=${id}`

  const listen = async (id: string) => {
    audio.current?.pause()
    if (preview?.id === id && preview.state === 'playing') return setPreview(null)
    setPreview({ id, state: 'rendering' })
    try {
      const url = await studioMixUrl(projectId, id)
      const el = new Audio(url)
      el.onended = () => setPreview(null)
      await el.play()
      audio.current = el
      setPreview({ id, state: 'playing' })
    } catch (err) {
      setPreview({ id, state: 'error', message: (err as Error).message })
    }
  }

  if (list === null) return <p className="text-xs text-white/35">載入 Studio 專案…</p>
  if (list.length === 0)
    return (
      <div className="rounded-xl border border-dashed border-white/15 p-4 text-center text-xs text-white/45" data-studio-binding>
        此演出還沒有 Studio 專案。
        <a href={`?role=studio&project=${projectId}&version=${version}`} target="_blank" rel="noreferrer" className="ml-1 text-accent underline">
          開啟 DAW Studio 建立 ↗
        </a>
      </div>
    )

  return (
    <div className="space-y-1.5" data-studio-binding>
      {list.map((s) => {
        const on = s.id === value
        return (
          <div key={s.id} className={`flex items-center gap-2 rounded-xl border px-3 py-2 ${on ? 'border-[#bf5af2] bg-[#bf5af2]/10' : 'border-line bg-white/[0.03]'}`}>
            <button type="button" onClick={() => onChange(s)} className="min-w-0 flex-1 text-left" data-bind-studio={s.id}>
              <span className="flex items-center gap-1.5 text-sm font-medium text-white">
                {on && <span className="text-[#d7a6ff]">✓</span>}🎚 <span className="truncate">{s.name}</span>
              </span>
              <span className="block font-mono text-[10px] text-white/40">
                {timecode(s.length)} · {s.tracks} 軌 · {s.regions} 片段
              </span>
            </button>
            <button
              type="button"
              onClick={() => listen(s.id)}
              disabled={!s.regions}
              className="h-8 shrink-0 rounded-lg bg-white/[0.07] px-2.5 text-[11px] text-white/75 hover:bg-white/15 disabled:opacity-30"
              title="在這台電腦試聽目前的混音"
              data-preview-studio={s.id}
            >
              {preview?.id === s.id ? (preview.state === 'rendering' ? '混音中…' : preview.state === 'playing' ? '■ 停止' : '⚠') : '▶ 試聽'}
            </button>
            <a href={href(s.id)} target="_blank" rel="noreferrer" className="h-8 shrink-0 rounded-lg px-2 text-[11px] leading-8 text-white/50 hover:bg-white/10 hover:text-white" title="在 Studio 中編輯">
              ↗
            </a>
          </div>
        )
      })}
      {preview?.state === 'error' && <p className="text-xs text-panic">{preview.message}</p>}
      <p className="text-[11px] leading-relaxed text-white/35">GO 時每台觀眾裝置會即時載入這個 Studio 的多軌混音播放（含自動化、EQ 與效果）；Studio 裡的修改不需匯出就會生效，Cue 長度也會自動同步。</p>
    </div>
  )
}
