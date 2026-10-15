import { get, ref } from 'firebase/database'
import { db } from './services/firebase'
import { useEffect, useState } from 'react'
import { AudienceView } from './components/audience/AudienceView'
import { ConsoleView } from './components/console/ConsoleView'
import { Hub } from './components/hub/Hub'
import { LoginScreen } from './components/hub/LoginScreen'
import { StudioView } from './components/studio/StudioView'
import { SurfaceView } from './components/surface/SurfaceView'
import { useProject } from './services/projects'
import { useAuth, type AppUser } from './services/auth'
import { ensureProjectAccess, joinSetCue, type Access } from './services/membership'
import { ReadOnlyBar } from './components/hub/ProjectStatus'
import type { ShowRef } from './types/project'

/*
 * Routes:
 *   /                                       audience, follows the on-air version
 *   /?project=…&version=…                   audience pinned to one version
 *   /?role=console                          hub (Set Cue / Studio projects) — sign-in required
 *   (console, control surface and Studio all need a Google sign-in; the audience never does)
 *   /?role=console&project=…&version=…      cue console for one version
 *   /surface  (or /?role=surface)           control surface; picks a project first
 *   /surface?project=…&version=…&surface=…  a specific control surface
 *   …&invite=…                              share link: joins the project as a collaborator
 *
 * Opening a project needs membership (owner / collaborator), an admin account, or the project's
 * invite token from a share link (see ProjectGate).
 */
// ?project / ?version, also accepted as ?projectId / ?versionId.
const projectParam = (params: URLSearchParams) => params.get('project') ?? params.get('projectId')
function readShow(params: URLSearchParams): ShowRef | null {
  const projectId = projectParam(params)
  const versionId = params.get('version') ?? params.get('versionId')
  return projectId && versionId ? { projectId, versionId } : null
}

const initialParams = new URLSearchParams(window.location.search)
const isSurface = /\/(surface|control-panel)$/.test(window.location.pathname.replace(/\/+$/, '')) || initialParams.get('role') === 'surface'
const isConsole = initialParams.get('role') === 'console'
const isStudio = initialParams.get('role') === 'studio'

/** URL-backed navigation for the console and surface apps (keeps the current path and role). */
function useShowRoute() {
  const [show, setShow] = useState(() => readShow(new URLSearchParams(window.location.search)))

  useEffect(() => {
    const onPop = () => setShow(readShow(new URLSearchParams(window.location.search)))
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  // A link with only the project (e.g. /control-panel?projectId=…) opens its newest version.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const projectId = projectParam(params)
    if (show || !projectId) return
    get(ref(db, `projectIndex/${projectId}/versions`))
      .then((snap) => {
        const versions = Object.entries((snap.val() ?? {}) as Record<string, { createdAt?: number }>).sort((a, b) => (b[1].createdAt ?? 0) - (a[1].createdAt ?? 0))
        const versionId = versions[0]?.[0]
        if (!versionId) return
        params.delete('projectId')
        params.set('project', projectId)
        params.set('version', versionId)
        window.history.replaceState(null, '', `${window.location.pathname}?${params}`)
        setShow({ projectId, versionId })
      })
      .catch(() => {})
  }, [show])

  const navigate = (next: ShowRef | null, extra: Record<string, string> = {}) => {
    const params = new URLSearchParams()
    const role = new URLSearchParams(window.location.search).get('role')
    if (role) params.set('role', role)
    if (next) {
      params.set('project', next.projectId)
      params.set('version', next.versionId)
    }
    for (const [k, v] of Object.entries(extra)) params.set(k, v)
    window.history.pushState(null, '', `${window.location.pathname}?${params}`)
    setShow(next)
  }

  return [show, navigate] as const
}

/** Resolve project/version names, or render a "not found" screen. */
function useShowNames(show: ShowRef | null) {
  const found = useProject(show?.projectId ?? null)
  const project = found ?? undefined
  const version = project?.versions.find((v) => v.id === show?.versionId)
  return { loaded: found !== undefined, missing: found !== undefined && !!show && !version, project, version }
}

/**
 * Lets members and admins in; joins people who bring the project's invite token (share link);
 * shows "no access" to everyone else. Renders `children` once access is settled.
 */
function ProjectGate({ user, projectId, onBack, children }: { user: AppUser; projectId: string; onBack: () => void; children: React.ReactNode }) {
  const [access, setAccess] = useState<Access | null>(null)
  useEffect(() => {
    let alive = true
    const params = new URLSearchParams(window.location.search)
    const invite = params.get('invite')
    ensureProjectAccess(user, projectId, invite).then(
      (a) => {
        if (!alive) return
        setAccess(a)
        // The token has done its job; keep it out of the address bar (and of links copied from it).
        if (invite && a.status !== 'denied') {
          params.delete('invite')
          window.history.replaceState(null, '', `${window.location.pathname}?${params}`)
        }
      },
      () => alive && setAccess({ status: 'denied', reason: 'no-invite' }),
    )
    return () => {
      alive = false
    }
  }, [user, projectId])
  if (!access) return <div className="flex h-dvh items-center justify-center bg-ink text-sm text-white/30">確認專案權限…</div>
  if (access.status === 'missing') return <NotFound onBack={onBack} />
  if (access.status === 'denied') return <NoAccess reason={access.reason} onBack={onBack} />
  return <>{children}</>
}

function NoAccess({ reason, onBack }: { reason: 'no-invite' | 'bad-invite'; onBack: () => void }) {
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-ink px-6 text-center text-white" data-no-access>
      <div className="text-5xl">🔒</div>
      <p className="text-lg font-semibold">你沒有這個專案的存取權</p>
      <p className="max-w-md text-sm text-white/50">
        {reason === 'bad-invite'
          ? '這個邀請連結已失效（可能已被專案成員重新產生）。請向專案成員索取新的專案網址。'
          : '只有專案的建立者與協作者可以開啟它。請向專案成員索取專案網址（含邀請碼），用 Google 帳號登入後開啟即可加入。'}
      </p>
      <button onClick={onBack} className="min-h-11 rounded-xl bg-accent px-5 text-sm font-semibold">
        返回大廳
      </button>
    </div>
  )
}

function NotFound({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-4 bg-ink text-white">
      <p className="text-white/50">找不到這個專案版本（可能已被刪除）。</p>
      <button onClick={onBack} className="min-h-11 rounded-xl bg-accent px-5 text-sm font-semibold">
        返回大廳
      </button>
    </div>
  )
}

/** Opening a Set Cue project (console / control panel) while signed in joins it. */
function useJoinSetCue(user: AppUser, show: ShowRef | null, projectName: string | undefined) {
  useEffect(() => {
    if (show && projectName) joinSetCue(user, show.projectId, show.versionId, projectName).catch(() => {})
  }, [user, show, projectName])
}

/** Operator pages need a Google sign-in. */
function RequireLogin({ children }: { children: (user: AppUser) => React.ReactNode }) {
  const { user, ready } = useAuth()
  if (!ready) return <div className="flex h-dvh items-center justify-center bg-ink text-sm text-white/30">載入中…</div>
  if (!user) return <LoginScreen />
  return <>{children(user)}</>
}

function ConsoleApp({ user }: { user: AppUser }) {
  const [show, navigate] = useShowRoute()
  if (!show) return <Hub user={user} onOpenSetCue={navigate} />
  return (
    <ProjectGate key={show.projectId} user={user} projectId={show.projectId} onBack={() => navigate(null)}>
      <ConsoleShow user={user} show={show} navigate={navigate} />
    </ProjectGate>
  )
}

function ConsoleShow({ user, show, navigate }: { user: AppUser; show: ShowRef; navigate: (next: ShowRef | null) => void }) {
  const { missing, project, version } = useShowNames(show)
  useJoinSetCue(user, missing ? null : show, project?.name)
  if (missing) return <NotFound onBack={() => navigate(null)} />
  return (
    <>
    <ReadOnlyBar user={user} projectId={show.projectId} projectName={project?.name ?? ''} />
    <ConsoleView
      key={`${show.projectId}/${show.versionId}`}
      show={show}
      projectName={project?.name ?? '…'}
      versionName={version?.name ?? '…'}
      onBack={() => navigate(null)}
      onOpenVersion={navigate}
    />
    </>
  )
}

function SurfaceApp({ user }: { user: AppUser }) {
  const [show, navigate] = useShowRoute()
  if (!show) return <Hub user={user} onOpenSetCue={navigate} />
  return (
    <ProjectGate key={show.projectId} user={user} projectId={show.projectId} onBack={() => navigate(null)}>
      <SurfaceShow user={user} show={show} navigate={navigate} />
    </ProjectGate>
  )
}

function SurfaceShow({ user, show, navigate }: { user: AppUser; show: ShowRef; navigate: (next: ShowRef | null) => void }) {
  const { missing, project, version } = useShowNames(show)
  useJoinSetCue(user, missing ? null : show, project?.name)
  if (missing) return <NotFound onBack={() => navigate(null)} />
  return (
    <>
    <ReadOnlyBar user={user} projectId={show.projectId} projectName={project?.name ?? ''} />
    <SurfaceView
      key={`${show.projectId}/${show.versionId}`}
      show={show}
      projectName={project?.name ?? '…'}
      versionName={version?.name ?? '…'}
      initialSurfaceId={new URLSearchParams(window.location.search).get('surface')}
      onSurfaceChange={(surfaceId) => {
        const params = new URLSearchParams(window.location.search)
        if (surfaceId) params.set('surface', surfaceId)
        else params.delete('surface')
        window.history.replaceState(null, '', `${window.location.pathname}?${params}`)
      }}
      onBack={() => navigate(null)}
    />
    </>
  )
}

function StudioApp({ user }: { user: AppUser }) {
  const [show, navigate] = useShowRoute()
  if (!show) return <Hub user={user} onOpenSetCue={(s) => (location.href = `${location.pathname}?role=console&project=${s.projectId}&version=${s.versionId}`)} />
  return (
    <ProjectGate key={show.projectId} user={user} projectId={show.projectId} onBack={() => navigate(null)}>
      <StudioShow user={user} show={show} navigate={navigate} />
    </ProjectGate>
  )
}

function StudioShow({ user, show, navigate }: { user: AppUser; show: ShowRef; navigate: (next: ShowRef | null) => void }) {
  const { missing, project } = useShowNames(show)
  if (missing) return <NotFound onBack={() => navigate(null)} />
  return (
    <>
    <ReadOnlyBar user={user} projectId={show.projectId} projectName={project?.name ?? ''} />
    <StudioView
      key={show.projectId}
      show={show}
      projectName={project?.name ?? '…'}
      backLabel={project?.kind === 'studio' ? '大廳' : '控台'}
      standalone={project?.kind === 'studio'}
      onBack={() => {
        // A standalone Studio project goes back to the hub; a show's studio to its Set Cue console.
        location.href =
          project?.kind === 'studio' ? (localStorage.setItem('theatre.hub.tab', 'studio'), `${location.pathname}?role=console`) : `${location.pathname}?role=console&project=${show.projectId}&version=${show.versionId}`
      }}
    />
    </>
  )
}

function App() {
  if (isStudio) return <RequireLogin>{(user) => <StudioApp user={user} />}</RequireLogin>
  if (isSurface) return <RequireLogin>{(user) => <SurfaceApp user={user} />}</RequireLogin>
  if (isConsole) return <RequireLogin>{(user) => <ConsoleApp user={user} />}</RequireLogin>
  return <AudienceView pinned={readShow(initialParams)} />
}

export default App
