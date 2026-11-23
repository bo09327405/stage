import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import { XrStage, type XrStatus } from '../../services/xrStage'
import { wrapDegrees, type XrScene, type XrVec3 } from '../../types/xr'

export type XrTool = 'translate' | 'rotate' | 'scale'
/** 'orbit': look at the scene from outside (place things). 'pov': stand where the audience stands. */
export type XrViewMode = 'orbit' | 'pov'

export interface XrViewportHandle {
  /** Where the audience view is pointing right now (initial view + what was dragged), in degrees. */
  currentView: () => { yaw: number; pitch: number }
  /** Forget the dragged offset (after it has been saved as the initial view). */
  resetView: () => void
  /** Move the orbit camera so the object (or everything) fills the view. */
  focus: (id: string | null) => void
  /** Size of a loaded object in metres (after its scale), or null. */
  sizeOf: (id: string) => XrVec3 | null
  /** Jump the orbit camera to a standard view of what it is looking at. */
  setCamera: (view: XrCameraPreset) => void
}

export type XrCameraPreset = 'persp' | 'top' | 'front'
/** What is dragged from the asset library onto the viewport. */
export interface XrAssetDrop {
  url: string
  name: string
  kind: 'model' | 'image' | 'video'
}
export const XR_ASSET_MIME = 'application/x-xr-asset'

const round = (v: number, digits: number) => {
  const k = 10 ** digits
  return Math.round(v * k) / k
}
const deg = THREE.MathUtils.radToDeg

/**
 * The XR editor's 3D viewport: the same scene graph the audience gets (services/xrStage.ts) plus editing aids —
 * floor grid, a marker for where the audience stands and faces, an orbit camera (drag to turn, wheel to zoom,
 * right-drag / two fingers to pan), a move / rotate / scale gizmo on the selected object, grid snapping,
 * top / front views, a marker at the stage origin, and a drop target for files dragged from the asset library.
 */
export function XrViewport({
  scene,
  selectedId,
  tool,
  view,
  playing,
  snap = false,
  onSelect,
  onTransform,
  onModel,
  onDropAsset,
  handle,
}: {
  scene: XrScene
  selectedId: string | null
  tool: XrTool
  view: XrViewMode
  /** Run animations and panorama video (a free-running clock; the show clock only exists on stage). */
  playing: boolean
  /** Snap the gizmo to the grid: 0.25 m, 15°, 0.1×. */
  snap?: boolean
  /** `additive`: shift / ⌘ / ctrl was held (add to or remove from the selection). */
  onSelect: (id: string | null, additive: boolean) => void
  onTransform: (id: string, transform: { position: XrVec3; rotation: XrVec3; scale: XrVec3 }) => void
  /** A model finished loading: its animation clips are now known. */
  onModel: (id: string, clips: string[]) => void
  /** A library file was dropped at this point of the floor (scene coordinates). */
  onDropAsset?: (asset: XrAssetDrop, at: XrVec3) => void
  handle: Ref<XrViewportHandle>
}) {
  const wrap = useRef<HTMLDivElement>(null)
  const latest = useRef({ scene, selectedId, tool, view, playing, snap, onSelect, onTransform, onModel, onDropAsset })
  useEffect(() => {
    latest.current = { scene, selectedId, tool, view, playing, snap, onSelect, onTransform, onModel, onDropAsset }
  })
  const [status, setStatus] = useState<XrStatus>({ loading: 0, errors: [] })
  const [failed, setFailed] = useState<string | null>(null)
  const api = useRef<XrViewportHandle | null>(null)
  useImperativeHandle(handle, () => ({
    currentView: () => api.current?.currentView() ?? { yaw: 0, pitch: 0 },
    resetView: () => api.current?.resetView(),
    focus: (id) => api.current?.focus(id),
    sizeOf: (id) => api.current?.sizeOf(id) ?? null,
    setCamera: (preset) => api.current?.setCamera(preset),
  }))

  useEffect(() => {
    const box = wrap.current
    if (!box) return
    const canvas = document.createElement('canvas')
    canvas.className = 'absolute inset-0 h-full w-full touch-none outline-none'
    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    } catch {
      setFailed('這個瀏覽器無法啟動 3D 繪圖（WebGL），無法顯示預覽')
      return
    }
    box.prepend(canvas)
    const stage = new XrStage({
      editor: true,
      videoScope: 'editor',
      onStatus: setStatus,
      onModel: (id) => latest.current.onModel(id, stage.clipsOf(id)),
    })
    stage.attachRenderer(renderer)

    // — editing aids (never part of what the audience sees) —
    const aids = new THREE.Group()
    const grid = new THREE.GridHelper(20, 20, 0x5b6472, 0x2b313b)
    ;(grid.material as THREE.Material).transparent = true
    ;(grid.material as THREE.Material).opacity = 0.7
    const viewer = new THREE.Group()
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.11, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffd60a }))
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 1, 6), new THREE.MeshBasicMaterial({ color: 0xffd60a, transparent: true, opacity: 0.5 }))
    const arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, -1), new THREE.Vector3(), 1.4, 0xffd60a, 0.3, 0.16)
    viewer.add(head, body, arrow)
    // The stage origin (0, 0, 0): red = X, green = Y, blue = Z, one metre each.
    const origin = new THREE.AxesHelper(1)
    ;(origin.material as THREE.Material).depthTest = false
    origin.renderOrder = 2
    aids.add(grid, viewer, origin)
    stage.scene.add(aids)

    const orbitCam = new THREE.PerspectiveCamera(50, 1, 0.05, 2000)
    orbitCam.position.set(3.5, 3.2, 4.5)
    const orbit = new OrbitControls(orbitCam, canvas)
    orbit.target.set(0, 1, -2)
    orbit.enableDamping = true
    orbit.dampingFactor = 0.12
    orbit.update()

    const gizmo = new TransformControls(orbitCam, canvas)
    gizmo.setSize(0.9)
    const gizmoHelper = gizmo.getHelper()
    stage.scene.add(gizmoHelper)
    gizmo.addEventListener('dragging-changed', (e) => {
      orbit.enabled = !e.value
    })
    gizmo.addEventListener('objectChange', () => {
      const root = gizmo.object
      const id = root?.userData.xrObjectId as string | undefined
      if (!root || !id) return
      // A model can't be scaled to nothing (or mirrored through zero).
      root.scale.set(Math.max(0.001, Math.abs(root.scale.x)), Math.max(0.001, Math.abs(root.scale.y)), Math.max(0.001, Math.abs(root.scale.z)))
      latest.current.onTransform(id, {
        position: { x: round(root.position.x, 3), y: round(root.position.y, 3), z: round(root.position.z, 3) },
        rotation: { x: round(deg(root.rotation.x), 1), y: round(deg(root.rotation.y), 1), z: round(deg(root.rotation.z), 1) },
        scale: { x: round(root.scale.x, 3), y: round(root.scale.y, 3), z: round(root.scale.z, 3) },
      })
    })

    const fit = () => {
      const w = Math.max(1, box.clientWidth)
      const h = Math.max(1, box.clientHeight)
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
      renderer.setSize(w, h, false)
      orbitCam.aspect = stage.camera.aspect = w / h
      orbitCam.updateProjectionMatrix()
      stage.camera.updateProjectionMatrix()
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(box)

    // — pointer: click to select (orbit view), drag to look around (audience view) —
    const pov = { yaw: 0, pitch: 0, zoom: 0 }
    let press: { id: number; x: number; y: number; moved: number } | null = null
    const raycaster = new THREE.Raycaster()
    const onDown = (e: PointerEvent) => {
      press = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: 0 }
    }
    const onMove = (e: PointerEvent) => {
      if (!press || press.id !== e.pointerId) return
      const dx = e.clientX - press.x
      const dy = e.clientY - press.y
      press.x = e.clientX
      press.y = e.clientY
      press.moved += Math.abs(dx) + Math.abs(dy)
      if (latest.current.view !== 'pov') return
      const perPixel = stage.camera.fov / Math.max(1, box.clientHeight)
      const base = latest.current.scene.camera.pitch
      pov.yaw -= dx * perPixel
      pov.pitch = THREE.MathUtils.clamp(pov.pitch + dy * perPixel, -89 - base, 89 - base)
    }
    const onUp = (e: PointerEvent) => {
      const p = press
      press = null
      if (!p || p.id !== e.pointerId || p.moved > 5 || latest.current.view !== 'orbit' || e.button !== 0) return
      // A click on a gizmo handle is the gizmo's, not a selection.
      if (gizmo.dragging || gizmo.axis) return
      const additive = e.shiftKey || e.metaKey || e.ctrlKey
      const rect = canvas.getBoundingClientRect()
      raycaster.setFromCamera(new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1), orbitCam)
      const hit = stage.pick(raycaster)
      if (hit || !additive) latest.current.onSelect(hit?.id ?? null, additive)
    }
    const onWheel = (e: WheelEvent) => {
      if (latest.current.view !== 'pov') return
      e.preventDefault()
      pov.zoom = THREE.MathUtils.clamp(pov.zoom + e.deltaY * 0.03, -40, 30)
    }
    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointercancel', onUp)
    canvas.addEventListener('wheel', onWheel, { passive: false })

    // — drop a library file onto the floor —
    const floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
    const onDragOver = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes(XR_ASSET_MIME)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
    const onDrop = (e: DragEvent) => {
      const raw = e.dataTransfer?.getData(XR_ASSET_MIME)
      if (!raw) return
      e.preventDefault()
      const camera = latest.current.view === 'pov' ? stage.camera : orbitCam
      const rect = canvas.getBoundingClientRect()
      raycaster.setFromCamera(new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1), camera)
      // Where the pointer meets the floor; looking above the horizon, 4 m along the view instead.
      const point = raycaster.ray.intersectPlane(floor, new THREE.Vector3())
      const at = point && point.distanceTo(raycaster.ray.origin) < 60 ? point : raycaster.ray.at(4, new THREE.Vector3()).setY(0)
      try {
        latest.current.onDropAsset?.(JSON.parse(raw) as XrAssetDrop, { x: round(at.x, 2), y: 0, z: round(at.z, 2) })
      } catch {
        // Not one of ours.
      }
    }
    box.addEventListener('dragover', onDragOver)
    box.addEventListener('drop', onDrop)

    const box3 = new THREE.Box3()
    api.current = {
      currentView: () => {
        const cam = latest.current.scene.camera
        return { yaw: round(wrapDegrees(cam.yaw + pov.yaw), 1), pitch: round(THREE.MathUtils.clamp(cam.pitch + pov.pitch, -89, 89), 1) }
      },
      resetView: () => {
        pov.yaw = 0
        pov.pitch = 0
      },
      focus: (id) => {
        const target = (id && stage.rootOf(id)) || stage.content
        box3.setFromObject(target)
        if (box3.isEmpty()) return
        const sphere = box3.getBoundingSphere(new THREE.Sphere())
        const distance = Math.max(0.5, sphere.radius) / Math.sin(THREE.MathUtils.degToRad(orbitCam.fov / 2)) + 0.2
        const direction = orbitCam.position.clone().sub(orbit.target).normalize()
        orbit.target.copy(sphere.center)
        orbitCam.position.copy(sphere.center).addScaledVector(direction, distance)
        orbit.update()
      },
      sizeOf: (id) => {
        const root = stage.rootOf(id)
        if (!root || root.children.length === 0) return null
        const size = box3.setFromObject(root).getSize(new THREE.Vector3())
        return { x: round(size.x, 2), y: round(size.y, 2), z: round(size.z, 2) }
      },
      setCamera: (preset) => {
        const distance = Math.max(2, orbitCam.position.distanceTo(orbit.target))
        // Top: straight down (a hair off vertical so "up" stays defined). Front: from the audience's side.
        if (preset === 'top') orbitCam.position.set(orbit.target.x, orbit.target.y + distance, orbit.target.z + 0.001)
        else if (preset === 'front') orbitCam.position.set(orbit.target.x, orbit.target.y, orbit.target.z + distance)
        else orbitCam.position.set(orbit.target.x + distance * 0.5, orbit.target.y + distance * 0.45, orbit.target.z + distance * 0.7)
        orbit.update()
      },
    }

    let applied: XrScene | null = null
    let attached: THREE.Object3D | null = null
    let elapsed = 0
    let last = performance.now()
    renderer.setAnimationLoop(() => {
      const now = latest.current
      const time = performance.now()
      if (now.playing) elapsed += (time - last) / 1000
      last = time
      if (now.scene !== applied) {
        applied = now.scene
        stage.apply(now.scene)
        const cam = now.scene.camera
        viewer.position.set(0, cam.height, 0)
        body.position.y = -cam.height / 2
        body.scale.y = Math.max(0.01, cam.height)
        // The arrow shows the initial view direction.
        const yaw = THREE.MathUtils.degToRad(cam.yaw)
        const pitch = THREE.MathUtils.degToRad(cam.pitch)
        arrow.setDirection(new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)))
      }
      const povView = now.view === 'pov'
      // The gizmo follows the selection (only while looking from outside).
      const root = !povView && now.selectedId ? stage.rootOf(now.selectedId) : null
      if (root !== attached) {
        if (root) gizmo.attach(root)
        else gizmo.detach()
        attached = root
      }
      if (gizmo.mode !== now.tool) gizmo.setMode(now.tool)
      gizmo.setTranslationSnap(now.snap ? 0.25 : null)
      gizmo.setRotationSnap(now.snap ? THREE.MathUtils.degToRad(15) : null)
      gizmo.setScaleSnap(now.snap ? 0.1 : null)
      gizmoHelper.visible = !!root
      aids.visible = !povView
      orbit.enabled = !povView && !gizmo.dragging
      stage.look(pov.yaw, pov.pitch)
      const fov = THREE.MathUtils.clamp(now.scene.camera.fov + (povView ? pov.zoom : 0), 25, 110)
      if (stage.camera.fov !== fov) {
        stage.camera.fov = fov
        stage.camera.updateProjectionMatrix()
      }
      const camera = povView ? stage.camera : orbitCam
      if (!povView) orbit.update()
      stage.update(elapsed, !now.playing, camera)
      renderer.render(stage.scene, camera)
    })

    return () => {
      api.current = null
      renderer.setAnimationLoop(null)
      observer.disconnect()
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onUp)
      canvas.removeEventListener('wheel', onWheel)
      box.removeEventListener('dragover', onDragOver)
      box.removeEventListener('drop', onDrop)
      origin.dispose()
      gizmo.detach()
      gizmo.dispose()
      orbit.dispose()
      grid.geometry.dispose()
      ;(grid.material as THREE.Material).dispose()
      for (const mesh of [head, body]) {
        mesh.geometry.dispose()
        mesh.material.dispose()
      }
      arrow.dispose()
      stage.dispose()
      renderer.dispose()
      renderer.forceContextLoss()
      canvas.remove()
    }
  }, [])

  return (
    <div ref={wrap} className="relative h-full w-full overflow-hidden rounded-lg bg-[#0b0d12]" data-xr-viewport={view} data-xr-loading={status.loading}>
      {failed && <p className="absolute inset-0 flex items-center justify-center px-6 text-center text-xs text-white/50">{failed}</p>}
      {status.loading > 0 && (
        <span className="pointer-events-none absolute top-2 left-2 flex items-center gap-1.5 rounded-md bg-black/60 px-2 py-1 text-[10px] text-white/70">
          <span className="h-3 w-3 animate-spin rounded-full border border-white/20 border-t-white/80" />
          載入中…
        </span>
      )}
      {status.errors.length > 0 && (
        <p className="pointer-events-none absolute inset-x-2 bottom-2 rounded-md bg-black/75 px-2 py-1.5 text-[11px] leading-relaxed text-red-300" data-xr-error>
          {status.errors.join('；')}
        </p>
      )}
    </div>
  )
}
