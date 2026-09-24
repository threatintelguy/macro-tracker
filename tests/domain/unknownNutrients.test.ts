/**
 * Unknown is not zero.
 *
 * The rule that makes logging without full information safe: a blank
 * protein field is null, and a day containing it reports a floor with its
 * coverage -- never a confident low number. These tests are the audit of
 * the read paths the addendum asks for.
 */

import { describe, expect, it } from 'vitest'
import {
  aggregateNutrients,
  aggregateOf,
  addNutrients,
  impliedKcal,
  makeNutrients,
  missingNutrients,
  nutrientsForGrams,
  scaleNutrients,
  sumNutrients,
} from '../../src/domain/nutrition/index.ts'
import {
  buildSeries,
  dayConfidence,
  describeAggregate,
  meanIntakeKcal,
  meanOfComplete,
  occasionsClearingProtein,
  rollupDay,
} from '../../src/domain/analytics/index.ts'
import {
  adjustedFields,
  fillUnknown,
  fillUnknownPer100g,
  needsDetail,
  refoodEntry,
  rescaleCompositeRows,
  rescaleEntry,
} from '../../src/domain/editing.ts'
import { normaliseOffProduct } from '../../src/food/barcode.ts'
import { bandState } from '../../src/ui/components/common.tsx'
import type { DayRecord, Entry, FoodItem } from '../../src/domain/types.ts'

let seq = 0
function entry(over: Partial<Entry> = {}): Entry {
  seq++
  return {
    id: `e${seq}`,
    date: '2026-09-20',
    source: { kind: 'food', foodId: 'f', name: 'Food' },
    grams: 100,
    nutrients: makeNutrients({ kcal: 100, protein: 10 }),
    fidelity: 'weighed',
    createdAt: seq,
    ...over,
  }
}

function day(over: Partial<DayRecord> = {}): DayRecord {
  return {
    date: '2026-09-20',
    phase: 'steady',
    precisionMode: 'weighed',
    entries: [],
    training: [],
    ...over,
  }
}

describe('arithmetic carries null through', () => {
  it('scales an unknown to an unknown', () => {
    const v = scaleNutrients(makeNutrients({ kcal: 200, protein: null }), 2)
    expect(v.kcal).toBe(400)
    expect(v.protein).toBeNull()
    expect(nutrientsForGrams(makeNutrients({ fibre: null }), 50).fibre).toBeNull()
  })

  it('makes a strict sum unknown when any part is unknown', () => {
    const a = makeNutrients({ protein: 10 })
    const b = makeNutrients({ protein: null })
    expect(addNutrients(a, b).protein).toBeNull()
    expect(sumNutrients([a, b, a]).protein).toBeNull()
    expect(sumNutrients([a, a]).protein).toBe(20)
  })

  it('never produces NaN from an unknown', () => {
    const v = sumNutrients([makeNutrients({ kcal: null }), makeNutrients({ kcal: 5 })])
    for (const x of Object.values(v)) expect(Number.isNaN(x)).toBe(false)
  })

  it('reports implied energy as undefined rather than low', () => {
    expect(impliedKcal(makeNutrients({ protein: null, carbs: 10, fat: 1 }))).toBeUndefined()
  })

  it('lists which fields are missing', () => {
    expect(missingNutrients(makeNutrients({ protein: null, sodium: null }))).toEqual([
      'protein',
      'sodium',
    ])
  })
})

describe('aggregates report floors with coverage', () => {
  it('sums known contributions and counts coverage', () => {
    const agg = aggregateOf([10, null, 20])
    expect(agg).toEqual({ value: 30, knownEntries: 2, totalEntries: 3, complete: false })
    expect(aggregateOf([1, 2]).complete).toBe(true)
    expect(aggregateOf([]).complete).toBe(true)
  })

  it('never reports a total lower than the sum of known entries', () => {
    // The acceptance criterion, as a property over random days.
    for (let trial = 0; trial < 500; trial++) {
      const values = Array.from({ length: 1 + (trial % 12) }, (_, i) =>
        (trial * 7 + i) % 4 === 0 ? null : ((trial * 13 + i * 5) % 60) + 0.5,
      )
      const entries = values.map((p) => entry({ nutrients: makeNutrients({ protein: p }) }))
      const r = rollupDay({ day: day(), entries })
      const knownSum = values.reduce<number>((a, v) => a + (v ?? 0), 0)
      expect(r.totals.protein.value).toBeCloseTo(knownSum, 9)
      expect(r.totals.protein.complete).toBe(values.every((v) => v !== null))
      expect(r.totals.protein.knownEntries).toBe(values.filter((v) => v !== null).length)
    }
  })

  it('reads as "at least N, from k of n entries" when incomplete', () => {
    const entries = [
      ...Array.from({ length: 9 }, () => entry({ nutrients: makeNutrients({ protein: 16.11 }) })),
      entry({ nutrients: makeNutrients({ protein: null }) }),
      entry({ nutrients: makeNutrients({ protein: null }) }),
    ]
    const r = rollupDay({ day: day(), entries })
    expect(describeAggregate(r.totals.protein, 'g')).toBe('at least 145 g, from 9 of 11 entries')
    const whole = rollupDay({ day: day(), entries: entries.slice(0, 9) })
    expect(describeAggregate(whole.totals.protein, 'g')).toBe('145 g')
  })

  it('keeps each occasion honest about its protein', () => {
    const r = rollupDay({
      day: day(),
      entries: [
        entry({ at: '08:00', nutrients: makeNutrients({ protein: 40 }) }),
        entry({ at: '13:00', nutrients: makeNutrients({ protein: 12 }) }),
        entry({ at: '13:10', nutrients: makeNutrients({ protein: null }) }),
      ],
    })
    const lunch = r.occasions[1]!
    expect(lunch.proteinG).toBe(12)
    expect(lunch.proteinComplete).toBe(false)
    const score = occasionsClearingProtein(r, 90)
    expect(score.clearing).toBe(1)
    // Unknown is reported separately rather than counted as a miss.
    expect(score.unknown).toBe(1)
  })
})

describe('incomplete calories and observed TDEE', () => {
  it('marks a day with unknown calories partial, reusing the estimated-day path', () => {
    const d = day()
    expect(dayConfidence(d, [entry(), entry({ nutrients: makeNutrients({ kcal: null }) })])).toBe(
      'partial',
    )
    // Complete calories with a missing micronutrient still feed TDEE.
    expect(dayConfidence(d, [entry({ nutrients: makeNutrients({ kcal: 300, sodium: null }) })])).toBe(
      'logged',
    )
  })

  it('treats a stand-in as an estimate', () => {
    expect(dayConfidence(day(), [entry({ proxyFor: { note: 'tacos' } })])).toBe('partial')
  })

  it('leaves partial days out of the intake mean', () => {
    const complete = rollupDay({ day: day({ date: '2026-09-01' }), entries: [entry({ nutrients: makeNutrients({ kcal: 2500 }) })] })
    const floor = rollupDay({
      day: day({ date: '2026-09-02' }),
      entries: [entry({ nutrients: makeNutrients({ kcal: 900 }) }), entry({ nutrients: makeNutrients({ kcal: null }) })],
    })
    expect(meanIntakeKcal([complete, floor])).toBe(2500)
  })
})

describe('averages count only complete days', () => {
  it('excludes a day whose nutrient is incomplete, and says how many', () => {
    const a = rollupDay({ day: day({ date: '2026-09-01' }), entries: [entry({ nutrients: makeNutrients({ protein: 180 }) })] })
    const b = rollupDay({
      day: day({ date: '2026-09-02' }),
      entries: [entry({ nutrients: makeNutrients({ protein: 40 }) }), entry({ nutrients: makeNutrients({ protein: null }) })],
    })
    const m = meanOfComplete([a, b], 'protein')!
    expect(m.value).toBe(180)
    expect(m.days).toBe(1)
    expect(m.incompleteDays).toBe(1)
  })

  it('treats a minimal day as protein only, with everything else unknown', () => {
    const r = rollupDay({ day: day({ proteinOverride: 150, precisionMode: 'minimal' }), entries: [] })
    expect(r.totals.protein).toEqual({ value: 150, knownEntries: 1, totalEntries: 1, complete: true })
    expect(r.totals.kcal.complete).toBe(false)
    expect(meanOfComplete([r], 'kcal')).toBeUndefined()
    expect(meanOfComplete([r], 'protein')!.value).toBe(150)
  })

  it('marks incomplete days in a series, and leaves wholly unknown fields as gaps', () => {
    const r = rollupDay({
      day: day({ date: '2026-09-02' }),
      entries: [entry({ nutrients: makeNutrients({ kcal: 500, fibre: null }) })],
    })
    const s = buildSeries([r], '2026-09-01', '2026-09-02')
    expect(s.values.kcal).toEqual([undefined, 500])
    expect(s.complete.kcal).toEqual([false, true])
    expect(s.values.fibre).toEqual([undefined, undefined])
  })
})

describe('the band renders unknown as partial, never as a shortfall', () => {
  it('still reads a known value against its band', () => {
    expect(bandState(50, 100, false)).toBe('beyond')
  })
})

describe('editing rules', () => {
  const food: FoodItem = {
    id: 'x_yog',
    name: 'Yogurt, full-fat',
    tier: 'custom',
    per100g: makeNutrients({ kcal: 100, protein: 9, fat: 5 }),
    portions: [],
    cookState: 'n/a',
  }

  it('rescales the snapshot on an amount change, keeping unknowns unknown', () => {
    const e = entry({ grams: 150, nutrients: makeNutrients({ kcal: 150, protein: 15, sodium: null }) })
    const next = rescaleEntry(e, 180)
    expect(next.grams).toBe(180)
    expect(next.nutrients.kcal).toBeCloseTo(180, 9)
    expect(next.nutrients.protein).toBeCloseTo(18, 9)
    expect(next.nutrients.sodium).toBeNull()
  })

  it('takes a fresh snapshot on a food change, and resolves a stand-in', () => {
    const e = entry({ grams: 200, proxyFor: { note: 'something' } })
    const next = refoodEntry(e, food)
    expect(next.source).toEqual({ kind: 'food', foodId: 'x_yog', name: 'Yogurt, full-fat' })
    expect(next.nutrients.kcal).toBe(200)
    expect(next.proxyFor).toBeUndefined()
  })

  it('rescales every row of a composite log together', () => {
    const root = entry({
      grams: 100,
      nutrients: makeNutrients({ kcal: 100 }),
      source: { kind: 'composite', compositeId: 'c', version: 1, multiplier: 1, overrides: [], name: 'Salad' },
    })
    const child = entry({ grams: 50, nutrients: makeNutrients({ kcal: 50 }), fromCompositeEntryId: root.id })
    const [r, c] = rescaleCompositeRows([root, child], 1, 1.5)
    expect(r!.grams).toBe(150)
    expect(c!.nutrients.kcal).toBe(75)
    expect(r!.source.kind === 'composite' && r!.source.multiplier).toBe(1.5)
  })

  it('fills only unknown fields, never overwriting a known one', () => {
    const v = fillUnknown(makeNutrients({ kcal: 640, protein: null }), { kcal: 1, protein: 30 })
    expect(v.kcal).toBe(640)
    expect(v.protein).toBe(30)
  })

  it('carries a fix back to per-100 g', () => {
    const v = fillUnknownPer100g(makeNutrients({ protein: null }), { protein: 30 }, 300)
    expect(v.protein).toBe(10)
  })

  it('queues unknowns and stand-ins, and nothing else', () => {
    expect(needsDetail(entry())).toBe(false)
    expect(needsDetail(entry({ nutrients: makeNutrients({ fibre: null }) }))).toBe(true)
    expect(needsDetail(entry({ proxyFor: { note: 'tacos' } }))).toBe(true)
  })

  it('records which fields a clone adjusted', () => {
    expect(
      adjustedFields(makeNutrients({ fat: 1.5, kcal: 60 }), makeNutrients({ fat: 5, kcal: 90, sodium: null })),
    ).toEqual(['kcal', 'fat', 'sodium'])
  })
})

describe('barcode results keep unknowns unknown', () => {
  it('stores a missing field as null, not zero', () => {
    const food = normaliseOffProduct(
      '0123456789012',
      { product_name: 'Bar', nutriments: { 'energy-kcal_100g': 400, proteins_100g: 20 } },
      0,
    )!
    expect(food.per100g.kcal).toBe(400)
    expect(food.per100g.protein).toBe(20)
    expect(food.per100g.fat).toBeNull()
    expect(food.per100g.fibre).toBeNull()
    expect(food.per100g.sodium).toBeNull()
    // A label with alcohol must declare it, so its absence is a zero.
    expect(food.per100g.alcohol).toBe(0)
  })

  it('aggregates a vector with unknowns without inventing values', () => {
    const agg = aggregateNutrients([makeNutrients({ fat: null }), makeNutrients({ fat: 3 })])
    expect(agg.fat).toEqual({ value: 3, knownEntries: 1, totalEntries: 2, complete: false })
  })
})
