/**
 * The food registry.
 *
 * Foods come from three places that are stored differently: the curated
 * table is bundled with the app, the USDA subset is a build artefact fetched
 * at runtime, and custom and barcode foods live in IndexedDB. Anything that
 * needs to turn a FoodId into nutrients has to see all three.
 *
 * This module is that single view. Without it, a composite built from
 * curated foods resolves to nothing, because the curated rows are not in the
 * database -- which is exactly the bug this module exists to prevent.
 */

import type { FoodId, FoodItem } from '../domain/types.ts'
import { curatedFoods } from './curated.ts'

let registry: Map<FoodId, FoodItem> | null = null

function ensure(): Map<FoodId, FoodItem> {
  if (!registry) {
    // The curated table is always available, with no I/O and no loading step.
    registry = new Map(curatedFoods().map((f) => [f.id, f]))
  }
  return registry
}

export function registerFoods(foods: readonly FoodItem[]): void {
  const map = ensure()
  for (const f of foods) map.set(f.id, f)
}

export function resolveFood(id: FoodId): FoodItem | undefined {
  return ensure().get(id)
}

export function registeredFoodCount(): number {
  return ensure().size
}

export function unregisterFood(id: FoodId): void {
  ensure().delete(id)
}

/** Test seam: drop everything but the curated table. */
export function resetRegistry(): void {
  registry = null
}
