import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { XrStage, type XrStatus } from '../../services/xrStage'
import type { XrScene, XrTrigger } from '../../types/xr'

type GyroState = 'none' | 'ask' | 'on' | 'off'
type XrSessionKind = 'immersive-vr' | 'immersive-ar'
/**
 * Placing a passthrough scene in the room: ask for the camera → scan the floor with a grid reticle → a tap
 * anchors the scene there.
 */
type PlacePhase = 'CAMERA_INIT' | 'SCANNING_GROUND' | 'PLACED'

/** iOS 13+ hides the gyroscope behind a permission prompt that must be opened from a tap. */
const orientationPermission = () => (typeof DeviceOrientationEvent !== 'undefined' ? (DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<'granted' | 'denied'> }).requestPermission : undefined)
const isTouchDevice = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches

const Z_AXIS = new THREE.Vector3(0, 0, 1)
/** −90° about X: a phone held upright looks at the horizon. */
const UPRIGHT = new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2)

/** Camera orientation of a phone from its DeviceOrientation angles (W3C convention) and the screen's rotation. */
function deviceQuaternion(out: THREE.Quaternion, alpha: number, beta: number, gamma: number, screen: number) {
  const rad = THREE.MathUtils.degToRad
  out.setFromEuler(new THREE.Euler(rad(beta), rad(alpha), -rad(gamma), 'YXZ'))
  out.multiply(UPRIGHT)
  out.multiply(new THREE.Quaternion().setFromAxisAngle(Z_AXIS, -rad(screen)))
  return out
}

/**
 * Plays one XR scene, filling its container.
 *  · mode 'audience': the real thing on a phone or headset — Magic Window (drag to look around, gyroscope where
 *    the phone has one), a floating button into WebXR where the browser supports it, and the back camera as the
 *    backdrop of a passthrough scene.
 *  · mode 'preview': the console's Stage simulation — the same picture, drag to look around, no sensors.
 * `clock()` is seconds into the cue on the show clock: animations and panorama video follow it, so all devices
 * agree and a paused show stands still.
 * Unmounting (STOP, or the next picture taking over) gives back every asset and destroys the WebGL context.
 *
 * A passthrough (MR) scene on an audience device is placed first: a button opens the camera (WebXR immersive-ar
 * with hit-test where the browser has it, otherwise the back camera behind the canvas), a grid reticle follows
 * the floor — the real one from hit-test, or one projected from the phone's tilt (gyroscope) — and a tap stands
 * the scene on that spot. The models load and compile while the reticle is up, so they appear at once.
 *
 * `interactive`: objects answer to a tap (click) or to being looked at for 1.5 s (gaze, with a reticle in the
 * middle of the view) — play a sound, show a message, switch an object, play a clip, or ask for the next cue.
 */
export default function XrPlayer({
  scene,
  clock,
  paused = false,
  mode,
  interactive = mode === 'audience',
  onAudio,
  onNextCue,
}: {
  scene: XrScene
  clock: () => number
  paused?: boolean
  mode: 'audience' | 'preview'
  interactive?: boolean
  /** Play an interaction's sound (default: a plain audio element). */
  onAudio?: (url: string) => void
  /** An interaction asks for the next cue; without a handler it is only announced on screen. */
  onNextCue?: (objectId: string, interactionId: string) => void
}) {
  const wrap = useRef<HTMLDivElement>(null)
  /** Where the WebGL canvas goes: above the camera picture / simulated backdrop, below the buttons. */
  const mount = useRef<HTMLDivElement>(null)
  const cameraFeed = useRef<HTMLVideoElement>(null)
  const latest = useRef({ scene, clock, paused, interactive, onAudio, onNextCue })
  useEffect(() => {
    latest.current = { scene, clock, paused, interactive, onAudio, onNextCue }
  })
  const reticle = useRef<HTMLSpanElement>(null)
  const [dialog, setDialog] = useState<{ title: string; text: string } | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 2500)
    return () => window.clearTimeout(timer)
  }, [toast])
  const [status, setStatus] = useState<XrStatus>({ loading: 0, errors: [] })
  const [failed, setFailed] = useState<string | null>(null)
  const [gyro, setGyro] = useState<GyroState>('none')
  const [xrKind, setXrKind] = useState<XrSessionKind | null>(null)
  const [presenting, setPresenting] = useState(false)
  const [xrError, setXrError] = useState<string | null>(null)
  const [cameraState, setCameraState] = useState<'off' | 'on' | 'denied'>('off')
  const [phase, setPhase] = useState<PlacePhase>('CAMERA_INIT')
  /** The back camera as the backdrop (devices without WebXR AR), switched on by the placement button. */
  const [cameraOn, setCameraOn] = useState(false)
  /** What the renderer effect exposes to the buttons. */
  const api = useRef<{ enterXr: (kind: XrSessionKind) => Promise<void>; startGyro: () => void; stopGyro: () => void; scan: () => void } | null>(null)
  /** True right after a drag, so the tap that ends it doesn't also toggle the audience menu. */
  const dragged = useRef(false)

  const passthrough = scene.mode === 'mr_passthrough'
  const audience = mode === 'audience'
  /** This device places the scene in the room before showing it. */
  const placing = passthrough && audience
  const placingRef = useRef(placing)
  useEffect(() => {
    placingRef.current = placing
  })

  useEffect(() => {
    const box = wrap.current
    const slot = mount.current
    if (!box || !slot) return
    const canvas = document.createElement('canvas')
    canvas.className = 'absolute inset-0 h-full w-full touch-none'
    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: !isTouchDevice(), powerPreference: 'default' })
    } catch {
      setFailed('這台裝置無法啟動 3D 繪圖（WebGL）')
      return
    }
    slot.append(canvas)
    renderer.setClearColor(0x000000, 0)
    renderer.xr.enabled = true
    const stage = new XrStage({ onStatus: setStatus })
    stage.attachRenderer(renderer)
    let applied: XrScene | null = null

    // — size: sharp enough, but never more pixels than a phone GPU fills comfortably —
    const fit = () => {
      if (renderer.xr.isPresenting) return
      const w = Math.max(1, box.clientWidth)
      const h = Math.max(1, box.clientHeight)
      const budget = isTouchDevice() ? 1_600_000 : 3_000_000
      const dpr = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(budget / (w * h)))
      renderer.setPixelRatio(Math.max(0.5, dpr))
      renderer.setSize(w, h, false)
      stage.camera.aspect = w / h
      stage.camera.updateProjectionMatrix()
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(box)

    // — AR placement: a grid reticle on the floor, then the scene anchored where the viewer tapped —
    const marker = new THREE.Group()
    const markerGrid = new THREE.GridHelper(1.2, 8, 0xffffff, 0xffffff)
    const gridMaterial = markerGrid.material as THREE.LineBasicMaterial
    gridMaterial.transparent = true
    gridMaterial.opacity = 0.55
    gridMaterial.depthTest = false
    const ringMaterial = new THREE.MeshBasicMaterial({ color: 0xffd60a, transparent: true, opacity: 0.95, depthTest: false, side: THREE.DoubleSide })
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.16, 0.2, 48).rotateX(-Math.PI / 2), ringMaterial)
    const dot = new THREE.Mesh(new THREE.CircleGeometry(0.035, 20).rotateX(-Math.PI / 2), ringMaterial)
    marker.add(markerGrid, ring, dot)
    marker.traverse((o) => (o.renderOrder = 5))
    marker.visible = false
    stage.scene.add(marker)
    const ar = {
      phase: 'CAMERA_INIT' as PlacePhase,
      anchor: new THREE.Vector3(),
      yaw: 0,
      placedAt: 0,
      /** Height of the floor in scene coordinates (0, or below the head when the session has no floor tracking). */
      floorY: 0,
      hitSource: null as XRHitTestSource | null,
      compiled: false,
    }
    const setPlacePhase = (next: PlacePhase) => {
      ar.phase = next
      setPhase(next)
    }
    const eye = new THREE.Vector3()
    const aim = new THREE.Vector3()
    /** Anchor the scene on the reticle. */
    const placeScene = () => {
      if (ar.phase !== 'SCANNING_GROUND' || !marker.visible) return false
      const viewer = renderer.xr.isPresenting ? renderer.xr.getCamera() : stage.camera
      viewer.getWorldPosition(eye)
      ar.anchor.copy(marker.position)
      // Turned towards the viewer: what faced the audience in the editor faces them here.
      const dx = ar.anchor.x - eye.x
      const dz = ar.anchor.z - eye.z
      if (Math.hypot(dx, dz) > 0.05) ar.yaw = Math.atan2(-dx, -dz)
      else {
        viewer.getWorldDirection(aim)
        ar.yaw = Math.atan2(-aim.x, -aim.z)
      }
      ar.placedAt = performance.now()
      setPlacePhase('PLACED')
      return true
    }

    // — interactions —
    const fired = new Set<string>()
    const raycaster = new THREE.Raycaster()
    /** Run what the object (or the nearest parent that has any) does on this trigger. Returns whether anything ran. */
    const fire = (objectId: string, trigger: XrTrigger): boolean => {
      const now = latest.current
      const objects = now.scene.objects
      let object = objects.find((o) => o.id === objectId)
      while (object && !object.interactions.some((i) => i.trigger === trigger)) object = objects.find((o) => o.id === object!.parentId)
      if (!object) return false
      const owner = object
      let ran = false
      for (const it of owner.interactions) {
        if (it.trigger !== trigger) continue
        const key = `${owner.id}:${it.id}`
        if (it.once && fired.has(key)) continue
        fired.add(key)
        ran = true
        if (it.action === 'audio' && it.url) {
          if (now.onAudio) now.onAudio(it.url)
          else {
            const el = new Audio()
            el.src = it.url
            el.play().catch(() => setToast('🔇 瀏覽器擋住了聲音：請先點一下畫面'))
          }
        } else if (it.action === 'dialog') setDialog({ title: owner.name, text: it.text })
        else if (it.action === 'toggle') stage.toggle(it.targetId || owner.id)
        else if (it.action === 'animation') stage.playClip(owner.id, it.text, now.clock())
        else if (it.action === 'next_cue') {
          if (now.onNextCue) now.onNextCue(owner.id, it.id)
          setToast(now.onNextCue ? '✓ 已觸發下一個 Cue' : '▶ 會執行下一個 Cue（預覽中不會真的 GO）')
        }
      }
      return ran
    }
    const pickAt = (x: number, y: number, camera: THREE.Camera) => {
      raycaster.setFromCamera(new THREE.Vector2(x, y), camera)
      return stage.pick(raycaster)?.id ?? null
    }
    // Gaze: whatever sits in the middle of the view for 1.5 s.
    const gaze = { id: null as string | null, since: 0, done: false, checked: 0 }
    const GAZE_MS = 1500

    // — Magic Window: drag to look around —
    const view = { yaw: 0, pitch: 0, zoom: 0 }
    let pointer: { id: number; x: number; y: number; moved: number } | null = null
    const onDown = (e: PointerEvent) => {
      if (renderer.xr.isPresenting) return
      pointer = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: 0 }
      dragged.current = false
      canvas.setPointerCapture(e.pointerId)
    }
    const onMove = (e: PointerEvent) => {
      if (!pointer || pointer.id !== e.pointerId) return
      const dx = e.clientX - pointer.x
      const dy = e.clientY - pointer.y
      pointer.x = e.clientX
      pointer.y = e.clientY
      pointer.moved += Math.abs(dx) + Math.abs(dy)
      if (pointer.moved > 6) dragged.current = true
      // Grab-the-world: the scene follows the finger. One screen height ≈ the vertical field of view.
      const perPixel = stage.camera.fov / Math.max(1, box.clientHeight)
      view.yaw -= dx * perPixel
      // Kept inside what the camera can show, so the view never "sticks" at the top or bottom.
      const base = latest.current.scene.camera.pitch
      if (!device.reading) view.pitch = THREE.MathUtils.clamp(view.pitch + dy * perPixel, -89 - base, 89 - base)
    }
    const onUp = (e: PointerEvent) => {
      const p = pointer
      if (p?.id !== e.pointerId) return
      pointer = null
      if (e.type !== 'pointerup' || p.moved > 6 || renderer.xr.isPresenting) return
      // Scanning the floor: a tap puts the scene on the reticle (and is not a tap for the page's menu).
      if (placingRef.current && ar.phase !== 'PLACED') {
        if (placeScene()) dragged.current = true
        return
      }
      // A tap (not a drag) on an object runs its click interactions.
      if (!latest.current.interactive) return
      const rect = canvas.getBoundingClientRect()
      const id = pickAt(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1, stage.camera)
      // The tap was for the object: keep it from also toggling the page's own menu.
      if (id && fire(id, 'click')) dragged.current = true
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      view.zoom = THREE.MathUtils.clamp(view.zoom + e.deltaY * 0.03, -40, 30)
    }
    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointercancel', onUp)
    canvas.addEventListener('wheel', onWheel, { passive: false })

    // — Magic Window: the phone's gyroscope —
    const device = { reading: null as THREE.Quaternion | null, yaw0: null as number | null, listening: false }
    const onOrientation = (e: DeviceOrientationEvent) => {
      if (e.alpha == null || e.beta == null || e.gamma == null) return
      const angle = window.screen.orientation?.angle ?? (window as unknown as { orientation?: number }).orientation ?? 0
      device.reading = deviceQuaternion(device.reading ?? new THREE.Quaternion(), e.alpha, e.beta, e.gamma, angle)
      // Wherever the phone points when the first reading arrives is "ahead".
      if (device.yaw0 == null) {
        device.yaw0 = new THREE.Euler().setFromQuaternion(device.reading, 'YXZ').y
        view.pitch = 0
        setGyro('on')
      }
    }
    const startGyro = () => {
      if (device.listening) return
      device.listening = true
      window.addEventListener('deviceorientation', onOrientation)
    }
    const stopGyro = () => {
      device.listening = false
      window.removeEventListener('deviceorientation', onOrientation)
      device.reading = null
      device.yaw0 = null
    }

    // — WebXR —
    let session: XRSession | null = null
    const enterXr = async (kind: XrSessionKind) => {
      if (session || !navigator.xr) return
      const augmented = kind === 'immersive-ar'
      // AR: hit-test finds the real floor; the DOM overlay keeps the hint and the buttons on screen.
      const started = await navigator.xr.requestSession(kind, augmented ? { optionalFeatures: ['local-floor', 'hit-test', 'dom-overlay'], domOverlay: { root: box } } : { optionalFeatures: ['local-floor'] })
      session = started
      started.addEventListener('end', () => {
        session = null
        ar.hitSource?.cancel()
        ar.hitSource = null
        ar.floorY = 0
        stage.rig.position.set(0, 0, 0)
        setPresenting(false)
        // Leaving AR ends the placement: the viewer starts over from the camera button.
        if (augmented) setPlacePhase('CAMERA_INIT')
        fit()
      })
      // In AR a tap anywhere on the screen is the session's "select".
      if (augmented) started.addEventListener('select', () => placeScene())
      try {
        // Floor-level space: the headset reports the viewer's real eye height.
        renderer.xr.setReferenceSpaceType('local-floor')
        await renderer.xr.setSession(started)
      } catch {
        // No floor tracking: start at the head and lift the rig to the scene's eye height.
        renderer.xr.setReferenceSpaceType('local')
        await renderer.xr.setSession(started)
        // AR keeps real-world coordinates (the floor is then below the starting head position).
        if (augmented) ar.floorY = -latest.current.scene.camera.height
        else stage.rig.position.set(0, latest.current.scene.camera.height, 0)
      }
      if (augmented && started.requestHitTestSource) {
        try {
          const viewerSpace = await started.requestReferenceSpace('viewer')
          ar.hitSource = (await started.requestHitTestSource({ space: viewerSpace })) ?? null
        } catch {
          // No hit-test on this device: the reticle is projected onto the floor plane instead.
        }
      }
      setPresenting(true)
    }
    api.current = { enterXr, startGyro, stopGyro, scan: () => setPlacePhase('SCANNING_GROUND') }

    renderer.setAnimationLoop((_time: number, frame?: XRFrame) => {
      const now = latest.current
      if (now.scene !== applied) {
        applied = now.scene
        stage.apply(now.scene)
        ar.compiled = false
      }
      const placingNow = placingRef.current
      if (renderer.xr.isPresenting) {
        // The headset aims the camera; the rig only turns the viewer towards the initial view.
        // (A placed AR scene keeps real-world coordinates instead.)
        stage.rig.rotation.set(0, placingNow ? 0 : -THREE.MathUtils.degToRad(now.scene.camera.yaw), 0)
        if (session?.environmentBlendMode && session.environmentBlendMode !== 'opaque') stage.scene.background = null
      } else {
        stage.look(view.yaw, view.pitch, device.reading, device.yaw0 ?? 0)
        const fov = THREE.MathUtils.clamp(now.scene.camera.fov + view.zoom, 25, 110)
        if (stage.camera.fov !== fov) {
          stage.camera.fov = fov
          stage.camera.updateProjectionMatrix()
        }
      }
      const viewer = renderer.xr.isPresenting ? renderer.xr.getCamera() : stage.camera
      stage.update(now.clock(), now.paused, viewer)

      // — AR placement —
      if (!placingNow) {
        marker.visible = false
        stage.place(null)
        stage.setContentVisible(true)
      } else if (ar.phase === 'PLACED') {
        marker.visible = false
        // Entrance: the scene grows out of the anchor point.
        const k = Math.min(1, (performance.now() - ar.placedAt) / 450)
        stage.place({ anchor: ar.anchor, yaw: ar.yaw, scale: Math.max(0.001, 1 - Math.pow(1 - k, 3)) })
        stage.setContentVisible(true)
      } else {
        // Loaded and compiled, but not shown until it has a place.
        stage.setContentVisible(false)
        if (!ar.compiled && stage.status().loading === 0) {
          ar.compiled = true
          try {
            renderer.compile(stage.scene, stage.camera)
          } catch {
            // Compiling ahead is only an optimisation.
          }
        }
        let found = false
        if (ar.phase === 'SCANNING_GROUND') {
          const space = renderer.xr.getReferenceSpace()
          const pose = frame && ar.hitSource && space ? frame.getHitTestResults(ar.hitSource)[0]?.getPose(space) : null
          if (pose) {
            // The real floor, from WebXR hit-test.
            marker.position.set(pose.transform.position.x, pose.transform.position.y, pose.transform.position.z)
            found = true
          } else {
            // Ground projection: where the middle of the view meets the floor plane, from the phone's tilt
            // (gyroscope) and eye height — never nearer than arm's length, never farther than a few metres.
            viewer.getWorldPosition(eye)
            viewer.getWorldDirection(aim)
            const flat = Math.hypot(aim.x, aim.z)
            if (flat > 1e-4) {
              const drop = Math.max(0.3, eye.y - ar.floorY)
              const reach = THREE.MathUtils.clamp(aim.y < -0.02 ? (drop * flat) / -aim.y : 6, 0.6, 6)
              marker.position.set(eye.x + (aim.x / flat) * reach, ar.floorY, eye.z + (aim.z / flat) * reach)
              found = true
            }
          }
          const pulse = 1 + Math.sin(performance.now() / 260) * 0.06
          ring.scale.set(pulse, 1, pulse)
        }
        marker.visible = found
      }

      const active = !placingNow || ar.phase === 'PLACED'
      const wantsGaze = active && now.interactive && now.scene.objects.some((o) => o.interactions.some((i) => i.trigger === 'gaze'))
      const time = performance.now()
      if (wantsGaze && time - gaze.checked > 100) {
        gaze.checked = time
        const id = pickAt(0, 0, viewer)
        // Only objects that answer to a gaze (themselves or through a parent) hold the reticle.
        const objects = now.scene.objects
        let owner = objects.find((o) => o.id === id)
        while (owner && !owner.interactions.some((i) => i.trigger === 'gaze')) owner = objects.find((o) => o.id === owner!.parentId)
        const target = owner ? id : null
        if (target !== gaze.id) {
          gaze.id = target
          gaze.since = time
          gaze.done = false
        } else if (target && !gaze.done && time - gaze.since >= GAZE_MS) {
          gaze.done = true
          fire(target, 'gaze')
        }
      }
      if (reticle.current) {
        reticle.current.style.display = wantsGaze ? '' : 'none'
        const progress = wantsGaze && gaze.id && !gaze.done ? Math.min(1, (time - gaze.since) / GAZE_MS) : 0
        reticle.current.style.setProperty('--gaze', `${Math.round(progress * 360)}deg`)
        reticle.current.dataset.xrGaze = gaze.id ? (gaze.done ? 'done' : 'dwell') : 'idle'
      }
      renderer.render(stage.scene, stage.camera)
    })

    return () => {
      api.current = null
      renderer.setAnimationLoop(null)
      session?.end().catch(() => {})
      stopGyro()
      observer.disconnect()
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onUp)
      canvas.removeEventListener('wheel', onWheel)
      // Hand back the models and textures (freed once nobody else holds them), then the context itself.
      ar.hitSource?.cancel()
      markerGrid.geometry.dispose()
      gridMaterial.dispose()
      ring.geometry.dispose()
      dot.geometry.dispose()
      ringMaterial.dispose()
      stage.dispose()
      renderer.dispose()
      renderer.forceContextLoss()
      canvas.remove()
    }
  }, [])

  // Gyroscope: only real phones, only when the scene allows it. iOS needs a tap first (see the button below).
  // (A passthrough scene always uses it: the floor reticle follows the phone's tilt.)
  const wantsGyro = audience && (scene.gyro || passthrough) && isTouchDevice() && typeof DeviceOrientationEvent !== 'undefined' && window.isSecureContext
  useEffect(() => {
    if (!wantsGyro) return
    if (orientationPermission()) {
      setGyro((g) => (g === 'none' ? 'ask' : g))
      return
    }
    api.current?.startGyro()
    return () => {
      api.current?.stopGyro()
      setGyro('none')
    }
  }, [wantsGyro])

  // WebXR: offer the immersive mode this scene is made for, where the browser has it.
  useEffect(() => {
    if (!audience || !navigator.xr) return
    let live = true
    const kind: XrSessionKind = passthrough ? 'immersive-ar' : 'immersive-vr'
    navigator.xr
      .isSessionSupported(kind)
      .then((ok) => live && setXrKind(ok ? kind : null))
      .catch(() => live && setXrKind(null))
    return () => {
      live = false
    }
  }, [audience, passthrough])

  // Passthrough on a phone without WebXR AR: the back camera is the backdrop, the models float over it.
  // It opens from the placement button and closes with the cue (unmount stops the tracks).
  const wantsCamera = placing && cameraOn && !presenting
  useEffect(() => {
    if (!wantsCamera) return
    let stream: MediaStream | null = null
    let live = true
    const media = navigator.mediaDevices
    if (!media?.getUserMedia) {
      setCameraState('denied')
      return
    }
    media
      .getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } })
      .then((s) => {
        if (!live) return s.getTracks().forEach((t) => t.stop())
        stream = s
        const el = cameraFeed.current
        if (el) {
          el.srcObject = s
          el.play().catch(() => {})
        }
        setCameraState('on')
      })
      .catch(() => live && setCameraState('denied'))
    return () => {
      live = false
      stream?.getTracks().forEach((t) => t.stop())
      setCameraState('off')
    }
  }, [wantsCamera])

  const askGyro = async () => {
    try {
      const answer = await orientationPermission()?.()
      if (answer === 'granted') {
        api.current?.startGyro()
        setGyro('on')
      } else setGyro('off')
    } catch {
      setGyro('off')
    }
  }

  /** CAMERA_INIT → SCANNING_GROUND: runs inside the viewer's tap (the camera and iOS's motion prompt need one). */
  const openCamera = async () => {
    setXrError(null)
    const supportsAr = xrKind === 'immersive-ar'
    if (!supportsAr) {
      // iOS: motion access must be asked from a tap — this one. (No WebXR there, so nothing else needs the tap.)
      const ask = orientationPermission()
      if (ask) {
        try {
          if ((await ask()) === 'granted') {
            api.current?.startGyro()
            setGyro('on')
          } else setGyro('off')
        } catch {
          setGyro('off')
        }
      }
    } else {
      try {
        await api.current?.enterXr('immersive-ar')
        api.current?.scan()
        return
      } catch (err) {
        setXrError(`無法啟動 AR：${(err as Error).message}，改用相機背景模式`)
      }
    }
    setCameraOn(true)
    api.current?.scan()
  }

  const chip = 'pointer-events-auto rounded-full bg-black/60 font-semibold text-white shadow-lg backdrop-blur'
  return (
    <div
      ref={wrap}
      // (Transparent while in AR: this element is the session's DOM overlay, over the real camera picture.)
      className={`relative h-full w-full overflow-hidden ${passthrough && !presenting ? 'bg-black' : ''}`}
      // A drag to look around ends in a click: keep it from reaching the page (it would toggle the audience menu).
      onClickCapture={(e) => {
        if (dragged.current) {
          dragged.current = false
          e.stopPropagation()
        }
      }}
      data-xr-player={mode}
      data-xr-mode={scene.mode}
      data-xr-loading={status.loading}
      data-xr-phase={placing ? phase : undefined}
    >
      {passthrough && audience && <video ref={cameraFeed} muted playsInline className={`absolute inset-0 h-full w-full object-cover ${cameraState === 'on' && !presenting ? '' : 'hidden'}`} data-xr-camera={cameraState} />}
      {passthrough && !audience && (
        <div className="absolute inset-0 flex items-end justify-center bg-[repeating-linear-gradient(45deg,#1b1f27_0_12px,#161a21_12px_24px)] pb-[6cqw]">
          <span className="rounded bg-black/50 px-2 py-0.5 text-[clamp(8px,2.6cqw,12px)] text-white/55">MR 透視（模擬）· 觀眾看到的是手機後鏡頭畫面</span>
        </div>
      )}

      <div ref={mount} className="absolute inset-0" />

      {failed ? (
        <p className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-white/60">{failed}</p>
      ) : (
        <>
          {status.loading > 0 && (!placing || phase === 'PLACED') && (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3" data-xr-loading-overlay>
              <span className="h-7 w-7 animate-spin rounded-full border-2 border-white/20 border-t-white/80" />
              <span className="text-xs tracking-widest text-white/50">載入 XR 場景…</span>
            </div>
          )}
          {status.errors.length > 0 && (
            <p className="pointer-events-none absolute inset-x-3 top-[max(0.75rem,env(safe-area-inset-top))] rounded-lg bg-black/70 px-3 py-2 text-center text-[11px] text-red-300" data-xr-error>
              {status.errors.join('；')}
            </p>
          )}
          {placing && phase !== 'CAMERA_INIT' && cameraState === 'denied' && !presenting && (
            <p className="pointer-events-none absolute inset-x-3 bottom-[max(5.5rem,calc(env(safe-area-inset-bottom)+5rem))] rounded-lg bg-black/70 px-3 py-2 text-center text-[11px] text-white/60">無法開啟後鏡頭（未允許相機，或需要 HTTPS）：改以黑底顯示</p>
          )}

          {/* AR placement: camera button → scanning hint → re-place button */}
          {placing && phase === 'CAMERA_INIT' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/70 px-6 text-center" onClick={(e) => e.stopPropagation()} data-xr-camera-init>
              <span className="text-4xl">📸</span>
              <p className="max-w-xs text-sm leading-relaxed text-white/75">接下來會把場景放進你眼前的空間。請允許使用相機{orientationPermission() ? '與動作感測' : ''}。</p>
              <button type="button" onClick={() => void openCamera()} className="min-h-14 rounded-full bg-white px-7 text-base font-bold text-black shadow-xl active:scale-95" data-xr-open-camera>
                📸 開啟相機進行空間定位
              </button>
              {xrError && <span className="text-[11px] text-red-300">{xrError}</span>}
            </div>
          )}
          {placing && phase === 'SCANNING_GROUND' && (
            <p className="pointer-events-none absolute inset-x-4 top-[max(1.25rem,calc(env(safe-area-inset-top)+0.75rem))] mx-auto w-fit max-w-sm rounded-2xl bg-black/70 px-4 py-2.5 text-center text-sm font-semibold text-white shadow-lg backdrop-blur" data-xr-scan-hint>
              請移動手機對準地面，點擊螢幕放置場景
              {status.loading > 0 && <span className="mt-0.5 block text-[10px] font-normal text-white/50">模型載入中…</span>}
            </p>
          )}
          {placing && phase === 'PLACED' && (
            <button
              type="button"
              // In AR every tap is also the session's "select": keep this one from placing the scene again.
              ref={(el) => el?.addEventListener('beforexrselect', (e) => e.preventDefault())}
              onClick={(e) => {
                e.stopPropagation()
                api.current?.scan()
              }}
              className={`${chip} absolute top-[max(0.9rem,calc(env(safe-area-inset-top)+0.4rem))] right-3 min-h-11 px-4 text-sm`}
              data-xr-replace
            >
              🔄 重新定位
            </button>
          )}

          {/* Gaze reticle: a ring in the middle of the view that fills while an object is being looked at. */}
          <span
            ref={reticle}
            style={{ display: 'none', background: 'conic-gradient(#ffd60a var(--gaze, 0deg), rgba(255,255,255,0.35) 0)', WebkitMask: 'radial-gradient(circle, transparent 55%, #000 58%)', mask: 'radial-gradient(circle, transparent 55%, #000 58%)' }}
            className="pointer-events-none absolute top-1/2 left-1/2 h-7 w-7 -translate-x-1/2 -translate-y-1/2 rounded-full"
            data-xr-reticle
          />
          {toast && (
            <span className="pointer-events-none absolute inset-x-0 top-[max(1rem,env(safe-area-inset-top))] mx-auto w-fit max-w-[90%] rounded-full bg-black/70 px-4 py-1.5 text-center text-xs text-white/90 backdrop-blur" data-xr-toast>
              {toast}
            </span>
          )}
          {dialog && (
            <div className="absolute inset-x-3 bottom-[max(5rem,calc(env(safe-area-inset-bottom)+4.5rem))] mx-auto max-w-md rounded-2xl border border-white/25 bg-black/80 p-4 shadow-2xl backdrop-blur-xl" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={dialog.title} data-xr-dialog>
              <span className="text-[11px] font-bold tracking-widest text-standby">{dialog.title}</span>
              <p className="mt-1 text-base leading-relaxed whitespace-pre-line text-white">{dialog.text || '…'}</p>
              <button type="button" onClick={() => setDialog(null)} className="mt-3 min-h-12 w-full rounded-lg bg-white/15 text-base font-semibold text-white active:bg-white/25">
                關閉
              </button>
            </div>
          )}

          {audience && !presenting && (
            <div className="pointer-events-none absolute inset-x-0 bottom-[max(1.25rem,calc(env(safe-area-inset-bottom)+0.75rem))] flex flex-col items-center gap-2 px-4" onClick={(e) => e.stopPropagation()}>
              {xrError && !placing && <span className="rounded-lg bg-black/70 px-3 py-1 text-[11px] text-red-300">{xrError}</span>}
              {xrKind && !placing && (
                <button
                  type="button"
                  onClick={() => {
                    setXrError(null)
                    api.current?.enterXr(xrKind).catch((err: Error) => setXrError(`無法進入沉浸模式：${err.message}`))
                  }}
                  className={`${chip} min-h-12 border border-white/40 px-6 text-sm`}
                  data-xr-enter={xrKind}
                >
                  🥽 進入 VR/MR 沉浸模式
                </button>
              )}
              {gyro === 'ask' && !placing && (
                <button type="button" onClick={askGyro} className={`${chip} min-h-12 px-6 text-sm`} data-xr-gyro="ask">
                  📱 點一下，轉動手機環視
                </button>
              )}
              {gyro === 'on' && <span className="rounded-full bg-black/40 px-3 py-1 text-[10px] text-white/50" data-xr-gyro="on">轉動手機或滑動畫面環視</span>}
              {(gyro === 'none' || gyro === 'off') && !xrKind && <span className="rounded-full bg-black/40 px-3 py-1 text-[10px] text-white/50" data-xr-gyro={gyro}>滑動畫面環視</span>}
            </div>
          )}
        </>
      )}
    </div>
  )
}
