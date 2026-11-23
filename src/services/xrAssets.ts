/*
 * XR asset pipeline: 3D models (.glb / .gltf, Draco and Meshopt compressed ones included) and 360° panoramas
 * (equirectangular picture or video), read from Cloudflare R2 through this server.
 *
 * Everything is cached by address and reference counted:
 *   · STANDBY — the audience page takes a lease on the next XR cue's files (hooks/useXrPreload.ts), so they
 *     download and parse in the background;
 *   · GO — the player takes its own leases and finds the files already there, so the picture is up at once;
 *   · STOP / the next picture — the player lets go; when nobody holds a file any more its geometries,
 *     materials and textures are disposed (after a short grace, so a hand-over from preload to player or a
 *     quick re-fire doesn't download it twice). That is what keeps a phone's WebGL memory from piling up.
 */
import * as THREE from 'three'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { apiUrl, setSrcAsIs } from './apiBase'

export interface ModelAsset {
  /** The parsed model. Never added to a scene itself: users clone it (clones share its geometries and textures). */
  scene: THREE.Object3D
  animations: THREE.AnimationClip[]
}

export interface PanoAsset {
  texture: THREE.Texture
  /** The playing element of a panorama video (muted; the player keeps it on the show clock). */
  video: HTMLVideoElement | null
}

export interface Lease<T> {
  promise: Promise<T>
  release: () => void
}

interface Entry {
  promise: Promise<unknown>
  refs: number
  timer: number | null
  dispose: (value: never) => void
}

/** How long an unused file stays in memory before it is disposed. */
const GRACE_MS = 4000
const cache = new Map<string, Entry>()

function acquire<T>(key: string, load: () => Promise<T>, dispose: (value: T) => void): Lease<T> {
  let entry = cache.get(key)
  if (!entry) {
    const created: Entry = { promise: load(), refs: 0, timer: null, dispose: dispose as (value: never) => void }
    // A failed download isn't kept: the next cue (or a retry) starts over.
    created.promise.catch(() => cache.get(key) === created && cache.delete(key))
    cache.set(key, created)
    entry = created
  }
  const held = entry
  if (held.timer != null) {
    window.clearTimeout(held.timer)
    held.timer = null
  }
  held.refs++
  let released = false
  return {
    promise: held.promise as Promise<T>,
    release() {
      if (released) return
      released = true
      if (--held.refs > 0) return
      held.timer = window.setTimeout(() => {
        if (cache.get(key) === held) cache.delete(key)
        held.promise.then(held.dispose as (value: unknown) => void, () => {})
      }, GRACE_MS)
    },
  }
}

/** For tests and diagnostics: what is currently held, and by how many users. */
export const xrCacheStats = () => [...cache.entries()].map(([key, e]) => ({ key, refs: e.refs }))

/**
 * Where to read a file from, in order. Normally just its address (sent to the Worker on the hosted build).
 * On the dev server an R2 file is first read through the dev server itself — the same origin as the page — so
 * it also loads on a phone that opened the page by its LAN address: WebGL may only use files it is allowed
 * to read cross-origin, and the Worker only allows the known site origins.
 */
function sources(url: string): string[] {
  const remote = apiUrl(url)
  return import.meta.env.DEV && url.startsWith('/api/r2/') && remote !== url ? [url, remote] : [remote]
}

async function firstThatLoads<T>(url: string, load: (address: string) => Promise<T>): Promise<T> {
  let failure: unknown
  for (const address of sources(url)) {
    try {
      return await load(address)
    } catch (err) {
      failure = err
    }
  }
  throw failure
}

/* ---------- models ---------- */

let gltf: GLTFLoader | null = null
function gltfLoader() {
  if (!gltf) {
    // Draco's decoder (wasm + a small wrapper) is served from /draco/ and runs in workers.
    const draco = new DRACOLoader().setDecoderPath(`${import.meta.env.BASE_URL}draco/`)
    draco.setWorkerLimit(2)
    gltf = new GLTFLoader().setDRACOLoader(draco).setMeshoptDecoder(MeshoptDecoder)
  }
  return gltf
}

function disposeMaterial(material: THREE.Material) {
  for (const value of Object.values(material)) {
    if (value instanceof THREE.Texture) {
      value.dispose()
      // GLTF textures are ImageBitmaps: free the decoded pixels too.
      ;(value.source?.data as { close?: () => void } | null)?.close?.()
    }
  }
  material.dispose()
}

/** Free the GPU memory of everything under `root` (geometries, materials, their textures, skeletons). */
export function disposeObject(root: THREE.Object3D) {
  root.traverse((node) => {
    const mesh = node as THREE.Mesh
    mesh.geometry?.dispose()
    const material = mesh.material
    if (Array.isArray(material)) material.forEach(disposeMaterial)
    else if (material) disposeMaterial(material)
    ;(node as THREE.SkinnedMesh).skeleton?.dispose()
  })
}

export function acquireModel(url: string): Lease<ModelAsset> {
  return acquire<ModelAsset>(
    `model:${url}`,
    async () => {
      let loaded
      try {
        loaded = await firstThatLoads(url, (address) => gltfLoader().loadAsync(address))
      } catch (err) {
        // A .gltf usually points at a .bin and textures next to it; uploads are stored one file at a time.
        const hint = /\.gltf(?:$|[?#])/i.test(url) ? '。.gltf 需要同資料夾的 .bin 與貼圖檔，上傳後找不到它們：請改用單一檔案的 .glb' : ''
        throw new Error(`無法載入 3D 模型（${fileName(url)}）：${(err as Error).message || '檔案不存在或格式不支援'}${hint}`)
      }
      // Skinned meshes are culled by their bind pose, which is wrong once they animate.
      loaded.scene.traverse((node) => {
        if ((node as THREE.SkinnedMesh).isSkinnedMesh) node.frustumCulled = false
      })
      return { scene: loaded.scene, animations: loaded.animations }
    },
    (asset) => disposeObject(asset.scene),
  )
}

/* ---------- panoramas ---------- */

const coarse = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
const fileName = (url: string) => decodeURIComponent(url.split(/[?#]/)[0].split('/').pop() ?? url).replace(/^[0-9a-z]{6,10}-/, '')

async function loadPanoImage(url: string): Promise<PanoAsset> {
  let image: HTMLImageElement
  try {
    image = await firstThatLoads(
      url,
      (address) =>
        new Promise<HTMLImageElement>((resolve, reject) => {
          const img = new Image()
          img.crossOrigin = 'anonymous'
          img.onload = () => resolve(img)
          img.onerror = () => reject(new Error('load failed'))
          setSrcAsIs(img, address)
        }),
    )
  } catch {
    throw new Error(`無法載入全景圖（${fileName(url)}）`)
  }
  // Phones can't hold an 8K texture (and many refuse anything over 4096 px): scale it down once, here.
  const limit = coarse() ? 4096 : 8192
  let source: HTMLImageElement | HTMLCanvasElement = image
  if (image.naturalWidth > limit) {
    const canvas = document.createElement('canvas')
    canvas.width = limit
    canvas.height = Math.round((image.naturalHeight / image.naturalWidth) * limit)
    canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height)
    source = canvas
  }
  const texture = new THREE.Texture(source)
  texture.colorSpace = THREE.SRGBColorSpace
  // No mipmaps: a third less memory, and no seam where the picture wraps around.
  texture.generateMipmaps = false
  texture.minFilter = THREE.LinearFilter
  texture.needsUpdate = true
  return { texture, video: null }
}

function loadPanoVideo(url: string): Promise<PanoAsset> {
  return firstThatLoads(
    url,
    (address) =>
      new Promise<PanoAsset>((resolve, reject) => {
        const video = document.createElement('video')
        video.crossOrigin = 'anonymous'
        // Silent: sound belongs to an AUDIO cue (the audio engine keeps every phone in sync and gesture-unlocked).
        video.muted = true
        video.playsInline = true
        video.setAttribute('playsinline', '')
        video.preload = 'auto'
        let settled = false
        const ready = () => {
          if (settled) return
          settled = true
          window.clearTimeout(timer)
          const texture = new THREE.VideoTexture(video)
          texture.colorSpace = THREE.SRGBColorSpace
          resolve({ texture, video })
        }
        // iPhones don't buffer before play(): knowing the length is enough to start in sync.
        video.addEventListener('loadedmetadata', ready, { once: true })
        video.addEventListener(
          'error',
          () => {
            if (settled) return
            settled = true
            window.clearTimeout(timer)
            reject(new Error(`無法載入影片（${fileName(url)}）`))
          },
          { once: true },
        )
        const timer = window.setTimeout(ready, 15_000)
        setSrcAsIs(video, address)
        video.load()
      }),
  )
}

/**
 * `scope`: a panorama video is one playing element, so users that run on different clocks (the show and the
 * cue editor) each get their own; everything on the show clock shares one.
 */
export function acquirePano(url: string, kind: 'image' | 'video', scope = 'show'): Lease<PanoAsset> {
  return acquire<PanoAsset>(
    kind === 'video' ? `pano-video:${scope}:${url}` : `pano:${url}`,
    () => (kind === 'video' ? loadPanoVideo(url) : loadPanoImage(url)),
    (asset) => {
      asset.texture.dispose()
      if (asset.video) {
        asset.video.pause()
        asset.video.removeAttribute('src')
        asset.video.load()
      }
    },
  )
}
