import { get, limitToLast, onValue, orderByChild, push, query, ref, serverTimestamp, set } from 'firebase/database'
import { useEffect, useState } from 'react'
import { currentUser } from './auth'
import { db } from './firebase'

/*
 * File activity log: every upload, add, rename, move, assignment and delete of a media file, with
 * who did it and which project / Studio it belongs to.
 *
 *   fileActivity/{id}   { at, action, name, fileType, storage, url, key, record, projectId,
 *                         projectName, studioId, studioName, editor: {uid, name, email}, from, to }
 *
 * Anyone signed in appends entries in their own name; only admins read them (global manager →
 * 📜 檔案流動紀錄). Logging never blocks or fails the operation it records.
 */

export type FileAction = 'upload' | 'link' | 'rename' | 'move' | 'delete' | 'assign'
export type FileType = 'audio' | 'image' | 'video' | 'document' | 'other'

export const ACTION_LABELS: Record<FileAction | 'existing', string> = {
  upload: '上傳',
  link: '加入素材庫',
  rename: '重新命名',
  move: '移動',
  delete: '刪除',
  assign: '指派到專案',
  existing: '既有檔案',
}

export interface FileActivity {
  id: string
  at: number
  action: FileAction
  name: string
  fileType: FileType
  storage: 'r2' | 'cloudinary' | null
  url: string | null
  key: string | null
  /** Library record the entry is about (projects/{pid}/media/{id}, sharedMedia/default/{id}). */
  record: string | null
  projectId: string | null
  projectName: string | null
  studioId: string | null
  studioName: string | null
  editor: { uid: string; name: string; email: string } | null
  /** Before → after (old name / folder, new name / folder). */
  from: string | null
  to: string | null
}

export type FileActivityInput = Partial<Omit<FileActivity, 'id' | 'at' | 'editor' | 'action' | 'name'>> & { action: FileAction; name: string }

/** File type from a name, URL or library kind. */
export function fileTypeOf(nameOrUrl: string, kind?: string | null): FileType {
  if (kind === 'audio' || kind === 'image' || kind === 'video') return kind
  if (kind === 'project' || kind === 'config') return 'document'
  const ext = /\.([a-z0-9]+)(?:$|\?)/i.exec(nameOrUrl)?.[1]?.toLowerCase() ?? ''
  if (/^(wav|mp3|m4a|aac|ogg|oga|flac|webm|opus|aif|aiff)$/.test(ext)) return 'audio'
  if (/^(png|jpe?g|gif|webp|avif|heic|svg)$/.test(ext)) return 'image'
  if (/^(mp4|mov|m4v|mkv)$/.test(ext)) return 'video'
  if (/^(json|txt|md|pdf|docx?)$/.test(ext)) return 'document'
  return 'other'
}

const names = new Map<string, string>()
async function projectNameOf(projectId: string) {
  if (!names.has(projectId)) names.set(projectId, String((await get(ref(db, `projectIndex/${projectId}/name`)).catch(() => null))?.val() ?? ''))
  return names.get(projectId) || null
}
async function studioNameOf(projectId: string, studioId: string) {
  return String((await get(ref(db, `projects/${projectId}/studio/${studioId}/name`)).catch(() => null))?.val() ?? '') || null
}

/** Append an entry (as the signed-in user). Never throws. */
export async function logFileActivity(entry: FileActivityInput) {
  const u = currentUser()
  if (!u) return
  try {
    const projectName = entry.projectName ?? (entry.projectId ? await projectNameOf(entry.projectId) : null)
    const studioName = entry.studioName ?? (entry.projectId && entry.studioId ? await studioNameOf(entry.projectId, entry.studioId) : null)
    await set(push(ref(db, 'fileActivity')), {
      at: serverTimestamp(),
      action: entry.action,
      name: entry.name.slice(0, 200),
      fileType: entry.fileType ?? fileTypeOf(entry.name),
      storage: entry.storage ?? null,
      url: entry.url ?? null,
      key: entry.key ?? null,
      record: entry.record ?? null,
      projectId: entry.projectId ?? null,
      projectName,
      studioId: entry.studioId ?? null,
      studioName,
      editor: { uid: u.uid, name: u.name, email: u.email },
      from: entry.from ?? null,
      to: entry.to ?? null,
    })
  } catch {
    // The log is best effort: the file operation already happened.
  }
}

/** The project id behind a library record path (projects/{pid}/media/{id}); null for the shared Default index. */
export const projectOfRecord = (path: string) => /^projects\/([^/]+)\/media\//.exec(path)?.[1] ?? null

/** The latest entries (admins), newest first. */
export function useFileActivity(limit = 2000) {
  const [entries, setEntries] = useState<FileActivity[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(
    () =>
      onValue(
        query(ref(db, 'fileActivity'), orderByChild('at'), limitToLast(limit)),
        (snap) => {
          const out: FileActivity[] = []
          snap.forEach((c) => {
            out.push({ id: c.key!, ...(c.val() as Omit<FileActivity, 'id'>) })
          })
          setEntries(out.reverse())
        },
        (err) => setError(err.message),
      ),
    [limit],
  )
  return { entries, error }
}
