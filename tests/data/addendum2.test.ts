/**
 * Addendum 2, against the real IndexedDB algorithm (fake-indexeddb).
 *
 * Migrations E and F, the round trip with the new fidelity and source
 * fields, accepting an estimate, re-resolving it later, photos, and the
 * library writing every accepted online result locally for good.
 */

import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { beforeEach, describe, expect, it } from 'vitest'
import { MacroDb, db, defaultSettings } from '../../src/data/db.ts'
import * as repo from '../../src/data/repositories.ts'
import {
  collectPayload,
  commitImport,
  identifyFile,
  parseImport,
  planForImport,
  writePayload,
} from '../../src/data/transfer.ts'
import { acceptEstimate } from '../../src/data/estimates.ts'
import { parsePayload, payloadToJson, readJsonBackup, writeBackup, type BackupPayload } from '../../src/export/backup.ts'
import { resetRegistry } from '../../src/food/registry.ts'
import { curatedFoods } from '../../src/food/curated.ts'
import { makeNutrients } from '../../src/domain/nutrition/index.ts'
import { buildDraft, makeLibraryMatcher, type ModelOutput } from '../../src/estimate/pipeline.ts'
import { FoodSearchIndex } from '../../src/food/search.ts'
import { SCHEMA_VERSION } from '../../src/domain/schema.ts'
import type { FoodItem } from '../../src/domain/types.ts'
import * as store from '../../src/ui/store.ts'

const PROV = { tier: 'external' as const, model: 'test-model', at: '2026-10-07T12:00:00.000Z' }

const MODEL: ModelOutput = {
  components: [
    { name: 'Oats, rolled, dry', grams: 80, per100g: { kcal: 380, protein: 13, carbs: 67, fat: 7, satFat: 1, fibre: 10, sodium: 2 } },
    { name: 'carnitas', grams: 150, per100g: { kcal: 250, protein: 25, carbs: 0, fat: 16, satFat: 6, fibre: 0, sodium: 600 } },
  ],
  preparation: {
    description: 'Oil and salt',
    grams: 12,
    nutrients: { kcal: 90, protein: 0, carbs: 0, fat: 10, satFat: 2, fibre: 0, sodium: 900 },
  },
}

function index(): FoodSearchIndex {
  const idx = new FoodSearchIndex()
  idx.add(curatedFoods())
  return idx
}

async function seedProfile(): Promise<void> {
  await repo.saveProfile({
    id: 'profile',
    sex: 'male',
    birthYear: 1983,
    heightCm: 180,
    activityLevel: 'moderate',
    startDate: '2026-09-01',
    phase: 'calibration',
    phaseStartDate: '2026-09-01',
    precisionMode: 'weighed',
    units: 'metric',
    offlineMode: false,
    theme: 'dark',
  })
}

async function acceptSample(date = '2026-10-01') {
  const draft = buildDraft({
    output: MODEL,
    request: { description: 'carnitas bowl', pinned: [] },
    match: makeLibraryMatcher(index()),
    provenance: PROV,
  })
  return acceptEstimate({ name: 'Carnitas bowl', lines: draft.lines, provenance: PROV, date, at: '13:00' })
}

function comparable(p: BackupPayload): Omit<BackupPayload, 'exportedAt'> {
  const { exportedAt: _e, ...rest } = p
  return rest
}

beforeEach(async () => {
  await db.delete()
  await db.open()
  repo.invalidateAllRollups()
  resetRegistry()
  repo.setDayFactory((date) => repo.emptyDay(date, 'calibration', 'weighed'))
  await repo.saveSettings(defaultSettings())
})

describe('accepting an estimate', () => {
  it('logs every row at ai_estimated, with provenance and per-line sources', async () => {
    const result = await acceptSample()
    expect(result.problems).toEqual([])
    expect(result.entries).toHaveLength(3)
    for (const e of result.entries) {
      expect(e.fidelity).toBe('ai_estimated')
      expect(e.estimateSource).toEqual(PROV)
    }
    expect(result.entries.map((e) => e.lineSource)).toEqual(['db', 'model', 'prep'])
    // The library line took database values, not the model's 380 kcal/100 g.
    const oats = curatedFoods().find((f) => f.name === 'Oats, rolled, dry')!
    expect(result.entries[0]!.nutrients.kcal).toBeCloseTo(oats.per100g.kcal! * 0.8)
    expect(result.entries[2]!.nutrients.sodium).toBeCloseTo(900)
  })

  it('saves a reusable composite, so the next visit is two taps', async () => {
    const { composite } = await acceptSample()
    expect(composite.estimateSource).toEqual(PROV)
    const again = await repo.logCompositeInstance({
      instance: {
        kind: 'composite',
        compositeId: composite.id,
        version: 1,
        multiplier: 1,
        overrides: [],
        name: composite.name,
      },
      date: '2026-10-02',
    })
    // Logged again from the library, it is still an estimate.
    expect(again.entries.every((e) => e.fidelity === 'ai_estimated')).toBe(true)
    expect(again.entries.map((e) => e.lineSource)).toEqual(['db', 'model', 'prep'])
    const rollup = await repo.getRollup('2026-10-02')
    expect(rollup!.confidence).toBe('partial')
  })

  it('offers to re-resolve a model line once the library has the food, and only then', async () => {
    const { entries } = await acceptSample()
    const model = entries.find((e) => e.lineSource === 'model')!
    expect((await repo.modelLineEntries()).map((e) => e.id)).toEqual([model.id])

    const carnitas: FoodItem = {
      id: 'x_carnitas',
      name: 'Carnitas',
      tier: 'custom',
      origin: 'custom',
      per100g: makeNutrients({ kcal: 230, protein: 27, carbs: 0, fat: 13 }),
      portions: [],
      cookState: 'n/a',
    }
    const idx = index()
    idx.add([carnitas])
    // The model-made food never matches itself; the real one does.
    expect(makeLibraryMatcher(idx)('Carnitas')?.id).toBe('x_carnitas')

    const before = await repo.getRollup(model.date)
    const dates = await repo.reresolveEstimatedLine(model.id, carnitas)
    expect(dates).toEqual([model.date])
    const after = (await repo.getEntriesForDay(model.date)).find((e) => e.id === model.id)!
    expect(after.lineSource).toBe('db')
    expect(after.fidelity).toBe('ai_estimated')
    expect(after.nutrients.kcal).toBeCloseTo(345)
    expect(after.grams).toBe(model.grams)
    expect((await repo.getRollup(model.date))!.totals.kcal.value).not.toBe(before!.totals.kcal.value)
    expect(await repo.modelLineEntries()).toEqual([])
  })
})

describe('round trip with Addendum 2 fields', () => {
  it('reproduces estimates, sources and origins exactly through .mtb and .json', async () => {
    await seedProfile()
    await acceptSample()
    await repo.putFood({
      id: 'u_2035482',
      name: 'Greek Yogurt',
      brand: 'Ocean Spray',
      tier: 'online',
      origin: 'online',
      per100g: makeNutrients({ kcal: 467, protein: 3.3, carbs: 70, fat: 20, fibre: null }),
      portions: [{ label: '1 serving', grams: 30 }],
      cookState: 'n/a',
      barcode: '031200037206',
    })
    await repo.saveSettings({
      ...defaultSettings(),
      units: { bodyWeight: 'kg', food: 'oz', height: 'cm', waist: 'cm' },
      floatingAdd: false,
    })
    const before = await collectPayload()
    expect(before.schemaVersion).toBe(SCHEMA_VERSION)
    expect(before.foods.some((f) => f.tier === 'online')).toBe(true)
    expect(before.foods.some((f) => f.estimate?.line === 'prep')).toBe(true)

    const blob = await writeBackup({ payload: before, passphrase: 'pass' })
    await db.delete()
    await db.open()
    const file = identifyFile('b.mtb', await blob.arrayBuffer())
    await commitImport(await planForImport(await parseImport(file, 'pass'), 'replace'))
    expect(comparable(await collectPayload())).toEqual(comparable(before))

    const json = payloadToJson(before)
    await writePayload({ ...before, entries: [], foods: [], composites: [] })
    await commitImport(await planForImport({ kind: 'payload', source: 'json', payload: readJsonBackup(json) }, 'replace'))
    expect(comparable(await collectPayload())).toEqual(comparable(before))
  })

  it('never puts the external endpoint, its key or a photo in an export', async () => {
    await repo.saveExternalEndpoint({ id: 'external', baseUrl: 'https://e.example/v1', model: 'm', apiKey: 'secret-key', enabled: true })
    await repo.putPhoto(new Blob(['x']))
    const text = payloadToJson(await collectPayload())
    expect(text).not.toContain('secret-key')
    expect(text).not.toContain('e.example')
    expect(text).not.toContain('"blob"')
  })

  it('still imports an Addendum 1 export, filling food origins', () => {
    const v2: Record<string, unknown> = {
      schemaVersion: 2,
      exportedAt: 1,
      goals: [],
      days: [],
      entries: [],
      foods: [
        { id: 'x_1', name: 'Mine', tier: 'custom', per100g: makeNutrients({ kcal: 100 }), portions: [], cookState: 'n/a' },
        { id: 'bc_1', name: 'Scanned', tier: 'barcode', per100g: makeNutrients({ kcal: 100 }), portions: [], cookState: 'n/a', barcode: '00000001' },
      ],
      composites: [],
      compositeUsage: [],
      backups: [],
      tombstones: [],
      adjustments: [],
      tdeeEstimates: [],
    }
    const p = parsePayload(v2)
    expect(p.schemaVersion).toBe(3)
    expect(p.foods.map((f) => f.origin)).toEqual(['custom', 'barcode'])
  })

  it('refuses an unknown fidelity or line source rather than importing half of it', () => {
    const bad = {
      schemaVersion: 3,
      exportedAt: 1,
      goals: [],
      days: [],
      entries: [
        {
          id: 'e1',
          date: '2026-10-01',
          source: { kind: 'food', foodId: 'f', name: 'f' },
          grams: 1,
          nutrients: makeNutrients({}),
          fidelity: 'ai_estimated',
          lineSource: 'guess',
          createdAt: 1,
        },
      ],
      foods: [],
      composites: [],
      compositeUsage: [],
      backups: [],
    }
    expect(() => parsePayload(bad)).toThrow(/lineSource/)
  })
})

describe('migration E: the database upgrade', () => {
  it('adds an origin to every stored food and changes nothing else', async () => {
    const name = 'macro-tracker-v2-upgrade'
    await Dexie.delete(name)
    const v2 = new Dexie(name)
    v2.version(1).stores({
      days: 'date, phase, precisionMode',
      entries: 'id, date, [date+at], occasion, fromCompositeEntryId',
      foods: 'id, name, tier, barcode, *aliases',
      composites: 'id, name, updatedAt, retired',
      compositeUsage: '++id, compositeId, loggedAt',
      goals: '++id, active, startDate',
      profile: 'id',
      settings: 'id',
      backups: '++id, at',
    })
    v2.version(2).stores({ tombstones: 'id', adjustments: 'id, date, at', tdeeEstimates: 'windowEnd', snapshots: '++id, at' })
    await v2.open()
    const custom = { id: 'x_1', name: 'Mine', tier: 'custom', per100g: makeNutrients({ kcal: 1 }), portions: [], cookState: 'n/a' }
    const scanned = { id: 'bc_1', name: 'Scanned', tier: 'barcode', per100g: makeNutrients({ kcal: 2 }), portions: [], cookState: 'n/a', barcode: '12345670' }
    await v2.table('foods').bulkPut([custom, scanned])
    v2.close()

    const v3 = new MacroDb(name)
    await v3.open()
    expect(v3.verno).toBe(3)
    expect(await v3.foods.get('x_1')).toEqual({ ...custom, origin: 'custom' })
    expect(await v3.foods.get('bc_1')).toEqual({ ...scanned, origin: 'barcode' })
    expect(await v3.photos.count()).toBe(0)
    v3.close()
    await Dexie.delete(name)
  })
})

describe('the library grows toward what is eaten', () => {
  it('finds an accepted online result in local search, and its barcode locally', async () => {
    await seedProfile()
    store.settings.value = await repo.getSettings()
    await store.loadFoodIndex()
    const online: FoodItem = {
      id: 'bc_0894700010137',
      name: 'Nonfat Greek Yogurt Chobani',
      tier: 'online',
      origin: 'online',
      per100g: makeNutrients({ kcal: 52.9, protein: 9.41, carbs: 3.53, fat: 0 }),
      portions: [],
      cookState: 'n/a',
      barcode: '0894700010137',
    }
    expect(store.searchIndex.value.search('nonfat greek yogurt chobani').some((r) => r.food.id === online.id)).toBe(false)
    await store.saveLocalFood(online)
    expect(store.searchIndex.value.search('nonfat greek yogurt chobani')[0]!.food.id).toBe(online.id)

    // And it survives a reload: it is in the local table now.
    await store.loadFoodIndex()
    expect(store.searchIndex.value.search('nonfat greek yogurt chobani')[0]!.food.id).toBe(online.id)
    expect((await repo.findFoodByBarcode('894700010137'))?.id).toBe(online.id)
  })

  it('counts previously logged foods, including inside composite meals', async () => {
    await acceptSample()
    const usage = await repo.foodUsage()
    const oats = curatedFoods().find((f) => f.name === 'Oats, rolled, dry')!
    expect(usage.get(oats.id)?.count).toBe(1)
  })
})

describe('photos', () => {
  it('attach to an entry, delete individually, and leave no dangling reference', async () => {
    const id = await repo.putPhoto(new Blob(['jpeg']))
    const draft = buildDraft({
      output: MODEL,
      request: { description: 'bowl', pinned: [] },
      match: makeLibraryMatcher(index()),
      provenance: PROV,
    })
    const { entries } = await acceptEstimate({
      name: 'Bowl',
      lines: draft.lines,
      provenance: PROV,
      date: '2026-10-01',
      photoRef: id,
    })
    expect(entries[0]!.photoRef).toBe(id)
    expect(entries.slice(1).every((e) => e.photoRef === undefined)).toBe(true)
    expect(await repo.getPhoto(id)).toBeDefined()

    await repo.deletePhoto(id)
    expect(await repo.getPhoto(id)).toBeUndefined()
    expect((await repo.getEntriesForDay('2026-10-01')).some((e) => e.photoRef)).toBe(false)
  })

  it('go when the entry they belong to is deleted', async () => {
    const id = await repo.putPhoto(new Blob(['jpeg']))
    const e = await repo.addEntry({
      date: '2026-10-01',
      source: { kind: 'food', foodId: 'f', name: 'f' },
      grams: 10,
      nutrients: makeNutrients({}),
      fidelity: 'ai_estimated',
      photoRef: id,
    })
    await repo.deleteEntry(e.id)
    expect(await repo.getPhoto(id)).toBeUndefined()
  })

  it('can all be deleted at once', async () => {
    await repo.putPhoto(new Blob(['a']))
    await repo.putPhoto(new Blob(['b']))
    expect(await repo.deleteAllPhotos()).toBe(2)
    expect(await repo.photoCount()).toBe(0)
  })
})

describe('units never reach a record', () => {
  it('stores weight in kilograms whatever was typed', async () => {
    await repo.setWeight('2026-10-01', 92.6)
    await repo.setWaist('2026-10-01', 86.36)
    const day = await repo.getDay('2026-10-01')
    expect(day!.weightKg!.value).toBe(92.6)
    expect(day!.waistCm).toBe(86.36)
    expect(JSON.stringify(day)).not.toMatch(/"lb"|"oz"|unit/i)
  })
})
