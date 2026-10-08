/**
 * Addendum 1, against the real IndexedDB algorithm (fake-indexeddb).
 *
 * The regression test that matters most for an app holding the only copy
 * of its data is the round trip: export, wipe, import, compare. It runs
 * here for every format that claims to be a restore path, with the data the
 * addendum adds -- unknown nutrients, composite versions, tombstones, the
 * audit log, notes.
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
  restoreSnapshot,
  writePayload,
} from '../../src/data/transfer.ts'
import { recomputeAfterEdit, runDailyEngine } from '../../src/data/engine.ts'
import {
  BackupError,
  csvCell,
  daysToCsv,
  entriesToCsv,
  parsePayload,
  payloadToJson,
  readBackup,
  readJsonBackup,
  writeBackup,
  type BackupPayload,
} from '../../src/export/backup.ts'
import { parseCsv, planImport } from '../../src/export/importPlan.ts'
import { curatedFoods } from '../../src/food/curated.ts'
import { resetRegistry } from '../../src/food/registry.ts'
import { makeNutrients } from '../../src/domain/nutrition/index.ts'
import { addDays, today } from '../../src/domain/dates.ts'
import { SCHEMA_VERSION } from '../../src/domain/schema.ts'
import type { Composite, CompositeInstance, Entry } from '../../src/domain/types.ts'

const SALAD: Composite = {
  id: 'c_salad',
  name: 'Lincoln salad',
  version: 1,
  components: [
    { kind: 'food', ref: { kind: 'food', foodId: 'c_spinach_raw', name: 'Spinach, raw' }, grams: 100 },
    { kind: 'food', ref: { kind: 'food', foodId: 'c_salmon_cooked', name: 'Salmon, Atlantic, cooked' }, grams: 150 },
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

async function toBuffer(blob: Blob): Promise<ArrayBuffer> {
  return blob.arrayBuffer()
}

/** Everything but the export timestamp, which is meant to differ. */
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

/** A database exercising every addendum feature. */
async function seedRich(): Promise<void> {
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
  await repo.putFood({
    id: 'x_burrito',
    name: 'Market burrito',
    tier: 'custom',
    per100g: makeNutrients({ kcal: 200, protein: null, carbs: null, fat: null, sodium: null }),
    portions: [{ label: '1 serving (400 g)', grams: 400 }],
    cookState: 'n/a',
    createdAt: 5,
    derivedFrom: { ref: { kind: 'food', foodId: 'c_oats_dry', name: 'Oats' }, adjustedFields: ['kcal'] },
  })
  await repo.putComposite(SALAD)
  await repo.logCompositeInstance({ instance: instance(), date: '2026-09-02', at: '12:30' })
  // A second version, so the round trip must carry history.
  await repo.putComposite({
    ...SALAD,
    version: 2,
    components: [SALAD.components[0]!],
    history: [{ version: 1, components: SALAD.components, replacedAt: 10 }],
    updatedAt: 10,
  })
  await repo.putComposite({ ...SALAD, id: 'c_test', name: 'Test meal', version: 1 })
  await repo.logCompositeInstance({
    instance: instance({ compositeId: 'c_test', name: 'Test meal' }),
    date: '2026-09-03',
  })
  await repo.deleteComposite('c_test')
  await repo.addEntry({
    date: '2026-09-02',
    at: '19:00',
    source: { kind: 'food', foodId: 'x_burrito', name: 'Market burrito' },
    grams: 400,
    nutrients: makeNutrients({ kcal: 800, protein: null, carbs: null, fat: null, sodium: null }),
    fidelity: 'estimated',
  })
  await repo.addEntry({
    date: '2026-09-03',
    source: { kind: 'food', foodId: 'c_oats_dry', name: 'Oats, rolled, dry' },
    grams: 80,
    nutrients: makeNutrients({ kcal: 303, protein: 10.6 }),
    fidelity: 'estimated',
    proxyFor: { note: 'hotel porridge' },
  })
  await repo.setWeight('2026-09-02', 85.4, '07:00')
  await repo.saveDayNote('2026-09-02', 'Back from Chicago, ate out four nights.\nSecond line, "quoted", with commas')
  await repo.setActiveGoal({
    direction: 'loss',
    targetRateKgPerWeek: -0.35,
    startDate: '2026-09-01',
    anchorWeightKg: 85,
    active: true,
    createdAt: 7,
  })
  await repo.putAdjustment({
    id: 'adj_1',
    at: 100,
    date: '2026-09-03',
    trigger: 'scheduled',
    outcome: 'held',
    windowStart: '2026-08-13',
    windowEnd: '2026-09-02',
    adherencePct: 80,
    weightReadings: 10,
    before: { kcal: 2500, carbsG: 250 },
    after: { kcal: 2500, carbsG: 250 },
    deltaKcal: 0,
    rationale: 'No change.',
    notes: [{ at: 200, text: 'Edited later.', adherencePct: 85 }],
  })
  await repo.putTdeeEstimates([
    {
      windowEnd: '2026-09-02',
      windowStart: '2026-08-13',
      kcal: 2950,
      standardError: 140,
      sufficient: true,
      loggedDays: 18,
      windowDays: 21,
      computedAt: 1,
    },
  ])
  await repo.recordCompositeUsage('c_salad', 50)
}

describe('round trip: export, wipe, import', () => {
  it('reproduces the database exactly through an encrypted .mtb', async () => {
    await seedRich()
    const before = await collectPayload()
    const blob = await writeBackup({ payload: before, passphrase: 'correct horse' })

    await db.delete()
    await db.open()

    const file = identifyFile('backup.mtb', await toBuffer(blob))
    const parsed = await parseImport(file, 'correct horse')
    const plan = await planForImport(parsed, 'replace')
    await commitImport(plan)

    const after = await collectPayload()
    expect(comparable(after)).toEqual(comparable(before))
    // The specifics the addendum names.
    const burrito = after.entries.find((e) => e.source.name === 'Market burrito')!
    expect(burrito.nutrients.protein).toBeNull()
    expect(after.composites.find((c) => c.id === 'c_salad')!.history).toHaveLength(1)
    expect(after.tombstones.map((t) => t.id)).toEqual(['c_test'])
    expect(after.adjustments[0]!.notes).toHaveLength(1)
  })

  it('reproduces the database exactly through plain .json', async () => {
    await seedRich()
    const before = await collectPayload()
    const json = payloadToJson(before)
    await writePayload({ ...before, days: [], entries: [], composites: [], foods: [] })

    const file = identifyFile('backup.json', new TextEncoder().encode(json).buffer as ArrayBuffer)
    const plan = await planForImport(await parseImport(file), 'replace')
    await commitImport(plan)
    expect(comparable(await collectPayload())).toEqual(comparable(before))
  })

  it('still imports a version 1 export from the previous build', async () => {
    const v1 = {
      schemaVersion: 1,
      exportedAt: 1,
      goals: [],
      days: [{ date: '2026-08-01', phase: 'calibration', precisionMode: 'weighed', entries: ['e1'], training: [] }],
      entries: [
        {
          id: 'e1',
          date: '2026-08-01',
          source: { kind: 'food', foodId: 'c_oats_dry', name: 'Oats' },
          grams: 80,
          nutrients: { kcal: 303, protein: 10.6, carbs: 54, fat: 5, satFat: 1, fibre: 8, sodium: 2, addedSugar: 0, alcohol: 0 },
          fidelity: 'weighed',
          createdAt: 1,
        },
      ],
      foods: [],
      composites: [],
      compositeUsage: [],
      backups: [],
    }
    const blob = await writeBackup({ payload: v1 as unknown as BackupPayload })
    const payload = await readBackup({ buffer: await toBuffer(blob) })
    expect(payload.schemaVersion).toBe(SCHEMA_VERSION)
    expect(payload.tombstones).toEqual([])
    expect(payload.adjustments).toEqual([])
    const plan = planImport({ local: await collectPayload(), incoming: payload, mode: 'replace', source: 'mtb' })
    await commitImport(plan)
    expect(await db.entries.count()).toBe(1)
  })

  it('writes a snapshot first, so a bad import is one undo away', async () => {
    await seedRich()
    const before = await collectPayload()
    const plan = planImport({
      local: before,
      incoming: { ...before, days: [], entries: [] },
      mode: 'replace',
      source: 'json',
    })
    const snapshotId = await commitImport(plan)
    expect(await db.entries.count()).toBe(0)
    await restoreSnapshot(snapshotId)
    expect(comparable(await collectPayload())).toEqual(comparable(before))
  })
})

describe('reading a file', () => {
  it('refuses a file from a newer build rather than reading part of it', async () => {
    const blob = await writeBackup({
      payload: { ...(await collectPayload()), schemaVersion: SCHEMA_VERSION + 1 },
    })
    await expect(readBackup({ buffer: await toBuffer(blob) })).rejects.toMatchObject({
      kind: 'newer-schema',
    })
  })

  it('tells a wrong passphrase apart from a damaged file', async () => {
    await seedRich()
    const blob = await writeBackup({ payload: await collectPayload(), passphrase: 'right' })
    const buffer = await toBuffer(blob)
    await expect(readBackup({ buffer, passphrase: 'wrong' })).rejects.toMatchObject({
      kind: 'wrong-passphrase',
    })
    // Flip a byte in the ciphertext: the passphrase is right, the file is not.
    const damaged = new Uint8Array(buffer.slice(0))
    damaged[damaged.length - 5] = damaged[damaged.length - 5]! ^ 0xff
    await expect(readBackup({ buffer: damaged.buffer, passphrase: 'right' })).rejects.toMatchObject({
      kind: 'corrupt',
    })
  })

  it('rejects a malformed file whole, writing nothing', async () => {
    await seedRich()
    const good = await collectPayload()
    const bad = JSON.parse(payloadToJson(good)) as Record<string, unknown>
    ;(bad['entries'] as Record<string, unknown>[])[0]!['grams'] = 'lots'
    expect(() => readJsonBackup(JSON.stringify(bad))).toThrow(BackupError)
    const countBefore = await db.entries.count()
    try {
      readJsonBackup(JSON.stringify(bad))
    } catch {
      // expected
    }
    expect(await db.entries.count()).toBe(countBefore)
  })

  it('drops unknown keys and cannot be steered by prototype keys', () => {
    const raw = JSON.parse(
      JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        exportedAt: 1,
        goals: [],
        days: [],
        entries: [],
        foods: [],
        composites: [],
        compositeUsage: [],
        backups: [{ at: 1, recordCounts: { days: 1 }, encrypted: false, schemaVersion: 2, extra: 'x' }],
        tombstones: [],
        adjustments: [],
        tdeeEstimates: [],
        injected: '<script>',
      }).replace('"extra":"x"', '"__proto__":{"polluted":true}'),
    )
    const p = parsePayload(raw)
    expect((p as unknown as Record<string, unknown>)['injected']).toBeUndefined()
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
    // A discriminant of "constructor" is not a recognised kind.
    const sneaky = {
      ...raw,
      entries: [
        {
          id: 'e',
          date: '2026-01-01',
          source: { kind: 'constructor' },
          grams: 1,
          nutrients: {},
          fidelity: 'weighed',
          createdAt: 1,
        },
      ],
    }
    expect(() => parsePayload(sneaky)).toThrow(BackupError)
  })

  it('refuses CSV as a replacement', async () => {
    const csv = entriesToCsv([])
    const file = identifyFile('x.csv', new TextEncoder().encode(csv).buffer as ArrayBuffer)
    const parsed = await parseImport(file)
    await expect(planForImport(parsed, 'replace')).rejects.toBeInstanceOf(BackupError)
  })
})

describe('merge semantics', () => {
  async function local(): Promise<void> {
    await repo.addEntry({
      date: '2026-09-10',
      source: { kind: 'food', foodId: 'c_oats_dry', name: 'Oats' },
      grams: 80,
      nutrients: makeNutrients({ kcal: 300 }),
      fidelity: 'weighed',
    })
    await repo.addEntry({
      date: '2026-09-11',
      source: { kind: 'food', foodId: 'c_oats_dry', name: 'Oats' },
      grams: 40,
      nutrients: makeNutrients({ kcal: 150 }),
      fidelity: 'weighed',
    })
  }

  function incoming(base: BackupPayload): BackupPayload {
    const e: Entry = {
      id: 'file_e1',
      date: '2026-09-10',
      source: { kind: 'food', foodId: 'c_oats_dry', name: 'Oats' },
      grams: 100,
      nutrients: makeNutrients({ kcal: 999 }),
      fidelity: 'weighed',
      createdAt: 1,
    }
    const e2: Entry = { ...e, id: 'file_e2', date: '2026-09-12', nutrients: makeNutrients({ kcal: 500 }) }
    const sameDay = base.days.find((d) => d.date === '2026-09-11')!
    const sameEntries = base.entries.filter((x) => x.date === '2026-09-11')
    return {
      ...base,
      days: [
        { date: '2026-09-10', phase: 'calibration', precisionMode: 'weighed', entries: ['file_e1'], training: [] },
        sameDay,
        { date: '2026-09-12', phase: 'calibration', precisionMode: 'weighed', entries: ['file_e2'], training: [] },
      ],
      entries: [e, ...sameEntries, e2],
    }
  }

  it('file wins: a colliding day is replaced whole, never merged entry by entry', async () => {
    await local()
    const base = await collectPayload()
    const plan = planImport({ local: base, incoming: incoming(base), mode: 'fileWins', source: 'json' })
    expect(plan.preview.collisions).toBe(1)
    expect(plan.preview.duplicatesSkipped).toBeGreaterThanOrEqual(1)
    expect(plan.preview.days).toBe(3)
    expect(plan.preview.dateRange).toEqual({ start: '2026-09-10', end: '2026-09-12' })
    await commitImport(plan)
    const tenth = await repo.getEntriesForDay('2026-09-10')
    expect(tenth.map((e) => e.nutrients.kcal)).toEqual([999])
    expect(await repo.getEntriesForDay('2026-09-12')).toHaveLength(1)
  })

  it('local wins: a colliding day is kept, and new days are added', async () => {
    await local()
    const base = await collectPayload()
    const plan = planImport({ local: base, incoming: incoming(base), mode: 'localWins', source: 'json' })
    await commitImport(plan)
    const tenth = await repo.getEntriesForDay('2026-09-10')
    expect(tenth.map((e) => e.nutrients.kcal)).toEqual([300])
    expect(await repo.getEntriesForDay('2026-09-12')).toHaveLength(1)
    // The day record lists exactly the entries on it.
    const day = await repo.getDay('2026-09-10')
    expect(day!.entries).toEqual(tenth.map((e) => e.id))
  })

  it('repairs a logged meal whose definition exists nowhere into a plain entry', async () => {
    const base = await collectPayload()
    const orphan: Entry = {
      id: 'o1',
      date: '2026-09-15',
      source: instance({ compositeId: 'c_gone', name: 'Gone meal' }),
      componentRef: { kind: 'food', foodId: 'c_spinach_raw', name: 'Spinach, raw' },
      grams: 100,
      nutrients: makeNutrients({ kcal: 23 }),
      fidelity: 'weighed',
      createdAt: 1,
    }
    const child: Entry = { ...orphan, id: 'o2', source: { kind: 'food', foodId: 'c_salmon_cooked', name: 'Salmon' }, fromCompositeEntryId: 'o1' }
    delete (child as { componentRef?: unknown }).componentRef
    const plan = planImport({
      local: base,
      incoming: { ...base, entries: [orphan, child], days: [] },
      mode: 'fileWins',
      source: 'json',
    })
    expect(plan.preview.repairs.join(' ')).toContain('plain food entries')
    const repaired = plan.result.entries.find((e) => e.id === 'o1')!
    expect(repaired.source).toEqual({ kind: 'food', foodId: 'c_spinach_raw', name: 'Spinach, raw' })
    expect(repaired.nutrients.kcal).toBe(23)
    expect(plan.result.entries.find((e) => e.id === 'o2')!.fromCompositeEntryId).toBeUndefined()
  })

  it('breaks a cycle and drops a dangling nested reference on the way in', async () => {
    const base = await collectPayload()
    const a: Composite = { ...SALAD, id: 'a', name: 'A', components: [{ kind: 'composite', ref: 'b', multiplier: 1 }] }
    const b: Composite = { ...SALAD, id: 'b', name: 'B', components: [{ kind: 'composite', ref: 'a', multiplier: 1 }, { kind: 'composite', ref: 'nowhere', multiplier: 1 }] }
    const plan = planImport({ local: base, incoming: { ...base, composites: [a, b] }, mode: 'fileWins', source: 'json' })
    const out = new Map(plan.result.composites.map((c) => [c.id, c]))
    const refs = (id: string): string[] =>
      out.get(id)!.components.flatMap((c) => (c.kind === 'composite' ? [c.ref] : []))
    expect(refs('b')).not.toContain('nowhere')
    // Exactly one edge of the a <-> b cycle survives.
    expect(refs('a').length + refs('b').length).toBe(1)
    expect(plan.preview.repairs.length).toBe(2)
  })
})

describe('CSV', () => {
  it('writes unknown as blank and reads blank back as unknown', async () => {
    const entries: Entry[] = [
      {
        id: 'e1',
        date: '2026-09-02',
        at: '12:00',
        source: { kind: 'food', foodId: 'x', name: 'Menu burrito' },
        grams: 400,
        nutrients: makeNutrients({ kcal: 640, protein: null, fibre: null }),
        fidelity: 'estimated',
        proxyFor: { note: 'food truck' },
        createdAt: 1,
      },
    ]
    const csv = entriesToCsv(entries)
    const file = identifyFile('e.csv', new TextEncoder().encode(csv).buffer as ArrayBuffer)
    const parsed = await parseImport(file)
    expect(parsed.kind).toBe('csv-entries')
    if (parsed.kind !== 'csv-entries') return
    const e = parsed.payload.entries[0]!
    expect(e.nutrients.kcal).toBe(640)
    expect(e.nutrients.protein).toBeNull()
    expect(e.nutrients.fibre).toBeNull()
    expect(e.proxyFor).toEqual({ note: 'food truck' })
    // An unrecognised name becomes a custom food, unknowns and all.
    expect(parsed.payload.foods[0]!.name).toBe('Menu burrito')
    expect(parsed.payload.foods[0]!.per100g.protein).toBeNull()
  })

  it('carries notes intact on the day rows', async () => {
    await seedRich()
    const csv = daysToCsv({ days: await db.days.toArray(), entries: await db.entries.toArray() })
    await db.days.update('2026-09-02', { note: undefined as unknown as string })
    const file = identifyFile('d.csv', new TextEncoder().encode(csv).buffer as ArrayBuffer)
    const parsed = await parseImport(file)
    const plan = await planForImport(parsed, 'fileWins')
    await commitImport(plan)
    expect((await repo.getDay('2026-09-02'))!.note).toBe(
      'Back from Chicago, ate out four nights.\nSecond line, "quoted", with commas',
    )
    // Day rows never touch the day's entries.
    expect((await repo.getEntriesForDay('2026-09-02')).length).toBeGreaterThan(0)
  })

  it('defuses spreadsheet formulas on export and restores the text on import', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`)
    expect(csvCell('+1')).toBe(`'+1`)
    expect(csvCell(-3)).toBe('-3')
    const rows = parseCsv(`date,name\n2026-01-01,${csvCell('@SUM(A1)')}`)
    expect(rows[1]![1]).toBe(`'@SUM(A1)`)
  })

  it('parses quotes, embedded newlines and CRLF', () => {
    expect(parseCsv('a,b\r\n"x, ""y""\nz",2\r\n')).toEqual([
      ['a', 'b'],
      ['x, "y"\nz', '2'],
    ])
  })

  it('rejects a CSV with an unreadable row, importing nothing', async () => {
    const csv = `${entriesToCsv([]).split('\n')[0]}\nnot-a-date,,,food,Oats,80,weighed,1,,,,,,,,,,`
    const file = identifyFile('bad.csv', new TextEncoder().encode(csv).buffer as ArrayBuffer)
    await expect(parseImport(file)).rejects.toBeInstanceOf(BackupError)
  })
})

describe('editing entries', () => {
  beforeEach(async () => {
    await repo.putFoods(curatedFoods())
  })

  it('rescales on an amount change instead of re-resolving the food', async () => {
    const e = await repo.addEntry({
      date: '2026-09-20',
      source: { kind: 'food', foodId: 'c_oats_dry', name: 'Oats' },
      grams: 150,
      nutrients: makeNutrients({ kcal: 600, protein: 20 }),
      fidelity: 'weighed',
      at: '08:00',
    })
    // The food table has moved on since; the snapshot must not follow it.
    await repo.editEntryAmount(e.id, 180)
    const after = (await db.entries.get(e.id))!
    expect(after.nutrients.kcal).toBeCloseTo(720, 9)
    expect(after.nutrients.protein).toBeCloseTo(24, 9)
    expect(after.at).toBe('08:00')
    expect(after.createdAt).toBe(e.createdAt)
  })

  it('re-resolves on a food change', async () => {
    const e = await repo.addEntry({
      date: '2026-09-20',
      source: { kind: 'food', foodId: 'c_oats_dry', name: 'Oats' },
      grams: 100,
      nutrients: makeNutrients({ kcal: 1 }),
      fidelity: 'weighed',
    })
    const salmon = curatedFoods().find((f) => f.id === 'c_salmon_cooked')!
    await repo.editEntryFood(e.id, salmon)
    const after = (await db.entries.get(e.id))!
    expect(after.source.name).toBe(salmon.name)
    expect(after.nutrients.kcal).toBe(salmon.per100g.kcal)
  })

  it('re-buckets occasions when a time edit crosses a boundary', async () => {
    const a = await repo.addEntry({
      date: '2026-09-20',
      source: { kind: 'food', foodId: 'f', name: 'Eggs' },
      grams: 100,
      nutrients: makeNutrients({ protein: 20 }),
      fidelity: 'weighed',
      at: '08:00',
    })
    await repo.addEntry({
      date: '2026-09-20',
      source: { kind: 'food', foodId: 'f', name: 'Toast' },
      grams: 100,
      nutrients: makeNutrients({ protein: 20 }),
      fidelity: 'weighed',
      at: '08:10',
    })
    expect((await repo.getRollup('2026-09-20'))!.occasions).toHaveLength(1)
    await repo.editEntryMeta(a.id, { at: '13:00' })
    const r = (await repo.getRollup('2026-09-20'))!
    expect(r.occasions).toHaveLength(2)
    expect(r.occasions.map((o) => o.proteinG)).toEqual([20, 20])
  })

  it('edits a composite multiplier, overrides, and explodes it', async () => {
    await repo.putComposite(SALAD)
    const { entries } = await repo.logCompositeInstance({ instance: instance(), date: '2026-09-20', at: '12:00' })
    const rootId = entries[0]!.id
    const before = (await repo.getRollup('2026-09-20'))!.totals.kcal.value

    await repo.editCompositeMultiplier(rootId, 2)
    expect((await repo.getRollup('2026-09-20'))!.totals.kcal.value).toBeCloseTo(before * 2, 6)

    const r = await repo.editCompositeOverrides(rootId, [{ componentIndex: 1, action: 'skip' }])
    expect(r.problems).toEqual([])
    const rows = await repo.compositeLogRows(rootId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe(rootId)
    expect(rows[0]!.at).toBe('12:00')

    await repo.explodeCompositeLog(rootId)
    const loose = (await db.entries.get(rootId))!
    expect(loose.source).toEqual({ kind: 'food', foodId: 'c_spinach_raw', name: 'Spinach, raw' })
  })
})

describe('past days and notes', () => {
  it('creates a past day on first write with the context around it', async () => {
    await repo.ensureDay('2026-09-01', 'steady', 'minimal')
    repo.setDayFactory(async (date) => {
      const ctx = await repo.contextForDate(date, { phase: 'calibration', precisionMode: 'weighed' })
      return repo.emptyDay(date, ctx.phase, ctx.precisionMode)
    })
    await repo.setWeight('2026-09-05', 84)
    const d = (await repo.getDay('2026-09-05'))!
    expect(d.weightKg!.value).toBe(84)
    expect(d.precisionMode).toBe('minimal')
    expect(d.phase).toBe('steady')
  })

  it('adds, edits and deletes a note identically on any day', async () => {
    for (const date of [today(), addDays(today(), -400)]) {
      await repo.saveDayNote(date, 'first')
      expect((await repo.getDay(date))!.note).toBe('first')
      await repo.saveDayNote(date, 'second')
      expect((await repo.getDay(date))!.note).toBe('second')
      await repo.saveDayNote(date, '   ')
      expect((await repo.getDay(date))!.note).toBeUndefined()
    }
  })

  it('searches notes by plain substring, newest first', async () => {
    await repo.saveDayNote('2026-03-01', 'Felt run down all day')
    await repo.saveDayNote('2026-05-01', 'Ran well; not run DOWN at all')
    await repo.saveDayNote('2026-06-01', 'Nothing of note')
    const hits = await repo.searchNotes('run down')
    expect(hits.map((h) => h.date)).toEqual(['2026-05-01', '2026-03-01'])
  })

  it('reports the earliest record as the back limit', async () => {
    await repo.saveDayNote('2026-02-02', 'x')
    await repo.addEntry({
      date: '2026-01-15',
      source: { kind: 'food', foodId: 'f', name: 'F' },
      grams: 1,
      nutrients: makeNutrients({}),
      fidelity: 'weighed',
    })
    expect(await repo.earliestRecordDate()).toBe('2026-01-15')
  })
})

describe('deleting composites', () => {
  beforeEach(async () => {
    await repo.putFoods(curatedFoods())
    await repo.putComposite(SALAD)
  })

  it('leaves historical totals byte-identical and renders from the tombstone', async () => {
    await repo.logCompositeInstance({ instance: instance(), date: '2026-09-01' })
    await repo.logCompositeInstance({ instance: instance({ multiplier: 2 }), date: '2026-09-02' })
    await repo.logCompositeInstance({ instance: instance(), date: '2026-09-02' })
    const radius = await repo.compositeBlastRadius('c_salad')
    expect(radius).toMatchObject({ entries: 3, days: 2, parents: [] })

    repo.invalidateAllRollups()
    const before = JSON.stringify(await repo.getRollupsBetween('2026-09-01', '2026-09-02'))
    await repo.deleteComposite('c_salad')
    repo.invalidateAllRollups()
    const after = JSON.stringify(await repo.getRollupsBetween('2026-09-01', '2026-09-02'))
    expect(after).toBe(before)

    expect(await repo.getComposite('c_salad')).toBeUndefined()
    expect((await repo.getTombstones())[0]).toMatchObject({ id: 'c_salad', name: 'Lincoln salad' })
    // Resolution falls back to the tombstone rather than reading as broken.
    const lookups = await repo.makeLookups()
    expect(lookups.tombstone!('c_salad')!.name).toBe('Lincoln salad')
  })

  it('blocks a delete while another meal nests it, naming the parents', async () => {
    await repo.putComposite({
      ...SALAD,
      id: 'c_dinner',
      name: 'Dinner plate',
      components: [{ kind: 'composite', ref: 'c_salad', multiplier: 1 }],
    })
    await expect(repo.deleteComposite('c_salad')).rejects.toThrow('Dinner plate')
    await expect(repo.purgeComposite('c_salad')).rejects.toThrow('Dinner plate')
    expect(await repo.getComposite('c_salad')).toBeDefined()
  })

  it('purges a composite and its entries, reporting the days that changed', async () => {
    await repo.logCompositeInstance({ instance: instance(), date: '2026-09-01' })
    await repo.logCompositeInstance({ instance: instance(), date: '2026-09-03' })
    await repo.addEntry({
      date: '2026-09-03',
      source: { kind: 'food', foodId: 'c_oats_dry', name: 'Oats' },
      grams: 80,
      nutrients: makeNutrients({ kcal: 300 }),
      fidelity: 'weighed',
    })
    const dates = await repo.purgeComposite('c_salad')
    expect(dates).toEqual(['2026-09-01', '2026-09-03'])
    expect(await repo.getEntriesForDay('2026-09-01')).toEqual([])
    const third = await repo.getEntriesForDay('2026-09-03')
    expect(third.map((e) => e.source.name)).toEqual(['Oats'])
    expect((await repo.getDay('2026-09-03'))!.entries).toEqual(third.map((e) => e.id))
    expect(await repo.getComposite('c_salad')).toBeUndefined()
  })

  it('keeps retire reversible and separate from delete', async () => {
    await repo.putComposite({ ...SALAD, retired: true })
    expect((await repo.getComposite('c_salad'))!.retired).toBe(true)
    await repo.putComposite({ ...SALAD, retired: false })
    expect((await repo.getComposite('c_salad'))!.retired).toBe(false)
    expect(await repo.getTombstones()).toEqual([])
  })
})

describe('needs detail', () => {
  it('lists unknowns and stand-ins, and recalculates the days a fix touches', async () => {
    await repo.putFood({
      id: 'x_bar',
      name: 'Café bar',
      tier: 'custom',
      per100g: makeNutrients({ kcal: 400, protein: null }),
      portions: [],
      cookState: 'n/a',
    })
    const a = await repo.addEntry({
      date: '2026-09-01',
      source: { kind: 'food', foodId: 'x_bar', name: 'Café bar' },
      grams: 50,
      nutrients: makeNutrients({ kcal: 200, protein: null }),
      fidelity: 'weighed',
    })
    await repo.addEntry({
      date: '2026-09-04',
      source: { kind: 'food', foodId: 'x_bar', name: 'Café bar' },
      grams: 100,
      nutrients: makeNutrients({ kcal: 400, protein: null }),
      fidelity: 'weighed',
    })
    await repo.addEntry({
      date: '2026-09-04',
      source: { kind: 'food', foodId: 'c_oats_dry', name: 'Oats' },
      grams: 80,
      nutrients: makeNutrients({ kcal: 300 }),
      fidelity: 'estimated',
      proxyFor: { note: 'granola' },
    })
    expect(await repo.needsDetailCount()).toBe(3)
    expect((await repo.getRollup('2026-09-04'))!.totals.protein.complete).toBe(false)

    const dates = await repo.resolveEntryDetail(a.id, { protein: 10 }, { updateFood: true })
    expect(dates.sort()).toEqual(['2026-09-01', '2026-09-04'])
    expect((await repo.getFood('x_bar'))!.per100g.protein).toBe(20)
    const fourth = await repo.getEntriesForDay('2026-09-04')
    expect(fourth.find((e) => e.source.name === 'Café bar')!.nutrients.protein).toBe(20)
    expect(await repo.needsDetailCount()).toBe(1)

    const proxy = fourth.find((e) => e.proxyFor)!
    await repo.clearProxy(proxy.id)
    expect(await repo.needsDetailCount()).toBe(0)
  })
})

describe('recomputation after an edit', () => {
  async function seedWindow(daysLogged: number): Promise<void> {
    await repo.saveProfile({
      id: 'profile',
      sex: 'male',
      birthYear: 1983,
      heightCm: 180,
      activityLevel: 'moderate',
      startDate: addDays(today(), -60),
      phase: 'steady',
      phaseStartDate: addDays(today(), -60),
      precisionMode: 'weighed',
      units: 'metric',
      offlineMode: false,
      theme: 'dark',
    })
    for (let i = 1; i <= 50; i++) {
      const date = addDays(today(), -i)
      await repo.setWeight(date, 85 - i * 0.01)
      if (i <= daysLogged || i > 21) {
        await repo.addEntry({
          date,
          source: { kind: 'food', foodId: 'f', name: 'Food' },
          grams: 100,
          nutrients: makeNutrients({ kcal: 2500 }),
          fidelity: 'weighed',
        })
      }
    }
  }

  it('recomputes TDEE for an edit inside the current window, and leaves older estimates alone', async () => {
    await seedWindow(21)
    await runDailyEngine()
    const before = await repo.getTdeeEstimates()
    const current = before[before.length - 1]!
    const old = before.find((e) => e.windowEnd === addDays(today(), -30))!

    // An extra 1,000 kcal on a day inside the window moves the estimate...
    const inside = addDays(today(), -3)
    await repo.addEntry({
      date: inside,
      source: { kind: 'food', foodId: 'f', name: 'Cake' },
      grams: 100,
      nutrients: makeNutrients({ kcal: 1000 }),
      fidelity: 'weighed',
    })
    const r = await recomputeAfterEdit([inside])
    expect(r.tdeeRecomputed).toBe(true)
    const after = await repo.getTdeeEstimates()
    expect(after[after.length - 1]!.kcal).toBeGreaterThan(current.kcal)
    // ...and the frozen estimate from a month ago does not move.
    expect(after.find((e) => e.windowEnd === old.windowEnd)).toEqual(old)

    // An edit outside the window recomputes nothing.
    const outside = addDays(today(), -40)
    expect((await recomputeAfterEdit([outside])).tdeeRecomputed).toBe(false)
  })

  it('lets a backfill lift adherence over the threshold', async () => {
    await seedWindow(12)
    await runDailyEngine()
    const thin = await repo.getTdeeEstimates()
    expect(thin[thin.length - 1]!.sufficient).toBe(false)

    const backfilled: string[] = []
    for (let i = 13; i <= 16; i++) {
      const date = addDays(today(), -i)
      backfilled.push(date)
      await repo.addEntry({
        date,
        source: { kind: 'food', foodId: 'f', name: 'Food' },
        grams: 100,
        nutrients: makeNutrients({ kcal: 2500 }),
        fidelity: 'weighed',
      })
    }
    await recomputeAfterEdit(backfilled)
    const full = await repo.getTdeeEstimates()
    expect(full[full.length - 1]!.sufficient).toBe(true)
  })
})

describe('schema migration', () => {
  it('opens a version 1 database without touching its rows', async () => {
    const name = 'macro-tracker-v1-upgrade'
    await Dexie.delete(name)
    const v1 = new Dexie(name)
    v1.version(1).stores({
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
    await v1.open()
    const row = {
      id: 'e1',
      date: '2026-01-01',
      source: { kind: 'food', foodId: 'c_oats_dry', name: 'Oats' },
      grams: 80,
      nutrients: { kcal: 303, protein: 10.6, carbs: 54, fat: 5, satFat: 1, fibre: 8, sodium: 2, addedSugar: 0, alcohol: 0 },
      fidelity: 'weighed',
      createdAt: 1,
    }
    await v1.table('entries').put(row)
    v1.close()

    const v2 = new MacroDb(name)
    await v2.open()
    expect(v2.verno).toBe(3)
    expect(await v2.entries.get('e1')).toEqual(row)
    expect(await v2.tombstones.count()).toBe(0)
    expect(await v2.adjustments.count()).toBe(0)
    v2.close()
    await Dexie.delete(name)
  })
})
