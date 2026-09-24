/**
 * Composite resolution.
 *
 * A composite is a meal defined once with weighed gram amounts and logged in
 * one tap thereafter. This module walks the component tree depth-first,
 * applies overrides at the level they were recorded, multiplies through, and
 * emits a flat list of rows with their nutrients snapshotted.
 *
 * Two guards are mandatory rather than nice to have: cycle detection and a
 * depth cap. A composite that contains itself is an easy mistake to make
 * through the UI and an infinite loop if unguarded.
 */

import type {
  Composite,
  CompositeId,
  CompositeInstance,
  CompositeTombstone,
  CompositeUsage,
  Component,
  Fidelity,
  FoodId,
  FoodItem,
  NutrientVector,
  Override,
} from '../types.ts'
import { NUTRIENT_KEYS } from '../types.ts'
import {
  aggregateNutrients,
  nutrientsForGrams,
  type NutrientTotals,
} from '../nutrition/index.ts'

/** Every field unknown. What a row whose food cannot be found contributes. */
export function unknownNutrients(): NutrientVector {
  const out = {} as NutrientVector
  for (const k of NUTRIENT_KEYS) out[k] = null
  return out
}

export const MAX_COMPOSITE_DEPTH = 4

export type ResolvedComponent = {
  foodId: FoodId
  name: string
  grams: number
  nutrients: NutrientVector
  /** Path of composite names from the root, for display and debugging. */
  path: string[]
  fidelity: Fidelity
  /** True when an override changed this row from the stored definition. */
  overridden?: boolean
}

export type ResolutionProblem = {
  kind: 'cycle' | 'depth' | 'missing-food' | 'missing-composite' | 'missing-version'
  message: string
  path: string[]
}

export type ResolutionResult = {
  rows: ResolvedComponent[]
  /** Known sums with coverage; a row with an unknown field makes it a floor. */
  totals: NutrientTotals
  totalGrams: number
  problems: ResolutionProblem[]
}

export type Lookups = {
  food: (id: FoodId) => FoodItem | undefined
  composite: (id: CompositeId) => Composite | undefined
  /**
   * The fallback for an id that no longer resolves: a deleted composite
   * leaves a tombstone, so a dangling reference reads as "deleted" rather
   * than as broken.
   */
  tombstone?: (id: CompositeId) => CompositeTombstone | undefined
}

/**
 * Get the component list for a specific version of a composite.
 *
 * Definition edits bump `version` and push the old definition into history,
 * so every prior instance stays pinned to the definition it was logged
 * against. Nutrients are snapshotted on the entry as well; this path exists
 * for re-resolution and for inspecting an old instance.
 */
export function componentsAtVersion(
  composite: Composite,
  version: number,
): Component[] | undefined {
  if (composite.version === version) return composite.components
  return composite.history?.find((h) => h.version === version)?.components
}

function applyOverride(
  component: Component,
  override: Override | undefined,
): { component: Component | null; overridden: boolean } {
  if (!override) return { component, overridden: false }

  switch (override.action) {
    case 'skip':
      return { component: null, overridden: true }
    case 'swap': {
      if (component.kind !== 'food') return { component, overridden: false }
      return {
        component: {
          kind: 'food',
          ref: override.ref,
          grams: override.grams ?? component.grams,
        },
        overridden: true,
      }
    }
    case 'regram': {
      if (component.kind === 'food') {
        return {
          component: { kind: 'food', ref: component.ref, grams: override.grams },
          overridden: true,
        }
      }
      return { component, overridden: false }
    }
  }
}

/**
 * Resolve a composite instance into flat rows.
 *
 * `multiplier` scales the instance and never touches the definition.
 * Overrides apply only at the root level, which is where the log sheet
 * records them -- swapping salmon for chicken in the salad must not create
 * "Lincoln salad (chicken)" as a second composite.
 */
export function resolveCompositeInstance(
  instance: CompositeInstance,
  lookups: Lookups,
  fidelity: Fidelity = 'weighed',
): ResolutionResult {
  const problems: ResolutionProblem[] = []
  const rows: ResolvedComponent[] = []

  const root = lookups.composite(instance.compositeId)
  if (!root) {
    const tomb = lookups.tombstone?.(instance.compositeId)
    problems.push({
      kind: 'missing-composite',
      message: tomb
        ? `"${tomb.name}" was deleted. Entries already logged keep their totals.`
        : `Composite "${instance.name}" is no longer in the library.`,
      path: [tomb?.name ?? instance.name],
    })
    return { rows, totals: aggregateNutrients([]), totalGrams: 0, problems }
  }

  const components = componentsAtVersion(root, instance.version)
  if (!components) {
    problems.push({
      kind: 'missing-version',
      message: `Version ${instance.version} of "${root.name}" is no longer stored. Showing nothing rather than the wrong definition.`,
      path: [root.name],
    })
    return { rows, totals: aggregateNutrients([]), totalGrams: 0, problems }
  }

  const overrideByIndex = new Map<number, Override>()
  for (const o of instance.overrides) overrideByIndex.set(o.componentIndex, o)

  walk({
    components,
    multiplier: instance.multiplier,
    overrides: overrideByIndex,
    path: [root.name],
    visiting: new Set<CompositeId>([root.id]),
    depth: 1,
    lookups,
    fidelity,
    rows,
    problems,
  })

  return {
    rows,
    totals: aggregateNutrients(rows.map((r) => r.nutrients)),
    totalGrams: rows.reduce((a, r) => a + r.grams, 0),
    problems,
  }
}

/** Resolve a bare definition, for the composite editor's live totals. */
export function resolveComposite(
  composite: Composite,
  lookups: Lookups,
  multiplier = 1,
): ResolutionResult {
  return resolveCompositeInstance(
    {
      kind: 'composite',
      compositeId: composite.id,
      version: composite.version,
      multiplier,
      overrides: [],
      name: composite.name,
    },
    lookups,
  )
}

function walk(ctx: {
  components: readonly Component[]
  multiplier: number
  overrides: Map<number, Override> | null
  path: string[]
  visiting: Set<CompositeId>
  depth: number
  lookups: Lookups
  fidelity: Fidelity
  rows: ResolvedComponent[]
  problems: ResolutionProblem[]
}): void {
  const {
    components,
    multiplier,
    overrides,
    path,
    visiting,
    depth,
    lookups,
    fidelity,
    rows,
    problems,
  } = ctx

  if (depth > MAX_COMPOSITE_DEPTH) {
    problems.push({
      kind: 'depth',
      message: `Nesting deeper than ${MAX_COMPOSITE_DEPTH} levels is not resolved.`,
      path,
    })
    return
  }

  for (let i = 0; i < components.length; i++) {
    const raw = components[i]!
    const { component, overridden } = applyOverride(raw, overrides?.get(i))
    if (component === null) continue

    if (component.kind === 'food') {
      const food = lookups.food(component.ref.foodId)
      const grams = component.grams * multiplier
      if (!food) {
        problems.push({
          kind: 'missing-food',
          message: `"${component.ref.name}" is no longer in the food table.`,
          path: [...path, component.ref.name],
        })
        // Unknown, not zero: a missing food contributes nothing known.
        rows.push({
          foodId: component.ref.foodId,
          name: component.ref.name,
          grams,
          nutrients: unknownNutrients(),
          path,
          fidelity,
          ...(overridden ? { overridden: true } : {}),
        })
        continue
      }
      rows.push({
        foodId: food.id,
        name: food.name,
        grams,
        nutrients: nutrientsForGrams(food.per100g, grams),
        path,
        fidelity,
        ...(overridden ? { overridden: true } : {}),
      })
      continue
    }

    // Nested composite.
    const child = lookups.composite(component.ref)
    if (!child) {
      const tomb = lookups.tombstone?.(component.ref)
      problems.push({
        kind: 'missing-composite',
        message: tomb
          ? `The nested composite "${tomb.name}" was deleted.`
          : `A nested composite is no longer in the library.`,
        path,
      })
      continue
    }
    if (visiting.has(child.id)) {
      problems.push({
        kind: 'cycle',
        message: `"${child.name}" contains itself. The repeated branch was not resolved.`,
        path: [...path, child.name],
      })
      continue
    }

    walk({
      components: child.components,
      multiplier: multiplier * component.multiplier,
      overrides: null,
      path: [...path, child.name],
      visiting: new Set([...visiting, child.id]),
      depth: depth + 1,
      lookups,
      fidelity,
      rows,
      problems,
    })
  }
}

/**
 * Would adding `childId` to `parentId` create a cycle? Checked in the editor
 * so the mistake is refused at input rather than caught at resolution.
 */
export function wouldCycle(
  parentId: CompositeId,
  childId: CompositeId,
  lookup: (id: CompositeId) => Composite | undefined,
): boolean {
  if (parentId === childId) return true
  const seen = new Set<CompositeId>()
  const stack: CompositeId[] = [childId]
  while (stack.length > 0) {
    const id = stack.pop()!
    if (id === parentId) return true
    if (seen.has(id)) continue
    seen.add(id)
    const c = lookup(id)
    if (!c) continue
    for (const comp of c.components) {
      if (comp.kind === 'composite') stack.push(comp.ref)
    }
  }
  return false
}

/**
 * Composites whose current definition nests `id`. A delete is blocked while
 * any exist: offering to cascade would let one tap destroy several
 * definitions.
 */
export function compositeParents(
  id: CompositeId,
  composites: readonly Composite[],
): Composite[] {
  return composites.filter(
    (c) =>
      c.id !== id &&
      c.components.some((comp) => comp.kind === 'composite' && comp.ref === id),
  )
}

/** The nesting depth of a definition, counting the root as 1. */
export function compositeDepth(
  composite: Composite,
  lookup: (id: CompositeId) => Composite | undefined,
  seen: Set<CompositeId> = new Set(),
): number {
  if (seen.has(composite.id)) return 1
  const next = new Set([...seen, composite.id])
  let deepest = 1
  for (const comp of composite.components) {
    if (comp.kind !== 'composite') continue
    const child = lookup(comp.ref)
    if (!child) continue
    deepest = Math.max(deepest, 1 + compositeDepth(child, lookup, next))
  }
  return deepest
}

/**
 * Bump a definition to a new version, preserving the old one in history so
 * instances pinned to it still resolve. The default is that past entries
 * stay as logged.
 */
export function editDefinition(
  composite: Composite,
  components: Component[],
  now = Date.now(),
): Composite {
  return {
    ...composite,
    components,
    version: composite.version + 1,
    updatedAt: now,
    history: [
      ...(composite.history ?? []),
      {
        version: composite.version,
        components: composite.components,
        replacedAt: now,
      },
    ],
  }
}

// --- Ranking --------------------------------------------------------------

export const RANKING_RECENCY_HALFLIFE_DAYS = 10
/** Half-width of the time-of-day window, in hours. */
export const RANKING_HOUR_WINDOW = 2

export type RankedComposite = {
  composite: Composite
  score: number
  usageCount: number
  lastUsedAt?: number
  /** How many past uses fell in the current hour band. */
  hourMatches: number
}

/**
 * Rank composites by recency and time-of-day likelihood from each
 * composite's own usage histogram. Ordinary statistics, no model involved --
 * this is what makes the common case one tap from the home screen.
 */
export function rankComposites(input: {
  composites: readonly Composite[]
  usage: readonly CompositeUsage[]
  now?: number
}): RankedComposite[] {
  const now = input.now ?? Date.now()
  const currentHour = new Date(now).getHours()

  const byId = new Map<CompositeId, CompositeUsage[]>()
  for (const u of input.usage) {
    const list = byId.get(u.compositeId)
    if (list) list.push(u)
    else byId.set(u.compositeId, [u])
  }

  const ranked = input.composites
    .filter((c) => !c.retired)
    .map((composite): RankedComposite => {
      const uses = byId.get(composite.id) ?? []
      let recency = 0
      let hourMatches = 0
      let lastUsedAt: number | undefined

      for (const u of uses) {
        const ageDays = (now - u.loggedAt) / 86_400_000
        // Exponential decay: a meal eaten yesterday outranks one from March.
        recency += Math.pow(0.5, ageDays / RANKING_RECENCY_HALFLIFE_DAYS)
        const h = new Date(u.loggedAt).getHours()
        if (hourDistance(h, currentHour) <= RANKING_HOUR_WINDOW) hourMatches++
        if (lastUsedAt === undefined || u.loggedAt > lastUsedAt) {
          lastUsedAt = u.loggedAt
        }
      }

      // Time-of-day weight: the share of this composite's uses that fell in
      // the current band, which is what makes breakfast rank at breakfast.
      const hourShare = uses.length > 0 ? hourMatches / uses.length : 0
      const score = recency * (1 + 2 * hourShare)

      return {
        composite,
        score,
        usageCount: uses.length,
        hourMatches,
        ...(lastUsedAt !== undefined ? { lastUsedAt } : {}),
      }
    })

  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    // Never-used composites fall back to most recently defined.
    return b.composite.updatedAt - a.composite.updatedAt
  })

  return ranked
}

function hourDistance(a: number, b: number): number {
  const d = Math.abs(a - b)
  return Math.min(d, 24 - d)
}
