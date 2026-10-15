/**
 * Downscale a photo to fit within `maxSize` px and re-encode as JPEG.
 * Phone photos are often 5–12 MB; shrinking first keeps uploads fast on venue Wi-Fi.
 * Falls back to the original file if the browser can't decode it.
 */
export async function resizeImage(file: File, maxSize = 2048, quality = 0.85): Promise<Blob> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    return file
  }

  const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality))
  return blob && blob.size < file.size ? blob : file
}
