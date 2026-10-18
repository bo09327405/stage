/*
 * iOS 17+ "audio session" category, and the single door every microphone request goes through.
 *
 * The category decides what the page may do with audio. 'playback' (needed by audience phones to keep sound
 * going with the silent switch on / screen locked) is INCOMPATIBLE with capture: asking for the microphone
 * while it is set fails with "InvalidStateError: AudioSession category is not compatible with audio capture".
 * So:
 *  · audience pages (listen-only) hold 'playback' and never open a microphone;
 *  · crew pages never set 'playback'; before capture they switch to 'play-and-record', afterwards back to 'auto'.
 */

type SessionType = 'auto' | 'playback' | 'transient' | 'transient-solo' | 'ambient' | 'play-and-record'
type WithSession = Navigator & { audioSession?: { type: SessionType } }

/** Set the category (no-op where the API doesn't exist). Returns whether it is now what was asked. */
export function setAudioSession(type: SessionType): boolean {
  try {
    const session = (navigator as WithSession).audioSession
    if (!session) return false
    if (session.type !== type) session.type = type
    return session.type === type
  } catch {
    return false
  }
}

/** Listen-only pages (the audience) must never open a microphone for the show. */
let listenOnly = false
export function setListenOnly(on: boolean) {
  listenOnly = on
}
export const isListenOnly = () => listenOnly

export class ListenOnlyError extends Error {
  constructor() {
    super('觀眾端是僅收聽模式，不會開啟麥克風')
    this.name = 'ListenOnlyError'
  }
}

/**
 * Open the microphone.
 *  · 'crew'   — intercom / Studio recording: refused on a listen-only page.
 *  · 'upload' — a single, user-tapped recording for an audience upload cue (the only mic use on an audience page).
 * The audio session is switched to a capture-compatible category first; if the browser still refuses because of
 * the category, it is reset to 'auto' and tried once more. `release()` puts the category back.
 */
export async function openMicrophone(constraints: MediaStreamConstraints, purpose: 'crew' | 'upload'): Promise<MediaStream> {
  if (listenOnly && purpose !== 'upload') throw new ListenOnlyError()
  setAudioSession('play-and-record')
  try {
    return await navigator.mediaDevices.getUserMedia(constraints)
  } catch (err) {
    if ((err as DOMException)?.name !== 'InvalidStateError') throw err
    setAudioSession('auto')
    return await navigator.mediaDevices.getUserMedia(constraints)
  }
}

/** The microphone was closed: give the session back (audience pages return to playback, others to auto). */
export function releaseMicrophone() {
  setAudioSession(listenOnly ? 'playback' : 'auto')
}
