/*
 * The Three.js scene of one XR cue (types/xr.ts): panorama sphere, the object tree (models, picture / video
 * screens, groups) with materials, animation and timeline, lights and the audience's camera rig. Shared by
 * the cue editor's viewport and the audience / Stage player, so what is edited is exactly what plays.
 *
 * The host owns the WebGLRenderer and the frame loop; this class owns the scene graph and the asset leases
 * (services/xrAssets.ts) and gives every one of them back in dispose().
 */
import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js'
import { animationTime, isDefaultMaterial, kelvinToRgb, lightDirection, panoVideoTime, xrMovedPosition, xrOnStage, xrPlayable, xrShowsPano, type XrObject, type XrScene } from '../types/xr'
import { acquireModel, acquirePano, type Lease, type ModelAsset, type PanoAsset } from './xrAssets'

export interface XrStatus {
  /** Files still downloading / parsing. */
  loading: number
  /** What failed to load (messages for the operator). */
  errors: string[]
}

interface Node {
  object: XrObject
  /** Carries the object's position / rotation / scale; its content and its children hang underneath. */
  root: THREE.Group
  lease: Lease<ModelAsset> | Lease<PanoAsset> | null
  /** The loaded model clone, or the screen's plane. */
  body: THREE.Object3D | null
  video: HTMLVideoElement | null
  clips: THREE.AnimationClip[]
  mixer: THREE.AnimationMixer | null
  action: THREE.AnimationAction | null
  clip: THREE.AnimationClip | null
  /** Materials this node owns (cloned so a tint never leaks to other placements of the same model). */
  owned: THREE.Material[]
  materialKey: string
  // — what interactions changed while playing —
  /** Shown / hidden by a viewer's interaction (null = as the scene says). */
  toggled: boolean | null
  /** A clip started by an interaction, and when (seconds into the cue). */
  played: { clip: string; at: number } | null
}

const rad = THREE.MathUtils.degToRad
const PANO_RADIUS = 50
/** One unit square for every picture / video screen (scaled to the picture's shape). */
const SCREEN_GEOMETRY = new THREE.PlaneGeometry(1, 1)

export class XrStage {
  readonly scene = new THREE.Scene()
  /** Turns the audience towards the initial view; the camera (or the headset) moves inside it. */
  readonly rig = new THREE.Group()
  readonly camera = new THREE.PerspectiveCamera(70, 1, 0.05, 2000)
  /** Parent of every placed object. */
  readonly content = new THREE.Group()
  private readonly ambient = new THREE.AmbientLight()
  private readonly sun = new THREE.DirectionalLight()
  private readonly panoMesh: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>
  private readonly nodes = new Map<string, Node>()
  private pano: { key: string; lease: Lease<PanoAsset>; asset: PanoAsset | null } | null = null
  private environment: THREE.Texture | null = null
  private current: XrScene | null = null
  private loading = 0
  private errors = new Map<string, string>()
  private disposed = false
  private readonly editor: boolean
  private readonly videoScope: string
  private readonly transparentPassthrough: boolean
  private readonly onStatus?: (status: XrStatus) => void
  private readonly onModel?: (id: string) => void

  constructor(
    opts: {
      /**
       * The cue editor: every object is loaded and shown as placed (hidden ones can be switched back on, the
       * timeline doesn't hide or move anything), and passthrough gets a backdrop.
       */
      editor?: boolean
      /** Which clock a video runs on (see acquirePano). */
      videoScope?: string
      /** Passthrough scenes render on a transparent canvas (the camera picture shows through). */
      transparentPassthrough?: boolean
      onStatus?: (status: XrStatus) => void
      /** An object finished loading (its clips and size are now known). */
      onModel?: (id: string) => void
    } = {},
  ) {
    this.editor = !!opts.editor
    this.videoScope = opts.videoScope ?? 'show'
    this.transparentPassthrough = opts.transparentPassthrough ?? !opts.editor
    this.onStatus = opts.onStatus
    this.onModel = opts.onModel

    this.camera.rotation.order = 'YXZ'
    this.rig.add(this.camera)
    this.scene.add(this.rig, this.content, this.ambient, this.sun, this.sun.target)

    // Seen from inside: flip the sphere so its inner face is the front face and the picture isn't mirrored.
    const geometry = new THREE.SphereGeometry(PANO_RADIUS, 64, 40)
    geometry.scale(-1, 1, 1)
    this.panoMesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ depthTest: false, depthWrite: false, toneMapped: false }))
    this.panoMesh.renderOrder = -1
    this.panoMesh.frustumCulled = false
    this.panoMesh.visible = false
    this.scene.add(this.panoMesh)
  }

  /** Image-based lighting for PBR materials (metal looks black without it). Call once with the host's renderer. */
  attachRenderer(renderer: THREE.WebGLRenderer) {
    if (this.environment || this.disposed) return
    const pmrem = new THREE.PMREMGenerator(renderer)
    const room = new RoomEnvironment()
    this.environment = pmrem.fromScene(room, 0.04).texture
    room.dispose()
    pmrem.dispose()
    this.scene.environment = this.environment
  }

  /** Bring the scene graph in line with `scene` (cheap when little changed: only differences are touched). */
  apply(scene: XrScene) {
    if (this.disposed) return
    this.current = scene

    // — objects —
    const wanted = new Map((this.editor ? scene.objects : xrPlayable(scene)).map((o) => [o.id, o]))
    for (const [id, node] of this.nodes) {
      const next = wanted.get(id)
      if (!next || next.url !== node.object.url || next.kind !== node.object.kind) this.removeNode(id)
    }
    for (const object of wanted.values()) {
      const node = this.nodes.get(object.id) ?? this.addNode(object)
      const previous = node.object
      node.object = object
      node.root.position.set(object.position.x, object.position.y, object.position.z)
      node.root.rotation.set(rad(object.rotation.x), rad(object.rotation.y), rad(object.rotation.z), 'XYZ')
      node.root.scale.set(object.scale.x, object.scale.y, object.scale.z)
      node.root.visible = object.visible
      if (node.body && previous.animation !== object.animation) this.setAnimation(node)
      if (node.body) this.applyMaterial(node)
    }
    // Parent / child: each holder hangs under its parent's holder (or the scene).
    for (const node of this.nodes.values()) {
      const parent = (node.object.parentId && this.nodes.get(node.object.parentId)?.root) || this.content
      if (node.root.parent !== parent) parent.add(node.root)
    }

    // — panorama —
    const showPano = xrShowsPano(scene)
    const panoKey = showPano ? `${scene.pano.kind}:${scene.pano.url}` : ''
    if ((this.pano?.key ?? '') !== panoKey) {
      this.dropPano()
      if (showPano) this.loadPano(scene.pano.url, scene.pano.kind, panoKey)
    }
    // The picture's centre is "ahead" (−Z); yaw turns the whole panorama to the right.
    this.panoMesh.rotation.y = -Math.PI / 2 - rad(scene.pano.yaw)
    this.panoMesh.visible = showPano && !!this.pano?.asset

    // — backdrop —
    const passthrough = scene.mode === 'mr_passthrough'
    this.scene.background = passthrough && this.transparentPassthrough ? null : new THREE.Color(passthrough ? '#14171d' : scene.background)

    // — lights —
    const [ar, ag, ab] = kelvinToRgb(scene.ambient.kelvin)
    this.ambient.color.setRGB(ar, ag, ab, THREE.SRGBColorSpace)
    this.ambient.intensity = scene.ambient.intensity
    this.scene.environmentIntensity = Math.min(1.5, scene.ambient.intensity) * 0.6
    const [dr, dg, db] = kelvinToRgb(scene.directional.kelvin)
    this.sun.color.setRGB(dr, dg, db, THREE.SRGBColorSpace)
    this.sun.intensity = scene.directional.intensity
    const from = lightDirection(scene.directional.azimuth, scene.directional.elevation)
    this.sun.position.set(from.x * 20, from.y * 20, from.z * 20)

    // — camera —
    this.camera.position.set(0, scene.camera.height, 0)
    if (this.camera.fov !== scene.camera.fov) {
      this.camera.fov = scene.camera.fov
      this.camera.updateProjectionMatrix()
    }
  }

  /**
   * Point the Magic Window: the scene's initial view plus what the viewer added by dragging.
   * With `device` (a gyroscope reading, already offset so that "ahead" is the initial view) the phone itself
   * aims the camera and dragging only turns left / right.
   */
  look(extraYaw: number, extraPitch: number, device: THREE.Quaternion | null = null, deviceYaw0 = 0) {
    const scene = this.current
    if (!scene) return
    if (device) {
      this.rig.rotation.set(0, -rad(scene.camera.yaw + extraYaw) - deviceYaw0, 0)
      this.camera.quaternion.copy(device)
    } else {
      this.rig.rotation.set(0, -rad(scene.camera.yaw + extraYaw), 0)
      this.camera.rotation.set(rad(THREE.MathUtils.clamp(scene.camera.pitch + extraPitch, -89, 89)), 0, 0, 'YXZ')
    }
  }

  /**
   * Per frame: put animations, videos and (when playing) the timeline where they belong `elapsed` seconds
   * into the cue. Everything follows that one clock, so every device shows the same moment and a paused show
   * stands still. `viewer`: the camera that renders (the panorama stays centred on it, also inside a headset).
   */
  update(elapsed: number, paused: boolean, viewer: THREE.Camera = this.camera) {
    for (const node of this.nodes.values()) {
      const { object } = node
      if (!this.editor) {
        // Timeline: appear / disappear and glide, unless a viewer's interaction switched the object.
        node.root.visible = node.toggled ?? (object.visible && xrOnStage(object.timeline, elapsed))
        const at = xrMovedPosition(object.position, object.timeline, elapsed)
        node.root.position.set(at.x, at.y, at.z)
      }
      if (node.mixer && node.action && node.clip) {
        const since = node.played ? elapsed - node.played.at : elapsed - (this.editor ? 0 : object.timeline.animationAt)
        node.action.time = animationTime(since, node.clip.duration, node.played ? 'once' : object.animationLoop, object.animationSpeed)
        node.mixer.update(0)
      }
      if (node.video) this.syncVideo(node.video, elapsed - (this.editor ? 0 : object.timeline.showAt), object.animationLoop !== 'once', paused || !node.root.visible)
    }
    const video = this.pano?.asset?.video
    if (video && this.current) this.syncVideo(video, elapsed, this.current.pano.loop, paused)
    if (this.panoMesh.visible) viewer.getWorldPosition(this.panoMesh.position)
  }

  /**
   * AR placement: stand the whole scene on a point of the real floor. The scene keeps its own layout (relative
   * positions, rotations, scales); its footprint centre goes to `anchor`, turned by `yaw` so that what faced
   * the audience still does, grown by `scale` (0 → 1 for the entrance). null = as authored (audience at the origin).
   */
  place(placement: { anchor: THREE.Vector3; yaw: number; scale: number } | null) {
    if (!placement) {
      this.content.position.set(0, 0, 0)
      this.content.rotation.set(0, 0, 0)
      this.content.scale.setScalar(1)
      return
    }
    // Footprint centre: the middle of the top-level objects, on the floor.
    const tops = (this.current?.objects ?? []).filter((o) => !o.parentId)
    const pivot = new THREE.Vector3()
    for (const o of tops) pivot.add(new THREE.Vector3(o.position.x, 0, o.position.z))
    if (tops.length) pivot.divideScalar(tops.length)
    this.content.rotation.set(0, placement.yaw, 0)
    this.content.scale.setScalar(placement.scale)
    this.content.position.copy(placement.anchor).sub(pivot.applyAxisAngle(THREE.Object3D.DEFAULT_UP, placement.yaw).multiplyScalar(placement.scale))
  }

  /** Hide / show every placed object at once (they stay loaded). */
  setContentVisible(visible: boolean) {
    this.content.visible = visible
  }

  /** Interaction: show / hide an object on this device (until the cue ends). Returns whether it is now shown. */
  toggle(id: string): boolean {
    const node = this.nodes.get(id)
    if (!node) return false
    node.toggled = !node.root.visible
    node.root.visible = node.toggled
    return node.toggled
  }

  /** Interaction: play one of the object's clips once, starting now (`elapsed` seconds into the cue). */
  playClip(id: string, clip: string, elapsed: number) {
    const node = this.nodes.get(id)
    if (!node?.body || !node.clips.some((c) => c.name === clip)) return
    node.played = { clip, at: elapsed }
    this.setAnimation(node)
  }

  /** The transform holder of an object (what a gizmo attaches to). */
  rootOf(id: string): THREE.Group | null {
    return this.nodes.get(id)?.root ?? null
  }

  /** Animation clip names of a loaded model. */
  clipsOf(id: string): string[] {
    return this.nodes.get(id)?.clips.map((c) => c.name) ?? []
  }

  /** Which object owns this mesh (for click-to-select and interactions): the nearest one up the tree, or null. */
  objectAt(hit: THREE.Object3D): string | null {
    for (let node: THREE.Object3D | null = hit; node; node = node.parent) {
      const id = node.userData.xrObjectId as string | undefined
      if (id) return id
    }
    return null
  }

  /** The object under a ray, skipping anything hidden (itself or through a parent). */
  pick(raycaster: THREE.Raycaster): { id: string; point: THREE.Vector3 } | null {
    for (const hit of raycaster.intersectObjects(this.content.children, true)) {
      let shown = true
      for (let node: THREE.Object3D | null = hit.object; node && node !== this.content; node = node.parent) if (!node.visible) shown = false
      const id = shown ? this.objectAt(hit.object) : null
      if (id) return { id, point: hit.point }
    }
    return null
  }

  status(): XrStatus {
    return { loading: this.loading, errors: [...this.errors.values()] }
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const id of [...this.nodes.keys()]) this.removeNode(id)
    this.dropPano()
    // The sphere and the environment map belong to this stage alone; models and pictures are shared (leases).
    this.panoMesh.geometry.dispose()
    this.panoMesh.material.dispose()
    this.environment?.dispose()
    this.scene.environment = null
    this.scene.clear()
  }

  private report() {
    this.onStatus?.(this.status())
  }

  private syncVideo(video: HTMLVideoElement, elapsed: number, loop: boolean, paused: boolean) {
    const target = panoVideoTime(elapsed, video.duration, loop)
    // Seeking stutters: only correct real drift.
    if (video.readyState >= 1 && Math.abs(video.currentTime - target) > (paused ? 0.05 : 0.6)) video.currentTime = target
    const ended = !loop && video.duration > 0 && elapsed >= video.duration
    if (paused || ended || elapsed < 0) {
      if (!video.paused) video.pause()
    } else if (video.paused) video.play().catch(() => {})
  }

  private addNode(object: XrObject): Node {
    const root = new THREE.Group()
    root.userData.xrObjectId = object.id
    this.content.add(root)
    const node: Node = { object, root, lease: null, body: null, video: null, clips: [], mixer: null, action: null, clip: null, owned: [], materialKey: '', toggled: null, played: null }
    this.nodes.set(object.id, node)
    if (object.kind === 'group' || !object.url) return node

    const live = () => !this.disposed && this.nodes.get(object.id) === node
    const failed = (err: Error) => {
      if (!live()) return
      this.loading--
      this.errors.set(`object:${object.id}`, err.message)
      this.report()
    }
    this.loading++
    if (object.kind === 'model') {
      const lease = acquireModel(object.url)
      node.lease = lease
      lease.promise.then((asset) => {
        if (!live()) return
        this.loading--
        // A clone per placement (the same model may stand in several places); skinned meshes need their own skeleton.
        node.body = cloneSkinned(asset.scene)
        node.clips = asset.animations
        root.add(node.body)
        this.setAnimation(node)
        this.applyMaterial(node)
        this.report()
        this.onModel?.(object.id)
      }, failed)
    } else {
      // A picture or video on a flat screen, 1 m wide, as tall as the picture's shape asks.
      const lease = acquirePano(object.url, object.kind, this.videoScope)
      node.lease = lease
      lease.promise.then((asset) => {
        if (!live()) return
        this.loading--
        const material = new THREE.MeshBasicMaterial({ map: asset.texture, side: THREE.DoubleSide, transparent: true, toneMapped: false })
        node.owned.push(material)
        const plane = new THREE.Mesh(SCREEN_GEOMETRY, material)
        const image = asset.texture.image as { width?: number; height?: number; videoWidth?: number; videoHeight?: number } | null
        const w = image?.videoWidth || image?.width || 16
        const h = image?.videoHeight || image?.height || 9
        plane.scale.set(1, h / w, 1)
        node.body = plane
        node.video = asset.video
        // A video that only now learns its size takes its real shape then.
        asset.video?.addEventListener('loadedmetadata', () => asset.video && asset.video.videoWidth > 0 && plane.scale.set(1, asset.video.videoHeight / asset.video.videoWidth, 1), { once: true })
        root.add(plane)
        this.applyMaterial(node)
        this.report()
        this.onModel?.(object.id)
      }, failed)
    }
    this.report()
    return node
  }

  private removeNode(id: string) {
    const node = this.nodes.get(id)
    if (!node) return
    this.nodes.delete(id)
    if (node.lease && !node.body && !this.errors.has(`object:${id}`)) this.loading = Math.max(0, this.loading - 1)
    this.errors.delete(`object:${id}`)
    node.mixer?.stopAllAction()
    if (node.body) node.mixer?.uncacheRoot(node.body)
    node.video?.pause()
    // Children outlive their parent here (apply() puts them where they belong, or removes them too).
    for (const child of [...node.root.children]) if (child.userData.xrObjectId) this.content.add(child)
    node.root.removeFromParent()
    // Only this node's own materials; geometries and textures belong to the shared asset (freed with the lease).
    node.owned.forEach((m) => m.dispose())
    node.lease?.release()
    this.report()
  }

  /** Opacity, tint, metalness and roughness on top of the model's own materials. */
  private applyMaterial(node: Node) {
    const m = node.object.material
    const key = `${m.opacity}|${m.color}|${m.metalness}|${m.roughness}`
    if (!node.body || key === node.materialKey) return
    node.materialKey = key
    if (node.object.kind !== 'model') {
      const material = (node.body as THREE.Mesh).material as THREE.MeshBasicMaterial
      material.color.set(m.color)
      material.opacity = m.opacity
      return
    }
    // Untouched models keep sharing the asset's materials.
    if (isDefaultMaterial(m) && node.owned.length === 0) return
    const tint = new THREE.Color(m.color)
    node.body.traverse((child) => {
      const mesh = child as THREE.Mesh
      if (!mesh.isMesh) return
      const base = (mesh.userData.xrBase ??= mesh.material) as THREE.Material | THREE.Material[]
      if (!mesh.userData.xrOwn) {
        const own = Array.isArray(base) ? base.map((b) => b.clone()) : base.clone()
        mesh.userData.xrOwn = own
        mesh.material = own
        node.owned.push(...(Array.isArray(own) ? own : [own]))
      }
      const owns = mesh.userData.xrOwn as THREE.Material | THREE.Material[]
      const pairs = Array.isArray(owns) ? owns.map((o, i) => [o, (base as THREE.Material[])[i]] as const) : [[owns, base as THREE.Material] as const]
      for (const [own, original] of pairs) {
        const o = own as THREE.MeshStandardMaterial
        const b = original as THREE.MeshStandardMaterial
        if (o.color && b.color) o.color.copy(b.color).multiply(tint)
        o.opacity = b.opacity * m.opacity
        o.transparent = b.transparent || m.opacity < 1
        o.depthWrite = m.opacity < 1 ? false : b.depthWrite
        if (typeof b.metalness === 'number') o.metalness = m.metalness ?? b.metalness
        if (typeof b.roughness === 'number') o.roughness = m.roughness ?? b.roughness
        o.needsUpdate = true
      }
    })
  }

  private setAnimation(node: Node) {
    node.mixer?.stopAllAction()
    node.action = null
    node.clip = null
    if (!node.body || node.object.kind !== 'model') return
    const name = node.played?.clip ?? node.object.animation
    const clip = name ? (node.clips.find((c) => c.name === name) ?? null) : null
    if (!clip) {
      // Back to the pose the model was authored in.
      if (node.mixer) {
        node.mixer.uncacheRoot(node.body)
        node.mixer = null
      }
      return
    }
    node.mixer ??= new THREE.AnimationMixer(node.body)
    node.clip = clip
    // The clip's position is set from the show clock every frame (update()), so the mixer never advances by itself.
    node.action = node.mixer.clipAction(clip)
    node.action.setLoop(THREE.LoopRepeat, Infinity)
    node.action.play()
  }

  private loadPano(url: string, kind: 'image' | 'video', key: string) {
    const lease = acquirePano(url, kind, this.videoScope)
    const pano: NonNullable<XrStage['pano']> = { key, lease, asset: null }
    this.pano = pano
    this.loading++
    this.errors.delete('pano')
    lease.promise.then(
      (asset) => {
        if (this.disposed || this.pano !== pano) return
        this.loading--
        pano.asset = asset
        this.panoMesh.material.map = asset.texture
        this.panoMesh.material.needsUpdate = true
        this.panoMesh.visible = !!this.current && xrShowsPano(this.current)
        this.report()
      },
      (err: Error) => {
        if (this.disposed || this.pano !== pano) return
        this.loading--
        this.errors.set('pano', err.message)
        this.report()
      },
    )
    this.report()
  }

  private dropPano() {
    const pano = this.pano
    if (!pano) return
    this.pano = null
    if (!pano.asset && !this.errors.has('pano')) this.loading = Math.max(0, this.loading - 1)
    this.errors.delete('pano')
    pano.asset?.video?.pause()
    this.panoMesh.material.map = null
    this.panoMesh.material.needsUpdate = true
    this.panoMesh.visible = false
    pano.lease.release()
    this.report()
  }
}
