import { describe, expect, it } from 'vitest'
import {
  MAX_COMPOSITE_DEPTH,
  componentsAtVersion,
  compositeDepth,
  editDefinition,
  rankComposites,
  resolveComposite,
  resolveCompositeInstance,
  wouldCycle,
} from '../../src/domain/composites/index.ts'
import type {
  Composite,
  CompositeInstance,
  FoodItem,
  NutrientVector,
} from '../../src/domain/types.ts'
import { makeNutrients } from '../../src/domain/nutrition/index.ts'

function food(id: string, name: string, per100g: Partial<NutrientVector>): FoodItem {
  return {
    id,
    name,
    tier: 'curated',
    per100g: makeNutrients(per100g),
    portions: [],
    cookState: 'n/a',
  }
}

const FOODS: FoodItem[] = [
  food('f_salmon', 'Salmon', { kcal: 206, protein: 22.1, fat: 12.4, satFat: 2.5 }),
  food('f_chicken', 'Chicken breast', { kcal: 165, protein: 31, fat: 3.6, satFat: 1 }),
  food('f_spinach', 'Spinach', { kcal: 23, protein: 2.9, carbs: 3.6, fibre: 2.2 }),
  food('f_oil', 'Olive oil', { kcal: 884, fat: 100, satFat: 13.8 }),
  food('f_seeds', 'Pumpkin seeds', { kcal: 559, protein: 30.2, fat: 49.1 }),
  food('f_rice', 'Rice, cooked', { kcal: 130, protein: 2.7, carbs: 28.2 }),
]

function makeComposite(
  id: string,
  name: string,
  components: Composite['components'],
): Composite {
  return {
    id,
    name,
    version: 1,
    components,
    createdAt: 1,
    updatedAt: 1,
  }
}

const SALAD = makeComposite('c_salad', 'Lincoln salad', [
  { kind: 'food', ref: { kind: 'food', foodId: 'f_spinach', name: 'Spinach' }, grams: 100 },
  { kind: 'food', ref: { kind: 'food', foodId: 'f_salmon', name: 'Salmon' }, grams: 150 },
  { kind: 'food', ref: { kind: 'food', foodId: 'f_oil', name: 'Olive oil' }, grams: 10 },
  { kind: 'food', ref: { kind: 'food', foodId: 'f_seeds', name: 'Pumpkin seeds' }, grams: 15 },
])

function lookups(composites: Composite[] = [SALAD]) {
  const f = new Map(FOODS.map((x) => [x.id, x]))
  const c = new Map(composites.map((x) => [x.id, x]))
  return { food: (id: string) => f.get(id), composite: (id: string) => c.get(id) }
}

function instance(over: Partial<CompositeInstance> = {}): CompositeInstance {
  return {
    kind: 'composite',
    compositeId: 'c_salad',
    version: 1,
    multiplier: 1,
    overrides: [],
    name: 'Lincoln salad',
    ...over,
  }
}

describe('resolution', () => {
  it('flattens a definition into rows with snapshotted nutrients', () => {
    const r = resolveCompositeInstance(instance(), lookups())
    expect(r.problems).toEqual([])
    expect(r.rows).toHaveLength(4)
    expect(r.totalGrams).toBe(275)
    // 100g spinach + 150g salmon + 10g oil + 15g seeds
    const expectedKcal = 23 + 206 * 1.5 + 884 * 0.1 + 559 * 0.15
    expect(r.totals.kcal).toBeCloseTo(expectedKcal, 4)
    expect(r.totals.protein).toBeCloseTo(2.9 + 22.1 * 1.5 + 30.2 * 0.15, 4)
  })

  it('scales by the multiplier without touching the definition', () => {
    const single = resolveCompositeInstance(instance(), lookups())
    const half = resolveCompositeInstance(instance({ multiplier: 0.5 }), lookups())
    const double = resolveCompositeInstance(instance({ multiplier: 2 }), lookups())

    expect(half.totals.kcal).toBeCloseTo(single.totals.kcal / 2, 6)
    expect(double.totalGrams).toBeCloseTo(single.totalGrams * 2, 6)
    // The stored definition is unchanged.
    expect(SALAD.components[1]).toMatchObject({ grams: 150 })
  })

  it('skips a component without creating a second composite', () => {
    const r = resolveCompositeInstance(
      instance({ overrides: [{ componentIndex: 3, action: 'skip' }] }),
      lookups(),
    )
    expect(r.rows).toHaveLength(3)
    expect(r.rows.some((row) => row.name === 'Pumpkin seeds')).toBe(false)
    expect(SALAD.components).toHaveLength(4)
  })

  it('swaps a component in place', () => {
    const r = resolveCompositeInstance(
      instance({
        overrides: [
          {
            componentIndex: 1,
            action: 'swap',
            ref: { kind: 'food', foodId: 'f_chicken', name: 'Chicken breast' },
          },
        ],
      }),
      lookups(),
    )
    const swapped = r.rows.find((row) => row.name === 'Chicken breast')
    expect(swapped).toBeDefined()
    // Keeps the original gram amount unless the override states one.
    expect(swapped!.grams).toBe(150)
    expect(swapped!.overridden).toBe(true)
    expect(r.rows.some((row) => row.name === 'Salmon')).toBe(false)
  })

  it('swaps with an explicit gram amount when given one', () => {
    const r = resolveCompositeInstance(
      instance({
        overrides: [
          {
            componentIndex: 1,
            action: 'swap',
            ref: { kind: 'food', foodId: 'f_chicken', name: 'Chicken breast' },
            grams: 200,
          },
        ],
      }),
      lookups(),
    )
    expect(r.rows.find((row) => row.name === 'Chicken breast')!.grams).toBe(200)
  })

  it('regrams one component', () => {
    const r = resolveCompositeInstance(
      instance({ overrides: [{ componentIndex: 1, action: 'regram', grams: 200 }] }),
      lookups(),
    )
    const salmon = r.rows.find((row) => row.name === 'Salmon')!
    expect(salmon.grams).toBe(200)
    expect(salmon.nutrients.protein).toBeCloseTo(22.1 * 2, 4)
  })

  it('applies the multiplier on top of an override', () => {
    const r = resolveCompositeInstance(
      instance({
        multiplier: 2,
        overrides: [{ componentIndex: 1, action: 'regram', grams: 100 }],
      }),
      lookups(),
    )
    expect(r.rows.find((row) => row.name === 'Salmon')!.grams).toBe(200)
  })

  it('resolves nested composites recursively', () => {
    const dinner = makeComposite('c_dinner', 'Tuesday dinner', [
      { kind: 'composite', ref: 'c_salad', multiplier: 1 },
      { kind: 'food', ref: { kind: 'food', foodId: 'f_rice', name: 'Rice, cooked' }, grams: 200 },
    ])
    const r = resolveCompositeInstance(
      instance({ compositeId: 'c_dinner', name: 'Tuesday dinner' }),
      lookups([SALAD, dinner]),
    )
    expect(r.problems).toEqual([])
    expect(r.rows).toHaveLength(5)
    expect(r.totalGrams).toBe(475)
    // The path records which composite each row came from.
    const spinach = r.rows.find((row) => row.name === 'Spinach')!
    expect(spinach.path).toEqual(['Tuesday dinner', 'Lincoln salad'])
  })

  it('multiplies through a nested composite', () => {
    const dinner = makeComposite('c_dinner', 'Tuesday dinner', [
      { kind: 'composite', ref: 'c_salad', multiplier: 0.5 },
    ])
    const r = resolveCompositeInstance(
      instance({ compositeId: 'c_dinner', name: 'Tuesday dinner', multiplier: 2 }),
      lookups([SALAD, dinner]),
    )
    // 0.5 nested x 2 instance = 1x the salad.
    expect(r.totalGrams).toBe(275)
  })
})

describe('guards', () => {
  it('detects a self-referencing composite rather than looping forever', () => {
    const selfRef = makeComposite('c_self', 'Self', [
      { kind: 'composite', ref: 'c_self', multiplier: 1 },
      { kind: 'food', ref: { kind: 'food', foodId: 'f_rice', name: 'Rice, cooked' }, grams: 100 },
    ])
    const r = resolveCompositeInstance(
      instance({ compositeId: 'c_self', name: 'Self' }),
      lookups([selfRef]),
    )
    expect(r.problems.some((p) => p.kind === 'cycle')).toBe(true)
    // The non-cyclic part still resolves.
    expect(r.rows).toHaveLength(1)
  })

  it('detects an indirect cycle', () => {
    const a = makeComposite('c_a', 'A', [{ kind: 'composite', ref: 'c_b', multiplier: 1 }])
    const b = makeComposite('c_b', 'B', [{ kind: 'composite', ref: 'c_a', multiplier: 1 }])
    const r = resolveCompositeInstance(
      instance({ compositeId: 'c_a', name: 'A' }),
      lookups([a, b]),
    )
    expect(r.problems.some((p) => p.kind === 'cycle')).toBe(true)
  })

  it('caps nesting depth', () => {
    const chain: Composite[] = []
    for (let i = 0; i < 8; i++) {
      chain.push(
        makeComposite(`c_${i}`, `Level ${i}`, [
          i < 7
            ? { kind: 'composite', ref: `c_${i + 1}`, multiplier: 1 }
            : {
                kind: 'food',
                ref: { kind: 'food', foodId: 'f_rice', name: 'Rice, cooked' },
                grams: 100,
              },
        ]),
      )
    }
    const r = resolveCompositeInstance(
      instance({ compositeId: 'c_0', name: 'Level 0' }),
      lookups(chain),
    )
    expect(r.problems.some((p) => p.kind === 'depth')).toBe(true)
    expect(r.rows).toHaveLength(0)
  })

  it('refuses a cycle at the editor, before it can be stored', () => {
    const a = makeComposite('c_a', 'A', [{ kind: 'composite', ref: 'c_b', multiplier: 1 }])
    const b = makeComposite('c_b', 'B', [])
    const look = (id: string) => ({ c_a: a, c_b: b })[id as 'c_a' | 'c_b']
    expect(wouldCycle('c_b', 'c_a', look)).toBe(true)
    expect(wouldCycle('c_a', 'c_a', look)).toBe(true)
    expect(wouldCycle('c_a', 'c_b', look)).toBe(false)
  })

  it('reports depth so the editor can refuse an over-deep nest', () => {
    const inner = makeComposite('c_i', 'Inner', [])
    const mid = makeComposite('c_m', 'Mid', [
      { kind: 'composite', ref: 'c_i', multiplier: 1 },
    ])
    const outer = makeComposite('c_o', 'Outer', [
      { kind: 'composite', ref: 'c_m', multiplier: 1 },
    ])
    const look = (id: string) =>
      ({ c_i: inner, c_m: mid, c_o: outer })[id as 'c_i' | 'c_m' | 'c_o']
    expect(compositeDepth(outer, look)).toBe(3)
    expect(compositeDepth(inner, look)).toBe(1)
    expect(MAX_COMPOSITE_DEPTH).toBe(4)
  })

  it('names a missing food rather than silently dropping it', () => {
    const c = makeComposite('c_x', 'X', [
      { kind: 'food', ref: { kind: 'food', foodId: 'f_gone', name: 'Deleted food' }, grams: 50 },
    ])
    const r = resolveCompositeInstance(
      instance({ compositeId: 'c_x', name: 'X' }),
      lookups([c]),
    )
    expect(r.problems.some((p) => p.kind === 'missing-food')).toBe(true)
    // The row survives at zero nutrients so the meal is still visible.
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0]!.nutrients.kcal).toBe(0)
  })

  it('reports a missing composite rather than resolving to nothing silently', () => {
    const r = resolveCompositeInstance(
      instance({ compositeId: 'c_gone', name: 'Gone' }),
      lookups(),
    )
    expect(r.problems[0]!.kind).toBe('missing-composite')
    expect(r.rows).toEqual([])
  })
})

describe('versioning', () => {
  it('bumps the version and preserves the old definition', () => {
    const edited = editDefinition(
      SALAD,
      [
        {
          kind: 'food',
          ref: { kind: 'food', foodId: 'f_chicken', name: 'Chicken breast' },
          grams: 200,
        },
      ],
      2000,
    )
    expect(edited.version).toBe(2)
    expect(edited.history).toHaveLength(1)
    expect(edited.history![0]!.version).toBe(1)
    expect(componentsAtVersion(edited, 1)).toHaveLength(4)
    expect(componentsAtVersion(edited, 2)).toHaveLength(1)
  })

  it('leaves a past instance pinned to the definition it was logged against', () => {
    const edited = editDefinition(SALAD, [], 2000)
    const oldInstance = resolveCompositeInstance(
      instance({ version: 1 }),
      lookups([edited]),
    )
    // The old instance still resolves to the four original components.
    expect(oldInstance.rows).toHaveLength(4)
    expect(oldInstance.problems).toEqual([])

    const newInstance = resolveCompositeInstance(
      instance({ version: 2 }),
      lookups([edited]),
    )
    expect(newInstance.rows).toHaveLength(0)
  })

  it('reports a version it can no longer reconstruct', () => {
    const r = resolveCompositeInstance(instance({ version: 99 }), lookups())
    expect(r.problems[0]!.kind).toBe('missing-version')
    expect(r.rows).toEqual([])
  })

  it('resolves a bare definition for the editor preview', () => {
    const r = resolveComposite(SALAD, lookups(), 1.5)
    expect(r.totalGrams).toBeCloseTo(412.5, 6)
  })
})

describe('ranking', () => {
  const NOW = new Date('2026-09-20T08:00:00').getTime()
  const DAY = 86_400_000
  const HOUR = 3_600_000

  const breakfast = makeComposite('c_breakfast', 'Oats and eggs', [])
  const dinner = makeComposite('c_dinner', 'Tuesday dinner', [])

  it('ranks a composite eaten at this hour above one eaten at another', () => {
    const usage = [
      // Breakfast: every morning at 08:00 for a week.
      ...Array.from({ length: 7 }, (_, i) => ({
        compositeId: 'c_breakfast',
        loggedAt: NOW - (i + 1) * DAY,
      })),
      // Dinner: every evening at 19:00 for a week.
      ...Array.from({ length: 7 }, (_, i) => ({
        compositeId: 'c_dinner',
        loggedAt: NOW - (i + 1) * DAY + 11 * HOUR,
      })),
    ]
    const ranked = rankComposites({
      composites: [dinner, breakfast],
      usage,
      now: NOW,
    })
    expect(ranked[0]!.composite.id).toBe('c_breakfast')
    expect(ranked[0]!.hourMatches).toBe(7)
  })

  it('decays recency so a stale composite falls behind a fresh one', () => {
    const usage = [
      { compositeId: 'c_breakfast', loggedAt: NOW - 200 * DAY },
      { compositeId: 'c_dinner', loggedAt: NOW - 1 * DAY },
    ]
    const ranked = rankComposites({
      composites: [breakfast, dinner],
      usage,
      now: NOW,
    })
    expect(ranked[0]!.composite.id).toBe('c_dinner')
  })

  it('reports usage counts and last-used dates for library management', () => {
    const usage = [
      { compositeId: 'c_breakfast', loggedAt: NOW - 2 * DAY },
      { compositeId: 'c_breakfast', loggedAt: NOW - 1 * DAY },
    ]
    const ranked = rankComposites({ composites: [breakfast, dinner], usage, now: NOW })
    const b = ranked.find((r) => r.composite.id === 'c_breakfast')!
    expect(b.usageCount).toBe(2)
    expect(b.lastUsedAt).toBe(NOW - 1 * DAY)
    const d = ranked.find((r) => r.composite.id === 'c_dinner')!
    expect(d.usageCount).toBe(0)
    expect(d.lastUsedAt).toBeUndefined()
  })

  it('omits retired composites', () => {
    const ranked = rankComposites({
      composites: [{ ...breakfast, retired: true }, dinner],
      usage: [],
      now: NOW,
    })
    expect(ranked.map((r) => r.composite.id)).toEqual(['c_dinner'])
  })

  it('returns never-used composites rather than hiding them', () => {
    const ranked = rankComposites({
      composites: [breakfast, dinner],
      usage: [],
      now: NOW,
    })
    expect(ranked).toHaveLength(2)
    expect(ranked.every((r) => r.score === 0)).toBe(true)
  })
})
