/**
 * Image handling for plate photos and label reads.
 *
 * A photo is compressed to about 1024 px on the long edge before it is
 * stored or sent: enough to show portion scale and preparation, small
 * enough that a year of restaurant meals does not fill the device.
 */

export const PHOTO_LONG_EDGE = 1024
export const PHOTO_QUALITY = 0.8

/** The scaled size for a long edge, never enlarging. */
export function fitWithin(width: number, height: number, longEdge = PHOTO_LONG_EDGE): {
  width: number
  height: number
} {
  const long = Math.max(width, height)
  if (long <= longEdge || long === 0) return { width, height }
  const k = longEdge / long
  return { width: Math.round(width * k), height: Math.round(height * k) }
}

/** Decode a picked file, scale it down, and re-encode it as JPEG. */
export async function compressImage(file: Blob, longEdge = PHOTO_LONG_EDGE): Promise<Blob> {
  const bitmap = await createImageBitmap(file)
  const { width, height } = fitWithin(bitmap.width, bitmap.height, longEdge)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('This browser cannot process images.')
  ctx.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('The image could not be encoded.'))),
      'image/jpeg',
      PHOTO_QUALITY,
    ),
  )
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('The image could not be read.'))
    reader.readAsDataURL(blob)
  })
}

/** Open the camera (or the photo picker, where there is no camera). */
export function pickImage(): Promise<File | undefined> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.setAttribute('capture', 'environment')
    input.onchange = () => resolve(input.files?.[0] ?? undefined)
    input.click()
  })
}
