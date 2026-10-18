/*
 * Live person cut-out for video layers: the same small MediaPipe segmentation model as the still-picture cut-out,
 * run on the device for the current video frame. The result is a soft matte (a small canvas, red = person) that the
 * compositor multiplies into the layer's alpha — so the video file itself is never changed and the effect can be
 * switched off at any time. Updates at most ~20 times a second and smooths the edge between frames.
 */

type MPMask = { width: number; height: number; getAsFloat32Array: () => Float32Array; close?: () => void }
type VideoSegmenter = { segmentForVideo: (video: HTMLVideoElement, timestamp: number) => { confidenceMasks?: MPMask[]; close?: () => void } | void }

const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm'
let shared: Promise<VideoSegmenter> | null = null

function loadVideoSegmenter(): Promise<VideoSegmenter> {
  shared ??= (async () => {
    const { FilesetResolver, ImageSegmenter } = await import('@mediapipe/tasks-vision')
    const fileset = await FilesetResolver.forVisionTasks(WASM)
    return (await ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: `${import.meta.env.BASE_URL}models/selfie_segmenter.tflite` },
      runningMode: 'VIDEO',
      outputConfidenceMasks: true,
      outputCategoryMask: false,
    })) as unknown as VideoSegmenter
  })().catch((err) => {
    shared = null
    throw err
  })
  return shared
}

export interface VideoMatte {
  /** The matte; upload it as a texture every frame. */
  canvas: HTMLCanvasElement
  /** Segment the video's current frame (cheap to call every frame: it rate-limits itself). */
  update: (video: HTMLVideoElement) => void
  /** True once the model has produced a matte (until then nothing of the picture is shown through it). */
  ready: () => boolean
  failed: () => string | null
}

/** Soft threshold of the model's person probability → matte value (0.35 → 0, 0.65 → 1). */
export const matteValue = (p: number) => Math.min(1, Math.max(0, (p - 0.35) / 0.3))

export function createVideoMatte(): VideoMatte {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 2
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  let segmenter: VideoSegmenter | null = null
  let failure: string | null = null
  let produced = false
  let busy = false
  let lastRun = 0
  let lastTime = -1
  let previous: Float32Array | null = null

  loadVideoSegmenter().then(
    (s) => (segmenter = s),
    (err: Error) => (failure = `無法載入即時去背模型：${err.message}`),
  )

  return {
    canvas,
    ready: () => produced,
    failed: () => failure,
    update(video) {
      const now = performance.now()
      if (!segmenter || busy || now - lastRun < 50 || video.readyState < 2) return
      if (video.currentTime === lastTime && produced) return
      busy = true
      lastRun = now
      lastTime = video.currentTime
      try {
        const result = segmenter.segmentForVideo(video, now)
        const masks = result?.confidenceMasks ?? []
        const m = masks.length >= 2 ? masks[1] : masks[0]
        if (m) {
          const probs = m.getAsFloat32Array()
          if (canvas.width !== m.width || canvas.height !== m.height) {
            canvas.width = m.width
            canvas.height = m.height
            previous = null
          }
          const image = ctx.createImageData(m.width, m.height)
          for (let i = 0; i < m.width * m.height; i++) {
            const v = matteValue(probs[i])
            // Blend with the last frame so the edge doesn't flicker.
            const smooth = previous ? previous[i] * 0.4 + v * 0.6 : v
            image.data[i * 4] = Math.round(smooth * 255)
            image.data[i * 4 + 3] = 255
            if (!previous) previous = new Float32Array(m.width * m.height)
            previous[i] = smooth
          }
          ctx.putImageData(image, 0, 0)
          produced = true
        }
        result?.close?.()
      } catch (err) {
        failure = `即時去背失敗：${(err as Error).message}`
      } finally {
        busy = false
      }
    },
  }
}
