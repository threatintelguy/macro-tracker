/**
 * Persistence tests against fake-indexeddb, which is the real IndexedDB
 * algorithm over an in-memory store -- so transactions, key ranges and index
 * behaviour are exercised rather than mocked.
 */

import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, defaultSettings, SCHEMA_VERSION } from '../../src/data/db.ts'
import {
  addEntries,
  addEntry,
  deleteCompositeLog,
  deleteEntry,
  ensureDay,
  ensureDayRange,
  getActiveGoal,
  getDaysBetween,
  getEntriesForDay,
  getRollup,
  getRollupsBetween,
  getWeightReadings,
  invalidateAllRollups,
  latestWeightKg,
  logCompositeInstance,
  putComposite,
  putFoods,
  recordBackup,
  recordCounts,
  recordCompositeUsage,
  setActiveGoal,
  setWeight,
  saveSettings,
  getSettings,
  updateEntry,
} from '../../src/data/repositories.ts'
import { curatedFoods } from '../../src/food/curated.ts'
import { resetRegistry } from '../../src/food/registry.ts'
import { makeNutrients } from '../../src/domain/nutrition/index.ts'
import type { Composite, CompositeInstance } from '../../src/domain/types.ts'

const SALAD: Composite = {
  id: 'c_salad',
  name: 'Lincoln salad',
  version: 1,
  components: [
    { kind: 'food', ref: { kind: 'food', foodId: 'c_spinach_raw', name: 'Spinach, raw' }, grams: 100 },
    { kind: 'food', ref: { kind: 'food', foodId: 'c_salmon_cooked', name: 'Salmon, Atlantic, cooked' }, grams: 150 },
    { kind: 'food', ref: { kind: 'food', foodId: 'c_olive_oil', name: 'Olive oil' }, grams: 10 },
  ],
  createdAt: 1,
  updatedAt: 1,
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

beforeEach(async () => {
  await db.delete()
  await db.open()
  invalidateAllRollups()
  resetRegistry()
  await putFoods(curatedFoods())
  await saveSettings(defaultSettings())
})

describe('days and entries', () => {
  it('creates a day once and returns the existing one after', async () => {
    const a = await ensureDay('2026-09-20', 'calibration', 'weighed')
    const b = await ensureDay('2026-09-20', 'steady', 'minimal')
    expect(b.phase).toBe('calibration')
    expect(b.precisionMode).toBe('weighed')
    expect(a.date).toBe(b.date)
    expect(await db.days.count()).toBe(1)
  })

  it('adds an entry and links it to its day', async () => {
    await ensureDay('2026-09-20', 'calibration', 'weighed')
    const entry = await addEntry({
      date: '2026-09-20',
      source: { kind: 'food', foodId: 'c_oats_dry', name: 'Oats, rolled, dry' },
      grams: 80,
      nutrients: makeNutrients({ kcal: 303, protein: 10.6 }),
      fidelity: 'weighed',
      at: '08:00',
    })
    const day = await db.days.get('2026-09-20')
    expect(day!.entries).toEqual([entry.id])
    expect(await getEntriesForDay('2026-09-20')).toHaveLength(1)
  })

  it('adds several entries in one transaction', async () => {
    await ensureDay('2026-09-20', 'calibration', 'weighed')
    const entries = await addEntries(
      [80, 120, 60].map((grams, i) => ({
        date: '2026-09-20',
        source: { kind: 'food' as const, foodId: 'c_oats_dry', name: 'Oats' },
        grams,
        nutrients: makeNutrients({ kcal: grams * 3 }),
        fidelity: 'weighed' as const,
        at: `0${8 + i}:00`,
      })),
    )
    expect(entries).toHaveLength(3)
    const day = await db.days.get('2026-09-20')
    expect(day!.entries).toHaveLength(3)
    // Ids are unique even when created in the same millisecond.
    expect(new Set(entries.map((e) => e.id)).size).toBe(3)
  })

  it('removes an entry from its day when deleted', async () => {
    await ensureDay('2026-09-20', 'calibration', 'weighed')
    const entry = await addEntry({
      date: '2026-09-20',
      source: { kind: 'food', foodId: 'c_oats_dry', name: 'Oats' },
      grams: 80,
      nutrients: makeNutrients({ kcal: 303 }),
      fidelity: 'weighed',
    })
    await deleteEntry(entry.id)
    const day = await db.days.get('2026-09-20')
    expect(day!.entries).toEqual([])
    expect(await getEntriesForDay('2026-09-20')).toHaveLength(0)
  })

  it('edits an entry and invalidates the day it belongs to', async () => {
    await ensureDay('2026-09-20', 'calibration', 'weighed')
    const entry = await addEntry({
      date: '2026-09-20',
      source: { kind: 'food', foodId: 'c_oats_dry', name: 'Oats' },
      grams: 80,
      nutrients: makeNutrients({ kcal: 300 }),
      fidelity: 'weighed',
    })
    const before = await getRollup('2026-09-20')
    expect(before!.totals.kcal).toBe(300)

    await updateEntry(entry.id, { grams: 160, nutrients: makeNutrients({ kcal: 600 }) })
    const after = await getRollup('2026-09-20')
    expect(after!.totals.kcal).toBe(600)
  })

  it('fills a date range with empty days for backfill', async () => {
    await ensureDayRange('2026-09-01', '2026-09-07', 'calibration', 'weighed')
    const days = await getDaysBetween('2026-09-01', '2026-09-07')
    expect(days).toHaveLength(7)
    // Running it again does not duplicate or overwrite.
    await ensureDayRange('2026-09-01', '2026-09-07', 'steady', 'minimal')
    const again = await getDaysBetween('2026-09-01', '2026-09-07')
    expect(again).toHaveLength(7)
    expect(again[0]!.phase).toBe('calibration')
  })
})

describe('rollups', () => {
  it('memoises and invalidates on edit', async () => {
    await ensureDay('2026-09-20', 'calibration', 'weighed')
    await addEntry({
      date: '2026-09-20',
      source: { kind: 'food', foodId: 'c_oats_dry', name: 'Oats' },
      grams: 80,
      nutrients: makeNutrients({ kcal: 300, protein: 10 }),
      fidelity: 'weighed',
    })
    const first = await getRollup('2026-09-20')
    const second = await getRollup('2026-09-20')
    // Same object: served from the memoised cache.
    expect(second).toBe(first)

    await addEntry({
      date: '2026-09-20',
      source: { kind: 'food', foodId: 'c_egg_whole', name: 'Egg' },
      grams: 100,
      nutrients: makeNutrients({ kcal: 143, protein: 12.6 }),
      fidelity: 'weighed',
    })
    const third = await getRollup('2026-09-20')
    expect(third).not.toBe(first)
    expect(third!.totals.kcal).toBe(443)
  })

  it('rolls up a range in one pass', async () => {
    for (const d of ['2026-09-18', '2026-09-19', '2026-09-20']) {
      await ensureDay(d, 'calibration', 'weighed')
      await addEntry({
        date: d,
        source: { kind: 'food', foodId: 'c_oats_dry', name: 'Oats' },
        grams: 100,
        nutrients: makeNutrients({ kcal: 379, protein: 13.2 }),
        fidelity: 'weighed',
      })
    }
    const rollups = await getRollupsBetween('2026-09-18', '2026-09-20')
    expect(rollups).toHaveLength(3)
    expect(rollups.map((r) => r.date)).toEqual([
      '2026-09-18',
      '2026-09-19',
      '2026-09-20',
    ])
    expect(rollups.every((r) => r.confidence === 'logged')).toBe(true)
  })

  it('returns nothing for a day that does not exist', async () => {
    expect(await getRollup('2026-01-01')).toBeUndefined()
  })
})

describe('composite logging', () => {
  beforeEach(async () => {
    await putComposite(SALAD)
    await ensureDay('2026-09-20', 'calibration', 'weighed')
  })

  it('writes one row per component with snapshotted nutrients', async () => {
    const { entries, problems } = await logCompositeInstance({
      instance: instance(),
      date: '2026-09-20',
      at: '19:00',
    })
    expect(problems).toEqual([])
    expect(entries).toHaveLength(3)

    const rollup = await getRollup('2026-09-20')
    // 100 g spinach + 150 g salmon + 10 g oil, from the curated table.
    const expected = 23 + 206 * 1.5 + 884 * 0.1
    expect(rollup!.totals.kcal).toBeCloseTo(expected, 4)
    expect(rollup!.occasions).toHaveLength(1)
  })

  it('keeps the composite instance on the first row for grouping', async () => {
    const { entries } = await logCompositeInstance({
      instance: instance({ multiplier: 1.5 }),
      date: '2026-09-20',
    })
    expect(entries[0]!.source.kind).toBe('composite')
    expect(entries[1]!.fromCompositeEntryId).toBe(entries[0]!.id)
    expect(entries[2]!.fromCompositeEntryId).toBe(entries[0]!.id)
  })

  it('records usage so ranking has something to read', async () => {
    await logCompositeInstance({ instance: instance(), date: '2026-09-20' })
    const usage = await db.compositeUsage.toArray()
    expect(usage).toHaveLength(1)
    expect(usage[0]!.compositeId).toBe('c_salad')
  })

  it('deletes every row one composite log produced', async () => {
    const { entries } = await logCompositeInstance({
      instance: instance(),
      date: '2026-09-20',
    })
    await deleteCompositeLog(entries[0]!.id)
    expect(await getEntriesForDay('2026-09-20')).toHaveLength(0)
    const day = await db.days.get('2026-09-20')
    expect(day!.entries).toEqual([])
  })

  it('applies an override without touching the stored definition', async () => {
    const { entries } = await logCompositeInstance({
      instance: instance({ overrides: [{ componentIndex: 2, action: 'skip' }] }),
      date: '2026-09-20',
    })
    expect(entries).toHaveLength(2)
    const stored = await db.composites.get('c_salad')
    expect(stored!.components).toHaveLength(3)
    expect(stored!.version).toBe(1)
  })

  it('resolves curated foods that were never written to the foods table', async () => {
    // Regression: the curated table is bundled with the app, not stored in
    // IndexedDB. Resolving components from the foods table alone made every
    // curated component land at zero nutrients -- silently wrong data in a
    // table that is never recomputed.
    await db.foods.clear()
    resetRegistry()

    const { entries, problems } = await logCompositeInstance({
      instance: instance(),
      date: '2026-09-20',
    })

    expect(problems).toEqual([])
    expect(entries).toHaveLength(3)
    for (const e of entries) {
      expect(e.nutrients.kcal, e.source.name).toBeGreaterThan(0)
    }
    const rollup = await getRollup('2026-09-20')
    expect(rollup!.totals.kcal).toBeCloseTo(23 + 206 * 1.5 + 884 * 0.1, 4)
  })

  it('refuses the meal rather than writing rows at zero nutrients', async () => {
    // A component pointing at a food that genuinely does not exist must not
    // produce a zero row that later reads as a real, very light meal.
    await putComposite({
      ...SALAD,
      id: 'c_broken',
      name: 'Broken',
      components: [
        {
          kind: 'food',
          ref: { kind: 'food', foodId: 'f_does_not_exist', name: 'Ghost food' },
          grams: 100,
        },
      ],
    })

    const { entries, problems } = await logCompositeInstance({
      instance: instance({ compositeId: 'c_broken', name: 'Broken' }),
      date: '2026-09-20',
    })

    expect(entries).toEqual([])
    expect(problems.join(' ')).toContain('Ghost food')
    expect(await getEntriesForDay('2026-09-20')).toHaveLength(0)
  })

  it('reports a problem rather than writing a broken meal', async () => {
    const { entries, problems } = await logCompositeInstance({
      instance: instance({ compositeId: 'c_missing', name: 'Gone' }),
      date: '2026-09-20',
    })
    expect(entries).toEqual([])
    expect(problems.length).toBeGreaterThan(0)
    expect(await getEntriesForDay('2026-09-20')).toHaveLength(0)
  })

  it('counts usage per composite', async () => {
    await recordCompositeUsage('c_salad', 1000)
    await recordCompositeUsage('c_salad', 2000)
    const rows = await db.compositeUsage.where('compositeId').equals('c_salad').toArray()
    expect(rows).toHaveLength(2)
  })
})

describe('weight', () => {
  it('stores a reading against its day and reads it back in order', async () => {
    for (const [date, kg] of [
      ['2026-09-18', 85.8],
      ['2026-09-20', 85.4],
      ['2026-09-19', 85.0],
    ] as const) {
      await ensureDay(date, 'calibration', 'weighed')
      await setWeight(date, kg, '07:10')
    }
    const readings = await getWeightReadings()
    expect(readings.map((r) => r.date)).toEqual([
      '2026-09-18',
      '2026-09-19',
      '2026-09-20',
    ])
    expect(await latestWeightKg()).toBe(85.4)
  })

  it('ignores days with no reading', async () => {
    await ensureDay('2026-09-20', 'calibration', 'weighed')
    expect(await getWeightReadings()).toEqual([])
    expect(await latestWeightKg()).toBeUndefined()
  })

  it('invalidates the rollup when a weight is entered', async () => {
    await ensureDay('2026-09-20', 'calibration', 'weighed')
    const before = await getRollup('2026-09-20')
    expect(before!.weightKg).toBeUndefined()
    await setWeight('2026-09-20', 85.4)
    const after = await getRollup('2026-09-20')
    expect(after!.weightKg).toBe(85.4)
  })
})

describe('goals and settings', () => {
  it('keeps exactly one goal active', async () => {
    await setActiveGoal({
      direction: 'loss',
      targetRateKgPerWeek: -0.35,
      startDate: '2026-09-01',
      anchorWeightKg: 85.0,
      active: true,
      createdAt: 1,
    })
    await setActiveGoal({
      direction: 'maintain',
      targetRateKgPerWeek: 0,
      startDate: '2026-10-01',
      anchorWeightKg: 91,
      active: true,
      createdAt: 2,
    })
    const all = await db.goals.toArray()
    expect(all).toHaveLength(2)
    expect(all.filter((g) => g.active)).toHaveLength(1)
    expect((await getActiveGoal())!.direction).toBe('maintain')
  })

  it('creates default settings on first read', async () => {
    await db.settings.clear()
    const s = await getSettings()
    expect(s.preset).toBe('fatLoss')
    expect(s.barcodeLookupEnabled).toBe(true)
    expect(s.secondary.fibreG).toBe(38)
    // Persisted, so a second read returns the same row.
    expect(await db.settings.count()).toBe(1)
  })
})

describe('backup bookkeeping', () => {
  it('counts records for the export header', async () => {
    await ensureDay('2026-09-20', 'calibration', 'weighed')
    await putComposite(SALAD)
    const counts = await recordCounts()
    expect(counts.days).toBe(1)
    expect(counts.composites).toBe(1)
    expect(counts.foods).toBeGreaterThan(140)
  })

  it('records a backup and stamps the profile', async () => {
    await db.profile.put({
      id: 'profile',
      sex: 'male',
      birthYear: 1983,
      heightCm: 180.0,
      activityLevel: 'moderate',
      startDate: '2026-09-01',
      phase: 'calibration',
      phaseStartDate: '2026-09-01',
      precisionMode: 'weighed',
      units: 'metric',
      offlineMode: false,
      theme: 'dark',
    })
    await recordBackup({
      recordCounts: await recordCounts(),
      encrypted: true,
      schemaVersion: SCHEMA_VERSION,
    })
    const profile = await db.profile.get('profile')
    expect(profile!.lastBackupAt).toBeDefined()
    expect(await db.backups.count()).toBe(1)
  })
})
