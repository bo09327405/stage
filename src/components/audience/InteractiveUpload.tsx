import { useEffect, useRef, useState } from 'react'
import type { CloudinaryUploadResult } from '../../services/cloudinary'
import { openAudienceWidget, type WidgetMedia } from '../../services/cloudinaryWidget'
import { audienceContext, audienceTags, recordAudienceUpload, submitAudienceMedia } from '../../services/uploads'
import type { Cue, UploadKind } from '../../types/cue'
import { uploadFolderFor, type ShowRef } from '../../types/project'

const MAX_RECORDING_SECONDS = 60

type Status =
  | { phase: 'idle' }
  | { phase: 'uploading' }
  | { phase: 'done'; count: number }
  | { phase: 'error'; message: string }

type Mode = 'photo' | 'audio' | 'file'

/** Ways to send for each cue setting; "file" is the Cloudinary Upload Widget. */
const MODES: Record<UploadKind, Mode[]> = {
  photo: ['photo'],
  audio: ['audio'],
  both: ['photo', 'audio'],
  video: ['file'],
  any: ['photo', 'audio', 'file'],
}
const MODE_LABEL: Record<Mode, string> = { photo: '📷 照片', audio: '🎙 錄音', file: '📎 檔案' }

/**
 * Shown during an INTERACTIVE_UPLOAD cue: the audience sends photos, voice recordings, or — via
 * the Cloudinary Upload Widget — videos and sound files. Everything goes to Cloudinary and waits
 * for moderation before it can be shown or played.
 */
export function InteractiveUpload({ cue, show }: { cue: Cue; show: ShowRef }) {
  const modes = MODES[cue.uploadKind] ?? MODES.photo
  const [mode, setMode] = useState<Mode>(modes[0])
  const [status, setStatus] = useState<Status>({ phase: 'idle' })
  const sent = useRef(0)

  const done = () => {
    sent.current += 1
    setStatus({ phase: 'done', count: sent.current })
  }

  async function send(file: File | Blob, kind: 'image' | 'audio') {
    setStatus({ phase: 'uploading' })
    try {
      await submitAudienceMedia(show, cue, file, kind)
      done()
    } catch (err) {
      setStatus({ phase: 'error', message: (err as Error).message })
    }
  }

  async function fromWidget(result: CloudinaryUploadResult) {
    try {
      await recordAudienceUpload(show, cue, result, { folder: uploadFolderFor(show.projectId, cue.uploadFolder), via: 'widget' })
      done()
    } catch (err) {
      setStatus({ phase: 'error', message: (err as Error).message })
    }
  }

  const busy = status.phase === 'uploading'

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 px-6 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-center">
      <p className="max-w-md text-2xl leading-relaxed font-medium whitespace-pre-line">{cue.text || cue.title}</p>

      {modes.length > 1 && (
        <div className="flex rounded-full bg-white/10 p-1 text-sm">
          {modes.map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              disabled={busy}
              className={`rounded-full px-5 py-1.5 transition ${mode === m ? 'bg-white text-black' : 'text-white/60'}`}
              data-upload-mode={m}
            >
              {MODE_LABEL[m]}
            </button>
          ))}
        </div>
      )}

      <div className={`w-full max-w-xs ${busy ? 'pointer-events-none opacity-40' : ''}`}>
        {mode === 'photo' ? (
          <PhotoPicker onPick={(file) => send(file, 'image')} again={status.phase === 'done'} />
        ) : mode === 'audio' ? (
          <VoiceRecorder onRecorded={(blob) => send(blob, 'audio')} />
        ) : (
          <WidgetButton
            accept={cue.uploadKind === 'video' ? ['video'] : ['image', 'video', 'audio']}
            open={(accept, handlers) =>
              openAudienceWidget({
                folder: uploadFolderFor(show.projectId, cue.uploadFolder),
                tags: audienceTags(show, cue.id),
                context: audienceContext(show, cue.id),
                accept,
                ...handlers,
              })
            }
            onUploaded={fromWidget}
            onError={(message) => setStatus({ phase: 'error', message })}
            again={status.phase === 'done'}
          />
        )}
      </div>

      {status.phase === 'uploading' && (
        <div className="w-full max-w-xs">
          <div className="h-1.5 overflow-hidden rounded-full bg-white/15">
            <div className="h-full w-1/3 animate-[upload-slide_1.2s_ease-in-out_infinite] rounded-full bg-white" />
          </div>
          <p className="mt-2 text-sm text-white/60">上傳中…</p>
        </div>
      )}
      {status.phase === 'done' && (
        <div>
          <p className="text-[#30d158]" data-upload-done>
            ✓ 已送出{status.count > 1 ? `（共 ${status.count} 份）` : ''}
          </p>
          <p className="mt-1 text-xs text-white/40">內容審查通過後才會出現在舞台上</p>
        </div>
      )}
      {status.phase === 'error' && <p className="text-[#ff453a]">上傳失敗：{status.message}</p>}
    </div>
  )
}

/** Opens the Cloudinary Upload Widget (files or camera) for videos, sound files and photos. */
function WidgetButton({
  accept,
  open,
  onUploaded,
  onError,
  again,
}: {
  accept: WidgetMedia[]
  open: (accept: WidgetMedia[], handlers: { onUploaded: (r: CloudinaryUploadResult) => void; onError: (m: string) => void; onClose: () => void }) => Promise<unknown>
  onUploaded: (result: CloudinaryUploadResult) => void
  onError: (message: string) => void
  again: boolean
}) {
  const [opening, setOpening] = useState(false)
  const label = accept.length === 1 && accept[0] === 'video' ? '🎬 上傳影片' : '📎 上傳照片／影片／音效'
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        disabled={opening}
        onClick={() => {
          setOpening(true)
          open(accept, { onUploaded, onError, onClose: () => setOpening(false) }).catch((err: Error) => {
            setOpening(false)
            onError(err.message)
          })
        }}
        className={`${pickerClass} bg-white text-black disabled:opacity-50`}
        data-upload-widget
      >
        {opening ? '開啟中…' : again ? '再傳一個' : label}
      </button>
      <p className="text-xs text-white/40">單檔上限 100 MB</p>
    </div>
  )
}

const pickerClass =
  'flex w-full cursor-pointer items-center justify-center rounded-2xl py-4 text-lg font-semibold transition active:scale-[0.98]'

function PhotoPicker({ onPick, again }: { onPick: (file: File) => void; again: boolean }) {
  const handle = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (file) onPick(file)
  }
  return (
    <div className="flex flex-col gap-3">
      <label className={`${pickerClass} bg-white text-black`}>
        📷 {again ? '再拍一張' : '拍照'}
        <input type="file" accept="image/*" capture="environment" className="hidden" onChange={handle} />
      </label>
      <label className={`${pickerClass} border border-white/40 text-white`}>
        🖼 從相簿選擇
        <input type="file" accept="image/*" className="hidden" onChange={handle} />
      </label>
    </div>
  )
}

const canRecord = () =>
  typeof window !== 'undefined' &&
  window.isSecureContext &&
  !!navigator.mediaDevices?.getUserMedia &&
  typeof MediaRecorder !== 'undefined'

function pickMimeType(): string | undefined {
  const candidates = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus']
  return candidates.find((t) => MediaRecorder.isTypeSupported?.(t))
}

/**
 * Records with MediaRecorder (needs HTTPS or localhost). On plain-http LAN testing it falls
 * back to the OS audio picker/recorder via a file input.
 */
function VoiceRecorder({ onRecorded }: { onRecorded: (blob: Blob) => void }) {
  const [state, setState] = useState<'idle' | 'recording' | 'review'>('idle')
  const [seconds, setSeconds] = useState(0)
  const [blob, setBlob] = useState<Blob | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl)
  }, [previewUrl])

  // Release the microphone if the cue ends mid-recording.
  useEffect(
    () => () => {
      const rec = recorderRef.current
      if (rec && rec.state !== 'inactive') rec.stop()
    },
    [],
  )

  useEffect(() => {
    if (state !== 'recording') return
    const timer = setInterval(() => {
      setSeconds((s) => {
        if (s + 1 >= MAX_RECORDING_SECONDS) recorderRef.current?.stop()
        return s + 1
      })
    }, 1000)
    return () => clearInterval(timer)
  }, [state])

  async function start() {
    setError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mimeType = pickMimeType()
      const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      const chunks: Blob[] = []
      rec.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data)
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop())
        const recorded = new Blob(chunks, { type: rec.mimeType || 'audio/webm' })
        setBlob(recorded)
        setPreviewUrl(URL.createObjectURL(recorded))
        setState('review')
      }
      recorderRef.current = rec
      rec.start()
      setSeconds(0)
      setState('recording')
    } catch (err) {
      setError((err as Error).name === 'NotAllowedError' ? '需要麥克風權限才能錄音' : (err as Error).message)
    }
  }

  if (!canRecord()) {
    return (
      <label className={`${pickerClass} bg-white text-black`}>
        🎙 錄音 / 選擇音檔
        <input
          type="file"
          accept="audio/*"
          capture
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = ''
            if (file) onRecorded(file)
          }}
        />
      </label>
    )
  }

  return (
    <div className="flex flex-col items-center gap-4">
      {state === 'idle' && (
        <button onClick={start} className={`${pickerClass} bg-white text-black`}>
          🎙 開始錄音
        </button>
      )}

      {state === 'recording' && (
        <>
          <div className="flex items-center gap-3 font-mono text-3xl tabular">
            <span className="h-3 w-3 animate-pulse rounded-full bg-[#ff453a]" />
            {String(Math.floor(seconds / 60)).padStart(2, '0')}:{String(seconds % 60).padStart(2, '0')}
          </div>
          <button onClick={() => recorderRef.current?.stop()} className={`${pickerClass} bg-[#ff453a] text-white`}>
            ■ 停止
          </button>
          <p className="text-xs text-white/40">最長 {MAX_RECORDING_SECONDS} 秒</p>
        </>
      )}

      {state === 'review' && blob && previewUrl && (
        <>
          <audio src={previewUrl} controls className="w-full" />
          <div className="grid w-full grid-cols-2 gap-3">
            <button onClick={() => setState('idle')} className={`${pickerClass} border border-white/40 text-white`}>
              重錄
            </button>
            <button
              onClick={() => {
                onRecorded(blob)
                setState('idle')
              }}
              className={`${pickerClass} bg-white text-black`}
            >
              送出
            </button>
          </div>
        </>
      )}

      {error && <p className="text-sm text-[#ff453a]">{error}</p>}
    </div>
  )
}
