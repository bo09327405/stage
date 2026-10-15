/** Load just the metadata of an audio/video URL to read its length in seconds; null if it can't be read. */
export function probeMediaDuration(url: string, timeoutMs = 10000): Promise<number | null> {
  return new Promise((resolve) => {
    const media = document.createElement('video')
    media.preload = 'metadata'
    const done = (value: number | null) => {
      clearTimeout(timer)
      media.removeAttribute('src')
      media.load()
      resolve(value)
    }
    const timer = setTimeout(() => done(null), timeoutMs)
    media.onloadedmetadata = () => done(Number.isFinite(media.duration) ? media.duration : null)
    media.onerror = () => done(null)
    media.src = url
  })
}
