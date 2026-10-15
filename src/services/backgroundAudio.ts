/**
 * Keeps audience playback alive when the phone is locked or the web app is in the background
 * (iOS "Add to Home Screen" and Android Chrome).
 *
 * What actually keeps a page running in the background is audio that is *playing*: iOS and Chrome
 * suspend or throttle timers of pages that are not, and a Service Worker cannot play audio or hold
 * timers for the page, so none is used. Instead:
 *
 *  1. audioSession.type = 'playback'  iOS 17+: keeps playing in the background and with the silent switch on.
 *  2. A silent looping <audio>        started inside the entry tap; it marks the page as "playing media",
 *                                     so the system keeps it (and its timers) alive between cues.
 *  3. Media Session                   lock-screen / notification card with the cue name; the controls
 *                                     are acknowledged but the show is driven by the console, not the audience.
 *  4. Context recovery                resume the AudioContext when the OS interrupts it (calls, Siri,
 *                                     unplugging headphones) and when the page becomes visible again.
 *  5. Worker ticker                   the engine's 50 ms loop runs on a Worker clock, which is not
 *                                     throttled like main-thread timers when the screen is off.
 *
 * Everything here is best-effort and silent on failure: unsupported browsers just keep today's behaviour.
 */

let started = false
let keepAlive: HTMLAudioElement | null = null

/** One second of silence as a WAV blob URL (8-bit mono), looped by the keep-alive element. */
function silentLoopUrl(): string {
  const rate = 8000
  const n = rate
  const buf = new ArrayBuffer(44 + n)
  const v = new DataView(buf)
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)))
  str(0, 'RIFF')
  v.setUint32(4, 36 + n, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, rate, true)
  v.setUint32(28, rate, true)
  v.setUint16(32, 1, true)
  v.setUint16(34, 8, true)
  str(36, 'data')
  v.setUint32(40, n, true)
  new Uint8Array(buf, 44).fill(128) // 8-bit PCM silence
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }))
}

/**
 * Call synchronously inside the user's tap (iOS only allows audio started by a gesture).
 * `resume` should re-start the engine's context and any voices the OS paused.
 */
export function startBackgroundPlayback(ctx: AudioContext, resume: () => void) {
  if (started) return
  started = true

  // iOS 17+: treat the page as media playback (background, lock screen, ignores the mute switch).
  try {
    const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession
    if (session) session.type = 'playback'
  } catch {
    /* unsupported */
  }

  // Silent loop that keeps the page counted as playing media.
  try {
    const el = new Audio(silentLoopUrl())
    el.loop = true
    el.volume = 1 // the file itself is silent; iOS ignores .volume anyway
    el.setAttribute('playsinline', '')
    keepAlive = el
    el.play().catch(() => {
      // Refused (no gesture yet): retried on the next tap or when the page returns.
    })
  } catch {
    /* ignore */
  }

  const recover = () => {
    resume()
    if (keepAlive?.paused) keepAlive.play().catch(() => {})
  }

  // The OS can interrupt the context ("interrupted" on iOS): bring it back as soon as allowed.
  ctx.addEventListener('statechange', () => {
    if (ctx.state !== 'running') recover()
  })
  // Hidden pages: do nothing that touches the UI; only make sure sound is still running on return.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') recover()
  })
  window.addEventListener('pageshow', recover)
  // The first tap after a refusal re-arms everything.
  document.addEventListener('pointerdown', () => keepAlive?.paused && recover(), { passive: true })

  setupMediaSession(recover)
}

function setupMediaSession(recover: () => void) {
  const ms = navigator.mediaSession
  if (!ms) return
  try {
    ms.playbackState = 'playing'
    // The audience can't stop the show: play re-arms sound, pause/stop are accepted but ignored so
    // a stray lock-screen tap doesn't silence the theatre. (The console controls the show.)
    ms.setActionHandler('play', recover)
    for (const a of ['pause', 'stop', 'previoustrack', 'nexttrack', 'seekbackward', 'seekforward', 'seekto'] as MediaSessionAction[]) {
      try {
        ms.setActionHandler(a, () => {
          ms.playbackState = 'playing'
          recover()
        })
      } catch {
        /* action not supported on this browser */
      }
    }
  } catch {
    /* unsupported */
  }
}

/** Show what's playing on the lock screen / notification shade. */
export function setNowPlaying(title: string | null, album = 'Theatre Cue') {
  const ms = navigator.mediaSession
  if (!ms || typeof MediaMetadata === 'undefined') return
  try {
    ms.metadata = new MediaMetadata({
      title: title || '演出進行中',
      artist: 'Theatre Cue',
      album,
      artwork: [{ src: new URL('favicon.svg', document.baseURI).href, sizes: '512x512', type: 'image/svg+xml' }],
    })
    ms.playbackState = 'playing'
  } catch {
    /* ignore */
  }
}

/**
 * setInterval on a Worker clock: unlike main-thread timers it keeps its rate while the screen is
 * off. Falls back to a plain setInterval if Workers / blob URLs are unavailable.
 */
export function startTicker(ms: number, fn: () => void): () => void {
  try {
    const url = URL.createObjectURL(new Blob([`setInterval(()=>postMessage(0),${ms})`], { type: 'text/javascript' }))
    const worker = new Worker(url)
    URL.revokeObjectURL(url)
    worker.onmessage = fn
    return () => worker.terminate()
  } catch {
    const id = window.setInterval(fn, ms)
    return () => window.clearInterval(id)
  }
}
