import { deviceMatrix, headingOf, recentre } from '../utils/deviceOrientation'
import { stageAudio } from './audioEngine'

/*
 * The audience phone's gyroscope as the listener's head, for sounds that follow the head (Ambisonics soundfields and
 * trajectories with head tracking on) when no XR scene is already doing it. iOS only reports the orientation after a
 * permission prompt that must be opened from a tap; Android needs none. Wherever the phone points when tracking starts
 * (or when "對正" is tapped) is "straight ahead", the stage.
 */

export type HeadPermission = 'granted' | 'denied' | 'unsupported'

const permissionRequest = () => (typeof DeviceOrientationEvent !== 'undefined' ? (DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<'granted' | 'denied'> }).requestPermission : undefined)

/** Whether the browser opens a permission prompt (iOS): then tracking can only start from a tap. */
export const headTrackingNeedsTap = () => typeof permissionRequest() === 'function'

class DeviceHeadTracker {
  private listening = false
  private heading0: number | null = null
  private raw: Float32Array | null = null

  get active() {
    return this.listening
  }

  private onOrientation = (e: DeviceOrientationEvent) => {
    if (e.alpha == null || e.beta == null || e.gamma == null) return
    const angle = window.screen.orientation?.angle ?? (window as unknown as { orientation?: number }).orientation ?? 0
    this.raw = deviceMatrix(e.alpha, e.beta, e.gamma, angle)
    this.heading0 ??= headingOf(this.raw)
    stageAudio.setListenerOrientation(recentre(this.raw, this.heading0), 'device')
  }

  /** Start listening; call from a tap where the browser asks for permission. */
  async start(): Promise<HeadPermission> {
    if (typeof DeviceOrientationEvent === 'undefined') return 'unsupported'
    const ask = permissionRequest()
    if (ask) {
      try {
        if ((await ask.call(DeviceOrientationEvent)) !== 'granted') return 'denied'
      } catch {
        return 'denied'
      }
    }
    if (!this.listening) {
      this.listening = true
      this.heading0 = null
      window.addEventListener('deviceorientation', this.onOrientation)
    }
    return 'granted'
  }

  /** The way the phone points now is straight ahead. */
  recentre() {
    if (this.raw) this.heading0 = headingOf(this.raw)
  }

  stop() {
    if (!this.listening) return
    this.listening = false
    window.removeEventListener('deviceorientation', this.onOrientation)
    this.raw = null
    this.heading0 = null
    stageAudio.setListenerOrientation(null, 'device')
  }
}

export const headTracker = new DeviceHeadTracker()
