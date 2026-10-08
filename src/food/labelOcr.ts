/**
 * Label OCR: text recognition, not interpretation.
 *
 * Tesseract.js in a worker, with its worker script, wasm core and English
 * data bundled into the app and precached -- fully offline, no model and no
 * network. Android's ML Kit would be better but is unreachable from a
 * browser app, and Chrome's TextDetector is too thinly supported.
 *
 * Flat, well-lit, high-contrast panels read well; curved bottles, gloss and
 * small type read poorly, and the UI says so.
 */

import { parseNutritionLabel, type ParsedLabel } from './labelParse.ts'

/** Where the bundled assets are served from; copied there at build. */
function assetBase(): string {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env
  const base = env?.['BASE_URL'] ?? '/'
  return new URL(`${base.replace(/\/?$/, '/')}tesseract/`, location.href).href
}

export type LabelRead = ParsedLabel & { text: string }

/**
 * Recognise a label photo and parse it. The worker is created per read and
 * torn down after: reads are rare, and a resident OCR worker would hold tens
 * of megabytes for nothing.
 */
export async function readLabel(
  image: Blob,
  onProgress?: (fraction: number) => void,
): Promise<LabelRead> {
  const { createWorker, OEM } = await import('tesseract.js')
  const base = assetBase()
  const worker = await createWorker('eng', OEM.LSTM_ONLY, {
    workerPath: `${base}worker.min.js`,
    corePath: `${base}tesseract-core-simd-lstm.wasm.js`,
    langPath: base,
    gzip: true,
    workerBlobURL: false,
    // The data is precached by the service worker; a second copy is waste.
    cacheMethod: 'none',
    logger: (m: { status: string; progress: number }) => {
      if (m.status === 'recognizing text') onProgress?.(m.progress)
    },
  })
  try {
    const { data } = await worker.recognize(image)
    return { ...parseNutritionLabel(data.text), text: data.text }
  } finally {
    await worker.terminate()
  }
}
