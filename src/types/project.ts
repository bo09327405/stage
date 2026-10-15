/** Lightweight listing data for the lobby, stored at /projectIndex/{projectId}. */
export interface ProjectSummary {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  versions: VersionSummary[]
  /** Who created it (projects from before sign-in have none). */
  owner?: { uid: string; name: string; email: string }
  /** uids of the people who joined it through its link. */
  collaboratorIds: string[]
  /** "studio": a container made for a standalone DAW Studio project (not listed under Set Cue). */
  kind?: 'studio'
  /** Read-only for everyone but admins (see services/projectLock.ts). */
  isLocked?: boolean
  /** Official template: viewable by every signed-in user, forkable; read-only. */
  isMasterTemplate?: boolean
  /** Archived: read-only, listed apart. */
  isArchived?: boolean
  /** Pinned by an admin: listed first. */
  isPinned?: boolean
  /** Set on a fork: the project it was copied from. */
  forkedFrom?: { projectId: string; name: string; at?: number }
}

export interface VersionSummary {
  id: string
  name: string
  createdAt: number
  /** The version this one was saved from, if any. */
  parentId: string | null
}

/** Which show version the audience follows, stored at /live. */
export interface LivePointer {
  projectId: string
  versionId: string
  projectName: string
  versionName: string
}

/** A project + version pair, which is everything needed to locate a show's data. */
export interface ShowRef {
  projectId: string
  versionId: string
}

/** Root of a version's data: cueList, hits, showState and presence live underneath. */
export const versionPath = ({ projectId, versionId }: ShowRef) => `projects/${projectId}/versions/${versionId}`

/** A project's audience media pool, shared by all of its versions. */
export const projectUploadsPath = (projectId: string) => `projects/${projectId}/uploads`

/** Cloudinary folders allow letters (including CJK), digits, spaces, '-', '_' and '/' separators. */
export function sanitizeFolder(folder: string): string {
  return folder
    .split('/')
    .map((part) => part.replace(/[^\p{L}\p{N} _-]/gu, '').trim())
    .filter(Boolean)
    .join('/')
}

/**
 * A project name made safe as one Cloudinary folder segment: whitespace and separators become
 * "_", anything that isn't a letter (CJK included), digit, "-" or "_" is removed, and runs of
 * "_" collapse. Falls back to the project id when nothing usable is left (e.g. "!!!").
 *   "318" → "318"   "2026 秋季公演" → "2026_秋季公演"   "A/B: Test?" → "A_B_Test"
 */
export function cleanProjectName(name: string, fallback: string): string {
  const cleaned = name
    .normalize('NFC')
    .replace(/[\s/\\.:]+/g, '_')
    .replace(/[^\p{L}\p{N}_-]/gu, '')
    .replace(/_+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '')
    .slice(0, 60)
  // "Default" is the shared folder every project uses; a project called that gets its own.
  if (cleaned.toLowerCase() === 'default') return `${cleaned}_${fallback.replace(/[^\w-]/g, '').slice(-6)}`
  return cleaned || fallback
}

/** Cloudinary folder for media uploaded in Set Cue: theatre/cues/{cleanProjectName}. */
export const cueMediaFolder = (projectName: string, projectId: string) =>
  `theatre/cues/${cleanProjectName(projectName, projectId)}`

/** Cloudinary folder for DAW Studio recordings, TTS clips and mixdowns: theatre/daw/{cleanProjectName}. */
export const studioMediaFolder = (projectName: string, projectId: string) =>
  `theatre/daw/${cleanProjectName(projectName, projectId)}`

/** Cloudinary folder for DAW project files (.json) shared by every show. */
export const STUDIO_DEFAULT_FOLDER = 'theatre/daw/Default'
/** Index of the shared DAW project files (Cloudinary can't be listed from the browser). */
export const SHARED_STUDIO_FILES_PATH = 'sharedStudioFiles/default'
/** Cloudinary folder for a show's own DAW project files. */
export const studioFilesFolder = (projectName: string, projectId: string) => `${studioMediaFolder(projectName, projectId)}/projects`

/** Cloudinary folder for hit sounds: theatre/hits/{cleanProjectName}. */
export const hitMediaFolder = (projectName: string, projectId: string) =>
  `theatre/hits/${cleanProjectName(projectName, projectId)}`

/** Cloudinary folder of shared media every project can pick from (sounds, music, stock images). */
export const DEFAULT_MEDIA_FOLDER = 'theatre/cues/Default'

/** Index of the shared Default folder, readable from every project. */
export const SHARED_MEDIA_PATH = 'sharedMedia/default'

/** A project's media library index (Cloudinary can't be listed from the browser). */
export const projectMediaPath = (projectId: string) => `projects/${projectId}/media`

/** Where a cue's audience uploads go: its own folder, or theatre/{projectId}. */
export const uploadFolderFor = (projectId: string, cueFolder: string) =>
  sanitizeFolder(cueFolder) || `theatre/${projectId}`
