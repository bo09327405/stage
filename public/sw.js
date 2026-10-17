/* Theatre Cue service worker: background Intercom CALL notifications (Web Push) with vibration. */
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = {}
  }
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      // The app is on screen: it already rings and vibrates itself (live database listener).
      if (!data.test && windows.some((w) => w.visibilityState === 'visible')) return
      if (data.type === 'vibe') {
        // A vibration cue / Pre-Wait reminder: a short notification that buzzes with the cue's own rhythm.
        await self.registration.showNotification(data.title || '📳 提示', {
          body: data.body || '請看畫面',
          tag: 'vibe',
          renotify: true,
          vibrate: Array.isArray(data.pattern) && data.pattern.length ? data.pattern : [500, 200, 500, 200, 500],
          icon: 'favicon.svg',
          badge: 'favicon.svg',
          timestamp: data.at || Date.now(),
          data: { projectId: data.projectId || '' },
        })
        return
      }
      await self.registration.showNotification(data.title || '📞 Intercom 呼叫', {
        body: data.body || '點開回到 Intercom',
        tag: data.type === 'announce' ? 'announce' : 'intercom-call',
        renotify: true,
        requireInteraction: true,
        // Android: long, unmistakable pattern. iOS ignores `vibrate` and uses the system alert haptic.
        vibrate: [400, 150, 400, 150, 400, 150, 800],
        icon: 'favicon.svg',
        badge: 'favicon.svg',
        timestamp: data.at || Date.now(),
        data: { projectId: data.projectId || '' },
      })
    })(),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const open = windows[0]
      if (open) return open.focus()
      return self.clients.openWindow(self.registration.scope)
    })(),
  )
})
