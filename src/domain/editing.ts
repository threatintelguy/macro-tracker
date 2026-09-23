/**
 * Pure rules for correcting a logged entry.
 *
 * The rules matter and are easy to get wrong:
 *
 *   - Changing the amount RESCALES the snapshotted nutrients. It never
 *     re-resolves against the food table: the snapshot is the record of what
 *     was eaten, and correcting 150 g to 180 g must not also pull in a food
 *     revision made since.
 *   - Changing the food re-resolves from scratch and takes a fresh snapshot,
 *     because it is a different food and the old snapshot no longer applies.
 *
 * Edits are silent. No history, no "edited" badge: a correction is not a
 * confession.
 */

import type {
  Entry,
  FoodItem,
  NutrientKey,
  NutrientVector,
} from './types.ts'
import { NUTRIENT_KEYS } from './types.ts'
import { nutrientsForGrams, scaleNutrients } from './nutrition/index.ts'

/** Rescale an entry's snapshot to a new amount. Unknown stays unknown. */
export function rescaleEntry(entry: Entry, grams: number): Entry {
  if (!(grams > 0) || !(entry.grams > 0)) return { ...entry, grams }
  const factor = grams / entry.grams
  return { ...entry, grams, nutrients: scaleNutrients(entry.nutrients, factor) }
}

/** Point an entry at a different food: fresh snapshot, and any stand-in is resolved. */
export function refoodEntry(entry: Entry, food: FoodItem, grams = entry.grams): Entry {
  const { proxyFor: _proxy, ...rest } = entry
  return {
    ...rest,
    source: { kind: 'food', foodId: food.id, name: food.name },
    grams,
    nutrients: nutrientsForGrams(food.per100g, grams),
  }
}

/** Scale every row of a composite log by the ratio of multipliers. */
export function rescaleCompositeRows(
  rows: readonly Entry[],
  fromMultiplier: number,
  toMultiplier: number,
): Entry[] {
  if (!(fromMultiplier > 0) || !(toMultiplier > 0)) return [...rows]
  const factor = toMultiplier / fromMultiplier
  return rows.map((r) => {
    const next: Entry = {
      ...r,
      grams: r.grams * factor,
      nutrients: scaleNutrients(r.nutrients, factor),
    }
    if (next.source.kind === 'composite') {
      next.source = { ...next.source, multiplier: toMultiplier }
    }
    return next
  })
}

/**
 * Fill the unknown fields of a snapshot with values given for the amount
 * as eaten. Known fields are never overwritten -- this is filling in, not
 * correcting.
 */
export function fillUnknown(
  nutrients: NutrientVector,
  values: Partial<Record<NutrientKey, number>>,
): NutrientVector {
  const out = { ...nutrients }
  for (const k of NUTRIENT_KEYS) {
    const v = values[k]
    if (out[k] === null && v !== undefined && Number.isFinite(v) && v >= 0) {
      out[k] = v
    }
  }
  return out
}

/**
 * The same fill, expressed per 100 g of a food, from a value given for an
 * entry of `grams`. Used to carry a fix back to the food so the next log
 * of it is complete.
 */
export function fillUnknownPer100g(
  per100g: NutrientVector,
  values: Partial<Record<NutrientKey, number>>,
  grams: number,
): NutrientVector {
  if (!(grams > 0)) return per100g
  const scaled: Partial<Record<NutrientKey, number>> = {}
  for (const k of NUTRIENT_KEYS) {
    const v = values[k]
    if (v !== undefined) scaled[k] = (v * 100) / grams
  }
  return fillUnknown(per100g, scaled)
}

/** Does this entry belong in the needs-detail queue? */
export function needsDetail(entry: Entry): boolean {
  return (
    entry.proxyFor !== undefined ||
    NUTRIENT_KEYS.some((k) => entry.nutrients[k] === null)
  )
}

/** Which fields a clone changed from its origin, for provenance. */
export function adjustedFields(
  origin: NutrientVector,
  next: NutrientVector,
): NutrientKey[] {
  return NUTRIENT_KEYS.filter((k) => {
    const a = origin[k]
    const b = next[k]
    if (a === null || b === null) return a !== b
    return Math.abs(a - b) > 1e-6
  })
}
