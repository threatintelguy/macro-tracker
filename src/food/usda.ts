/**
 * The bundled food index: USDA FoodData Central.
 *
 * Full Foundation and SR Legacy -- generic whole foods -- plus a curated
 * slice of USDA Branded, selected by how commonly a product is sold rather
 * than for completeness. The branded slice is what lets common packaged
 * foods resolve locally, with no network call, and it carries each
 * product's GTIN so a scan of a bundled product never leaves the device.
 *
 * The file is a build artefact generated in CI and is not committed. When
 * it is absent the app runs on the curated table, custom foods and cached
 * lookups alone -- `loadUsdaSubset` resolves to an empty list rather than
 * failing.
 *
 * Binary layout v2 (little endian), mirrored in scripts/build-food-index.ts:
 *
 *   magic    4 bytes  'MTF2'
 *   count    u32      number of records
 *   strLen   u32      byte length of the UTF-8 string blob
 *   strings  strLen   names, brands and GTINs, concatenated
 *   records  count * RECORD_BYTES_V2
 *
 * Each record: nameOffset u32, nameLength u16, fdcId u32, flags u8,
 * brandOffset u32, brandLength u16, gtinOffset u32, gtinLength u8,
 * servingDecigrams u16 (0 = none), then nine u16 nutrient values in
 * NUTRIENT_ORDER, quantised by each scale. 0xFFFF means unknown -- a branded
 * label that does not list fibre has not said it has none.
 *
 * Version 1 files ('MTF1': generic only, no brand, no unknowns) still decode.
 */

import type { FoodItem, NutrientVector, Portion } from '../domain/types.ts'

export const MAGIC = 'MTF1'
export const MAGIC_V2 = 'MTF2'
export const RECORD_BYTES = 28
export const RECORD_BYTES_V2 = 42
/** Quantised value meaning "not reported". */
export const UNKNOWN_U16 = 0xffff
export const FLAG_BRANDED = 1

/** Field order inside a record, and the scale each is quantised at. */
export const NUTRIENT_ORDER = [
  ['kcal', 10],
  ['protein', 100],
  ['carbs', 100],
  ['fat', 100],
  ['satFat', 100],
  ['fibre', 100],
  ['sodium', 1],
  ['addedSugar', 100],
  ['alcohol', 100],
] as const satisfies readonly (readonly [keyof NutrientVector, number])[]

function readMagic(bytes: Uint8Array): string {
  return String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!)
}

export function decodeUsdaSubset(buffer: ArrayBuffer): FoodItem[] {
  const bytes = new Uint8Array(buffer)
  const magic = readMagic(bytes)
  if (magic === MAGIC_V2) return decodeV2(buffer)
  if (magic !== MAGIC) {
    throw new Error(`Not a food index: expected ${MAGIC_V2}, found ${magic}`)
  }
  return decodeV1(buffer)
}

function header(buffer: ArrayBuffer, recordBytes: number): {
  view: DataView
  bytes: Uint8Array
  count: number
  blob: Uint8Array
  recordsStart: number
} {
  const view = new DataView(buffer)
  const bytes = new Uint8Array(buffer)
  const count = view.getUint32(4, true)
  const blobLength = view.getUint32(8, true)
  const recordsStart = 12 + blobLength
  const expected = recordsStart + count * recordBytes
  if (buffer.byteLength < expected) {
    throw new Error(
      `Food index truncated: expected ${expected} bytes, found ${buffer.byteLength}`,
    )
  }
  return { view, bytes, count, blob: bytes.subarray(12, recordsStart), recordsStart }
}

function decodeV1(buffer: ArrayBuffer): FoodItem[] {
  const { view, count, blob, recordsStart } = header(buffer, RECORD_BYTES)
  const decoder = new TextDecoder()
  const out: FoodItem[] = []
  for (let i = 0; i < count; i++) {
    const base = recordsStart + i * RECORD_BYTES
    const nameOffset = view.getUint32(base, true)
    const nameLength = view.getUint16(base + 4, true)
    const fdcId = view.getUint32(base + 6, true)
    const per100g = {} as NutrientVector
    NUTRIENT_ORDER.forEach(([key, scale], n) => {
      per100g[key] = view.getUint16(base + 10 + n * 2, true) / scale
    })
    out.push({
      id: `u_${fdcId}`,
      name: decoder.decode(blob.subarray(nameOffset, nameOffset + nameLength)),
      tier: 'usda',
      origin: 'usda-generic',
      per100g,
      portions: [],
      cookState: 'n/a',
    })
  }
  return out
}

function decodeV2(buffer: ArrayBuffer): FoodItem[] {
  const { view, count, blob, recordsStart } = header(buffer, RECORD_BYTES_V2)
  const decoder = new TextDecoder()
  const text = (offset: number, length: number): string =>
    length === 0 ? '' : decoder.decode(blob.subarray(offset, offset + length))
  const out: FoodItem[] = []

  for (let i = 0; i < count; i++) {
    const base = recordsStart + i * RECORD_BYTES_V2
    const name = text(view.getUint32(base, true), view.getUint16(base + 4, true))
    const fdcId = view.getUint32(base + 6, true)
    const flags = view.getUint8(base + 10)
    const brand = text(view.getUint32(base + 11, true), view.getUint16(base + 15, true))
    const gtin = text(view.getUint32(base + 17, true), view.getUint8(base + 21))
    const servingDg = view.getUint16(base + 22, true)

    const per100g = {} as NutrientVector
    NUTRIENT_ORDER.forEach(([key, scale], n) => {
      const q = view.getUint16(base + 24 + n * 2, true)
      per100g[key] = q === UNKNOWN_U16 ? null : q / scale
    })

    const branded = (flags & FLAG_BRANDED) !== 0
    const portions: Portion[] =
      servingDg > 0 ? [{ label: '1 serving', grams: servingDg / 10 }] : []

    out.push({
      id: `u_${fdcId}`,
      name,
      ...(brand ? { brand } : {}),
      tier: 'usda',
      origin: branded ? 'usda-branded' : 'usda-generic',
      per100g,
      portions,
      cookState: 'n/a',
      ...(gtin ? { barcode: gtin } : {}),
    })
  }

  return out
}

/**
 * Load the subset if the build produced one.
 *
 * Never throws for an absent file: the bundled index is optional by design,
 * and the app is fully usable without it.
 */
export async function loadUsdaSubset(
  url = 'usda-subset.bin',
  fetchImpl: typeof fetch = fetch,
): Promise<FoodItem[]> {
  try {
    const res = await fetchImpl(url)
    if (!res.ok) return []
    const buf = await res.arrayBuffer()
    if (buf.byteLength < 12) return []
    return decodeUsdaSubset(buf)
  } catch {
    return []
  }
}
