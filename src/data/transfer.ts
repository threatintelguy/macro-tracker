/**
 * Moving the whole database in and out.
 *
 * `collectPayload` reads everything that makes up the user's record;
 * `writePayload` replaces the database with a payload in one transaction.
 * Every import and every purge writes a snapshot first, so a bad import is
 * one undo away.
 */

import type { FoodItem, LocalDate } from '../domain/types.ts'
import { SCHEMA_VERSION } from '../domain/schema.ts'
import { normalise } from '../food/search.ts'
import {
  BackupError,
  isMtb,
  parsePayload,
  readBackup,
  readHeader,
  readJsonBackup,
  type BackupHeader,
  type BackupPayload,
} from '../export/backup.ts'
import {
  detectCsvKind,
  parseCsv,
  parseDayCsv,
  parseEntryCsv,
  planDayFieldsImport,
  planImport,
  type DayCsvRow,
  type ImportPlan,
  type MergeMode,
} from '../export/importPlan.ts'
import { db } from './db.ts'
import * as repo from './repositories.ts'

export async function collectPayload(now = Date.now()): Promise<BackupPayload> {
  const [
    profile,
    settings,
    goals,
    days,
    entries,
    foods,
    composites,
    usage,
    backups,
    tombstones,
    adjustments,
    tdeeEstimates,
  ] = await Promise.all([
    db.profile.get('profile'),
    db.settings.get('settings'),
    db.goals.toArray(),
    db.days.toArray(),
    db.entries.toArray(),
    db.foods.toArray(),
    db.composites.toArray(),
    db.compositeUsage.toArray(),
    db.backups.toArray(),
    db.tombstones.toArray(),
    db.adjustments.toArray(),
    db.tdeeEstimates.toArray(),
  ])
  return {
    schemaVersion: SCHEMA_VERSION,
    exportedAt: now,
    ...(profile ? { profile } : {}),
    ...(settings ? { settings } : {}),
    goals,
    days,
    entries,
    // Curated and USDA rows ship with the app; only local foods travel.
    foods: foods.filter((f) => f.tier === 'custom' || f.tier === 'barcode'),
    composites,
    compositeUsage: usage,
    backups,
    tombstones,
    adjustments,
    tdeeEstimates,
  }
}

/**
 * Replace the database with a payload, atomically. Snapshots are not part
 * of a payload and are left alone, so the undo survives the write.
 */
export async function writePayload(p: BackupPayload): Promise<void> {
  const tables = [
    db.profile,
    db.settings,
    db.goals,
    db.days,
    db.entries,
    db.foods,
    db.composites,
    db.compositeUsage,
    db.backups,
    db.tombstones,
    db.adjustments,
    db.tdeeEstimates,
  ]
  await db.transaction('rw', tables, async () => {
    for (const t of tables) await t.clear()
    if (p.profile) await db.profile.put(p.profile)
    if (p.settings) await db.settings.put(p.settings)
    await db.goals.bulkPut(p.goals)
    await db.days.bulkPut(p.days)
    await db.entries.bulkPut(p.entries)
    await db.foods.bulkPut(p.foods)
    await db.composites.bulkPut(p.composites)
    await db.compositeUsage.bulkPut(p.compositeUsage)
    await db.backups.bulkPut(p.backups)
    await db.tombstones.bulkPut(p.tombstones)
    await db.adjustments.bulkPut(p.adjustments)
    await db.tdeeEstimates.bulkPut(p.tdeeEstimates)
  })
  repo.invalidateAllRollups()
}

export async function takeSnapshot(reason: 'import' | 'purge'): Promise<number> {
  const payload = await collectPayload()
  return repo.putSnapshot({ at: Date.now(), reason, payload: JSON.stringify(payload) })
}

/** Put the database back exactly as a snapshot recorded it. */
export async function restoreSnapshot(id: number): Promise<void> {
  const snap = await repo.getSnapshot(id)
  if (!snap) throw new Error('That snapshot is no longer stored.')
  // Validated like any import: storage is evictable and editable, and a
  // restore must never write a malformed record.
  await writePayload(parsePayload(JSON.parse(snap.payload)))
}

// --- Reading a chosen file -----------------------------------------------

export type ParsedImport =
  | { kind: 'payload'; source: 'mtb' | 'json'; payload: BackupPayload }
  | { kind: 'csv-entries'; payload: BackupPayload }
  | { kind: 'csv-days'; rows: DayCsvRow[] }

export type PendingFile =
  | { kind: 'mtb'; buffer: ArrayBuffer; header: BackupHeader }
  | { kind: 'json'; text: string }
  | { kind: 'csv'; text: string }

/** Identify a file by its content, not only its name. */
export function identifyFile(name: string, buffer: ArrayBuffer): PendingFile {
  if (isMtb(buffer)) return { kind: 'mtb', buffer, header: readHeader(buffer) }
  const text = new TextDecoder().decode(buffer)
  const lower = name.toLowerCase()
  const trimmed = text.trimStart()
  if (lower.endsWith('.json') || trimmed.startsWith('{')) return { kind: 'json', text }
  if (lower.endsWith('.csv')) return { kind: 'csv', text }
  throw new BackupError(
    'not-backup',
    'That file is not a .mtb backup, a .json export, or a .csv from this app.',
  )
}

async function dayContextResolver(): Promise<
  (date: LocalDate) => { phase: 'calibration' | 'steady' | 'recalibration'; precisionMode: 'weighed' | 'composite' | 'minimal' }
> {
  const [days, profile] = await Promise.all([db.days.orderBy('date').toArray(), repo.getProfile()])
  const fallback = {
    phase: profile?.phase ?? ('calibration' as const),
    precisionMode: profile?.precisionMode ?? ('weighed' as const),
  }
  return (date) => {
    let best = undefined as (typeof days)[number] | undefined
    for (const d of days) {
      if (d.date <= date) best = d
      else break
    }
    const ctx = best ?? days[0]
    return ctx ? { phase: ctx.phase, precisionMode: ctx.precisionMode } : fallback
  }
}

/**
 * Decode a pending file into something that can be planned. For an
 * encrypted .mtb this is where the passphrase is used.
 */
export async function parseImport(
  file: PendingFile,
  passphrase?: string,
): Promise<ParsedImport> {
  if (file.kind === 'mtb') {
    const payload = await readBackup({
      buffer: file.buffer,
      ...(passphrase ? { passphrase } : {}),
    })
    return { kind: 'payload', source: 'mtb', payload }
  }
  if (file.kind === 'json') {
    return { kind: 'payload', source: 'json', payload: readJsonBackup(file.text) }
  }
  const rows = parseCsv(file.text)
  const kind = detectCsvKind(rows[0] ?? [])
  if (!kind) {
    throw new BackupError(
      'not-backup',
      'That CSV does not have the columns of a day or entry export from this app.',
    )
  }
  if (kind === 'days') return { kind: 'csv-days', rows: parseDayCsv(rows) }

  const local = await db.foods.toArray()
  const byName = new Map<string, FoodItem>()
  for (const f of local) byName.set(normalise(f.name), f)
  const dayContext = await dayContextResolver()
  const payload = parseEntryCsv(rows, {
    findFood: (name) => byName.get(normalise(name)) ?? findRegisteredByName(name),
    dayContext,
    newId: (prefix) => repo.newId(prefix),
  })
  return { kind: 'csv-entries', payload }
}

function findRegisteredByName(name: string): FoodItem | undefined {
  // The registry holds curated, USDA and stored foods; an exact normalised
  // name match is the only acceptable hit -- a near miss would log the
  // wrong food.
  const target = normalise(name)
  return registeredFoods().find((f) => normalise(f.name) === target)
}

let registeredFoodsCache: (() => FoodItem[]) | undefined
/** Test seam and runtime hook: the store supplies the full searchable set. */
export function setRegisteredFoods(fn: () => FoodItem[]): void {
  registeredFoodsCache = fn
}
function registeredFoods(): FoodItem[] {
  return registeredFoodsCache?.() ?? []
}

/** Plan an import in a chosen mode. Nothing is written. */
export async function planForImport(
  parsed: ParsedImport,
  mode: MergeMode,
): Promise<ImportPlan> {
  const local = await collectPayload()
  if (parsed.kind === 'csv-days') {
    if (mode === 'replace') {
      throw new BackupError('corrupt', 'A CSV can only be merged, never used to replace everything.')
    }
    return planDayFieldsImport({
      local,
      rows: parsed.rows,
      mode,
      dayContext: await dayContextResolver(),
    })
  }
  if (parsed.kind === 'csv-entries' && mode === 'replace') {
    throw new BackupError('corrupt', 'A CSV can only be merged, never used to replace everything.')
  }
  return planImport({
    local,
    incoming: parsed.payload,
    mode,
    source: parsed.kind === 'payload' ? parsed.source : 'csv-entries',
  })
}

/**
 * Commit a previewed plan: snapshot first, then write. Returns the
 * snapshot id, which is the undo.
 */
export async function commitImport(plan: ImportPlan): Promise<number> {
  const snapshotId = await takeSnapshot('import')
  await writePayload(plan.result)
  return snapshotId
}
