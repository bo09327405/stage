import { isAdmin, useAuth } from '../../services/auth'
import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { downloadWav, uploadStudioAudio } from '../../studio/cloud'
import { timecode } from '../../studio/format'
import { renderMix } from '../../studio/mixer'
import { STUDIO_DEFAULT_FOLDER } from '../../types/project'
import { sortedTracks, type StudioProject } from '../../types/studio'

/**
 * Export the mix (all tracks, or chosen ones) as WAV: download it, or upload it to cloud storage
 * on Cloudflare R2 — the project's studio folder or the shared Default folder —
 * where Set Cue can pick it.
 */
export function ExportDialog({
  open,
  studio,
  projectId,
  folder,
  initialTracks,
  onClose,
}: {
  open: boolean
  studio: StudioProject
  projectId: string
  folder: string
  initialTracks: string[] | null
  onClose: () => void
}) {
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <motion.div
            initial={{ scale: 0.96 }}
            animate={{ scale: 1 }}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-2xl border border-line bg-panel p-5 text-white shadow-2xl"
            role="dialog"
            aria-label="匯出音訊"
            data-export-dialog
          >
            <Body studio={studio} projectId={projectId} folder={folder} initialTracks={initialTracks} onClose={onClose} />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}

function Body({ studio, projectId, folder, initialTracks, onClose }: { studio: StudioProject; projectId: string; folder: string; initialTracks: string[] | null; onClose: () => void }) {
  const tracks = sortedTracks(studio)
  const [scope, setScope] = useState<'mix' | 'tracks'>(initialTracks ? 'tracks' : 'mix')
  const [chosen, setChosen] = useState<string[]>(initialTracks ?? tracks.map((t) => t.id))
  const [bitDepth, setBitDepth] = useState<16 | 24>(24)
  const [rate, setRate] = useState(48000)
  const [name, setName] = useState(studio.name)
  const [status, setStatus] = useState<{ busy: boolean; text: string; url?: string; error?: boolean }>({ busy: false, text: '' })

  const admin = isAdmin(useAuth().user)
  const run = async (target: 'download' | 'project' | 'default') => {
    setStatus({ busy: true, text: '混音中…' })
    try {
      const buffer = await renderMix(studio, { trackIds: scope === 'tracks' ? chosen : undefined, sampleRate: rate })
      if (target === 'download') {
        downloadWav(buffer, name, bitDepth)
        setStatus({ busy: false, text: `✓ 已下載 ${timecode(buffer.duration)}（${rate / 1000} kHz / ${bitDepth}-bit）` })
      } else {
        setStatus({ busy: true, text: '上傳到 Cloudflare R2…' })
        const result = await uploadStudioAudio(buffer, { name, folder: target === 'default' ? STUDIO_DEFAULT_FOLDER : folder, projectId, shared: target === 'default', bitDepth, placement: { studioId: studio.id, category: null } })
        setStatus({ busy: false, text: `✓ 已上傳到 ${target === 'default' ? 'Default 共用' : '專案素材'}，Set Cue 選取檔案時可直接使用`, url: result.secure_url })
      }
    } catch (err) {
      setStatus({ busy: false, text: (err as Error).message, error: true })
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold">匯出音訊</h2>
          <p className="text-xs text-white/40">不需要匯出也能把 Studio 直接綁定到 Cue；匯出適合存檔或給其他系統使用。</p>
        </div>
        <button type="button" onClick={onClose} className="h-9 w-9 rounded-lg text-white/50 hover:bg-white/10" aria-label="關閉">
          ✕
        </button>
      </div>
      <label className="block">
        <span className="mb-1 block text-xs text-white/55">檔名</span>
        <input value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded-lg border border-white/15 bg-black/40 px-2.5 py-2 text-sm outline-none focus:border-accent" />
      </label>
      <div className="grid grid-cols-2 gap-1 rounded-lg bg-black/40 p-1 text-xs">
        {(
          [
            ['mix', '整個混音'],
            ['tracks', '選定音軌'],
          ] as const
        ).map(([id, label]) => (
          <button key={id} type="button" onClick={() => setScope(id)} aria-pressed={scope === id} className={`min-h-8 rounded-md ${scope === id ? 'bg-white/15 text-white' : 'text-white/50'}`} data-export-scope={id}>
            {label}
          </button>
        ))}
      </div>
      {scope === 'tracks' && (
        <div className="space-y-1">
          {tracks.map((t) => (
            <label key={t.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={chosen.includes(t.id)}
                onChange={() => setChosen(chosen.includes(t.id) ? chosen.filter((x) => x !== t.id) : [...chosen, t.id])}
                className="h-4 w-4 accent-[#0a84ff]"
              />
              <span className="h-2 w-2 rounded-full" style={{ background: t.color }} />
              {t.name}
            </label>
          ))}
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 text-xs">
        <label className="block">
          <span className="mb-1 block text-white/55">取樣率</span>
          <select value={rate} onChange={(e) => setRate(Number(e.target.value))} className="w-full rounded-lg border border-white/15 bg-black/40 px-2 py-2 text-sm">
            <option value={44100}>44.1 kHz</option>
            <option value={48000}>48 kHz</option>
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-white/55">位元深度</span>
          <select value={bitDepth} onChange={(e) => setBitDepth(Number(e.target.value) as 16 | 24)} className="w-full rounded-lg border border-white/15 bg-black/40 px-2 py-2 text-sm">
            <option value={16}>16-bit</option>
            <option value={24}>24-bit</option>
          </select>
        </label>
      </div>
      {status.text && (
        <p className={`text-xs ${status.error ? 'text-panic' : 'text-white/65'}`} data-export-status>
          {status.text}
          {status.url && (
            <a href={status.url} target="_blank" rel="noreferrer" className="ml-1 text-accent underline">
              開啟
            </a>
          )}
        </p>
      )}
      <div className="grid grid-cols-3 gap-2">
        <button type="button" disabled={status.busy || (scope === 'tracks' && chosen.length === 0)} onClick={() => run('download')} className="min-h-11 rounded-xl bg-white/10 text-xs font-semibold hover:bg-white/15 disabled:opacity-40" data-export-download>
          ⇩ 下載 WAV
        </button>
        <button type="button" disabled={status.busy || (scope === 'tracks' && chosen.length === 0)} onClick={() => run('project')} className="min-h-11 rounded-xl bg-accent text-xs font-semibold text-white disabled:opacity-40" data-export-upload="project">
          ☁ 上傳專案
        </button>
        {admin && (
          <button type="button" disabled={status.busy || (scope === 'tracks' && chosen.length === 0)} onClick={() => run('default')} className="min-h-11 rounded-xl bg-accent/25 text-xs font-semibold text-accent disabled:opacity-40" data-export-upload="default">
            ☁ 上傳 Default
          </button>
        )}
      </div>
    </div>
  )
}
