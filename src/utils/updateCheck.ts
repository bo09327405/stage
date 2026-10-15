/**
 * Tells the user when a newer build has been deployed. Home-screen apps and static hosting keep old
 * files for a long time, so a device can run an outdated version without knowing. Each build writes
 * version.json; this compares it with the id baked into the running bundle (on start, whenever the
 * app returns to the foreground, and every 5 minutes) and shows a small "更新" bar — it never reloads
 * by itself, so nothing being edited is lost.
 */
const EVERY_MS = 5 * 60_000

async function latestId(): Promise<string | null> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}version.json?t=${Date.now()}`, { cache: 'no-store' })
    if (!res.ok) return null
    const body = (await res.json()) as { id?: unknown }
    return typeof body.id === 'string' ? body.id : null
  } catch {
    return null
  }
}

function showBar() {
  if (document.getElementById('update-bar')) return
  const bar = document.createElement('div')
  bar.id = 'update-bar'
  bar.setAttribute('role', 'status')
  bar.style.cssText =
    'position:fixed;left:50%;bottom:max(0.75rem,env(safe-area-inset-bottom));transform:translateX(-50%);z-index:9999;display:flex;align-items:center;gap:0.75rem;padding:0.5rem 0.75rem 0.5rem 1rem;border-radius:999px;background:#0a84ff;color:#fff;font:600 13px/1.2 system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.5)'
  const label = document.createElement('span')
  label.textContent = '有新版本可用'
  const go = document.createElement('button')
  go.textContent = '更新'
  go.style.cssText = 'min-height:36px;padding:0 14px;border:0;border-radius:999px;background:#fff;color:#0a84ff;font:700 13px system-ui,sans-serif;cursor:pointer'
  go.onclick = () => location.reload()
  const close = document.createElement('button')
  close.textContent = '✕'
  close.setAttribute('aria-label', '稍後')
  close.style.cssText = 'width:32px;height:32px;border:0;background:transparent;color:#fff;font-size:14px;cursor:pointer'
  close.onclick = () => bar.remove()
  bar.append(label, go, close)
  document.body.append(bar)
}

export function startUpdateCheck() {
  if (!import.meta.env.PROD) return
  const check = async () => {
    const id = await latestId()
    if (id && id !== __BUILD_ID__) showBar()
  }
  void check()
  window.setInterval(check, EVERY_MS)
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && void check())
}
