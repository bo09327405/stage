/**
 * Haptic tick for the show-critical buttons (GO, pause / stop, mute, fade out, stop hits).
 * Mark a button with data-haptic ("tap" | "strong"); one delegated listener does the rest.
 * navigator.vibrate exists on Android; iOS Safari has no vibration API, so there it is a no-op.
 */
const PATTERNS: Record<string, number | number[]> = { tap: 12, strong: [18, 40, 18] }

export function installHaptics() {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (e.pointerType === 'mouse') return
      const el = (e.target as HTMLElement | null)?.closest?.<HTMLElement>('[data-haptic]')
      if (!el || (el as HTMLButtonElement).disabled) return
      navigator.vibrate(PATTERNS[el.dataset.haptic ?? 'tap'] ?? PATTERNS.tap)
    },
    { passive: true, capture: true },
  )
}
