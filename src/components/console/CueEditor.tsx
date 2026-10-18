import { isAdmin, useAuth } from '../../services/auth'
import { useEffect, useState } from 'react'
import { studioMixUrl } from '../../studio/cueMix'
import type { CloudinaryUploadResult } from '../../services/cloudinary'
import { formatTime } from '../../hooks/useServerNow'
import { mediaFromUpload, uploadTitle } from '../../utils/uploadCue'
import {
  CUE_TYPE_GLYPHS,
  CUE_TYPE_LABELS,
  STOP_OTHERS_LABELS,
  UPLOAD_KIND_LABELS,
  cueRunLength,
  isMediaCue,
  segmentLength,
  vibrationLengthMs,
  type AudienceUpload,
  type Cue,
  type CueType,
  type StopOthersMode,
  type UploadKind,
} from '../../types/cue'
import type { ProjectMedia } from '../../services/mediaLibrary'
import { DEFAULT_MEDIA_FOLDER, cueMediaFolder, sanitizeFolder, uploadFolderFor } from '../../types/project'
import { probeMediaDuration } from '../../utils/probeMediaDuration'
import { R2_INPUT_PLACEHOLDER, normalizeMediaInput } from '../../services/r2Input'
import { Fader, Label, NumberField, Segmented, Tabs, fieldClass } from '../ui/controls'
import { MediaUploadButton } from '../ui/MediaUploadButton'
import { defaultMatch } from '../../types/trigger'
import { TriggerMatchEditor } from '../ui/TriggerMatchEditor'
import { AfterStartPanel } from './AfterStartPanel'
import { AudienceTargeting } from './AudienceTargeting'
import { ChannelTargets } from './ChannelTargets'
import { HapticEditor } from './HapticEditor'
import { BottomSheet } from '../ui/BottomSheet'
import { MediaConverter } from './MediaConverter'
import { UrlImporter } from './UrlImporter'
import { uploadMediaFile } from '../../services/storage'
import { YouTubePreview } from './YouTubePreview'
import { isYoutubeCue, youtubeIdOf, youtubeStartOf, youtubeWatchUrl } from '../../utils/youtube'
import { recordProjectMedia, recordSharedMedia } from '../../services/mediaLibrary'
import { InboxPickerModal } from './InboxPickerModal'
import { StudioBinding } from './StudioBinding'
import { WaveformTrimmer } from './WaveformTrimmer'

type Draft = Omit<Cue, 'id'>

/** The rendered mix of a Studio project as a blob URL (null while rendering). */
function useStudioMixUrl(projectId: string, studioId: string) {
  const [state, setState] = useState<{ key: string; url: string | null; error: string | null }>({ key: '', url: null, error: null })
  const key = projectId && studioId ? `${projectId}/${studioId}` : ''
  useEffect(() => {
    if (!key) return
    let live = true
    studioMixUrl(projectId, studioId).then(
      (url) => live && setState({ key, url, error: null }),
      (err: Error) => live && setState({ key, url: null, error: err.message }),
    )
    return () => {
      live = false
    }
  }, [key, projectId, studioId])
  return state.key === key && key ? state : { key, url: null, error: null }
}

/**
 * JSON with object keys sorted. Firebase returns keys alphabetically while the draft keeps
 * insertion order, so a plain JSON.stringify would report a just-saved cue as still changed.
 */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  )
}
type TabId = 'basic' | 'media' | 'start' | 'after' | 'target' | 'triggers'

const TYPES: CueType[] = ['AUDIO', 'VIDEO', 'IMAGE', 'TEXT', 'INTERACTIVE_UPLOAD', 'BLACKOUT', 'VIBRATION']
const UPLOAD_ACCEPT: Partial<Record<CueType, string>> = {
  AUDIO: 'audio/*',
  VIDEO: 'video/*',
  IMAGE: 'image/*',
}
const TEXT_LABELS: Partial<Record<CueType, string>> = {
  IMAGE: '圖說（選填）',
  TEXT: '顯示文字',
  INTERACTIVE_UPLOAD: '給觀眾的提示',
}

/** Map a Cloudinary result to the cue type it should be. */
function typeFromUpload(result: CloudinaryUploadResult): CueType {
  if (result.resource_type === 'image') return 'IMAGE'
  return result.is_audio && !result.width ? 'AUDIO' : 'VIDEO'
}

interface CueEditorProps {
  /** Existing cue being edited, or null when creating. */
  cue: Cue | null
  initial: Draft
  /** Audience codes currently connected, offered as quick picks for targeting. */
  onlineAudience: string[]
  /** The project's audience media pool, for "Select from Inbox". */
  inbox: AudienceUpload[] | null
  /** All cues, to label which cue each upload came from. */
  allCues: Cue[]
  projectId: string
  projectName: string
  /** Audience channel groups of this show (0 = not grouped). */
  channelCount?: number
  onSave: (draft: Draft) => Promise<unknown>
  onDelete?: () => void
  onClose: () => void
}

/** Go Button-style cue inspector. Parent should key it by cue id so the draft resets per cue. */
export function CueEditor({
  cue,
  initial,
  onlineAudience,
  inbox,
  allCues,
  projectId,
  projectName,
  channelCount = 0,
  onSave,
  onDelete,
  onClose,
}: CueEditorProps) {
  const [draft, setDraft] = useState<Draft>(initial)
  // When the stored cue changes underneath (undo / redo, another device) and nothing has been edited
  // here since, follow it; local unsaved edits are never overwritten.
  const initialKey = stableStringify(initial)
  const [syncedKey, setSyncedKey] = useState(initialKey)
  if (initialKey !== syncedKey) {
    setSyncedKey(initialKey)
    if (stableStringify(draft) === syncedKey) setDraft(initial)
  }
  const [tab, setTab] = useState<TabId>('basic')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [probing, setProbing] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [convertOpen, setConvertOpen] = useState(false)
  // Upload into this project's folder, or the shared Default folder every project can use.
  // The Default shared folder (R2) is managed by admins only.
  const admin = isAdmin(useAuth().user)
  const [uploadShared, setUploadShared] = useState(false)

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }))
  const dirty = stableStringify(draft) !== stableStringify(initial)
  const media = isMediaCue(draft as Cue)
  // AUDIO cues can play a DAW Studio project's live mix instead of a file.
  const [audioSource, setAudioSource] = useState<'file' | 'studio'>(initial.studioId ? 'studio' : 'file')
  const studioMode = draft.type === 'AUDIO' && audioSource === 'studio'
  const usesUrl = (media || draft.type === 'IMAGE') && !studioMode
  // Studio cues draw the waveform of the project's rendered mix (rendered on this device, in memory).
  const studioMix = useStudioMixUrl(studioMode ? projectId : '', studioMode ? draft.studioId : '')
  const waveUrl = studioMode ? (studioMix.url ?? '') : draft.targetUrl

  const pickFromInbox = (upload: AudienceUpload) =>
    setDraft((d) => ({ ...d, ...mediaFromUpload(upload), title: d.title || uploadTitle(upload) }))

  const pickFromLibrary = (m: ProjectMedia) => {
    // Typed R2 paths (and older records) don't know their length yet.
    if (!m.duration && m.kind !== 'image')
      void probeMediaDuration(m.url).then((s) => s != null && setDraft((d) => (d.targetUrl === m.url ? { ...d, duration: Math.round(s * 100) / 100 } : d)))
    setDraft((d) => ({
      ...d,
      type: m.kind === 'image' ? 'IMAGE' : m.kind === 'audio' ? 'AUDIO' : 'VIDEO',
      targetUrl: m.url,
      duration: m.kind === 'image' ? d.duration : Math.round(m.duration * 100) / 100,
      mediaStartTime: 0,
      mediaEndTime: 0,
      title: d.title || m.name.replace(/\.[^.]+$/, ''),
    }))
  }

  async function detectDuration(url: string) {
    if (!url || !media) return
    setProbing(true)
    const seconds = await probeMediaDuration(url)
    setProbing(false)
    if (seconds != null) set('duration', Math.round(seconds * 100) / 100)
  }

  async function handleSave() {
    if (!draft.title.trim()) {
      setTab('basic')
      return setError('請輸入標題')
    }
    if (studioMode && !draft.studioId) {
      setTab('media')
      return setError('請選擇要綁定的 Studio 專案')
    }
    if (usesUrl && !draft.targetUrl.trim()) {
      setTab('media')
      return setError('此類型需要媒體檔案或 URL')
    }
    if (draft.targetMode === 'selected' && draft.targetIds.length === 0) {
      setTab('target')
      return setError('已選擇「指定觀眾」，請至少加入一個識別碼')
    }
    setSaving(true)
    setError(null)
    try {
      await onSave({
        ...draft,
        title: draft.title.trim(),
        targetUrl: usesUrl ? normalizeMediaInput(draft.targetUrl) : '',
        studioId: studioMode ? draft.studioId : '',
      })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-line px-5 py-4">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold tracking-widest text-white/40 uppercase">
            {cue ? 'Edit Cue' : 'New Cue'}
          </div>
          <div className="truncate text-lg font-semibold">
            <span className="mr-2 font-mono text-white/50">{draft.cueNumber}</span>
            {draft.title || '未命名'}
          </div>
        </div>
        <button
          onClick={onClose}
          className="flex h-11 w-11 items-center justify-center rounded-lg text-white/40 hover:bg-white/10 hover:text-white"
          aria-label="關閉"
        >
          ✕
        </button>
      </header>

      <div className="px-4 pt-4">
        <Tabs<TabId>
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'basic', label: '基本' },
            { id: 'media', label: '媒體' },
            { id: 'start', label: '開始時' },
            { id: 'after', label: '開始後' },
            { id: 'target', label: '派發' },
            { id: 'triggers', label: draft.triggers.length ? `觸發 ${draft.triggers.length}` : '觸發' },
          ]}
        />
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5">
        {tab === 'basic' && (
          <>
            <div className="grid grid-cols-[9rem_1fr] gap-3">
              <NumberField
                label="編號"
                suffix=""
                step={0.1}
                stepperStep={1}
                value={draft.cueNumber}
                onChange={(v) => set('cueNumber', v)}
              />
              <label className="block">
                <Label>標題</Label>
                <input className={fieldClass} value={draft.title} onChange={(e) => set('title', e.target.value)} autoFocus />
              </label>
            </div>
            <label className="block">
              <Label>副標題</Label>
              <input
                className={fieldClass}
                placeholder="例如：場景二 · 雨聲進場"
                value={draft.subtitle}
                onChange={(e) => set('subtitle', e.target.value)}
              />
            </label>
            <label className="block">
              <Label hint="用來分類與批次編輯，例如「第一幕」「音效」">群組標籤</Label>
              <input className={fieldClass} placeholder="（無）" value={draft.group} onChange={(e) => set('group', e.target.value)} />
            </label>
            <div>
              <Label>類型</Label>
              <div className="grid grid-cols-3 gap-1.5">
                {TYPES.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => set('type', t)}
                    className={`flex min-h-16 flex-col items-center justify-center gap-1 rounded-lg border text-xs transition ${
                      draft.type === t
                        ? 'border-accent bg-accent/15 text-white'
                        : 'border-line bg-black/30 text-white/50 hover:text-white/80'
                    }`}
                  >
                    <span className="text-lg">{CUE_TYPE_GLYPHS[t]}</span>
                    {CUE_TYPE_LABELS[t]}
                  </button>
                ))}
              </div>
            </div>
            {TEXT_LABELS[draft.type] && (
              <label className="block">
                <Label>{TEXT_LABELS[draft.type]}</Label>
                <textarea className={fieldClass} rows={3} value={draft.text} onChange={(e) => set('text', e.target.value)} />
              </label>
            )}
            {draft.type === 'INTERACTIVE_UPLOAD' && (
              <UploadFolderField
                value={draft.uploadFolder}
                onChange={(v) => set('uploadFolder', v)}
                projectId={projectId}
                suggestions={[
                  sanitizeFolder(`${projectName}/${draft.title || `Q${draft.cueNumber}`}`),
                  sanitizeFolder(`${projectId}/${draft.title || `Q${draft.cueNumber}`}`),
                ]}
              />
            )}
            {draft.type === 'INTERACTIVE_UPLOAD' && (
              <div>
                <Label>收集內容</Label>
                <Segmented<UploadKind>
                  value={draft.uploadKind}
                  onChange={(k) => set('uploadKind', k)}
                  options={(Object.keys(UPLOAD_KIND_LABELS) as UploadKind[]).map((k) => ({ id: k, label: UPLOAD_KIND_LABELS[k] }))}
                />
              </div>
            )}
            {!media && (
              <NumberField
                label="停留時間"
                hint="0 = 直到被取代或停止"
                value={draft.duration}
                onChange={(v) => set('duration', v)}
              />
            )}
          </>
        )}

        {tab === 'media' && (
          <>
            {draft.type === 'AUDIO' && (
              <div className="grid grid-cols-2 gap-1 rounded-lg bg-black/40 p-1" role="group" aria-label="音訊來源" data-audio-source>
                {(
                  [
                    ['file', '🎵 音檔'],
                    ['studio', '🎚 DAW Studio 專案'],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setAudioSource(id)}
                    aria-pressed={audioSource === id}
                    className={`min-h-9 rounded-md text-xs font-medium ${audioSource === id ? 'bg-white/15 text-white' : 'text-white/50 hover:text-white/80'}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
            {studioMode ? (
              <StudioBinding
                projectId={projectId}
                value={draft.studioId}
                onChange={(s) =>
                  setDraft((d) => ({ ...d, studioId: s.id, targetUrl: '', duration: Math.round(s.length * 100) / 100, mediaStartTime: 0, mediaEndTime: 0, title: d.title || s.name }))
                }
              />
            ) : usesUrl ? (
              <>
                <div className="flex items-center gap-2 text-[11px] text-white/45" role="group" aria-label="上傳位置" data-upload-target>
                  <span>上傳到</span>
                  {(
                    [
                      [false, `📁 本專案（${cueMediaFolder(projectName, projectId).split('/').at(-1)}）`],
                      [true, '📌 Default 共用'],
                    ] as const
                  ).filter(([shared]) => !shared || admin).map(([shared, label]) => (
                    <button
                      key={label}
                      type="button"
                      onClick={() => setUploadShared(shared)}
                      aria-pressed={uploadShared === shared}
                      className={`min-h-7 rounded-md px-2 ${uploadShared === shared ? 'bg-white/15 text-white' : 'hover:text-white/80'}`}
                      title={shared ? `上傳到 ${DEFAULT_MEDIA_FOLDER}，所有專案都能選用` : '只屬於此專案'}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <MediaUploadButton
                  accept={UPLOAD_ACCEPT[draft.type] ?? 'audio/*,video/*,image/*'}
                  folder={uploadShared ? DEFAULT_MEDIA_FOLDER : cueMediaFolder(projectName, projectId)}
                  library={{ projectId, source: 'cue', shared: uploadShared }}
                  label={`上傳${CUE_TYPE_LABELS[draft.type]}檔案${uploadShared ? '到 Default' : ''}`}
                  onUploaded={(result, file) =>
                    setDraft((d) => ({
                      ...d,
                      type: typeFromUpload(result),
                      targetUrl: result.secure_url,
                      duration: result.duration ? Math.round(result.duration * 100) / 100 : d.duration,
                      mediaStartTime: 0,
                      mediaEndTime: 0,
                      title: d.title || file.name.replace(/\.[^.]+$/, ''),
                    }))
                  }
                />
                <button
                  type="button"
                  onClick={() => setImportOpen(true)}
                  className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-line bg-white/[0.04] text-xs font-medium text-white/75 active:bg-white/10"
                  data-url-import-open
                >
                  🌐 匯入網路影音（URL Import）
                </button>
                <button
                  type="button"
                  onClick={() => setConvertOpen(true)}
                  className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-line bg-white/[0.04] text-xs font-medium text-white/75 active:bg-white/10"
                  data-convert-open
                >
                  🛠 轉檔工具（本機檔案 → MP3 / WAV / MP4）
                </button>
                <BottomSheet open={convertOpen} onClose={() => setConvertOpen(false)} title="🛠 轉檔工具" subtitle="在你的裝置上轉檔，不用安裝任何軟體">
                  <MediaConverter
                    onConverted={async (files) => {
                      const folder = uploadShared ? DEFAULT_MEDIA_FOLDER : cueMediaFolder(projectName, projectId)
                      let first = true
                      for (const file of files) {
                        const result = await uploadMediaFile(file, folder)
                        await (uploadShared ? recordSharedMedia(result, file, 'link', folder) : recordProjectMedia(projectId, result, file, folder, 'link')).catch(() => {})
                        if (first) {
                          first = false
                          setDraft((d) => ({
                            ...d,
                            type: typeFromUpload(result),
                            targetUrl: result.secure_url,
                            duration: result.duration ? Math.round(result.duration * 100) / 100 : d.duration,
                            mediaStartTime: 0,
                            mediaEndTime: 0,
                            title: d.title || file.name.replace(/\.[^.]+$/, ''),
                          }))
                        }
                      }
                    }}
                  />
                </BottomSheet>
                <BottomSheet open={importOpen} onClose={() => setImportOpen(false)} title="🌐 匯入網路影音" subtitle="檔案連結 · YouTube 串流">
                <UrlImporter
                  onYoutube={({ url, start }) =>
                    setDraft((d) => ({ ...d, type: 'VIDEO', targetUrl: url, mediaStartTime: start, mediaEndTime: 0, title: d.title || 'YouTube 影片' }))
                  }
                  folder={uploadShared ? DEFAULT_MEDIA_FOLDER : cueMediaFolder(projectName, projectId)}
                  onDirect={(url) => {
                    set('targetUrl', url)
                    void detectDuration(url)
                  }}
                  onStored={async ({ result, name }) => {
                    const folder = uploadShared ? DEFAULT_MEDIA_FOLDER : cueMediaFolder(projectName, projectId)
                    setDraft((d) => ({
                      ...d,
                      type: typeFromUpload(result),
                      targetUrl: result.secure_url,
                      duration: result.duration ? Math.round(result.duration * 100) / 100 : d.duration,
                      mediaStartTime: 0,
                      mediaEndTime: 0,
                      title: d.title || name.replace(/\.[^.]+$/, ''),
                    }))
                    void probeMediaDuration(result.secure_url).then((s) => s != null && setDraft((d) => (d.targetUrl === result.secure_url ? { ...d, duration: Math.round(s * 100) / 100 } : d)))
                    // Also list it in the project's (or Default) library, like an upload.
                    const file = { name, size: result.bytes ?? 0, type: '' } as File
                    await (uploadShared ? recordSharedMedia(result, file, 'link', folder) : recordProjectMedia(projectId, result, file, folder, 'link')).catch(() => {})
                  }}
                />
                </BottomSheet>
                <div>
                  <Label hint={probing ? '偵測長度中…' : undefined}>URL</Label>
                  <div className="flex gap-2">
                    <input
                      className={`${fieldClass} font-mono text-xs`}
                      type="url"
                      aria-label="媒體 URL"
                      placeholder={R2_INPUT_PLACEHOLDER}
                      spellCheck={false}
                      value={draft.targetUrl}
                      onChange={(e) => set('targetUrl', e.target.value)}
                      onBlur={(e) => {
                        // A YouTube link is kept as a video cue played by YouTube's embedded player.
                        const yt = youtubeIdOf(e.target.value)
                        if (yt) {
                          setDraft((d) => ({ ...d, type: 'VIDEO', targetUrl: youtubeWatchUrl(yt), mediaStartTime: youtubeStartOf(e.target.value) || d.mediaStartTime }))
                          return
                        }
                        // An R2 path / URL plays through this server's address, like picked files.
                        const url = normalizeMediaInput(e.target.value)
                        if (url !== draft.targetUrl) set('targetUrl', url)
                        detectDuration(url)
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => setPickerOpen(true)}
                      className="min-h-11 shrink-0 rounded-lg border border-accent/50 bg-accent/10 px-3 text-xs font-medium whitespace-nowrap text-accent transition hover:bg-accent hover:text-white"
                    >
                      📁 選取檔案
                    </button>
                  </div>
                </div>
                <InboxPickerModal
                  open={pickerOpen}
                  projectId={projectId}
                  projectName={projectName}
                  uploads={inbox}
                  cues={allCues}
                  lockKind={draft.type === 'IMAGE' ? 'image' : draft.type === 'AUDIO' ? 'audio' : draft.type === 'VIDEO' ? 'video' : undefined}
                  onPick={pickFromInbox}
                  onPickMedia={pickFromLibrary}
                  onClose={() => setPickerOpen(false)}
                />
                {draft.type === 'IMAGE' && draft.targetUrl && (
                  <img src={draft.targetUrl} alt="" className="max-h-48 w-full rounded-lg bg-black object-contain" />
                )}
              </>
            ) : draft.type === 'VIBRATION' ? (
              <HapticEditor
                value={draft}
                onChange={(changes) =>
                  setDraft((d) => {
                    const next = { ...d, ...changes }
                    // The cue lasts as long as its pattern.
                    return { ...next, duration: Math.round(vibrationLengthMs(next)) / 1000 }
                  })
                }
              />
            ) : (
              <p className="rounded-lg bg-white/[0.03] p-4 text-sm text-white/40">
                「{CUE_TYPE_LABELS[draft.type]}」類型不需要媒體檔案。
              </p>
            )}

            {media && studioMode && draft.studioId && !studioMix.url && (
              <p className="rounded-lg bg-white/[0.03] p-4 text-center text-xs text-white/45" data-studio-wave-status>
                {studioMix.error ? `無法產生混音波形：${studioMix.error}` : '正在混音 Studio 專案以顯示波形…'}
              </p>
            )}
            {media && isYoutubeCue(draft) && (
              <YouTubePreview
                key={draft.targetUrl}
                url={draft.targetUrl}
                start={draft.mediaStartTime}
                end={draft.mediaEndTime}
                onTrim={(s, e) => setDraft((d) => ({ ...d, mediaStartTime: s, mediaEndTime: e }))}
                onDuration={(d) => setDraft((prev) => (prev.duration === d ? prev : { ...prev, duration: d }))}
              />
            )}
            {media && waveUrl && !isYoutubeCue(draft) && (
              <>
                <div>
                  <Label hint="黃色把手裁剪 · 藍色把手拉淡入淡出">波形 · 裁剪 · Fades</Label>
                  <WaveformTrimmer
                    key={waveUrl}
                    url={waveUrl}
                    start={draft.mediaStartTime}
                    end={draft.mediaEndTime}
                    onChange={(s, e) => setDraft((d) => ({ ...d, mediaStartTime: s, mediaEndTime: e }))}
                    onDuration={(d) => setDraft((prev) => (prev.duration === d ? prev : { ...prev, duration: d }))}
                    fadeIn={draft.fadeInTime}
                    fadeOut={draft.fadeOutTime}
                    autoStopAfter={draft.autoStopAfter}
                    loop={draft.loop}
                    volume={draft.volume}
                    onFadesChange={(fadeInTime, fadeOutTime) => setDraft((d) => ({ ...d, fadeInTime, fadeOutTime }))}
                    fadeInShape={draft.fadeInShape}
                    fadeOutShape={draft.fadeOutShape}
                    onShapesChange={(fadeInShape, fadeOutShape) => setDraft((d) => ({ ...d, fadeInShape, fadeOutShape }))}
                    onVolumeChange={(volume) => setDraft((d) => (d.volume === volume ? d : { ...d, volume }))}
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <NumberField
                    label="Start"
                    value={draft.mediaStartTime}
                    onChange={(v) => set('mediaStartTime', v)}
                    max={draft.duration || undefined}
                  />
                  <NumberField
                    label="End"
                    hint="0 = 檔案結尾"
                    value={draft.mediaEndTime}
                    onChange={(v) => set('mediaEndTime', v)}
                    max={draft.duration || undefined}
                  />
                </div>
                <div className="flex items-center justify-between rounded-lg bg-white/[0.03] px-3 py-2.5 text-xs">
                  <span className="text-white/40">片段長度 / 檔案長度</span>
                  <span className="font-mono text-white/80 tabular">
                    {formatTime(segmentLength(draft as Cue))} / {draft.duration ? formatTime(draft.duration) : '—'}
                  </span>
                </div>
              </>
            )}

            {media && (
              <div>
                <Label hint={`${draft.volume}%`}>音量</Label>
                <Fader label="Cue volume" value={draft.volume} onChange={(v) => set('volume', v)} fill="#30d158" />
              </div>
            )}
          </>
        )}

        {tab === 'start' && (
          <>
            <SectionTitle>When this cue starts</SectionTitle>
            <NumberField
              label="Pre-wait"
              hint="按下 GO 後延遲多久才開始"
              value={draft.preWaitTime}
              onChange={(v) => set('preWaitTime', v)}
            />
            {draft.preWaitTime > 0 && (
              <div className="space-y-3 rounded-xl border border-line bg-white/[0.03] p-3" data-prewait-vibrate>
                <button
                  type="button"
                  onClick={() => set('preWaitVibrate', !draft.preWaitVibrate)}
                  aria-pressed={draft.preWaitVibrate}
                  className={`flex min-h-12 w-full items-center justify-between rounded-xl border px-3 text-left text-sm font-semibold ${draft.preWaitVibrate ? 'border-standby bg-standby/15 text-standby' : 'border-line text-white/60'}`}
                  data-prewait-vibrate-toggle
                >
                  <span>⚡ Pre-Wait 結束前震動提醒</span>
                  <span className="text-xs">{draft.preWaitVibrate ? '已開啟' : '關閉'}</span>
                </button>
                {draft.preWaitVibrate && (
                  <>
                    <NumberField
                      label="提前提醒"
                      hint="在 Pre-Wait 結束前幾秒震動（0 = 結束的瞬間）"
                      value={draft.preWaitVibrateLead}
                      max={draft.preWaitTime}
                      onChange={(v) => set('preWaitVibrateLead', Math.min(v, draft.preWaitTime))}
                    />
                    {draft.type !== 'VIBRATION' && (
                      <HapticEditor
                        value={draft}
                        onChange={(changes) => setDraft((d) => ({ ...d, ...changes }))}
                      />
                    )}
                  </>
                )}
              </div>
            )}
            <div>
              <Label>Stop Others</Label>
              <Segmented<StopOthersMode>
                value={draft.stopOthers}
                onChange={(m) => set('stopOthers', m)}
                options={[
                  { id: 'none', label: STOP_OTHERS_LABELS.none },
                  { id: 'fade', label: STOP_OTHERS_LABELS.fade, description: '用各自的 Fade Out' },
                  { id: 'cut', label: STOP_OTHERS_LABELS.cut, description: '立即切斷' },
                ]}
              />
            </div>
            <div>
              <Label hint={draft.duckOthers > 0 ? `其他音軌降低 ${draft.duckOthers}%` : '關閉'}>Duck Others</Label>
              <Fader label="Duck others" value={draft.duckOthers} onChange={(v) => set('duckOthers', v)} fill="#ffd60a" />
              <p className="mt-1.5 text-xs text-white/35">此 Cue 播放期間，降低其他播放中音軌的音量；結束後自動恢復。</p>
            </div>
            <NumberField label="Fade In" value={draft.fadeInTime} onChange={(v) => set('fadeInTime', v)} />
            <Envelope draft={draft} />
          </>
        )}

        {tab === 'after' && (
          <AfterStartPanel
            draft={draft}
            media={media}
            onChange={(changes: Partial<Draft>) => setDraft((d) => ({ ...d, ...changes }))}
          />
        )}

        {tab === 'triggers' && (
          <>
            <SectionTitle>Triggers · 外部觸發</SectionTitle>
            <p className="text-xs leading-relaxed text-white/40">
              收到指定的 MIDI 或 OSC 訊號時，直接 GO 這個 Cue（不經過 Standby）。按「🎯 Learn」後操作外部設備即可自動填入。
            </p>
            {draft.triggers.map((trigger, i) => (
              <div key={i} className={`space-y-3 rounded-xl border border-line bg-black/30 p-3 ${trigger.enabled ? '' : 'opacity-50'}`}>
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-white/60">觸發 {i + 1}</span>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={() =>
                        set('triggers', draft.triggers.map((t, j) => (j === i ? { ...t, enabled: !t.enabled } : t)))
                      }
                      className={`min-h-9 rounded-lg px-3 text-xs font-semibold ${trigger.enabled ? 'bg-go/15 text-go' : 'bg-white/10 text-white/50'}`}
                    >
                      {trigger.enabled ? '啟用中' : '已停用'}
                    </button>
                    <button
                      type="button"
                      onClick={() => set('triggers', draft.triggers.filter((_, j) => j !== i))}
                      className="min-h-9 rounded-lg px-3 text-xs text-white/35 hover:bg-panic/20 hover:text-panic"
                    >
                      移除
                    </button>
                  </div>
                </div>
                <TriggerMatchEditor
                  match={trigger.match}
                  onChange={(match) => set('triggers', draft.triggers.map((t, j) => (j === i ? { ...t, match } : t)))}
                />
              </div>
            ))}
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => set('triggers', [...draft.triggers, { enabled: true, match: defaultMatch('midi') }])}
                className="min-h-12 rounded-xl border border-dashed border-white/20 text-sm text-white/60 hover:border-accent hover:text-white"
              >
                ＋ MIDI 觸發
              </button>
              <button
                type="button"
                onClick={() =>
                  set('triggers', [...draft.triggers, { enabled: true, match: { source: 'osc', address: `/cue/${draft.cueNumber}/go` } }])
                }
                className="min-h-12 rounded-xl border border-dashed border-white/20 text-sm text-white/60 hover:border-accent hover:text-white"
              >
                ＋ OSC 觸發
              </button>
            </div>
            <p className="text-[11px] text-white/30">需在「⚡ 外部觸發」設定中連線 OSC Bridge 或啟用 MIDI，且此演出版本有一個分頁擔任觸發主機。</p>
          </>
        )}

        {tab === 'target' && (
          <div className="space-y-6">
          <ChannelTargets count={channelCount} value={draft.targetChannels} onChange={(targetChannels) => setDraft((d) => ({ ...d, targetChannels }))} />
          <AudienceTargeting
            mode={draft.targetMode}
            ids={draft.targetIds}
            online={onlineAudience}
            onChange={(mode, ids) => setDraft((d) => ({ ...d, targetMode: mode, targetIds: ids }))}
          />
          </div>
        )}
      </div>

      <footer className="space-y-2 border-t border-line px-5 py-4">
        {error && <p className="text-xs text-panic">{error}</p>}
        <div className="flex gap-2">
          {onDelete && (
            <button
              onClick={() => confirm(`刪除 Cue ${draft.cueNumber}「${draft.title}」？`) && onDelete()}
              className="min-h-11 rounded-lg px-4 text-sm text-white/40 hover:bg-panic/20 hover:text-panic"
            >
              刪除
            </button>
          )}
          <button
            onClick={handleSave}
            disabled={saving || (!!cue && !dirty)}
            className="ml-auto min-h-11 rounded-lg bg-accent px-6 text-sm font-semibold text-white transition hover:brightness-110 disabled:opacity-35 pointer-coarse:min-h-13 pointer-coarse:text-base"
          >
            {saving ? '儲存中…' : cue ? (dirty ? '儲存變更' : '已儲存') : '加入清單'}
          </button>
        </div>
      </footer>
    </div>
  )
}

/** Cloudinary folder for an interactive cue's audience uploads, with one-tap suggestions. */
function UploadFolderField({
  value,
  onChange,
  projectId,
  suggestions,
}: {
  value: string
  onChange: (value: string) => void
  projectId: string
  suggestions: string[]
}) {
  const effective = uploadFolderFor(projectId, value)
  return (
    <div className="space-y-2">
      <Label hint="留空 = 專案預設資料夾">指定 Cloudinary 資料夾</Label>
      <input
        className={`${fieldClass} font-mono text-xs`}
        placeholder={`theatre/${projectId}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={(e) => onChange(sanitizeFolder(e.target.value))}
      />
      <div className="flex flex-wrap gap-1.5">
        {[...new Set(suggestions)].filter(Boolean).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onChange(s)}
            className="min-h-9 max-w-full truncate rounded-full bg-white/[0.06] px-3 text-[11px] text-white/60 hover:bg-white/10 hover:text-white"
          >
            ↳ {s}
          </button>
        ))}
      </div>
      <p className="text-[11px] text-white/35">
        觀眾上傳將存到 <span className="font-mono text-white/60">{effective}/</span>
      </p>
    </div>
  )
}

function SectionTitle({ children }: { children: string }) {
  return <h3 className="text-xs font-semibold tracking-wider text-white/60">{children}</h3>
}

/** Volume envelope preview: pre-wait, fade in, sustain, fade out. */
function Envelope({ draft }: { draft: Draft }) {
  const length = cueRunLength(draft as Cue)
  const body = Number.isFinite(length) ? length : Math.max(10, draft.fadeInTime + draft.fadeOutTime + 5)
  const total = draft.preWaitTime + body || 1
  const W = 300
  const H = 80
  const x = (s: number) => (s / total) * W
  const top = 12
  const level = top + (1 - draft.volume / 100) * (H - top - 6)

  const pw = x(draft.preWaitTime)
  const fi = x(draft.preWaitTime + Math.min(draft.fadeInTime, body))
  const fo = x(draft.preWaitTime + Math.max(0, body - draft.fadeOutTime))
  const points = `${pw},${H} ${fi},${level} ${Math.max(fi, fo)},${level} ${W},${H}`

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-24 w-full rounded-lg bg-black/40" preserveAspectRatio="none">
      {draft.preWaitTime > 0 && <rect x={0} y={0} width={pw} height={H} fill="rgba(255,214,10,0.08)" />}
      <polygon points={points} fill="rgba(48,209,88,0.18)" />
      <polyline points={points} fill="none" stroke="#30d158" strokeWidth={2} vectorEffect="non-scaling-stroke" />
      {!Number.isFinite(length) && (
        <text x={W - 6} y={top + 4} textAnchor="end" fontSize={10} fill="rgba(255,255,255,0.35)">
          ∞ hold
        </text>
      )}
    </svg>
  )
}
