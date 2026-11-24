import { fieldRotation, mul3 } from '../types/spatialAudio.ts'

/*
 * A phone's DeviceOrientation (alpha, beta, gamma; W3C convention) as the orientation of a head looking out of the
 * screen: a column-major 3×3 rotation (local → scene: +X right, +Y up, −Z ahead). Pure maths, shared by the audience
 * head tracker; the XR player builds the same matrix with Three.js.
 */

const rad = (d: number) => (d * Math.PI) / 180

/** Rotation about an axis as a column-major 3×3 (right-handed). */
function axisRotation(axis: 'x' | 'y' | 'z', a: number): Float32Array {
  const c = Math.cos(a)
  const s = Math.sin(a)
  // column-major: [col0..., col1..., col2...]
  if (axis === 'x') return Float32Array.of(1, 0, 0, 0, c, s, 0, -s, c)
  if (axis === 'y') return Float32Array.of(c, 0, -s, 0, 1, 0, s, 0, c)
  return Float32Array.of(c, s, 0, -s, c, 0, 0, 0, 1)
}

/**
 * Orientation of the device's "camera" (looking out of the back of the phone, as when held upright) from its
 * angles and the screen's rotation, in degrees. Alpha 0 / beta 90 / gamma 0 (upright, any heading) looks along −Z.
 */
export function deviceMatrix(alpha: number, beta: number, gamma: number, screenAngle = 0): Float32Array {
  // Euler order YXZ: Ry(alpha) · Rx(beta) · Rz(−gamma), then the camera looks down −Z when the phone stands upright.
  let m = mul3(axisRotation('y', rad(alpha)), mul3(axisRotation('x', rad(beta)), axisRotation('z', -rad(gamma))))
  m = mul3(m, axisRotation('x', -Math.PI / 2))
  return mul3(m, axisRotation('z', -rad(screenAngle)))
}

/** The direction the head looks (−Z of its own frame) in scene coordinates. */
export const lookDirection = (m: ArrayLike<number>) => ({ x: -m[6], y: -m[7], z: -m[8] })

/** The clockwise angle (degrees, seen from above) of the look direction away from the stage front (−Z). */
export function headingOf(m: ArrayLike<number>): number {
  const d = lookDirection(m)
  return (Math.atan2(d.x, -d.z) * 180) / Math.PI
}

/** Make `heading` degrees the new "straight ahead": turn the orientation by −heading about the vertical axis. */
export const recentre = (m: ArrayLike<number>, heading: number) => mul3(fieldRotation({ yaw: -heading, pitch: 0, roll: 0 }), m)
