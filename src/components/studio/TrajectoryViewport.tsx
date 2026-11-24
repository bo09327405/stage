import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { buildPath, type TrajectoryPath } from '../../studio/trajectoryPath'
import { TRAJ_LIMIT, decimateStroke, type TrajectoryConfig, type TrajVec3 } from '../../types/trajectory'

export type TrajView = 'top' | 'side' | 'persp'
/** edit: drag waypoints · draw: hold and drag to record a free-hand path. */
export type TrajTool = 'edit' | 'draw'

/** A sound dot shown on the path: the selected track and any tracks following the same path. */
export interface TrajDot {
  color: string
  cfg: TrajectoryConfig
}

const RING_RADII = [1, 2, 4, 8, 16, 32]
const ORTHO_HALF = 7
const clampTo = (v: number) => Math.max(-TRAJ_LIMIT, Math.min(TRAJ_LIMIT, v))

/**
 * The sound-stage viewport: the listener at the centre (nose = the direction they face, −Z), distance rings and a
 * 3D grid, the track's spline with draggable waypoints and the moving sound dot. Top (XZ), side (YZ) and 3D views.
 * Drawing and dragging map the pointer onto a plane of the current view, so the same gesture edits what that view shows.
 */
export function TrajectoryViewport({
  config,
  view,
  tool,
  selected,
  drawHeight,
  dots,
  getTime,
  scrub,
  onSelect,
  onWaypoints,
}: {
  config: TrajectoryConfig
  view: TrajView
  tool: TrajTool
  selected: number | null
  /** Height (Y) a free-hand stroke is drawn at in the top and 3D views. */
  drawHeight: number
  dots: TrajDot[]
  /** Seconds on the path clock right now, or null when nothing is playing (the dot then shows `scrub`). */
  getTime: () => number | null
  /** 0–1 position of the dot while nothing plays. */
  scrub: number
  onSelect: (index: number | null) => void
  /** New control points; `final` is false while the gesture is still going (listen, don't save yet). */
  onWaypoints: (waypoints: TrajVec3[], final: boolean, kind: 'move' | 'draw') => void
}) {
  const wrap = useRef<HTMLDivElement>(null)
  const latest = useRef({ config, view, tool, selected, drawHeight, dots, getTime, scrub, onSelect, onWaypoints })
  useEffect(() => {
    latest.current = { config, view, tool, selected, drawHeight, dots, getTime, scrub, onSelect, onWaypoints }
  })
  /** What the scene effect exposes to the prop-driven effects below. */
  const api = useRef<{ rebuild: () => void; setView: (fit: boolean) => void } | null>(null)

  useEffect(() => {
    const host = wrap.current
    if (!host) return
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
    renderer.setClearColor(0x0d0d10)
    const canvas = renderer.domElement
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;touch-action:none;display:block'
    host.appendChild(canvas)

    const scene = new THREE.Scene()
    const persp = new THREE.PerspectiveCamera(50, 1, 0.05, 400)
    persp.position.set(6, 5, 8)
    persp.lookAt(0, 0, 0)
    const top = new THREE.OrthographicCamera(-ORTHO_HALF, ORTHO_HALF, ORTHO_HALF, -ORTHO_HALF, 0.1, 400)
    top.up.set(0, 0, -1)
    top.position.set(0, 100, 0)
    top.lookAt(0, 0, 0)
    const side = new THREE.OrthographicCamera(-ORTHO_HALF, ORTHO_HALF, ORTHO_HALF, -ORTHO_HALF, 0.1, 400)
    side.position.set(100, 0, 0)
    side.lookAt(0, 0, 0)
    const cams = { persp, top, side }

    /* ---------- the stage: grids, rings, listener ---------- */
    const lineMat = (color: number, opacity: number) => new THREE.LineBasicMaterial({ color, transparent: true, opacity })
    const floor = new THREE.Group() // XZ plane: top + 3D
    const wall = new THREE.Group() // YZ plane: side
    const gridXZ = new THREE.GridHelper(64, 64, 0x3a3a44, 0x24242b)
    floor.add(gridXZ)
    const gridYZ = new THREE.GridHelper(64, 64, 0x3a3a44, 0x24242b)
    gridYZ.rotation.z = Math.PI / 2
    wall.add(gridYZ)
    const ring = (r: number) => {
      const pts: THREE.Vector3[] = []
      for (let i = 0; i <= 96; i++) pts.push(new THREE.Vector3(Math.sin((i / 96) * Math.PI * 2) * r, Math.cos((i / 96) * Math.PI * 2) * r, 0))
      return new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lineMat(0x6a6a7a, r === 1 || r === 4 || r === 16 ? 0.7 : 0.4))
    }
    for (const r of RING_RADII) {
      const a = ring(r)
      a.rotation.x = -Math.PI / 2 // flat on the floor
      floor.add(a)
      const b = ring(r)
      b.rotation.y = Math.PI / 2 // standing in the YZ plane
      wall.add(b)
    }
    const axes = new THREE.Group()
    const axis = (a: THREE.Vector3, b: THREE.Vector3, color: number) => axes.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), lineMat(color, 0.9)))
    axis(new THREE.Vector3(-40, 0, 0), new THREE.Vector3(40, 0, 0), 0x6b3030)
    axis(new THREE.Vector3(0, -40, 0), new THREE.Vector3(0, 40, 0), 0x306b3a)
    axis(new THREE.Vector3(0, 0, -40), new THREE.Vector3(0, 0, 40), 0x30456b)
    scene.add(floor, wall, axes)

    const listener = new THREE.Group()
    const skin = new THREE.MeshBasicMaterial({ color: 0xd8d8e0 })
    listener.add(new THREE.Mesh(new THREE.SphereGeometry(0.22, 24, 16), skin))
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.2, 16), new THREE.MeshBasicMaterial({ color: 0xff6b6b }))
    nose.rotation.x = -Math.PI / 2
    nose.position.z = -0.3
    listener.add(nose)
    for (const sx of [-1, 1]) {
      const ear = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 8), skin)
      ear.position.set(sx * 0.23, 0, 0)
      listener.add(ear)
    }
    scene.add(listener)

    /* ---------- the path, its handles, the sound dots ---------- */
    const pathGroup = new THREE.Group()
    const handleGeo = new THREE.SphereGeometry(1, 16, 12)
    const handles: THREE.Mesh[] = []
    const dotMeshes: THREE.Mesh[] = []
    const dotPaths: TrajectoryPath[] = []
    const strokeLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffd43b }))
    strokeLine.visible = false
    strokeLine.frustumCulled = false
    scene.add(pathGroup, strokeLine)
    const dispose = (g: THREE.Object3D) =>
      g.traverse((o) => {
        const m = o as THREE.Mesh
        if (m.geometry && m.geometry !== handleGeo) m.geometry.dispose()
        const mat = m.material as THREE.Material | undefined
        mat?.dispose()
      })

    const rebuild = () => {
      const { config: cfg, selected: sel, dots: ds } = latest.current
      for (const c of [...pathGroup.children]) {
        pathGroup.remove(c)
        dispose(c)
      }
      handles.length = 0
      if (cfg.pathType !== 'static' && cfg.waypoints.length >= 2) {
        const pts = buildPath(cfg)
          .sample(240)
          .map((p) => new THREE.Vector3(p.x, p.y, p.z))
        pathGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x0a84ff })))
      }
      // The control polygon, faint, so the handles read as a skeleton of the curve.
      if (cfg.pathType !== 'static' && cfg.waypoints.length >= 2) {
        const poly = cfg.waypoints.map((p) => new THREE.Vector3(p.x, p.y, p.z))
        if (cfg.closed) poly.push(poly[0].clone())
        pathGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(poly), lineMat(0x4dabf7, 0.25)))
      }
      cfg.waypoints.forEach((p, i) => {
        const m = new THREE.Mesh(handleGeo, new THREE.MeshBasicMaterial({ color: i === sel ? 0xffd43b : i === 0 ? 0x69db7c : 0xffffff }))
        m.position.set(p.x, p.y, p.z)
        pathGroup.add(m)
        handles.push(m)
      })
      for (const m of dotMeshes) {
        scene.remove(m)
        dispose(m)
      }
      dotMeshes.length = 0
      dotPaths.length = 0
      ds.forEach((d) => {
        const m = new THREE.Mesh(handleGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(d.color) }))
        m.renderOrder = 5
        scene.add(m)
        dotMeshes.push(m)
        dotPaths.push(buildPath(d.cfg))
      })
    }

    /* ---------- camera / view ---------- */
    const controls = {
      persp: new OrbitControls(persp, canvas),
      top: new OrbitControls(top, canvas),
      side: new OrbitControls(side, canvas),
    }
    for (const k of ['top', 'side'] as const) {
      controls[k].enableRotate = false
      controls[k].screenSpacePanning = true
    }
    for (const c of Object.values(controls)) {
      c.enableDamping = false
      c.minZoom = 0.15
      c.maxZoom = 12
    }
    controls.persp.minDistance = 1.5
    controls.persp.maxDistance = 120
    const setView = (fit: boolean) => {
      const { view: v, tool: t } = latest.current
      floor.visible = v !== 'side'
      wall.visible = v === 'side'
      for (const k of ['persp', 'top', 'side'] as const) controls[k].enabled = k === v && t !== 'draw'
      if (!fit) return
      // fit the stage into the view
      const far = Math.max(4, ...latest.current.config.waypoints.map((p) => Math.hypot(p.x, p.y, p.z)))
      if (v !== 'persp') {
        cams[v].zoom = Math.max(0.3, Math.min(4, ORTHO_HALF / (far * 1.25)))
        cams[v].updateProjectionMatrix()
      }
    }
    api.current = { rebuild, setView }

    const size = () => {
      const w = Math.max(10, host.clientWidth)
      const h = Math.max(10, host.clientHeight)
      renderer.setSize(w, h, false)
      const aspect = w / h
      persp.aspect = aspect
      persp.updateProjectionMatrix()
      for (const o of [top, side]) {
        o.left = -ORTHO_HALF * aspect
        o.right = ORTHO_HALF * aspect
        o.top = ORTHO_HALF
        o.bottom = -ORTHO_HALF
        o.updateProjectionMatrix()
      }
    }
    const ro = new ResizeObserver(size)
    ro.observe(host)
    size()

    /* ---------- pointer: drag waypoints, draw strokes ---------- */
    const ray = new THREE.Raycaster()
    const ndc = new THREE.Vector2()
    const activeCam = () => cams[latest.current.view]
    const setRay = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect()
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
      ray.setFromCamera(ndc, activeCam())
    }
    /** The pointer's point on the plane that suits the view: floor (top, 3D) or the YZ wall (side). */
    const hitPlane = (e: PointerEvent, through: TrajVec3, vertical: boolean): TrajVec3 | null => {
      setRay(e)
      const v = latest.current.view
      const normal =
        vertical && v === 'persp'
          ? new THREE.Vector3(persp.position.x, 0, persp.position.z).normalize()
          : v === 'side'
            ? new THREE.Vector3(1, 0, 0)
            : new THREE.Vector3(0, 1, 0)
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, new THREE.Vector3(through.x, through.y, through.z))
      const hit = ray.ray.intersectPlane(plane, new THREE.Vector3())
      return hit ? { x: hit.x, y: hit.y, z: hit.z } : null
    }
    const nearestHandle = (e: PointerEvent): number | null => {
      const r = canvas.getBoundingClientRect()
      const cam = activeCam()
      let best: number | null = null
      let bestD = 16 // px
      latest.current.config.waypoints.forEach((p, i) => {
        const s = new THREE.Vector3(p.x, p.y, p.z).project(cam)
        if (s.z > 1) return
        const d = Math.hypot(((s.x + 1) / 2) * r.width - (e.clientX - r.left), ((1 - s.y) / 2) * r.height - (e.clientY - r.top))
        if (d < bestD) {
          bestD = d
          best = i
        }
      })
      return best
    }

    let drag: { index: number; vertical: boolean } | null = null
    let stroke: TrajVec3[] | null = null
    const strokePoint = (e: PointerEvent): TrajVec3 | null => {
      const { view: v, drawHeight: h } = latest.current
      const p = hitPlane(e, { x: 0, y: h, z: 0 }, false)
      if (!p) return null
      return v === 'side' ? { x: 0, y: clampTo(p.y), z: clampTo(p.z) } : { x: clampTo(p.x), y: clampTo(h), z: clampTo(p.z) }
    }
    const drawStroke = () => {
      if (!stroke) return
      strokeLine.geometry.dispose()
      strokeLine.geometry = new THREE.BufferGeometry().setFromPoints(stroke.map((p) => new THREE.Vector3(p.x, p.y, p.z)))
      strokeLine.visible = stroke.length > 1
    }
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return
      const { tool: t, config: cfg } = latest.current
      if (t === 'draw') {
        const p = strokePoint(e)
        if (!p) return
        stroke = [p]
        canvas.setPointerCapture(e.pointerId)
        for (const c of Object.values(controls)) c.enabled = false
        return
      }
      const i = nearestHandle(e)
      if (i === null) {
        // A static sound is placed by clicking; a path is only deselected (the camera takes the drag).
        if (cfg.pathType === 'static') {
          const p = hitPlane(e, cfg.waypoints[0], false)
          if (p) {
            const from = cfg.waypoints[0]
            const to = latest.current.view === 'side' ? { x: from.x, y: clampTo(p.y), z: clampTo(p.z) } : { x: clampTo(p.x), y: from.y, z: clampTo(p.z) }
            latest.current.onWaypoints([to], false, 'move')
            drag = { index: 0, vertical: false }
            canvas.setPointerCapture(e.pointerId)
            for (const c of Object.values(controls)) c.enabled = false
            return
          }
        }
        latest.current.onSelect(null)
        return
      }
      latest.current.onSelect(i)
      drag = { index: i, vertical: e.shiftKey || e.altKey }
      canvas.setPointerCapture(e.pointerId)
      for (const c of Object.values(controls)) c.enabled = false
    }
    const onMove = (e: PointerEvent) => {
      if (stroke) {
        const p = strokePoint(e)
        if (p) {
          stroke.push(p)
          drawStroke()
        }
        return
      }
      if (!drag) return
      const cfg = latest.current.config
      const from = cfg.waypoints[drag.index]
      if (!from) return
      const p = hitPlane(e, from, drag.vertical)
      if (!p) return
      const v = latest.current.view
      const to: TrajVec3 =
        drag.vertical && v === 'persp'
          ? { x: from.x, y: clampTo(p.y), z: from.z }
          : v === 'side'
            ? { x: from.x, y: clampTo(p.y), z: clampTo(p.z) }
            : { x: clampTo(p.x), y: from.y, z: clampTo(p.z) }
      const next = cfg.waypoints.map((w, i) => (i === drag!.index ? to : w))
      latest.current.onWaypoints(next, false, 'move')
    }
    const onUp = (e: PointerEvent) => {
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId)
      if (stroke) {
        const s = decimateStroke(stroke)
        stroke = null
        strokeLine.visible = false
        if (s.length >= 2) latest.current.onWaypoints(s, true, 'draw')
      } else if (drag) {
        drag = null
        latest.current.onWaypoints(latest.current.config.waypoints, true, 'move')
      }
      setView(false) // controls.enabled follows the tool again
    }
    // Capture phase: runs before OrbitControls' own pointerdown, which then sees `enabled = false`.
    canvas.addEventListener('pointerdown', onDown, { capture: true })
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointercancel', onUp)

    /* ---------- render loop ---------- */
    let raf = 0
    const tmp = new THREE.Vector3()
    const frame = () => {
      raf = requestAnimationFrame(frame)
      const { view: v, getTime: clock, scrub: u, dots: ds } = latest.current
      const cam = cams[v]
      controls[v].update()
      // World size of one screen pixel at a point, so handles and dots keep a steady on-screen size.
      const px = (at: THREE.Vector3) =>
        cam instanceof THREE.OrthographicCamera
          ? (cam.top - cam.bottom) / cam.zoom / Math.max(1, canvas.clientHeight)
          : (2 * tmp.copy(at).sub(cam.position).length() * Math.tan(THREE.MathUtils.degToRad(persp.fov / 2))) / Math.max(1, canvas.clientHeight)
      for (const h of handles) h.scale.setScalar(px(h.position) * (h.material instanceof THREE.MeshBasicMaterial && h.material.color.getHex() === 0xffd43b ? 8 : 6))
      const t = clock()
      dotMeshes.forEach((m, i) => {
        const cfg = ds[i]?.cfg
        const path = dotPaths[i]
        if (!cfg || !path) return
        const p = t !== null ? path.at(t) : path.atProgress((u + cfg.playback.phaseOffset) % 1)
        m.position.set(p.x, p.y, p.z)
        m.scale.setScalar(px(m.position) * 8)
      })
      renderer.render(scene, cam)
    }
    frame()

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      canvas.removeEventListener('pointerdown', onDown, { capture: true })
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onUp)
      for (const c of Object.values(controls)) c.dispose()
      scene.traverse((o) => {
        const m = o as THREE.Mesh
        if (m.geometry && m.geometry !== handleGeo) m.geometry.dispose()
        const mat = m.material as THREE.Material | THREE.Material[] | undefined
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose())
        else mat?.dispose()
      })
      handleGeo.dispose()
      renderer.dispose()
      canvas.remove()
      api.current = null
    }
  }, [])

  // Path, handles or dots changed → rebuild their meshes; view or tool changed → re-aim the cameras / controls.
  useEffect(() => {
    api.current?.rebuild()
  }, [config, selected, dots])
  useEffect(() => {
    api.current?.setView(true)
  }, [view])
  useEffect(() => {
    api.current?.setView(false)
  }, [tool])

  return <div ref={wrap} className="relative h-full w-full overflow-hidden" data-traj-viewport data-view={view} data-tool={tool} />
}
