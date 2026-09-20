/**
 * The backup path is what makes device-only storage survivable, so it is
 * tested as carefully as the engine: a round trip must return exactly what
 * went in, a wrong passphrase must fail rather than return garbage, and the
 * header must be readable without the key.
 */

import { describe, expect, it } from 'vitest'
import {
  BACKUP_PROMPT_ESCALATION_DAYS,
  backupFilename,
  daysSinceBackup,
  daysToCsv,
  entriesToCsv,
  migratePayload,
  readBackup,
  readHeader,
  writeBackup,
  type BackupPayload,
} from '../../src/export/backup.ts'
import { SCHEMA_VERSION } from '../../src/data/db.ts'
import type { DayRecord, Entry } from '../../src/domain/types.ts'
import { makeNutrients } from '../../src/domain/nutrition/index.ts'

const DAYS: DayRecord[] = [
  {
    date: '2026-09-19',
    phase: 'calibration',
    precisionMode: 'weighed',
    entries: ['e1'],
    weightKg: { value: 92.6, time: '07:10' },
    training: [{ kind: 'lifting', minutes: 60 }],
    note: 'Felt strong, and "quoted, comma" text',
  },
  {
    date: '2026-09-20',
    phase: 'calibration',
    precisionMode: 'weighed',
    entries: ['e2'],
    training: [],
  },
]

const ENTRIES: Entry[] = [
  {
    id: 'e1',
    date: '2026-09-19',
    at: '08:05',
    source: { kind: 'food', foodId: 'c_oats_dry', name: 'Oats, rolled, dry' },
    grams: 80,
    nutrients: makeNutrients({ kcal: 303, protein: 10.6, carbs: 54.2, fat: 5.2 }),
    fidelity: 'weighed',
    createdAt: 1_700_000_000_000,
  },
  {
    id: 'e2',
    date: '2026-09-20',
    at: '19:30',
    source: {
      kind: 'composite',
      compositeId: 'c_salad',
      version: 2,
      multiplier: 1.5,
      overrides: [{ componentIndex: 1, action: 'skip' }],
      name: 'Lincoln salad',
    },
    grams: 275,
    nutrients: makeNutrients({ kcal: 480, protein: 38 }),
    fidelity: 'weighed',
    createdAt: 1_700_000_100_000,
  },
]

function payload(): BackupPayload {
  return {
    schemaVersion: SCHEMA_VERSION,
    exportedAt: 1_758_000_000_000,
    goals: [
      {
        id: 1,
        direction: 'loss',
        targetRateKgPerWeek: -0.35,
        startDate: '2026-09-01',
        anchorWeightKg: 92.6,
        active: true,
        createdAt: 1,
      },
    ],
    days: DAYS,
    entries: ENTRIES,
    foods: [],
    composites: [],
    compositeUsage: [{ compositeId: 'c_salad', loggedAt: 1_758_000_000_000 }],
    backups: [],
  }
}

async function toBuffer(blob: Blob): Promise<ArrayBuffer> {
  return blob.arrayBuffer()
}

describe('encrypted round trip', () => {
  it('returns exactly what went in', async () => {
    const blob = await writeBackup({ payload: payload(), passphrase: 'correct horse' })
    const out = await readBackup({
      buffer: await toBuffer(blob),
      passphrase: 'correct horse',
    })
    expect(out).toEqual(payload())
  })

  it('preserves a composite instance with its overrides intact', async () => {
    const blob = await writeBackup({ payload: payload(), passphrase: 'pw' })
    const out = await readBackup({ buffer: await toBuffer(blob), passphrase: 'pw' })
    const source = out.entries[1]!.source
    expect(source.kind).toBe('composite')
    if (source.kind === 'composite') {
      expect(source.version).toBe(2)
      expect(source.multiplier).toBe(1.5)
      expect(source.overrides).toEqual([{ componentIndex: 1, action: 'skip' }])
    }
  })

  it('refuses a wrong passphrase rather than returning garbage', async () => {
    const blob = await writeBackup({ payload: payload(), passphrase: 'right' })
    await expect(
      readBackup({ buffer: await toBuffer(blob), passphrase: 'wrong' }),
    ).rejects.toThrow(/no recovery mechanism/)
  })

  it('says plainly when a passphrase is missing', async () => {
    const blob = await writeBackup({ payload: payload(), passphrase: 'pw' })
    await expect(readBackup({ buffer: await toBuffer(blob) })).rejects.toThrow(
      /encrypted/,
    )
  })

  it('produces a different ciphertext each time, from a fresh salt and iv', async () => {
    const a = new Uint8Array(await toBuffer(await writeBackup({ payload: payload(), passphrase: 'pw' })))
    const b = new Uint8Array(await toBuffer(await writeBackup({ payload: payload(), passphrase: 'pw' })))
    expect(a.length).toBe(b.length)
    expect(a).not.toEqual(b)
  })
})

describe('header', () => {
  it('is readable in clear, without the passphrase', async () => {
    const blob = await writeBackup({ payload: payload(), passphrase: 'pw' })
    const header = readHeader(await toBuffer(blob))
    expect(header.magic).toBe('MTB1')
    expect(header.encrypted).toBe(true)
    expect(header.schemaVersion).toBe(SCHEMA_VERSION)
    expect(header.exportedAt).toBe(1_758_000_000_000)
    expect(header.recordCounts).toMatchObject({ days: 2, entries: 2, goals: 1 })
  })

  it('rejects a file that is not a backup', async () => {
    const junk = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]).buffer
    expect(() => readHeader(junk)).toThrow(/not a Macro Tracker backup/)
  })
})

describe('unencrypted export', () => {
  it('round trips without a passphrase', async () => {
    const blob = await writeBackup({ payload: payload() })
    const header = readHeader(await toBuffer(blob))
    expect(header.encrypted).toBe(false)
    const out = await readBackup({ buffer: await toBuffer(blob) })
    expect(out).toEqual(payload())
  })
})

describe('migration', () => {
  it('brings an older payload forward', () => {
    const old = { ...payload(), schemaVersion: 0 }
    expect(migratePayload(old).schemaVersion).toBe(1)
  })

  it('leaves a current payload alone', () => {
    const p = payload()
    expect(migratePayload(p)).toEqual(p)
  })
})

describe('plain CSV', () => {
  it('writes one row per day with totals', () => {
    const csv = daysToCsv({ days: DAYS, entries: ENTRIES })
    const lines = csv.split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain('date,phase,precision_mode')
    expect(lines[1]).toContain('2026-09-19')
    expect(lines[1]).toContain('92.6')
    expect(lines[1]).toContain('303')
  })

  it('quotes a cell containing a comma or a quote', () => {
    const csv = daysToCsv({ days: DAYS, entries: ENTRIES })
    expect(csv).toContain('"Felt strong, and ""quoted, comma"" text"')
  })

  it('writes one row per entry, with the source kind', () => {
    const csv = entriesToCsv(ENTRIES)
    const lines = csv.split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[1]).toContain('food,"Oats, rolled, dry"')
    expect(lines[2]).toContain('composite,Lincoln salad')
  })

  it('sorts by date and time', () => {
    const csv = entriesToCsv([...ENTRIES].reverse())
    const lines = csv.split('\n')
    expect(lines[1]).toContain('2026-09-19')
    expect(lines[2]).toContain('2026-09-20')
  })
})

describe('backup health', () => {
  const NOW = new Date('2026-09-20T12:00:00').getTime()

  it('counts days since the last export', () => {
    expect(daysSinceBackup(NOW - 3 * 86_400_000, NOW)).toBe(3)
    expect(daysSinceBackup(NOW, NOW)).toBe(0)
  })

  it('reports nothing when there has never been one', () => {
    expect(daysSinceBackup(undefined, NOW)).toBeUndefined()
  })

  it('escalates after a fortnight', () => {
    expect(BACKUP_PROMPT_ESCALATION_DAYS).toBe(14)
  })

  it('names the file by date, and marks an unencrypted one', () => {
    expect(backupFilename(new Date(2026, 8, 20).getTime(), true)).toBe(
      'macro-tracker-2026-09-20.mtb',
    )
    expect(backupFilename(new Date(2026, 8, 20).getTime(), false)).toBe(
      'macro-tracker-2026-09-20-plain.mtb',
    )
  })
})
