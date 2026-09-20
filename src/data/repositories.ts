/**
 * Repositories.
 *
 * All persistence goes through here so the domain layer stays pure and the
 * UI never talks to Dexie directly. Rollups are memoised in memory and
 * invalidated on any write that touches their day.
 */

import type {
  Composite,
  CompositeId,
  CompositeInstance,
  CompositeUsage,
  DayRecord,
  Entry,
  EntryId,
  Fidelity,
  FoodId,
  FoodItem,
  Goal,
  LocalDate,
  NutrientVector,
  Phase,
  PrecisionMode,
  Profile,
  Settings,
} from '../domain/types.ts'
import { db, defaultSettings } from './db.ts'
import { rollupDay, type DayRollup } from '../domain/analytics/index.ts'
import {
  resolveCompositeInstance,
  type Lookups,
} from '../domain/composites/index.ts'
import { addDays, today } from '../domain/dates.ts'
import { registerFoods, resolveFood, unregisterFood } from '../food/registry.ts'
import type { WeightReading } from '../domain/engine/weightTrend.ts'

export function newId(prefix = 'e'): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10)
  return `${prefix}_${Date.now().toString(36)}_${rand}`
}

// --- Rollup cache ---------------------------------------------------------

const rollupCache = new Map<LocalDate, DayRollup>()

export function invalidateRollup(date: LocalDate): void {
  rollupCache.delete(date)
}

export function invalidateAllRollups(): void {
  rollupCache.clear()
}

// --- Profile and settings -------------------------------------------------

export async function getProfile(): Promise<Profile | undefined> {
  return db.profile.get('profile')
}

export async function saveProfile(p: Profile): Promise<void> {
  await db.profile.put(p)
}

export async function getSettings(): Promise<Settings> {
  const s = await db.settings.get('settings')
  if (s) return s
  const fresh = defaultSettings()
  await db.settings.put(fresh)
  return fresh
}

export async function saveSettings(s: Settings): Promise<void> {
  await db.settings.put(s)
}

export async function getActiveGoal(): Promise<Goal | undefined> {
  const goals = await db.goals.toArray()
  return goals.find((g) => g.active)
}

export async function setActiveGoal(goal: Omit<Goal, 'id'>): Promise<number> {
  return db.transaction('rw', db.goals, async () => {
    const existing = await db.goals.toArray()
    for (const g of existing) {
      if (g.active && g.id !== undefined) {
        await db.goals.update(g.id, { active: false })
      }
    }
    return (await db.goals.add({ ...goal, active: true })) as number
  })
}

// --- Days -----------------------------------------------------------------

export function emptyDay(
  date: LocalDate,
  phase: Phase,
  precisionMode: PrecisionMode,
): DayRecord {
  return { date, phase, precisionMode, entries: [], training: [] }
}

export async function getDay(date: LocalDate): Promise<DayRecord | undefined> {
  return db.days.get(date)
}

export async function ensureDay(
  date: LocalDate,
  phase: Phase,
  precisionMode: PrecisionMode,
): Promise<DayRecord> {
  const existing = await db.days.get(date)
  if (existing) return existing
  const fresh = emptyDay(date, phase, precisionMode)
  await db.days.put(fresh)
  return fresh
}

export async function saveDay(day: DayRecord): Promise<void> {
  await db.days.put(day)
  invalidateRollup(day.date)
}

export async function getDaysBetween(
  start: LocalDate,
  end: LocalDate,
): Promise<DayRecord[]> {
  return db.days.where('date').between(start, end, true, true).toArray()
}

export async function getEntriesForDay(date: LocalDate): Promise<Entry[]> {
  return db.entries.where('date').equals(date).toArray()
}

export async function getEntriesBetween(
  start: LocalDate,
  end: LocalDate,
): Promise<Entry[]> {
  return db.entries.where('date').between(start, end, true, true).toArray()
}

export async function getRollup(date: LocalDate): Promise<DayRollup | undefined> {
  const cached = rollupCache.get(date)
  if (cached) return cached
  const day = await db.days.get(date)
  if (!day) return undefined
  const entries = await getEntriesForDay(date)
  const settings = await getSettings()
  const r = rollupDay({
    day,
    entries,
    occasionWindowMinutes: settings.occasionWindowMinutes,
  })
  rollupCache.set(date, r)
  return r
}

export async function getRollupsBetween(
  start: LocalDate,
  end: LocalDate,
): Promise<DayRollup[]> {
  const days = await getDaysBetween(start, end)
  if (days.length === 0) return []
  const entries = await getEntriesBetween(start, end)
  const settings = await getSettings()
  const byDate = new Map<LocalDate, Entry[]>()
  for (const e of entries) {
    const list = byDate.get(e.date)
    if (list) list.push(e)
    else byDate.set(e.date, [e])
  }
  return days
    .map((day) => {
      const cached = rollupCache.get(day.date)
      if (cached) return cached
      const r = rollupDay({
        day,
        entries: byDate.get(day.date) ?? [],
        occasionWindowMinutes: settings.occasionWindowMinutes,
      })
      rollupCache.set(day.date, r)
      return r
    })
    .sort((a, b) => (a.date < b.date ? -1 : 1))
}

// --- Entries --------------------------------------------------------------

export type NewEntryInput = {
  date: LocalDate
  source: Entry['source']
  grams: number
  nutrients: NutrientVector
  fidelity: Fidelity
  at?: string
  occasion?: string
  parsedFrom?: string
  note?: string
  fromCompositeEntryId?: EntryId
}

export async function addEntry(input: NewEntryInput): Promise<Entry> {
  const entry: Entry = {
    id: newId('e'),
    createdAt: Date.now(),
    ...input,
  }
  await db.transaction('rw', db.entries, db.days, async () => {
    await db.entries.put(entry)
    const day = await db.days.get(entry.date)
    if (day) {
      await db.days.put({ ...day, entries: [...day.entries, entry.id] })
    }
  })
  invalidateRollup(entry.date)
  return entry
}

export async function addEntries(inputs: NewEntryInput[]): Promise<Entry[]> {
  const now = Date.now()
  const entries: Entry[] = inputs.map((input, i) => ({
    id: newId('e'),
    createdAt: now + i,
    ...input,
  }))
  const dates = [...new Set(entries.map((e) => e.date))]
  await db.transaction('rw', db.entries, db.days, async () => {
    await db.entries.bulkPut(entries)
    for (const date of dates) {
      const day = await db.days.get(date)
      if (!day) continue
      const ids = entries.filter((e) => e.date === date).map((e) => e.id)
      await db.days.put({ ...day, entries: [...day.entries, ...ids] })
    }
  })
  for (const d of dates) invalidateRollup(d)
  return entries
}

export async function updateEntry(
  id: EntryId,
  patch: Partial<Entry>,
): Promise<void> {
  const existing = await db.entries.get(id)
  if (!existing) return
  await db.entries.put({ ...existing, ...patch, id })
  invalidateRollup(existing.date)
  if (patch.date && patch.date !== existing.date) invalidateRollup(patch.date)
}

export async function deleteEntry(id: EntryId): Promise<void> {
  const existing = await db.entries.get(id)
  if (!existing) return
  await db.transaction('rw', db.entries, db.days, async () => {
    await db.entries.delete(id)
    const day = await db.days.get(existing.date)
    if (day) {
      await db.days.put({
        ...day,
        entries: day.entries.filter((e) => e !== id),
      })
    }
  })
  invalidateRollup(existing.date)
}

/** Delete every row produced by one composite log. */
export async function deleteCompositeLog(rootEntryId: EntryId): Promise<void> {
  const all = await db.entries
    .where('id')
    .equals(rootEntryId)
    .or('fromCompositeEntryId')
    .equals(rootEntryId)
    .toArray()
  for (const e of all) await deleteEntry(e.id)
}

// --- Foods ----------------------------------------------------------------

export async function getFood(id: FoodId): Promise<FoodItem | undefined> {
  return db.foods.get(id)
}

export async function getAllFoods(): Promise<FoodItem[]> {
  return db.foods.toArray()
}

export async function putFood(food: FoodItem): Promise<void> {
  await db.foods.put(food)
  registerFoods([food])
}

export async function putFoods(foods: FoodItem[]): Promise<void> {
  await db.foods.bulkPut(foods)
  registerFoods(foods)
}

export async function findFoodByBarcode(
  barcode: string,
): Promise<FoodItem | undefined> {
  return db.foods.where('barcode').equals(barcode).first()
}

export async function deleteFood(id: FoodId): Promise<void> {
  await db.foods.delete(id)
  unregisterFood(id)
}

// --- Composites -----------------------------------------------------------

export async function getComposite(
  id: CompositeId,
): Promise<Composite | undefined> {
  return db.composites.get(id)
}

export async function getAllComposites(): Promise<Composite[]> {
  return db.composites.toArray()
}

export async function putComposite(c: Composite): Promise<void> {
  await db.composites.put(c)
}

export async function deleteComposite(id: CompositeId): Promise<void> {
  await db.composites.delete(id)
}

export async function getCompositeUsage(): Promise<CompositeUsage[]> {
  return db.compositeUsage.toArray()
}

export async function recordCompositeUsage(
  compositeId: CompositeId,
  loggedAt = Date.now(),
): Promise<void> {
  await db.compositeUsage.add({ compositeId, loggedAt })
}

export async function compositeUsageStats(
  id: CompositeId,
): Promise<{ count: number; lastUsedAt?: number }> {
  const rows = await db.compositeUsage.where('compositeId').equals(id).toArray()
  if (rows.length === 0) return { count: 0 }
  return {
    count: rows.length,
    lastUsedAt: Math.max(...rows.map((r) => r.loggedAt)),
  }
}

/**
 * Build the lookup pair the composite resolver needs.
 *
 * Foods resolve through the registry, which spans the bundled curated table,
 * the USDA subset and the stored custom and barcode rows. Reading the foods
 * table alone would silently resolve every curated component to nothing.
 */
export async function makeLookups(): Promise<Lookups> {
  const [foods, composites] = await Promise.all([
    getAllFoods(),
    getAllComposites(),
  ])
  registerFoods(foods)
  const compMap = new Map(composites.map((c) => [c.id, c]))
  return {
    food: (id) => resolveFood(id),
    composite: (id) => compMap.get(id),
  }
}

/**
 * Log a composite instance: resolve it to flat rows, snapshot the nutrients,
 * write the rows, and record the usage that drives ranking.
 */
export async function logCompositeInstance(input: {
  instance: CompositeInstance
  date: LocalDate
  at?: string
  occasion?: string
}): Promise<{ entries: Entry[]; problems: string[] }> {
  const lookups = await makeLookups()
  const resolved = resolveCompositeInstance(input.instance, lookups)

  // A row whose food cannot be resolved would be written at zero nutrients,
  // which is silently wrong data in a table that is never recomputed. Refuse
  // the whole meal and say why instead.
  const blocking = resolved.problems.filter(
    (p) => p.kind !== 'cycle' && p.kind !== 'depth',
  )
  if (resolved.rows.length === 0 || blocking.length > 0) {
    return { entries: [], problems: resolved.problems.map((p) => p.message) }
  }

  // The first row carries the composite instance as its source, so the diary
  // can group the meal and an edit can find every row it produced.
  const rootId = newId('e')
  const now = Date.now()
  const entries: Entry[] = resolved.rows.map((row, i) => ({
    id: i === 0 ? rootId : newId('e'),
    date: input.date,
    ...(input.at !== undefined ? { at: input.at } : {}),
    ...(input.occasion !== undefined ? { occasion: input.occasion } : {}),
    source:
      i === 0
        ? input.instance
        : { kind: 'food' as const, foodId: row.foodId, name: row.name },
    grams: row.grams,
    nutrients: row.nutrients,
    fidelity: row.fidelity,
    ...(i === 0 ? {} : { fromCompositeEntryId: rootId }),
    createdAt: now + i,
  }))

  await db.transaction('rw', db.entries, db.days, db.compositeUsage, async () => {
    await db.entries.bulkPut(entries)
    const day = await db.days.get(input.date)
    if (day) {
      await db.days.put({
        ...day,
        entries: [...day.entries, ...entries.map((e) => e.id)],
      })
    }
    await db.compositeUsage.add({
      compositeId: input.instance.compositeId,
      loggedAt: now,
    })
  })

  invalidateRollup(input.date)
  return { entries, problems: resolved.problems.map((p) => p.message) }
}

// --- Weight ---------------------------------------------------------------

export async function setWeight(
  date: LocalDate,
  kg: number,
  time?: string,
): Promise<void> {
  const day = await db.days.get(date)
  if (!day) return
  await db.days.put({
    ...day,
    weightKg: time !== undefined ? { value: kg, time } : { value: kg },
  })
  invalidateRollup(date)
}

export async function getWeightReadings(
  start?: LocalDate,
  end?: LocalDate,
): Promise<WeightReading[]> {
  const days =
    start && end ? await getDaysBetween(start, end) : await db.days.toArray()
  return days
    .filter((d): d is DayRecord & { weightKg: { value: number } } =>
      d.weightKg !== undefined,
    )
    .map((d) => ({ date: d.date, kg: d.weightKg.value }))
    .sort((a, b) => (a.date < b.date ? -1 : 1))
}

export async function latestWeightKg(): Promise<number | undefined> {
  const readings = await getWeightReadings()
  return readings.length > 0 ? readings[readings.length - 1]!.kg : undefined
}

// --- Misc -----------------------------------------------------------------

export async function recordBackup(meta: {
  recordCounts: Record<string, number>
  encrypted: boolean
  schemaVersion: number
}): Promise<void> {
  const at = Date.now()
  await db.backups.add({ at, ...meta })
  const p = await getProfile()
  if (p) await db.profile.put({ ...p, lastBackupAt: at })
}

export async function lastBackupAt(): Promise<number | undefined> {
  const rows = await db.backups.orderBy('at').reverse().limit(1).toArray()
  return rows[0]?.at
}

export async function recordCounts(): Promise<Record<string, number>> {
  const [days, entries, foods, composites, usage, goals] = await Promise.all([
    db.days.count(),
    db.entries.count(),
    db.foods.count(),
    db.composites.count(),
    db.compositeUsage.count(),
    db.goals.count(),
  ])
  return { days, entries, foods, composites, usage, goals }
}

/** Days that exist between two dates, filling absent days as empty records. */
export async function ensureDayRange(
  start: LocalDate,
  end: LocalDate,
  phase: Phase,
  mode: PrecisionMode,
): Promise<void> {
  const existing = new Set((await getDaysBetween(start, end)).map((d) => d.date))
  const missing: DayRecord[] = []
  let cursor = start
  while (cursor <= end) {
    if (!existing.has(cursor)) missing.push(emptyDay(cursor, phase, mode))
    cursor = addDays(cursor, 1)
  }
  if (missing.length > 0) await db.days.bulkPut(missing)
}

export async function todayRecord(
  phase: Phase,
  mode: PrecisionMode,
): Promise<DayRecord> {
  return ensureDay(today(), phase, mode)
}
