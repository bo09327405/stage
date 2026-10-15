import { useState } from 'react'
import { useAudiencePool, withTransform } from '../../services/uploads'
import type { AudienceUpload } from '../../types/cue'

const ICON = { image: '🖼', audio: '♪', video: '▶' } as const

/**
 * Audience uploads from every project (approved, not hidden), from the Cloudinary audience space —
 * for a cue, hit or block in any project.
 */
export function AudiencePoolGrid({ kind, projectId, onPick }: { kind?: AudienceUpload['kind']; projectId: string; onPick: (u: AudienceUpload) => void }) {
  const pool = useAudiencePool(kind)
  const [only, setOnly] = useState<'all' | 'others'>('all')
  const list = (pool ?? []).filter((u) => only === 'all' || u.projectId !== projectId)
  if (pool === null) return <p className="p-8 text-center text-sm text-white/30">載入所有專案的觀眾上傳…</p>
  return (
    <div className="h-full overflow-y-auto" data-audience-pool>
      <div className="flex items-center gap-2 px-4 pt-3 text-[11px] text-white/45">
        <span>{list.length} 個審查通過的觀眾作品</span>
        <label className="ml-auto flex items-center gap-1">
          <input type="checkbox" checked={only === 'others'} onChange={(e) => setOnly(e.target.checked ? 'others' : 'all')} className="accent-[#0a84ff]" />
          只看其他專案
        </label>
      </div>
      {list.length === 0 ? (
        <p className="p-8 text-center text-sm text-white/35">還沒有{kind ? '這類' : ''}觀眾上傳</p>
      ) : (
        <ul className="grid grid-cols-2 gap-2 p-4 sm:grid-cols-3 md:grid-cols-4">
          {list.map((u) => (
            <li key={u.id}>
              <button
                type="button"
                onClick={() => onPick({ ...u, folder: '', audienceId: '', via: 'direct' } as AudienceUpload)}
                className="w-full overflow-hidden rounded-xl border border-line bg-black/30 text-left hover:border-accent"
                data-audience-item={u.id}
              >
                {u.kind === 'image' ? (
                  <img src={withTransform(u.url, 'c_fill,w_320,h_220,q_auto,f_auto')} alt="" className="aspect-[3/2] w-full object-cover" loading="lazy" />
                ) : (
                  <div className="flex aspect-[3/2] items-center justify-center bg-gradient-to-b from-accent/15 to-transparent text-2xl">{ICON[u.kind]}</div>
                )}
                <div className="truncate px-2 py-1.5 text-[10px] text-white/55">
                  {u.projectId === projectId ? '此專案' : `來自「${u.projectName ?? '其他專案'}」`} · {new Date(u.createdAt).toLocaleDateString('zh-TW')}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
