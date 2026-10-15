import { NewStudioDialog, StudioAdminMenu } from './StudioManage'
import { restoreStudio } from '../../services/studioAdmin'
import { PurgeDialog } from './PurgeDialog'
import { LobbyPlayerBar, LobbyPlayerSpacer, StudioPlayButton } from './LobbyPlayer'
import { GroupMenu, SortableList, TagButton, TagChips, ViewToggle, type TagActions } from './StudioHubControls'
import { GROUP_MODES, arrange, byName, dateBucket, tagDefsOf, tagLabel, useGroupMode, useStudioLayout, useViewMode, type GroupMode, type StudioLayout, type TagDef, type ViewMode } from '../../services/hubLayout'
import { GlobalManager } from './GlobalManager'
import { onValue, ref } from 'firebase/database'
import { useEffect, useMemo, useState } from 'react'
import { isAdmin, signOutUser, useAuth, type AppUser } from '../../services/auth'
import { db } from '../../services/firebase'
import { leaveProject, useStudioMeta, useUserProjects, type StudioMeta } from '../../services/membership'
import { restoreProject, useProjectIndex, useTrash } from '../../services/projects'
import type { ProjectSummary, ShowRef } from '../../types/project'
import { Lobby } from '../lobby/Lobby'
import { isReadOnlyProject, useTemplates } from '../../services/projectLock'
import { AdminProjectFlags, ForkButton, ProjectBadges } from './ProjectStatus'
import { ConfirmDialog } from '../ui/ConfirmDialog'

type Tab = 'setcue' | 'studio' | 'trash' | 'files'
const TAB_KEY = 'theatre.hub.tab'

const studioUrl = (projectId: string, versionId: string, studioId: string) =>
  `${location.pathname.replace(/\/surface\/?$/, '/')}?role=studio&project=${encodeURIComponent(projectId)}&version=${encodeURIComponent(versionId)}&studio=${encodeURIComponent(studioId)}`

/** Signed-in user chip: avatar, name, email, admin badge, sign out. */
export function UserChip({ user, compact = false }: { user: AppUser; compact?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative" data-user-chip>
      <button type="button" onClick={() => setOpen(!open)} className="flex min-h-10 items-center gap-2 rounded-full bg-white/[0.06] py-1 pr-3 pl-1 text-xs hover:bg-white/10" title={user.email}>
        <Avatar user={user} size={28} />
        {!compact && <span className="max-w-32 truncate text-white/80">{user.name}</span>}
        {isAdmin(user) && <span className="rounded bg-standby/20 px-1 text-[9px] font-bold text-standby">管理員</span>}
      </button>
      {open && (
        <div className="absolute top-full right-0 z-50 mt-1 w-64 rounded-xl border border-white/10 bg-[#202020]/95 p-3 text-xs shadow-2xl backdrop-blur-xl">
          <div className="flex items-center gap-2">
            <Avatar user={user} size={36} />
            <div className="min-w-0">
              <div className="truncate font-semibold text-white">{user.name}</div>
              <div className="truncate text-white/45">{user.email}</div>
            </div>
          </div>
          <button type="button" onClick={() => signOutUser()} className="mt-3 min-h-9 w-full rounded-lg bg-white/10 font-semibold text-white/80 hover:bg-white/15" data-sign-out>
            登出
          </button>
        </div>
      )}
    </div>
  )
}

/** The signed-in user's chip, for headers that don't have the user at hand. */
export function CurrentUserChip() {
  const { user } = useAuth()
  return user ? <UserChip user={user} compact /> : null
}

export function Avatar({ user, size = 24 }: { user: { name: string; photo?: string }; size?: number }) {
  const initial = (user.name || '?').trim().slice(0, 1).toUpperCase()
  return user.photo ? (
    <img src={user.photo} alt="" referrerPolicy="no-referrer" className="shrink-0 rounded-full object-cover" style={{ width: size, height: size }} />
  ) : (
    <span className="flex shrink-0 items-center justify-center rounded-full bg-accent/40 font-bold text-white" style={{ width: size, height: size, fontSize: size * 0.45 }}>
      {initial}
    </span>
  )
}

/**
 * The hub after sign-in: Set Cue projects and Studio projects, each split into your own, the
 * ones you joined through a link, and (admins) everything else.
 */
export function Hub({ user, onOpenSetCue }: { user: AppUser; onOpenSetCue: (show: ShowRef) => void }) {
  const [tab, setTab] = useState<Tab>(() => {
    try {
      const saved = localStorage.getItem(TAB_KEY)
      return saved === 'studio' || ((saved === 'trash' || saved === 'files') && isAdmin(user)) ? saved : 'setcue'
    } catch {
      return 'setcue'
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem(TAB_KEY, tab)
    } catch {
      // ignore
    }
  }, [tab])

  return (
    <div className="min-h-dvh bg-ink text-white" data-hub>
      <header data-safe-header className="sticky top-0 z-20 flex flex-wrap items-center gap-3 border-b border-line bg-panel/80 px-4 py-3 backdrop-blur-xl sm:px-6">
        <span className="h-2.5 w-2.5 rounded-full bg-go shadow-[0_0_10px_#30d158]" />
        <span className="text-sm font-bold tracking-[0.2em]">THEATRE CUE</span>
        <span className="text-sm text-white/40">大廳</span>
        <div className="ml-2 flex gap-1 rounded-xl bg-black/40 p-1 text-sm" role="tablist">
          {(
            [
              ['setcue', '🎭 Set Cue 專案'],
              ['studio', '🎚 Studio 專案'],
              ...(isAdmin(user) ? ([['files', '📁 全域資源'], ['trash', '🗑 回收桶']] as const) : []),
            ] as const
          ).map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={`min-h-9 rounded-lg px-4 font-semibold ${tab === id ? 'bg-white/15 text-white' : 'text-white/50 hover:text-white/80'}`} data-hub-tab={id}>
              {label}
            </button>
          ))}
        </div>
        <span className="ml-auto" />
        <UserChip user={user} />
      </header>
      {tab === 'setcue' ? <Lobby onOpen={onOpenSetCue} user={user} /> : tab === 'studio' ? <StudioHub user={user} /> : tab === 'files' ? <GlobalManager user={user} /> : <TrashBin user={user} />}
      {/* Keeps playing across the lobby's tabs. */}
      <LobbyPlayerSpacer />
      <LobbyPlayerBar />
    </div>
  )
}

interface StudioItem {
  /** `${projectId}_${studioId}`: this card in the user's layout (order, tags). */
  key: string
  projectId: string
  versionId: string
  studioId: string
  name: string
  showName: string
  standalone: boolean
  updatedAt: number
  /** When this user last opened it (their hub entry), if ever. */
  lastOpenedAt: number | null
  role: 'owner' | 'collaborator' | 'other' | 'template'
  project: ProjectSummary
  owner?: StudioMeta['owner']
  collaborators: number
}

type StudioDates = Record<string, { createdAt?: number; updatedAt?: number }>

/** Created / modified time of each studio (its own fields in projects/{pid}/studio/{sid}). */
function useStudioDates(items: { key: string; projectId: string; studioId: string }[]) {
  const [dates, setDates] = useState<StudioDates>({})
  const sig = items.map((i) => `${i.key}|${i.projectId}|${i.studioId}`).join(',')
  useEffect(() => {
    if (!sig) return
    const offs = sig.split(',').flatMap((entry) => {
      const [key, pid, sid] = entry.split('|')
      return (['createdAt', 'updatedAt'] as const).map((field) =>
        onValue(
          ref(db, `projects/${pid}/studio/${sid}/${field}`),
          (snap) => {
            const v = snap.val()
            setDates((d) => (d[key]?.[field] === v ? d : { ...d, [key]: { ...d[key], [field]: typeof v === 'number' ? v : undefined } }))
          },
          () => {},
        ),
      )
    })
    return () => offs.forEach((o) => o())
  }, [sig])
  return dates
}

/** Every studio of every project (admins), from projects/{pid}/studio. */
function useAllStudios(projects: ProjectSummary[] | null, enabled: boolean) {
  const [byProject, setByProject] = useState<Record<string, { id: string; name: string; updatedAt: number }[]>>({})
  const ids = (projects ?? []).map((p) => p.id).join(',')
  useEffect(() => {
    if (!enabled || !ids) return
    const offs = ids.split(',').map((pid) =>
      onValue(ref(db, `projects/${pid}/studio`), (snap) => {
        const raw = (snap.val() ?? {}) as Record<string, { name?: string; updatedAt?: number }>
        setByProject((b) => ({ ...b, [pid]: Object.entries(raw).map(([id, s]) => ({ id, name: s.name ?? 'Studio', updatedAt: s.updatedAt ?? 0 })) }))
      }),
    )
    return () => offs.forEach((o) => o())
  }, [ids, enabled])
  return byProject
}

function StudioHub({ user }: { user: AppUser }) {
  const admin = isAdmin(user)
  const { projects } = useProjectIndex()
  const mine = useUserProjects(user.uid)
  const meta = useStudioMeta((projects ?? []).map((p) => p.id))
  const all = useAllStudios(projects, admin)
  // Official Studio templates: listed for everyone signed in.
  const templates = useTemplates()?.filter((p) => p.kind === 'studio') ?? null
  const templateStudios = useAllStudios(templates, true)
  const [creating, setCreating] = useState(false)
  const [leaving, setLeaving] = useState<StudioItem | null>(null)
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null)
  const [group, setGroup] = useGroupMode()
  const [view, setView] = useViewMode()
  const { layout, setOrder, setSections, toggleTag, updateTag, addTag, removeTag, resetTags } = useStudioLayout(user.uid)
  const tagDefs = tagDefsOf(layout)

  const items = useMemo(() => {
    const byId = new Map([...(projects ?? []), ...(templates ?? [])].map((p) => [p.id, p]))
    const out = new Map<string, StudioItem>()
    const add = (projectId: string, studioId: string, name: string, updatedAt: number, role: StudioItem['role']) => {
      const p = byId.get(projectId)
      if (!p) return // its project was deleted
      const m = meta?.[projectId]?.[studioId]
      const key = `${projectId}/${studioId}`
      const prev = out.get(key)
      if (prev && prev.role !== 'other' && role !== 'template') return
      out.set(key, {
        key: `${projectId}_${studioId}`,
        lastOpenedAt: role === 'owner' || role === 'collaborator' ? updatedAt || null : (prev?.lastOpenedAt ?? null),
        project: p,
        projectId,
        versionId: p.versions[0]?.id ?? '',
        studioId,
        name,
        showName: p.name,
        standalone: p.kind === 'studio',
        updatedAt,
        role: role === 'template' ? 'template' : m?.owner?.uid === user.uid ? 'owner' : role,
        owner: m?.owner,
        collaborators: Object.keys(m?.collaborators ?? {}).length,
      })
    }
    for (const u of mine ?? []) if (u.kind === 'studio' && u.studioId) add(u.projectId, u.studioId, u.name, u.lastOpenedAt ?? 0, u.role)
    if (admin) for (const [pid, list] of Object.entries(all)) for (const s of list) add(pid, s.id, s.name, s.updatedAt, 'other')
    for (const t of templates ?? []) for (const s of templateStudios[t.id] ?? []) add(t.id, s.id, t.name, s.updatedAt, 'template')
    // Admin scan has the live names; prefer them.
    for (const [pid, list] of Object.entries(all)) for (const s of list) {
      const it = out.get(`${pid}/${s.id}`)
      if (it) it.name = s.name
    }
    return [...out.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  }, [projects, mine, meta, all, admin, user.uid, templates, templateStudios])

  const dates = useStudioDates(items)
  const loading = projects === null || mine === null
  const tagsOf = (s: StudioItem) => layout.tags[s.key] ?? []
  // The dates each grouping uses.
  const joinedAt = (s: StudioItem) =>
    s.role === 'owner' ? (dates[s.key]?.createdAt ?? null) : s.role === 'collaborator' ? ((meta?.[s.projectId]?.[s.studioId]?.collaborators?.[user.uid] as { joinedAt?: number } | undefined)?.joinedAt ?? null) : null
  const DATE_OF: Partial<Record<GroupMode, { of: (s: StudioItem) => number | null; label: string }>> = {
    opened: { of: (s) => s.lastOpenedAt, label: '上次打開' },
    joined: { of: joinedAt, label: '加入' },
    created: { of: (s) => dates[s.key]?.createdAt ?? null, label: '製作' },
    modified: { of: (s) => dates[s.key]?.updatedAt ?? (s.updatedAt || null), label: '修改' },
  }
  const shownDate = DATE_OF[group] ?? DATE_OF.modified!
  const groups = groupStudios(items, group, { layout, tagDefs, tagsOf, dateOf: DATE_OF[group]?.of })
  const free = group === 'none'

  const card = (s: StudioItem) => (
    <StudioEntry
      s={s}
      view={view}
      user={user}
      admin={admin}
      projects={projects}
      tags={tagsOf(s)}
      date={{ label: shownDate.label, at: shownDate.of(s) }}
      tagDefs={tagDefs}
      tagActions={{ toggle: (t) => toggleTag(s.key, t), update: updateTag, add: addTag, remove: removeTag, reset: resetTags }}
      onLeave={() => setLeaving(s)}
      onNotice={(text, ok = true) => setNotice({ text, ok })}
    />
  )
  const list = (g: StudioGroup) => (
    <SortableList
      id={`studio-${g.id}`}
      items={g.list}
      keyOf={(s) => s.key}
      labelOf={(s) => s.name}
      enabled={free}
      onReorder={(keys) => setOrder(g.id, keys)}
      className={view === 'grid' ? 'grid grid-cols-1 gap-3 md:grid-cols-2' : 'divide-y divide-line overflow-hidden rounded-2xl border border-line bg-panel/80'}
      itemClassName={free ? 'cursor-grab active:cursor-grabbing' : ''}
      render={card}
    />
  )
  const header = (g: StudioGroup, grip: boolean) =>
    g.title ? (
      <h2 className="flex items-center gap-2 text-xs font-semibold tracking-wider text-white/50">
        {grip && (
          <span className="-ml-1 flex h-7 w-5 cursor-grab touch-none items-center justify-center rounded text-white/25 hover:bg-white/10 hover:text-white/60 active:cursor-grabbing" data-drag-handle title="拖曳以調整區塊順序" aria-label={`拖曳「${g.title}」區塊`}>
            ⠿
          </span>
        )}
        {g.color && <span className="h-2.5 w-2.5 rounded-full" style={{ background: g.color }} />}
        {g.title}
        <span className="font-mono text-white/30">{g.list.length}</span>
        {g.hint && <span className="font-normal text-white/30">{g.hint}</span>}
      </h2>
    ) : null

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-6 sm:px-6" data-studio-hub data-group={group} data-view={view}>
      <div className="flex flex-wrap items-center gap-2 sm:gap-3">
        <span className="mr-auto text-lg font-semibold">🎚 Studio 專案</span>
        <GroupMenu value={group} onChange={setGroup} />
        <ViewToggle value={view} onChange={setView} />
        <button type="button" onClick={() => setCreating(true)} className="min-h-11 rounded-xl bg-accent px-5 text-sm font-semibold text-white hover:brightness-110" data-new-studio-project>
          ＋ 新增 Studio 專案
        </button>
      </div>
      {!loading && items.length > 0 && (
        <p className="-mt-3 text-[11px] text-white/30" data-arrange-hint>
          {free ? '拖曳卡片可自由排列（觸控裝置請長按後拖曳）；拖曳區塊標題左側的 ⠿ 可調整區塊順序。順序會自動儲存。' : `依「${GROUP_MODES.find((m) => m.id === group)?.label}」分組；選「無」可自由拖曳排列。`}
        </p>
      )}
      {loading && <p className="text-sm text-white/30">載入中…</p>}
      {!loading && items.length === 0 && (
        <div className="flex flex-col items-center gap-2 py-20 text-center">
          <div className="text-5xl text-white/10">🎚</div>
          <p className="text-white/50">還沒有你的 Studio 專案</p>
          <p className="max-w-sm text-xs text-white/35">建立新的 Studio 專案，或開啟別人分享的 Studio 網址，它就會出現在「共編 Studio」。</p>
        </div>
      )}
      {free ? (
        <SortableList
          id="studio-sections"
          items={groups}
          keyOf={(g) => g.id}
          labelOf={(g) => g.title}
          enabled
          handle
          onReorder={(ids) => setSections([...ids, ...SECTION_IDS.filter((x) => !ids.includes(x))])}
          className="space-y-6"
          render={(g) => (
            <section className="space-y-3" data-hub-group={`studio-${g.id}`} data-group-title={g.title}>
              {header(g, groups.length > 1)}
              {list(g)}
            </section>
          )}
        />
      ) : (
        groups.map((g) => (
          <section key={g.id} className="space-y-3" data-hub-group={`studio-${g.id}`} data-group-title={g.title}>
            {header(g, false)}
            {list(g)}
          </section>
        ))
      )}
      {notice && (
        <p className={`rounded-lg px-3 py-2 text-xs ${notice.ok ? 'bg-go/10 text-go' : 'bg-panic/10 text-panic'}`} data-hub-notice>
          {notice.text}
        </p>
      )}
      <ConfirmDialog
        open={!!leaving}
        title={leaving ? `退出「${leaving.standalone ? leaving.name : leaving.showName}」？` : ''}
        confirmLabel="退出專案"
        onClose={() => setLeaving(null)}
        onConfirm={async () => {
          if (!leaving) return
          await leaveProject(user, leaving.projectId)
          setNotice({ text: `已退出「${leaving.standalone ? leaving.name : leaving.showName}」`, ok: true })
        }}
      >
        你會從這個{leaving?.standalone ? ' Studio ' : '專案（含其中的 Studio）'}的協作者名單移除，它也會從你的大廳消失。專案本身與其他協作者<b className="text-white">完全不受影響</b>。
      </ConfirmDialog>
      <NewStudioDialog open={creating} onClose={() => setCreating(false)} user={user} projects={projects} />
    </div>
  )
}

interface StudioGroup {
  id: string
  title: string
  hint?: string
  color?: string
  list: StudioItem[]
}

const SECTION_IDS = ['templates', 'mine', 'shared', 'all', 'archived']

/** The Studio tab's sections for a grouping mode. */
function groupStudios(items: StudioItem[], mode: GroupMode, opts: { layout: StudioLayout; tagDefs: TagDef[]; tagsOf: (s: StudioItem) => string[]; dateOf?: (s: StudioItem) => number | null }): StudioGroup[] {
  const nameSort = (a: StudioItem, b: StudioItem) => byName(a.name, b.name)
  if (mode === 'none') {
    // By role, in the user's own order (sections too).
    const working = items.filter((i) => !i.project.isArchived)
    const sections: StudioGroup[] = [
      { id: 'templates', title: '🔒 官方範本', hint: '唯讀：請按「複製為我的專案」建立自己的副本再編輯', list: items.filter((i) => i.role === 'template') },
      { id: 'mine', title: '我的 Studio', hint: '你建立的', list: working.filter((i) => i.role === 'owner') },
      { id: 'shared', title: '共編 Studio', hint: '透過專案網址加入的', list: working.filter((i) => i.role === 'collaborator') },
      { id: 'all', title: '所有其他 Studio', hint: '管理員可見', list: working.filter((i) => i.role === 'other') },
      { id: 'archived', title: '📦 已封存', hint: '唯讀', list: items.filter((i) => i.project.isArchived && i.role !== 'template') },
    ]
    const rank = (id: string) => {
      const i = opts.layout.sections.indexOf(id)
      return i < 0 ? 100 + SECTION_IDS.indexOf(id) : i
    }
    return sections
      .filter((g) => g.list.length)
      .sort((a, b) => rank(a.id) - rank(b.id))
      .map((g) => ({ ...g, list: arrange(g.list, opts.layout.order[g.id], (s) => s.key, (s) => s.updatedAt) }))
  }
  if (mode === 'setcue') {
    const by = new Map<string, StudioItem[]>()
    for (const s of items) {
      const k = s.standalone ? '' : s.showName
      by.set(k, [...(by.get(k) ?? []), s])
    }
    return [...by.entries()]
      .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : byName(a, b)))
      .map(([k, list]) => ({ id: `setcue:${k}`, title: k ? `📁 ${k}` : '獨立 Studio', hint: k ? 'Set Cue 專案' : '沒有 Set Cue 母專案', list: list.sort(nameSort) }))
  }
  if (mode === 'name') return [{ id: 'name', title: '', list: [...items].sort(nameSort) }]
  if (mode === 'tags') {
    const known = new Set(opts.tagDefs.map((t) => t.id))
    const out: StudioGroup[] = opts.tagDefs.map((t) => ({ id: `tag:${t.id}`, title: tagLabel(t), color: t.color, list: items.filter((s) => opts.tagsOf(s).includes(t.id)).sort(nameSort) }))
    out.push({ id: 'tag:none', title: '沒有標籤', list: items.filter((s) => !opts.tagsOf(s).some((t) => known.has(t))).sort(nameSort) })
    return out.filter((g) => g.list.length)
  }
  // Dates: Finder-style buckets, newest first.
  const dateOf = opts.dateOf ?? (() => null)
  const buckets = new Map<string, StudioGroup & { rank: number }>()
  for (const s of items) {
    const b = dateBucket(dateOf(s))
    if (!buckets.has(b.id)) buckets.set(b.id, { id: `date:${b.id}`, title: b.title, rank: b.rank, list: [] })
    buckets.get(b.id)!.list.push(s)
  }
  return [...buckets.values()]
    .sort((a, b) => b.rank - a.rank)
    .map((g) => ({ ...g, list: g.list.sort((a, b) => (dateOf(b) ?? 0) - (dateOf(a) ?? 0) || nameSort(a, b)) }))
}

const when = (ms: number) => {
  const d = new Date(ms)
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleString('zh-TW', { hour12: false, ...(sameYear ? {} : { year: 'numeric' }), month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

const ROLE_CHIP: Partial<Record<StudioItem['role'], string>> = { collaborator: '共編', other: '他人', template: '範本' }

/** One Studio, as a card (grid) or a row (list). */
function StudioEntry({
  s,
  view,
  user,
  admin,
  projects,
  tags,
  date,
  tagDefs,
  tagActions,
  onLeave,
  onNotice,
}: {
  s: StudioItem
  view: ViewMode
  user: AppUser
  admin: boolean
  projects: ProjectSummary[] | null
  tags: string[]
  date: { label: string; at: number | null }
  tagDefs: TagDef[]
  tagActions: TagActions
  onLeave: () => void
  onNotice: (text: string, ok?: boolean) => void
}) {
  const readOnly = !admin && isReadOnlyProject(s.project)
  const actions = (
    <>
      {s.role === 'collaborator' && (
        <button
          type="button"
          onClick={onLeave}
          className="flex min-h-10 items-center rounded-xl px-3 text-xs text-white/55 hover:bg-standby/15 hover:text-standby"
          title="退出專案：從你的大廳移除，不影響專案與其他人"
          data-leave-studio={s.studioId}
        >
          ⎋<span className="ml-1 hidden sm:inline">退出</span>
        </button>
      )}
      {s.standalone && (s.project.isMasterTemplate || readOnly) && (
        <ForkButton user={user} project={s.project} className="flex min-h-10 items-center rounded-xl bg-standby px-3 text-xs font-bold text-black" label="📋 複製" />
      )}
      <TagButton tags={tags} defs={tagDefs} actions={tagActions} name={s.name} />
      <StudioAdminMenu studio={{ projectId: s.projectId, studioId: s.studioId, name: s.name, project: s.project }} user={user} projects={projects} onDone={onNotice} />
      <a
        href={studioUrl(s.projectId, s.versionId, s.studioId)}
        draggable={false}
        className={`flex min-h-10 items-center rounded-xl px-4 text-sm font-bold ${readOnly ? 'bg-white/[0.1] text-white' : 'bg-go text-black'}`}
        data-hub-open-studio={s.studioId}
      >
        {readOnly ? '檢視' : '開啟'}
      </a>
    </>
  )
  const play = <StudioPlayButton projectId={s.projectId} studioId={s.studioId} name={s.name} showName={s.standalone ? null : s.showName} />
  const dateText = date.at ? `${date.label} ${when(date.at)}` : `${date.label}：—`

  if (view === 'list')
    return (
      <div className="flex items-center gap-3 px-3 py-2 hover:bg-white/[0.03]" data-hub-studio={s.studioId} data-studio-key={s.key}>
        {play}
        <div className="min-w-0 flex-1">
          <div className="flex items-center truncate text-sm font-semibold">
            <span className="truncate" data-studio-name>
              {s.name}
            </span>
            <TagChips ids={tags} defs={tagDefs} size="sm" />
            {ROLE_CHIP[s.role] && <span className="ml-2 shrink-0 rounded bg-white/10 px-1.5 text-[10px] font-normal text-white/50">{ROLE_CHIP[s.role]}</span>}
            {s.project.isArchived && <span className="ml-1 shrink-0 rounded bg-white/10 px-1.5 text-[10px] font-normal text-white/50">封存</span>}
          </div>
          <div className="truncate text-[11px] text-white/40">{s.standalone ? '獨立 Studio' : `📁 ${s.showName}`}</div>
        </div>
        <div className="hidden w-44 shrink-0 text-right text-[11px] text-white/40 tabular md:block" data-studio-date>
          {dateText}
        </div>
        <div className="flex shrink-0 items-center gap-1">{actions}</div>
      </div>
    )

  return (
    <div className="flex h-full items-center gap-3 rounded-2xl border border-line bg-panel/80 p-4" data-hub-studio={s.studioId} data-studio-key={s.key}>
      {play}
      <div className="min-w-0 flex-1">
        <div className="flex items-center font-semibold">
          <span className="truncate" data-studio-name>
            {s.name}
          </span>
          <TagChips ids={tags} defs={tagDefs} />
        </div>
        {s.standalone && (
          <div className="mt-0.5">
            <ProjectBadges project={s.project} />
          </div>
        )}
        {s.standalone && admin && (
          <div className="mt-1.5" data-no-drag>
            <AdminProjectFlags user={user} project={s.project} />
          </div>
        )}
        <div className="truncate text-[11px] text-white/40">
          {s.standalone ? '獨立 Studio（未指定 Set Cue 母專案）' : `📁 屬於 Set Cue「${s.showName}」`}
          <span data-studio-date>{` · ${dateText}`}</span>
        </div>
        <div className="truncate text-[11px] text-white/30">
          {s.owner ? `建立者 ${s.owner.uid === user.uid ? '你' : s.owner.name}` : '建立者未記錄'}
          {s.collaborators > 0 && ` · ${s.collaborators} 位協作者`}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">{actions}</div>
    </div>
  )
}

/** Admins: soft-deleted projects and studios: restore, or purge for good. */
function TrashBin({ user }: { user: AppUser }) {
  const { items, error } = useTrash(isAdmin(user))
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null)
  const [purging, setPurging] = useState<string[] | null>(null)
  const size = (n: number) => (n > 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : n > 1000 ? `${Math.round(n / 1000)} KB` : `${n} B`)
  return (
    <div className="mx-auto max-w-5xl space-y-4 px-4 py-6 sm:px-6" data-trash-bin>
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
        <div className="text-lg font-semibold">🗑 已刪除專案回收桶</div>
        <p className="text-xs text-white/45">刪除的專案會完整保存在這裡（所有版本、Cue、控台、Studio、觀眾上傳與成員）。還原後專案回到原狀態，成員的大廳也會重新出現它。只有管理員看得到這裡。</p>
        </div>
        {items && items.length > 0 && (
          <button
            type="button"
            onClick={() => setPurging(items.map((t) => t.id))}
            className="min-h-10 rounded-xl border border-panic/40 px-4 text-sm font-semibold text-panic hover:bg-panic/15"
            data-empty-trash
          >
            🧹 清空回收桶
          </button>
        )}
      </div>
      <PurgeDialog ids={purging} user={user} onClose={() => setPurging(null)} onDone={(text) => setNote({ text, ok: true })} />
      {note && <p className={`rounded-lg px-3 py-2 text-xs ${note.ok ? 'bg-go/10 text-go' : 'bg-panic/10 text-panic'}`} data-trash-note>{note.text}</p>}
      {error && <p className="text-sm text-panic">無法讀取回收桶：{error}</p>}
      {items === null && !error && <p className="text-sm text-white/30">載入中…</p>}
      {items?.length === 0 && <p className="py-16 text-center text-sm text-white/35">回收桶是空的</p>}
      <ul className="space-y-2">
        {items?.map((t) => (
          <li key={t.id} className="flex items-center gap-3 rounded-2xl border border-line bg-panel/80 p-4" data-trash-item={t.name}>
            <span className="text-2xl">{t.type === 'studio' || t.kind === 'studio' ? '🎚' : '🎭'}</span>
            <div className="min-w-0 flex-1">
              <div className="truncate font-semibold">{t.name}</div>
              {t.type === 'studio' && <div className="truncate text-[11px] text-white/55">Studio · 屬於 Set Cue「{t.parentName}」</div>}
              <div className="truncate text-[11px] text-white/45">
                {t.deletedAt ? new Date(t.deletedAt).toLocaleString('zh-TW', { hour12: false }) : '—'} 由 {t.deletedBy.name || t.deletedBy.email} 刪除
              </div>
              <div className="truncate text-[11px] text-white/30">
                {t.type === 'studio' ? '' : t.owner ? `建立者 ${t.owner.name} · ${t.owner.email} · ` : '建立者未記錄 · '}資料 {size(t.size)}
              </div>
            </div>
            <button
              type="button"
              disabled={!!busy}
              onClick={async () => {
                setBusy(t.id)
                setNote(null)
                try {
                  await (t.type === 'studio' ? restoreStudio(t.id) : restoreProject(t.id))
                  setNote({ text: `✓ 已還原「${t.name}」`, ok: true })
                } catch (err) {
                  setNote({ text: (err as Error).message, ok: false })
                } finally {
                  setBusy(null)
                }
              }}
              className="flex min-h-10 items-center rounded-xl bg-go px-4 text-sm font-bold text-black disabled:opacity-40"
              data-restore-project={t.name}
            >
              {busy === t.id ? '還原中…' : '↺ 還原'}
            </button>
            <button
              type="button"
              disabled={!!busy}
              onClick={() => setPurging([t.id])}
              className="flex min-h-10 items-center rounded-xl px-3 text-xs text-white/45 hover:bg-panic/15 hover:text-panic disabled:opacity-40"
              data-purge-project={t.name}
            >
              徹底刪除
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
