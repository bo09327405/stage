import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { AutoSaveStatus } from '../../hooks/useR2AutoSave'
import {
  deleteDawAudio,
  deleteDawProject,
  loadDawCloud,
  planDawDelete,
  restoreDawProject,
  type DawCloud,
} from '../../services/r2Manage'
import { DAW_PROJECTS_PREFIX, objectName } from '../../services/storage'
import type { StudioSummary } from '../../services/studio'
import { deleteLegacyShowFile, fetchStudioFile, useLegacyShowFiles, type CloudStudioFile, type StudioFile } from '../../studio/projectFile'
import { formatBytes, formatWhen } from '../../utils/formatFile'
import { isAdmin, useAuth } from '../../services/auth'
import { useProjectIndex } from '../../services/projects'
import { AutoSaveBadge } from '../ui/AutoSaveBadge'

/**
 * "此演出雲端": everything this show's DAW keeps on Cloudflare R2, in one place.
 *
 *  - DAW 專案: every studio of the show, auto-saved to theatre/projects/{show}/{studio}.json — with
 *    live auto-save state for the open one, size, last save and version count. Open / restore /
 *    import a copy, or delete for good. Studios not yet on R2 are listed too. Older copies saved
 *    with the former "儲存到此演出雲端" button (theatre/daw/{show}/projects) can be imported or deleted.
 *  - 上傳音檔: studio audio (theatre/daw/), with who uses it.
 */
export function ShowCloudPanel({
  projectId,
  projectName,
  studios,
  currentStudioId,
  autoSave,
  onOpenStudio,
  onImportFile,
}: {
  projectId: string
  projectName: string
  /** Studios of this show in Firebase (to list the ones not saved to R2 yet). */
  studios: StudioSummary[] | null
  currentStudioId: string | null
  /** Auto-save state of the open studio. */
  autoSave: AutoSaveStatus | null
  onOpenStudio: (studioId: string) => void
  /** Preview a file and import it as a new studio here. */
  onImportFile: (load: () => Promise<StudioFile>, source: string, key: string) => void
}) {
  const [cloud, setCloud] = useState<DawCloud | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [scope, setScope] = useState<'show' | 'all'>('show')
  const [section, setSection] = useState<'projects' | 'audio'>('projects')
  const [confirming, setConfirming] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const legacy = useLegacyShowFiles(projectId, projectName)

  // Admins see every show's files; everyone else their own projects' (the server filters too).
  const { user } = useAuth()
  const admin = isAdmin(user)
  const { projects: mine } = useProjectIndex()
  const mineKey = admin ? 'all' : (mine?.map((p) => p.id).join(',') ?? null)
  const reload = useCallback(() => {
    if (mineKey === null) return
    loadDawCloud(mineKey === 'all' ? null : mineKey.split(',').filter(Boolean))
      .then(setCloud)
      .catch((err: Error) => setError(err.message))
  }, [mineKey])
  useEffect(reload, [reload])

  const run = async (id: string, job: () => Promise<string>) => {
    setBusy(id)
    setError(null)
    try {
      setNote(await job())
      setConfirming(null)
      reload()
      legacy.reload()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const projects = (cloud?.projects ?? []).filter((p) => scope === 'all' || p.showId === projectId)
  const onR2 = new Set((cloud?.projects ?? []).filter((p) => p.showId === projectId).map((p) => p.studioId))
  const unsaved = scope === 'show' && cloud ? (studios ?? []).filter((s) => !onR2.has(s.id)) : []
  const legacyFiles = scope === 'show' ? (legacy.files ?? []) : []
  const audio = cloud?.audio ?? []
  const urlOf = (key: string) => `/api/r2/o/${key.split('/').map(encodeURIComponent).join('/')}`

  return (
    <div className="flex h-full flex-col" data-show-cloud>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3">
        <div className="grid grid-cols-2 gap-1 rounded-lg bg-black/40 p-1 text-xs">
          {(
            [
              ['projects', `🎚 DAW 專案 ${cloud ? projects.length + unsaved.length + legacyFiles.length : '…'}`],
              ['audio', `♪ 上傳音檔 ${cloud ? audio.length : '…'}`],
            ] as const
          ).map(([id, label]) => (
            <button key={id} type="button" onClick={() => setSection(id)} aria-pressed={section === id} className={`min-h-8 rounded-md px-3 ${section === id ? 'bg-white/15 text-white' : 'text-white/50'}`} data-cloud-section={id}>
              {label}
            </button>
          ))}
        </div>
        {section === 'projects' && (
          <select value={scope} onChange={(e) => setScope(e.target.value as 'show' | 'all')} className="min-h-8 rounded-lg border border-white/15 bg-black/40 px-2 text-xs" data-cloud-scope>
            <option value="show">此演出</option>
            <option value="all">{admin ? "所有演出" : "我的所有專案"}</option>
          </select>
        )}
        <button
          type="button"
          onClick={() => {
            setError(null)
            setNote(null)
            reload()
            legacy.reload()
          }}
          className="ml-auto min-h-8 rounded-lg px-2 text-xs text-white/55 hover:bg-white/10"
          data-cloud-reload
        >
          ↻ 重新整理
        </button>
        <p className="w-full truncate font-mono text-[11px] text-white/40" title="Cloudflare R2">
          {section === 'projects' ? `☁ ${DAW_PROJECTS_PREFIX}${scope === 'show' ? `${projectId}/` : ''} · 每個 Studio 編輯後自動儲存，內含最近 15 個版本` : '☁ theatre/daw/ · 所有演出的 Studio 音檔（錄音、TTS、匯入、混音）'}
        </p>
        {note && <p className="w-full text-xs text-go" data-cloud-note>{note}</p>}
        {error && <p className="w-full text-xs text-panic" data-cloud-error>{error}</p>}
      </div>

      <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto p-3">
        {!cloud && !error && <li className="p-6 text-center text-sm text-white/35">讀取 R2…</li>}

        {cloud && section === 'projects' && (
          <>
            {projects.length + unsaved.length + legacyFiles.length === 0 && <li className="p-10 text-center text-sm text-white/35">{scope === 'show' ? '這個演出還沒有 Studio' : 'R2 上還沒有 DAW 專案'}</li>}
            {projects.map((p) => {
              const plan = planDawDelete(cloud, p)
              const here = p.showId === projectId
              const open = here && p.studioId === currentStudioId
              return (
                <Row
                  key={p.key}
                  id={p.key}
                  icon="🎚"
                  name={p.name}
                  badges={
                    <>
                      {open && <Badge tone="accent">目前開啟</Badge>}
                      <Badge tone={p.live ? 'go' : 'dim'}>{p.live ? '系統中' : '僅雲端'}</Badge>
                    </>
                  }
                  meta={`${scope === 'all' ? `${p.showName} · ` : ''}${p.tracks} 軌 · ${p.regions} 片段 · ${p.versions} 個版本 · ${formatBytes(p.size)} · 最後儲存 ${formatWhen(p.savedAt)}`}
                  status={open && autoSave ? <AutoSaveBadge status={autoSave} /> : null}
                  action={here ? (p.live ? '開啟' : '還原') : '匯入副本'}
                  busy={busy === p.key}
                  disabled={!!busy}
                  onAction={() =>
                    here && p.live
                      ? onOpenStudio(p.studioId)
                      : here
                        ? run(p.key, async () => {
                            await restoreDawProject(p)
                            onOpenStudio(p.studioId)
                            return `✓ 已還原「${p.name}」`
                          })
                        : onImportFile(() => fetchStudioFile(urlOf(p.key)), `${p.showName} · ${p.name}`, p.key)
                  }
                  confirming={confirming === p.key}
                  onDelete={() => setConfirming(confirming === p.key ? null : p.key)}
                  confirm={
                    <Confirm
                      title={`永久刪除「${p.name}」？無法復原。`}
                      busy={busy === p.key}
                      onCancel={() => setConfirming(null)}
                      onConfirm={() =>
                        run(p.key, async () => {
                          const r = await deleteDawProject(cloud, p)
                          return `✓ 已刪除「${p.name}」：R2 刪除 ${r.deleted} 個檔案${r.kept ? `，保留 ${r.kept} 個共用音檔` : ''}`
                        })
                      }
                    >
                      <li>R2 專案檔 {p.key}（含 {p.versions} 個歷史版本）</li>
                      <li>{plan.exclusive.length} 個只有這個專案使用的音檔</li>
                      {plan.shared.length > 0 && <li className="text-standby">{plan.shared.length} 個音檔仍被其他專案或 Cue 使用，會保留</li>}
                      {p.live && <li>系統中的這個 Studio（綁定它的 Cue 將無法播放）</li>}
                    </Confirm>
                  }
                />
              )
            })}

            {unsaved.map((s) => (
              <Row
                key={s.id}
                id={`unsaved:${s.id}`}
                icon="🎚"
                name={s.name}
                badges={<Badge tone="standby">尚未存到雲端</Badge>}
                meta={`${s.tracks} 軌 · ${s.regions} 片段 · 開啟後會自動儲存到 R2`}
                action="開啟"
                disabled={!!busy}
                onAction={() => onOpenStudio(s.id)}
              />
            ))}

            {legacyFiles.length > 0 && (
              <li className="px-3 pt-4 pb-1 text-[11px] text-white/40" data-cloud-legacy-heading>
                舊版檔案 · 以前用「儲存到此演出雲端」存的副本（{legacy.folder}/）· 匯入後會存到標準位置
              </li>
            )}
            {legacyFiles.map((f: CloudStudioFile) => (
              <Row
                key={f.id}
                id={f.publicId}
                icon="📄"
                name={f.name}
                badges={<Badge tone="dim">舊版</Badge>}
                meta={`${f.fromListing ? '' : `${f.tracks} 軌 · ${f.regions} 片段 · `}${formatBytes(f.bytes)} · ${formatWhen(f.createdAt)}`}
                action="匯入"
                disabled={!!busy}
                onAction={() => onImportFile(() => fetchStudioFile(f.url), `舊版雲端檔 · ${f.name}`, f.id)}
                confirming={confirming === f.id}
                onDelete={() => setConfirming(confirming === f.id ? null : f.id)}
                confirm={
                  <Confirm
                    title={`永久刪除舊版檔案「${f.name}」？無法復原。`}
                    busy={busy === f.id}
                    onCancel={() => setConfirming(null)}
                    onConfirm={() =>
                      run(f.id, async () => {
                        await deleteLegacyShowFile(projectId, f)
                        return `✓ 已刪除舊版檔案「${f.name}」`
                      })
                    }
                  >
                    <li>R2 檔案 {f.publicId}</li>
                    <li>只刪除這份副本；音檔與系統中的 Studio 不受影響</li>
                  </Confirm>
                }
              />
            ))}
          </>
        )}

        {cloud && section === 'audio' && audio.length === 0 && <li className="p-10 text-center text-sm text-white/35">R2 上沒有 Studio 音檔</li>}
        {cloud &&
          section === 'audio' &&
          audio.map((a) => (
            <Row
              key={a.key}
              id={a.key}
              icon="♪"
              name={objectName(a.key)}
              meta={
                <>
                  {a.key.split('/').slice(2, -1).join('/')} · {formatBytes(a.size)} · {formatWhen(a.lastModified)} ·{' '}
                  {a.usedBy.length ? <span className="text-standby">使用中：{a.usedBy.join('、')}</span> : <span>未被使用</span>}
                </>
              }
              extra={<audio src={a.url} controls preload="none" className="h-8 w-40 shrink-0" />}
              confirming={confirming === a.key}
              onDelete={() => setConfirming(confirming === a.key ? null : a.key)}
              confirm={
                <Confirm
                  title={`永久刪除「${objectName(a.key)}」？無法復原。`}
                  busy={busy === a.key}
                  onCancel={() => setConfirming(null)}
                  onConfirm={() =>
                    run(a.key, async () => {
                      await deleteDawAudio(cloud, a.key)
                      return `✓ 已從 R2 刪除「${objectName(a.key)}」`
                    })
                  }
                >
                  {a.usedBy.length > 0 && <li className="text-standby">⚠ 仍在使用中（{a.usedBy.join('、')}），刪除後這些地方會變成無聲</li>}
                </Confirm>
              }
            />
          ))}
      </ul>
    </div>
  )
}

const TONES = { accent: 'bg-accent/20 text-accent', go: 'bg-go/15 text-go', dim: 'bg-white/10 text-white/50', standby: 'bg-standby/15 text-standby' }
function Badge({ tone, children }: { tone: keyof typeof TONES; children: ReactNode }) {
  return <span className={`ml-2 rounded px-1 text-[10px] ${TONES[tone]}`}>{children}</span>
}

/** One file: name, badges, details, its main action and a delete button with an inline confirmation. */
function Row({
  id,
  icon,
  name,
  badges,
  meta,
  status,
  extra,
  action,
  busy = false,
  disabled = false,
  onAction,
  confirming = false,
  onDelete,
  confirm,
}: {
  id: string
  icon: string
  name: string
  badges?: ReactNode
  meta: ReactNode
  status?: ReactNode
  extra?: ReactNode
  action?: string
  busy?: boolean
  disabled?: boolean
  onAction?: () => void
  confirming?: boolean
  onDelete?: () => void
  confirm?: ReactNode
}) {
  return (
    <li className="rounded-xl px-3 py-2 hover:bg-white/[0.04]" data-cloud-row={id}>
      <div className="flex items-center gap-3">
        <span className="text-xl">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-white/90">
            {name}
            {badges}
          </span>
          <span className="block truncate text-[11px] text-white/40">{meta}</span>
          {status && <span className="mt-1 block">{status}</span>}
        </span>
        {extra}
        {action && onAction && (
          <button type="button" disabled={disabled} onClick={onAction} className="h-8 shrink-0 rounded-lg bg-white/[0.08] px-3 text-xs font-semibold text-white hover:bg-accent disabled:opacity-40" data-cloud-open={id}>
            {busy ? '…' : action}
          </button>
        )}
        {onDelete && (
          <button type="button" onClick={onDelete} className="h-8 shrink-0 rounded-lg px-2 text-xs text-white/40 hover:bg-panic/15 hover:text-panic" aria-label={`刪除 ${name}`} data-cloud-delete={id}>
            🗑
          </button>
        )}
      </div>
      {confirming && confirm}
    </li>
  )
}

/** Inline confirmation: what will be deleted, then 永久刪除 / 取消. */
function Confirm({ title, busy, onConfirm, onCancel, children }: { title: string; busy: boolean; onConfirm: () => void; onCancel: () => void; children?: ReactNode }) {
  return (
    <div
      // Bring it into view: on a row near the bottom it would open below the visible list.
      ref={(el) => el?.scrollIntoView({ block: 'nearest' })}
      className="mt-2 space-y-2 rounded-lg border border-panic/30 bg-panic/10 p-3 text-xs"
      role="alertdialog"
      aria-label={title}
      data-cloud-confirm
    >
      <p className="text-white/85">{title}</p>
      {children && <ul className="list-disc space-y-0.5 pl-4 text-white/60">{children}</ul>}
      <div className="flex gap-2">
        <button type="button" disabled={busy} onClick={onConfirm} className="min-h-8 rounded-lg bg-panic px-3 font-semibold text-white disabled:opacity-40" data-cloud-confirm-delete>
          {busy ? '刪除中…' : '永久刪除'}
        </button>
        <button type="button" onClick={onCancel} className="min-h-8 rounded-lg px-3 text-white/60 hover:bg-white/10">
          取消
        </button>
      </div>
    </div>
  )
}
