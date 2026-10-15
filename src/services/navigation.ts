import type { ShowRef } from '../types/project'

/*
 * Moving between the Set Cue console and its pop-out pages (control panel, Studio).
 *
 * The console opens the control panel with window.open() under a per-project window name, so the
 * panel keeps a link back (window.opener) and a second click reuses the same tab. "返回 Set Cue"
 * then brings the console tab forward (pointing it at this project if it shows another one); when
 * that tab is gone — or the panel was opened some other way — this tab loads the console itself.
 * A BroadcastChannel lets console tabs of the project raise themselves too.
 */

const CHANNEL = 'theatre-nav'

/** The app's base path (the control panel lives at /surface or /control-panel). */
const basePath = () => location.pathname.replace(/\/(surface|control-panel)\/?$/, '/')

export const consoleUrl = (show: ShowRef) =>
  `${basePath()}?role=console&project=${encodeURIComponent(show.projectId)}&version=${encodeURIComponent(show.versionId)}`

export const surfaceUrl = (show: ShowRef, surfaceId?: string | null) =>
  `${basePath().replace(/\/$/, '')}/surface?project=${encodeURIComponent(show.projectId)}&version=${encodeURIComponent(show.versionId)}${surfaceId ? `&surface=${encodeURIComponent(surfaceId)}` : ''}`

/** Open (or bring back) this project's control panel tab, keeping the link to this console tab. */
export function openSurfaceWindow(show: ShowRef) {
  const w = window.open(surfaceUrl(show), `theatre-surface-${show.projectId}`)
  w?.focus()
  return !!w
}

/** Is `w` a console tab of this project? (Same origin only; false when it can't be read.) */
function showsConsole(w: Window, show: ShowRef) {
  try {
    const u = new URL(w.location.href)
    return u.searchParams.get('role') === 'console' && u.searchParams.get('project') === show.projectId && u.searchParams.get('version') === show.versionId
  } catch {
    return false
  }
}

/**
 * "返回 Set Cue": focus the console tab this page was opened from (pointing it at this project if
 * needed); without one, load the console in this tab. Returns what happened.
 */
export function returnToSetCue(show: ShowRef): 'focused' | 'navigated' {
  const opener = window.opener as Window | null
  let usable = false
  try {
    usable = !!opener && !opener.closed && opener.location.origin === location.origin
  } catch {
    usable = false
  }
  if (usable && opener) {
    if (!showsConsole(opener, show)) opener.location.href = consoleUrl(show)
    opener.focus()
    try {
      new BroadcastChannel(CHANNEL).postMessage({ type: 'focus-console', projectId: show.projectId, versionId: show.versionId })
    } catch {
      // No BroadcastChannel: opener.focus() already did what it could.
    }
    return 'focused'
  }
  location.href = consoleUrl(show)
  return 'navigated'
}

/** Console tabs: come forward when a pop-out of this project asks for it. */
export function listenForFocusRequests(show: ShowRef) {
  let channel: BroadcastChannel | null = null
  try {
    channel = new BroadcastChannel(CHANNEL)
  } catch {
    return () => {}
  }
  channel.onmessage = (e: MessageEvent<{ type?: string; projectId?: string; versionId?: string }>) => {
    if (e.data?.type === 'focus-console' && e.data.projectId === show.projectId && e.data.versionId === show.versionId) window.focus()
  }
  return () => channel?.close()
}
