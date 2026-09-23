/**
 * Tier 3: barcode lookup.
 *
 * What leaves the device: one product code, on an explicit user action.
 * Nothing else -- no identifier, no session, no cookie. Fetched with
 * `credentials: 'omit'` and no referrer. Results are written to the local
 * custom-food table and served from local storage forever after, so a given
 * product is fetched at most once ever.
 *
 * A global offline-mode switch hard-disables this module, falling back to
 * manual label entry.
 */

import type { FoodItem, NutrientVector, Portion } from '../domain/types.ts'

const OFF_ENDPOINT = 'https://world.openfoodfacts.org/api/v2/product'

/** Only the fields actually used, so the response stays small. */
const OFF_FIELDS = [
  'product_name',
  'brands',
  'serving_size',
  'serving_quantity',
  'nutriments',
  'quantity',
].join(',')

export type BarcodeLookupResult =
  | { ok: true; food: FoodItem }
  | { ok: false; reason: 'not-found' | 'offline' | 'network' | 'incomplete'; message: string }

export type BarcodeDeps = {
  fetch: typeof fetch
  /** Hard off-switch. When false this module makes no request at all. */
  enabled: boolean
  now?: () => number
}

export function isPlausibleBarcode(code: string): boolean {
  return /^\d{8}$|^\d{12,14}$/.test(code.trim())
}

export async function lookupBarcode(
  code: string,
  deps: BarcodeDeps,
): Promise<BarcodeLookupResult> {
  if (!deps.enabled) {
    return {
      ok: false,
      reason: 'offline',
      message:
        'Barcode lookup is switched off. Enter the label values manually, or turn lookup back on in settings.',
    }
  }

  const clean = code.trim()
  if (!isPlausibleBarcode(clean)) {
    return {
      ok: false,
      reason: 'not-found',
      message: `"${code}" is not a barcode this can look up.`,
    }
  }

  let payload: OffResponse
  try {
    const res = await deps.fetch(
      `${OFF_ENDPOINT}/${encodeURIComponent(clean)}.json?fields=${OFF_FIELDS}`,
      {
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        mode: 'cors',
        headers: { Accept: 'application/json' },
      },
    )
    if (res.status === 404) {
      return {
        ok: false,
        reason: 'not-found',
        message: `No product found for ${clean}. Enter the label values manually and it will be saved for next time.`,
      }
    }
    if (!res.ok) {
      return {
        ok: false,
        reason: 'network',
        message: `Lookup failed (${res.status}). Enter the label values manually.`,
      }
    }
    payload = (await res.json()) as OffResponse
  } catch {
    return {
      ok: false,
      reason: 'network',
      message:
        'Could not reach the lookup service. Enter the label values manually and it will be saved locally.',
    }
  }

  if (payload.status !== 1 || !payload.product) {
    return {
      ok: false,
      reason: 'not-found',
      message: `No product found for ${clean}. Enter the label values manually and it will be saved for next time.`,
    }
  }

  const food = normaliseOffProduct(clean, payload.product, deps.now?.() ?? Date.now())
  if (!food) {
    return {
      ok: false,
      reason: 'incomplete',
      message:
        'That product has no usable nutrition data. Enter the label values manually.',
    }
  }
  return { ok: true, food }
}

type OffNutriments = Record<string, number | string | undefined>

type OffProduct = {
  product_name?: string
  brands?: string
  serving_size?: string
  serving_quantity?: number | string
  quantity?: string
  nutriments?: OffNutriments
}

type OffResponse = { status: number; product?: OffProduct }

function num(n: number | string | undefined): number | undefined {
  if (typeof n === 'number') return Number.isFinite(n) ? n : undefined
  if (typeof n === 'string') {
    const parsed = Number.parseFloat(n)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/**
 * Normalise an Open Food Facts product into a local food row.
 *
 * Exported for tests: the mapping is where a silently wrong value would
 * enter years of data, so it is exercised directly rather than through fetch.
 */
export function normaliseOffProduct(
  barcode: string,
  product: OffProduct,
  now: number,
): FoodItem | undefined {
  const n = product.nutriments ?? {}

  // Energy: prefer the stated kcal, fall back to kJ.
  let kcal = num(n['energy-kcal_100g'])
  if (kcal === undefined) {
    const kj = num(n['energy_100g']) ?? num(n['energy-kj_100g'])
    if (kj !== undefined) kcal = kj / 4.184
  }

  const protein = num(n['proteins_100g'])
  const carbs = num(n['carbohydrates_100g'])
  const fat = num(n['fat_100g'])

  // A product with no energy and no macros is not usable.
  if (kcal === undefined && protein === undefined && carbs === undefined && fat === undefined) {
    return undefined
  }

  // Unknown is not zero: a field the product does not report is stored as
  // null, so it never drags an average down. Alcohol is the one exception --
  // a product containing alcohol must declare it, so its absence from a
  // label is a statement that there is none.
  const per100g: NutrientVector = {
    kcal: kcal ?? null,
    protein: protein ?? null,
    carbs: carbs ?? null,
    fat: fat ?? null,
    satFat: num(n['saturated-fat_100g']) ?? null,
    fibre: num(n['fiber_100g']) ?? null,
    // OFF reports sodium in grams per 100 g; the app stores milligrams.
    sodium: sodiumMg(n),
    addedSugar: num(n['added-sugars_100g']) ?? null,
    alcohol: num(n['alcohol_100g']) ?? 0,
  }

  const portions: Portion[] = []
  const servingG = num(product.serving_quantity)
  if (servingG !== undefined && servingG > 0) {
    portions.push({
      label: product.serving_size?.trim() || '1 serving',
      grams: servingG,
    })
  }
  const packG = parsePackSize(product.quantity)
  if (packG !== undefined) portions.push({ label: 'whole pack', grams: packG })

  const name = product.product_name?.trim() || `Product ${barcode}`
  const brand = product.brands?.split(',')[0]?.trim()

  return {
    id: `bc_${barcode}`,
    name,
    ...(brand ? { brand } : {}),
    tier: 'barcode',
    per100g,
    portions,
    cookState: 'n/a',
    barcode,
    createdAt: now,
  }
}

function sodiumMg(n: OffNutriments): number | null {
  const sodiumG = num(n['sodium_100g'])
  if (sodiumG !== undefined) return sodiumG * 1000
  const saltG = num(n['salt_100g'])
  // Salt to sodium: the conventional 2.5 factor.
  if (saltG !== undefined) return (saltG / 2.5) * 1000
  return null
}

function parsePackSize(q: string | undefined): number | undefined {
  if (!q) return undefined
  const m = /([\d.]+)\s*(g|kg|ml|l)\b/i.exec(q)
  if (!m) return undefined
  const value = Number.parseFloat(m[1]!)
  if (!Number.isFinite(value)) return undefined
  const unit = m[2]!.toLowerCase()
  // ml is treated as grams: a density assumption, but the alternative is no
  // pack portion at all, and the user can always override the gram figure.
  if (unit === 'kg' || unit === 'l') return value * 1000
  return value
}

// --- Scanning -------------------------------------------------------------

export type ScanStop = () => void

export function barcodeDetectorAvailable(): boolean {
  return typeof globalThis !== 'undefined' && 'BarcodeDetector' in globalThis
}

type BarcodeDetectorLike = {
  detect: (source: CanvasImageSource) => Promise<{ rawValue: string }[]>
}

type BarcodeDetectorCtor = new (opts?: { formats?: string[] }) => BarcodeDetectorLike

/**
 * Drive the native BarcodeDetector over a video element.
 *
 * Returns a stop function. The caller owns the MediaStream; this only reads
 * frames. A ZXing-wasm fallback would slot in behind the same signature on
 * browsers without the native API.
 */
export function scanFromVideo(
  video: HTMLVideoElement,
  onCode: (code: string) => void,
  onError?: (message: string) => void,
): ScanStop {
  const Ctor = (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector
  if (!Ctor) {
    onError?.(
      'This browser cannot scan barcodes. Type the number from under the barcode instead.',
    )
    return () => {}
  }

  const detector = new Ctor({
    formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'],
  })
  let stopped = false
  let raf = 0

  const tick = async (): Promise<void> => {
    if (stopped) return
    try {
      if (video.readyState >= 2) {
        const found = await detector.detect(video)
        const first = found[0]
        if (first && first.rawValue) {
          onCode(first.rawValue)
          return
        }
      }
    } catch {
      // A failed frame is normal -- keep scanning rather than tearing down.
    }
    raf = requestAnimationFrame(() => void tick())
  }

  void tick()

  return () => {
    stopped = true
    if (raf) cancelAnimationFrame(raf)
  }
}
