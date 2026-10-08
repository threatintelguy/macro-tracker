/**
 * Accepting a reviewed estimate.
 *
 * Nothing commits without review; this is what runs when the user accepts.
 * The draft becomes a composite -- so a second visit to the same restaurant
 * is two taps -- and is logged as an instance of it at `ai_estimated`
 * fidelity, carrying the tier and model that produced it.
 *
 * Library lines reference their food. Model and preparation lines become
 * foods of their own, marked as estimates, so the composite can be logged
 * again and the needs-detail list can later offer to re-resolve a model
 * line against a real library food.
 */

import type {
  Component,
  Composite,
  EstimateSource,
  Entry,
  FoodItem,
  LocalDate,
} from '../domain/types.ts'
import { linePer100g, type DraftLine } from '../estimate/pipeline.ts'
import * as repo from './repositories.ts'

export async function acceptEstimate(input: {
  name: string
  lines: readonly DraftLine[]
  provenance: EstimateSource
  date: LocalDate
  at?: string
  photoRef?: string
}): Promise<{ composite: Composite; entries: Entry[]; problems: string[]; foods: FoodItem[] }> {
  const now = Date.now()
  const created: FoodItem[] = []
  const components: Component[] = []

  for (const line of input.lines) {
    if (!(line.grams > 0)) continue
    let food = line.source === 'db' ? line.food : undefined
    if (!food) {
      const isPrep = line.source === 'prep'
      food = {
        id: repo.newId('x'),
        name: isPrep ? `${line.name} — ${input.name}` : `${line.name} (estimate)`,
        tier: 'custom',
        origin: 'custom',
        per100g: linePer100g(line),
        portions: [],
        cookState: 'n/a',
        createdAt: now,
        estimate: { line: isPrep ? 'prep' : 'model', ...input.provenance },
      }
      created.push(food)
    }
    components.push({
      kind: 'food',
      ref: { kind: 'food', foodId: food.id, name: food.name },
      grams: line.grams,
    })
  }

  if (created.length > 0) await repo.putFoods(created)

  const composite: Composite = {
    id: repo.newId('c'),
    name: input.name.trim() || 'Estimated meal',
    version: 1,
    components,
    createdAt: now,
    updatedAt: now,
    estimateSource: input.provenance,
  }
  await repo.putComposite(composite)

  const logged = await repo.logCompositeInstance({
    instance: {
      kind: 'composite',
      compositeId: composite.id,
      version: composite.version,
      multiplier: 1,
      overrides: [],
      name: composite.name,
    },
    date: input.date,
    ...(input.at !== undefined ? { at: input.at } : {}),
    fidelity: 'ai_estimated',
    estimateSource: input.provenance,
    ...(input.photoRef ? { photoRef: input.photoRef } : {}),
  })
  return { composite, entries: logged.entries, problems: logged.problems, foods: created }
}
