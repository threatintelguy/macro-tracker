/**
 * Tier 2: the bundled USDA subset.
 *
 * Generated at build time from FoodData Central Foundation Foods and SR
 * Legacy -- generic whole foods, with the Branded dataset excluded on
 * purpose: it is label-derived rather than lab-verified, it is the bulk of
 * FoodData Central's size, and it duplicates what barcode lookup handles on
 * demand.
 *
 * The file is a build artefact and is not committed. When it is absent the
 * app runs on the curated table, custom foods and barcode results alone --
 * `loadUsdaSubset` resolves to an empty list rather than failing.
 *
 * Binary layout (little endian), mirrored in scripts/build-food-index.ts:
 *
 *   magic   4 bytes  'MTF1'
 *   count   u32      number of records
 *   nameLen u32      byte length of the UTF-8 name blob
 *   names   nameLen  concatenated names, no separators
 *   records count * RECORD_BYTES
 *
 * Each record: nameOffset u32, nameLength u16, fdcId u32, then nine
 * quantised u16 nutrient values in NUTRIENT_ORDER.
 */

import type { FoodItem, NutrientVector } from '../domain/types.ts'

export const MAGIC = 'MTF1'
export const RECORD_BYTES = 28

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

export function decodeUsdaSubset(buffer: ArrayBuffer): FoodItem[] {
  const view = new DataView(buffer)
  const bytes = new Uint8Array(buffer)

  const magic = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!)
  if (magic !== MAGIC) {
    throw new Error(`Not a food index: expected ${MAGIC}, found ${magic}`)
  }

  const count = view.getUint32(4, true)
  const nameBlobLength = view.getUint32(8, true)
  const namesStart = 12
  const recordsStart = namesStart + nameBlobLength

  const expected = recordsStart + count * RECORD_BYTES
  if (buffer.byteLength < expected) {
    throw new Error(
      `Food index truncated: expected ${expected} bytes, found ${buffer.byteLength}`,
    )
  }

  const decoder = new TextDecoder()
  const nameBlob = bytes.subarray(namesStart, namesStart + nameBlobLength)
  const out: FoodItem[] = []

  for (let i = 0; i < count; i++) {
    const base = recordsStart + i * RECORD_BYTES
    const nameOffset = view.getUint32(base, true)
    const nameLength = view.getUint16(base + 4, true)
    const fdcId = view.getUint32(base + 6, true)

    const name = decoder.decode(
      nameBlob.subarray(nameOffset, nameOffset + nameLength),
    )

    const per100g = {} as NutrientVector
    NUTRIENT_ORDER.forEach(([key, scale], n) => {
      per100g[key] = view.getUint16(base + 10 + n * 2, true) / scale
    })

    out.push({
      id: `u_${fdcId}`,
      name,
      tier: 'usda',
      per100g,
      portions: [],
      cookState: 'n/a',
    })
  }

  return out
}

/**
 * Load the subset if the build produced one.
 *
 * Never throws for an absent file: tier 2 is optional by design, and the app
 * is fully usable without it.
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
