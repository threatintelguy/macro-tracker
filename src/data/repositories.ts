/**
 * Repositories.
 *
 * All persistence goes through here so the domain layer stays pure and the
 * UI never talks to Dexie directly. Rollups are memoised in memory and
 * invalidated on any write that touches their day.
 */

import type {
  AdjustmentEvent,
  Composite,
  CompositeId,
  CompositeInstance,
  CompositeTombstone,
  CompositeUsage,
  DayRecord,
  Entry,
  EntryId,
  EstimateSource,
  ExternalEndpoint,
  Fidelity,
  FoodId,
  FoodItem,
  FoodRef,
  Goal,
  LineSource,
  LocalDate,
  LookupRecord,
  NutrientKey,
  NutrientVector,
  Override,
  Phase,
  PrecisionMode,
  Profile,
  Settings,
  Snapshot,
  TdeeEstimate,
} from '../domain/types.ts'
import { db, defaultSettings } from './db.ts'
import { rollupDay, type DayRollup } from '../domain/analytics/index.ts'
import {
  compositeParents,
  resolveCompositeInstance,
  type Lookups,
} from '../domain/composites/index.ts'
import {
  fillUnknown,
  fillUnknownPer100g,
  needsDetail,
  refoodEntry,
  rescaleCompositeRows,
  rescaleEntry,
} from '../domain/editing.ts'
import { addDays, today } from '../domain/dates.ts'
import { registerFoods, resolveFood, unregisterFood } from '../food/registry.ts'
import { barcodeVariants, type FoodUsage } from '../food/search.ts'
import { nutrientsForGrams } from '../domain/nutrition/index.ts'
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

/**
 * How a day record is created when something is first written to it.
 *
 * Viewing a past day never creates a record; the first write does. The
 * factory decides which phase and precision mode the new record carries,
 * because a day renders in the context it was logged under -- and every
 * write path must create the day, or a weight set on a past day would be
 * dropped silently.
 */
let dayFactory: (date: LocalDate) => Promise<DayRecord> | DayRecord = (date) =>
  emptyDay(date, 'calibration', 'weighed')

export function setDayFactory(
  fn: (date: LocalDate) => Promise<DayRecord> | DayRecord,
): void {
  dayFactory = fn
}

/** Get a day, creating it through the factory if it does not exist yet. */
export async function getOrCreateDay(date: LocalDate): Promise<DayRecord> {
  const existing = await db.days.get(date)
  if (existing) return existing
  const fresh = await dayFactory(date)
  await db.days.put(fresh)
  return fresh
}

/**
 * The phase and mode a new record should carry: the nearest earlier day's,
 * so a backfilled day inherits the context around it rather than today's.
 */
export async function contextForDate(
  date: LocalDate,
  fallback: { phase: Phase; precisionMode: PrecisionMode },
): Promise<{ phase: Phase; precisionMode: PrecisionMode }> {
  const earlier = await db.days.where('date').below(date).last()
  if (earlier) return { phase: earlier.phase, precisionMode: earlier.precisionMode }
  const later = await db.days.where('date').above(date).first()
  if (later) return { phase: later.phase, precisionMode: later.precisionMode }
  return fallback
}

/** The earliest date anything was recorded -- the diary's back limit. */
export async function earliestRecordDate(): Promise<LocalDate | undefined> {
  const [firstDay, firstEntry] = await Promise.all([
    db.days.orderBy('date').first(),
    db.entries.orderBy('date').first(),
  ])
  const dates = [firstDay?.date, firstEntry?.date].filter(
    (d): d is LocalDate => d !== undefined,
  )
  return dates.length === 0 ? undefined : dates.sort()[0]
}

/**
 * Write a day's note. Plain text, no limit worth enforcing, and no
 * distinction between a note written that evening and one added weeks later.
 * An empty note deletes it.
 */
export async function saveDayNote(date: LocalDate, note: string): Promise<void> {
  const day = await getOrCreateDay(date)
  const trimmed = note.trim()
  const { note: _old, ...rest } = day
  await db.days.put(trimmed.length === 0 ? rest : { ...rest, note })
  invalidateRollup(date)
}

/** minimal mode: protein grams and a saturated-fat flag, bypassing entries. */
export async function setMinimalDay(
  date: LocalDate,
  input: { proteinG?: number; satFatFlag?: 'low' | 'high' },
): Promise<void> {
  const day = await getOrCreateDay(date)
  const { proteinOverride: _p, satFatFlag: _s, ...rest } = day
  await db.days.put({
    ...rest,
    ...(input.proteinG !== undefined ? { proteinOverride: input.proteinG } : {}),
    ...(input.satFatFlag !== undefined ? { satFatFlag: input.satFatFlag } : {}),
  })
  invalidateRollup(date)
}

/** Search notes: a plain case-insensitive substring match, newest first. */
export async function searchNotes(
  query: string,
): Promise<{ date: LocalDate; note: string }[]> {
  const q = query.trim().toLowerCase()
  const days = await db.days.toArray()
  return days
    .filter(
      (d): d is DayRecord & { note: string } =>
        d.note !== undefined &&
        d.note.trim().length > 0 &&
        (q.length === 0 || d.note.toLowerCase().includes(q)),
    )
    .map((d) => ({ date: d.date, note: d.note }))
    .sort((a, b) => (a.date < b.date ? 1 : -1))
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
  proxyFor?: { note: string }
  estimateSource?: EstimateSource
  lineSource?: LineSource
  photoRef?: string
}

export async function addEntry(input: NewEntryInput): Promise<Entry> {
  const entry: Entry = {
    id: newId('e'),
    createdAt: Date.now(),
    ...input,
  }
  await getOrCreateDay(entry.date)
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
  for (const d of dates) await getOrCreateDay(d)
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
  if (existing.photoRef) await deletePhotoIfUnused(existing.photoRef)
}

/** Every row produced by one composite log: the root and its children. */
export async function compositeLogRows(rootEntryId: EntryId): Promise<Entry[]> {
  const rows = await db.entries
    .where('id')
    .equals(rootEntryId)
    .or('fromCompositeEntryId')
    .equals(rootEntryId)
    .toArray()
  // Root first, then children in the order they were logged.
  return rows.sort((a, b) =>
    a.id === rootEntryId ? -1 : b.id === rootEntryId ? 1 : a.createdAt - b.createdAt,
  )
}

/** Delete every row produced by one composite log. */
export async function deleteCompositeLog(rootEntryId: EntryId): Promise<void> {
  const all = await compositeLogRows(rootEntryId)
  for (const e of all) await deleteEntry(e.id)
}

// --- Editing a logged entry -----------------------------------------------
//
// Edits are silent: no history, no badge. Every edit invalidates the day's
// rollup; downstream recomputation (TDEE, adjustment notes) is the engine
// service's job and is triggered by the caller with the dates returned.

/** Change a plain entry's amount. Rescales the snapshot; never re-resolves. */
export async function editEntryAmount(id: EntryId, grams: number): Promise<LocalDate[]> {
  const existing = await db.entries.get(id)
  if (!existing || !(grams > 0)) return []
  await db.entries.put(rescaleEntry(existing, grams))
  invalidateRollup(existing.date)
  return [existing.date]
}

/** Change a plain entry's food. Re-resolves and takes a fresh snapshot. */
export async function editEntryFood(
  id: EntryId,
  food: FoodItem,
  grams?: number,
): Promise<LocalDate[]> {
  const existing = await db.entries.get(id)
  if (!existing || existing.source.kind !== 'food') return []
  await db.entries.put(refoodEntry(existing, food, grams ?? existing.grams))
  invalidateRollup(existing.date)
  return [existing.date]
}

/**
 * Time, occasion and fidelity. Applied to every row of a composite log so
 * the meal moves as one. A time change may cross an occasion boundary; the
 * rollup re-buckets on its next read.
 */
export async function editEntryMeta(
  id: EntryId,
  patch: { at?: string | null; occasion?: string | null; fidelity?: Fidelity },
): Promise<LocalDate[]> {
  const existing = await db.entries.get(id)
  if (!existing) return []
  const rows =
    existing.source.kind === 'composite' ? await compositeLogRows(id) : [existing]
  const next = rows.map((r) => {
    const { at: _at, occasion: _occ, ...rest } = r
    const at = patch.at === undefined ? r.at : patch.at ?? undefined
    const occasion =
      patch.occasion === undefined ? r.occasion : patch.occasion ?? undefined
    return {
      ...rest,
      ...(at !== undefined ? { at } : {}),
      ...(occasion !== undefined ? { occasion } : {}),
      fidelity: patch.fidelity ?? r.fidelity,
    } satisfies Entry
  })
  await db.entries.bulkPut(next)
  invalidateRollup(existing.date)
  return [existing.date]
}

/** Change a composite log's multiplier. Rescales every row's snapshot. */
export async function editCompositeMultiplier(
  rootId: EntryId,
  multiplier: number,
): Promise<LocalDate[]> {
  const rows = await compositeLogRows(rootId)
  const root = rows[0]
  if (!root || root.source.kind !== 'composite' || !(multiplier > 0)) return []
  await db.entries.bulkPut(
    rescaleCompositeRows(rows, root.source.multiplier, multiplier),
  )
  invalidateRollup(root.date)
  return [root.date]
}

/**
 * Change a composite log's component overrides. This changes what was
 * eaten, so the instance re-resolves at its pinned version and the rows are
 * replaced with a fresh snapshot. The root keeps its id, time and occasion.
 */
export async function editCompositeOverrides(
  rootId: EntryId,
  overrides: Override[],
): Promise<{ dates: LocalDate[]; problems: string[] }> {
  const rows = await compositeLogRows(rootId)
  const root = rows[0]
  if (!root || root.source.kind !== 'composite') return { dates: [], problems: [] }
  const instance: CompositeInstance = { ...root.source, overrides }
  const lookups = await makeLookups()
  const resolved = resolveCompositeInstance(instance, lookups, root.fidelity)
  const blocking = resolved.problems.filter(
    (p) => p.kind !== 'cycle' && p.kind !== 'depth',
  )
  if (resolved.rows.length === 0 || blocking.length > 0) {
    return { dates: [], problems: resolved.problems.map((p) => p.message) }
  }
  const next = resolvedRowsToEntries({
    rows: resolved.rows,
    rootId,
    instance,
    date: root.date,
    ...(root.at !== undefined ? { at: root.at } : {}),
    ...(root.occasion !== undefined ? { occasion: root.occasion } : {}),
    createdAt: root.createdAt,
    ...(root.estimateSource ? { estimateSource: root.estimateSource } : {}),
    ...(root.photoRef ? { photoRef: root.photoRef } : {}),
  })
  await db.transaction('rw', db.entries, db.days, async () => {
    const oldIds = rows.map((r) => r.id)
    await db.entries.bulkDelete(oldIds)
    await db.entries.bulkPut(next)
    const day = await db.days.get(root.date)
    if (day) {
      const kept = day.entries.filter((e) => !oldIds.includes(e))
      await db.days.put({ ...day, entries: [...kept, ...next.map((e) => e.id)] })
    }
  })
  invalidateRollup(root.date)
  return { dates: [root.date], problems: resolved.problems.map((p) => p.message) }
}

/**
 * Explode a composite log into loose entries, for the rare meal that
 * diverged too far to express as overrides. Every snapshot is kept; only
 * the grouping goes.
 */
export async function explodeCompositeLog(rootId: EntryId): Promise<LocalDate[]> {
  const rows = await compositeLogRows(rootId)
  const root = rows[0]
  if (!root || root.source.kind !== 'composite') return []

  let ref: FoodRef | undefined = root.componentRef
  if (!ref) {
    // Rows logged before componentRef existed: recover the first component
    // from the definition, if it still resolves.
    const lookups = await makeLookups()
    const first = resolveCompositeInstance(root.source, lookups).rows[0]
    if (first) ref = { kind: 'food', foodId: first.foodId, name: first.name }
  }
  const rootRef: FoodRef = ref ?? {
    kind: 'food',
    foodId: '',
    name: `${root.source.name} — first component`,
  }

  const next = rows.map((r) => {
    const { fromCompositeEntryId: _from, componentRef: _ref, ...rest } = r
    return r.id === rootId ? { ...rest, source: rootRef } : rest
  })
  await db.entries.bulkPut(next)
  invalidateRollup(root.date)
  return [root.date]
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

/** A stored food under any spelling of the code (UPC-A, EAN-13, GTIN-14). */
export async function findFoodByBarcode(
  barcode: string,
): Promise<FoodItem | undefined> {
  const variants = barcodeVariants(barcode)
  if (variants.length === 0) return undefined
  return db.foods.where('barcode').anyOf(variants).first()
}

/** A network lookup already made, found or not. */
export async function getLookup(key: string): Promise<LookupRecord | undefined> {
  return db.lookups.get(key)
}

export async function putLookup(record: LookupRecord): Promise<void> {
  await db.lookups.put(record)
}

/**
 * How often and how recently each food has been logged -- including as a
 * component of a composite meal. Feeds the "previously logged" rank.
 */
export async function foodUsage(): Promise<FoodUsage> {
  const usage: FoodUsage = new Map()
  const bump = (id: FoodId, at: number): void => {
    if (!id) return
    const u = usage.get(id)
    if (u) {
      u.count++
      if (at > u.lastAt) u.lastAt = at
    } else usage.set(id, { count: 1, lastAt: at })
  }
  await db.entries.each((e) => {
    if (e.source.kind === 'food') bump(e.source.foodId, e.createdAt)
    else if (e.componentRef) bump(e.componentRef.foodId, e.createdAt)
  })
  return usage
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

export async function getTombstones(): Promise<CompositeTombstone[]> {
  return db.tombstones.toArray()
}

export type CompositeBlastRadius = {
  /** Composite logs (root entries) pinned to this composite. */
  entries: number
  /** Distinct days carrying one. */
  days: number
  dates: LocalDate[]
  /** Composites whose definition nests this one. Non-empty blocks a delete. */
  parents: { id: CompositeId; name: string }[]
}

/** The real counts a delete confirmation states, and whether it is blocked. */
export async function compositeBlastRadius(
  id: CompositeId,
): Promise<CompositeBlastRadius> {
  const [entries, composites] = await Promise.all([
    db.entries.toArray(),
    db.composites.toArray(),
  ])
  const roots = entries.filter(
    (e) => e.source.kind === 'composite' && e.source.compositeId === id,
  )
  const dates = [...new Set(roots.map((e) => e.date))].sort()
  return {
    entries: roots.length,
    days: dates.length,
    dates,
    parents: compositeParents(id, composites).map((c) => ({ id: c.id, name: c.name })),
  }
}

export class CompositeNestedError extends Error {
  constructor(readonly parents: string[]) {
    super(
      `Used inside ${parents.map((p) => `"${p}"`).join(', ')}. Remove it from ${parents.length === 1 ? 'that meal' : 'those meals'} first.`,
    )
  }
}

/**
 * Delete a composite definition and leave a tombstone.
 *
 * Past entries keep their snapshotted nutrients -- which is what totals
 * were always computed from -- and render as "name (deleted)". Nothing
 * recalculates, because nothing needs to. Blocked, naming the parents, when
 * another composite nests this one.
 */
export async function deleteComposite(id: CompositeId): Promise<void> {
  const composite = await db.composites.get(id)
  if (!composite) return
  const radius = await compositeBlastRadius(id)
  if (radius.parents.length > 0) {
    throw new CompositeNestedError(radius.parents.map((p) => p.name))
  }
  await db.transaction('rw', db.composites, db.tombstones, db.compositeUsage, async () => {
    await db.tombstones.put({
      id,
      name: composite.name,
      deletedAt: new Date().toISOString(),
    })
    await db.composites.delete(id)
    await db.compositeUsage.where('compositeId').equals(id).delete()
  })
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
 * Delete a composite AND every entry derived from it, recalculating the
 * days they sat on. The one operation in the app that alters historical
 * totals, so the caller must take a snapshot first and must have typed
 * confirmation. Returns the dates whose totals changed.
 */
export async function purgeComposite(id: CompositeId): Promise<LocalDate[]> {
  const radius = await compositeBlastRadius(id)
  if (radius.parents.length > 0) {
    throw new CompositeNestedError(radius.parents.map((p) => p.name))
  }
  const entries = await db.entries.toArray()
  const rootIds = new Set(
    entries
      .filter((e) => e.source.kind === 'composite' && e.source.compositeId === id)
      .map((e) => e.id),
  )
  const doomed = entries.filter(
    (e) =>
      rootIds.has(e.id) ||
      (e.fromCompositeEntryId !== undefined && rootIds.has(e.fromCompositeEntryId)),
  )
  const doomedIds = new Set(doomed.map((e) => e.id))
  const dates = [...new Set(doomed.map((e) => e.date))].sort()

  await db.transaction(
    'rw',
    [db.entries, db.days, db.composites, db.compositeUsage, db.tombstones],
    async () => {
      await db.entries.bulkDelete([...doomedIds])
      for (const date of dates) {
        const day = await db.days.get(date)
        if (day) {
          await db.days.put({
            ...day,
            entries: day.entries.filter((e) => !doomedIds.has(e)),
          })
        }
      }
      await db.composites.delete(id)
      await db.tombstones.delete(id)
      await db.compositeUsage.where('compositeId').equals(id).delete()
    },
  )
  for (const d of dates) invalidateRollup(d)
  return dates
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
  const tombs = new Map((await getTombstones()).map((t) => [t.id, t]))
  return {
    food: (id) => resolveFood(id),
    composite: (id) => compMap.get(id),
    tombstone: (id) => tombs.get(id),
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
  /**
   * Defaults to weighed; a meal built from estimated parts is `estimated`,
   * and a composite saved from an AI estimate is `ai_estimated`.
   */
  fidelity?: Fidelity
  /** An AI estimate's provenance, stamped on every row. */
  estimateSource?: EstimateSource
  /** A plate photo, attached to the meal's root row. */
  photoRef?: string
}): Promise<{ entries: Entry[]; problems: string[] }> {
  const lookups = await makeLookups()
  const definition = lookups.composite(input.instance.compositeId)
  const estimateSource = input.estimateSource ?? definition?.estimateSource
  const fidelity = input.fidelity ?? (estimateSource ? 'ai_estimated' : undefined)
  const resolved = resolveCompositeInstance(input.instance, lookups, fidelity)

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
  const entries = resolvedRowsToEntries({
    rows: resolved.rows,
    rootId,
    instance: input.instance,
    date: input.date,
    ...(input.at !== undefined ? { at: input.at } : {}),
    ...(input.occasion !== undefined ? { occasion: input.occasion } : {}),
    createdAt: now,
    ...(estimateSource ? { estimateSource } : {}),
    ...(input.photoRef ? { photoRef: input.photoRef } : {}),
  })

  await getOrCreateDay(input.date)
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

function resolvedRowsToEntries(input: {
  rows: ReturnType<typeof resolveCompositeInstance>['rows']
  rootId: EntryId
  instance: CompositeInstance
  date: LocalDate
  at?: string
  occasion?: string
  createdAt: number
  estimateSource?: EstimateSource
  photoRef?: string
}): Entry[] {
  return input.rows.map((row, i) => ({
    id: i === 0 ? input.rootId : newId('e'),
    ...(input.estimateSource
      ? { estimateSource: input.estimateSource, lineSource: lineSourceOf(row.foodId) }
      : {}),
    ...(i === 0 && input.photoRef ? { photoRef: input.photoRef } : {}),
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
    ...(i === 0
      ? { componentRef: { kind: 'food' as const, foodId: row.foodId, name: row.name } }
      : { fromCompositeEntryId: input.rootId }),
    createdAt: input.createdAt + i,
  }))
}

/** Where an estimated row's numbers came from, read off its food. */
function lineSourceOf(foodId: FoodId): LineSource {
  return resolveFood(foodId)?.estimate?.line ?? 'db'
}

// --- Needs detail ---------------------------------------------------------
//
// Anything logged with unknown nutrients or as a stand-in. A convenience,
// never a nag: no badge escalation, no notification, no warning colour. An
// item that sits here for a year is a legitimate outcome -- the day it
// belongs to is still logged, which was the point.

export async function needsDetailEntries(): Promise<Entry[]> {
  const all = await db.entries.toArray()
  return all
    .filter(needsDetail)
    .sort((a, b) =>
      a.date === b.date ? a.createdAt - b.createdAt : a.date < b.date ? 1 : -1,
    )
}

export async function needsDetailCount(): Promise<number> {
  let n = 0
  await db.entries.each((e) => {
    if (needsDetail(e)) n++
  })
  return n
}

/**
 * Fill an entry's unknown fields with values for the amount as eaten.
 *
 * With `updateFood`, the fix is carried back to the food per 100 g, and to
 * every other entry of the same food that is missing the same fields -- the
 * package in hand answers for all of them. Returns every date touched so
 * the caller can recompute those days.
 */
export async function resolveEntryDetail(
  id: EntryId,
  values: Partial<Record<NutrientKey, number>>,
  options: { updateFood?: boolean; clearProxy?: boolean } = {},
): Promise<LocalDate[]> {
  const entry = await db.entries.get(id)
  if (!entry) return []
  const touched = new Set<LocalDate>([entry.date])

  const updated: Entry = { ...entry, nutrients: fillUnknown(entry.nutrients, values) }
  if (options.clearProxy) delete updated.proxyFor
  await db.entries.put(updated)

  if (options.updateFood && entry.source.kind === 'food' && entry.grams > 0) {
    const food = await db.foods.get(entry.source.foodId)
    if (food && (food.tier === 'custom' || food.tier === 'barcode' || food.tier === 'online')) {
      const per100g = fillUnknownPer100g(food.per100g, values, entry.grams)
      await putFood({ ...food, per100g })
      const siblings = await db.entries.toArray()
      for (const e of siblings) {
        if (e.id === id || e.source.kind !== 'food') continue
        if (e.source.foodId !== food.id || !(e.grams > 0)) continue
        const scaled: Partial<Record<NutrientKey, number>> = {}
        for (const [k, v] of Object.entries(values) as [NutrientKey, number][]) {
          scaled[k] = (v * e.grams) / entry.grams
        }
        const filled = fillUnknown(e.nutrients, scaled)
        if (JSON.stringify(filled) !== JSON.stringify(e.nutrients)) {
          await db.entries.put({ ...e, nutrients: filled })
          touched.add(e.date)
        }
      }
    }
  }

  for (const d of touched) invalidateRollup(d)
  return [...touched]
}

/**
 * Lines of accepted estimates whose numbers came from the model. When the
 * library later gains the food, the needs-detail list offers to re-resolve
 * them -- optional, never automatic: silently changing a past day would
 * break the rule that history stays as logged.
 */
export async function modelLineEntries(): Promise<Entry[]> {
  return db.entries.filter((e) => e.lineSource === 'model').toArray()
}

/**
 * Re-resolve one model-valued line against a library food: database values
 * for the same grams, and the line's source becomes `db`. The entry stays
 * `ai_estimated` -- the amount is still an estimate.
 */
export async function reresolveEstimatedLine(
  id: EntryId,
  food: FoodItem,
): Promise<LocalDate[]> {
  const entry = await db.entries.get(id)
  if (!entry || entry.lineSource !== 'model') return []
  const ref: FoodRef = { kind: 'food', foodId: food.id, name: food.name }
  const next: Entry = {
    ...entry,
    nutrients: nutrientsForGrams(food.per100g, entry.grams),
    lineSource: 'db',
    ...(entry.source.kind === 'food' ? { source: ref } : { componentRef: ref }),
  }
  await db.entries.put(next)
  invalidateRollup(entry.date)
  return [entry.date]
}

/** Keep a stand-in as it is and take it out of the queue. */
export async function clearProxy(id: EntryId): Promise<LocalDate[]> {
  const entry = await db.entries.get(id)
  if (!entry || !entry.proxyFor) return []
  const { proxyFor: _p, ...rest } = entry
  await db.entries.put(rest)
  invalidateRollup(entry.date)
  return [entry.date]
}

// --- Photos ---------------------------------------------------------------
//
// Plate photos stay on the device. They are attached to an entry, are
// deletable one at a time or all at once, and are not part of an export.

export async function putPhoto(blob: Blob): Promise<string> {
  const id = newId('p')
  await db.photos.put({ id, blob, createdAt: Date.now() })
  return id
}

export async function getPhoto(id: string): Promise<Blob | undefined> {
  return (await db.photos.get(id))?.blob
}

/** Delete one photo and every reference to it. */
export async function deletePhoto(id: string): Promise<void> {
  const refs = await db.entries.filter((e) => e.photoRef === id).toArray()
  await db.transaction('rw', db.entries, db.photos, async () => {
    await db.photos.delete(id)
    await db.entries.bulkPut(refs.map(({ photoRef: _p, ...rest }) => rest))
  })
}

async function deletePhotoIfUnused(id: string): Promise<void> {
  const still = await db.entries.filter((e) => e.photoRef === id).count()
  if (still === 0) await db.photos.delete(id)
}

/** Delete every stored photo, for the global retention switch. */
export async function deleteAllPhotos(): Promise<number> {
  const n = await db.photos.count()
  const refs = await db.entries.filter((e) => e.photoRef !== undefined).toArray()
  await db.transaction('rw', db.entries, db.photos, async () => {
    await db.photos.clear()
    await db.entries.bulkPut(refs.map(({ photoRef: _p, ...rest }) => rest))
  })
  return n
}

export async function photoCount(): Promise<number> {
  return db.photos.count()
}

// --- External endpoint ----------------------------------------------------
//
// The key lives in IndexedDB, not a hardware-backed keystore, and it never
// travels in a backup.

export async function getExternalEndpoint(): Promise<ExternalEndpoint | undefined> {
  return db.secrets.get('external')
}

export async function saveExternalEndpoint(e: ExternalEndpoint): Promise<void> {
  await db.secrets.put(e)
}

export async function clearExternalEndpoint(): Promise<void> {
  await db.secrets.delete('external')
}

// --- Weight ---------------------------------------------------------------

export async function setWeight(
  date: LocalDate,
  kg: number,
  time?: string,
): Promise<void> {
  const day = await getOrCreateDay(date)
  await db.days.put({
    ...day,
    weightKg: time !== undefined ? { value: kg, time } : { value: kg },
  })
  invalidateRollup(date)
}

/** Waist circumference for a day, in centimetres whatever unit it was typed in. */
export async function setWaist(date: LocalDate, cm: number): Promise<void> {
  const day = await getOrCreateDay(date)
  await db.days.put({ ...day, waistCm: cm })
  invalidateRollup(date)
}

/** The most recent waist reading, for the waist-to-height reference. */
export async function latestWaistCm(): Promise<number | undefined> {
  const days = await db.days.orderBy('date').reverse().toArray()
  return days.find((d) => d.waistCm !== undefined)?.waistCm
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

// --- Engine records -------------------------------------------------------

export async function getAdjustments(): Promise<AdjustmentEvent[]> {
  return db.adjustments.orderBy('at').toArray()
}

export async function putAdjustment(e: AdjustmentEvent): Promise<void> {
  await db.adjustments.put(e)
}

export async function getTdeeEstimates(): Promise<TdeeEstimate[]> {
  return db.tdeeEstimates.orderBy('windowEnd').toArray()
}

export async function putTdeeEstimates(list: TdeeEstimate[]): Promise<void> {
  await db.tdeeEstimates.bulkPut(list)
}

// --- Snapshots ------------------------------------------------------------

/** How many snapshots to keep. Each is a full copy, so not unbounded. */
export const SNAPSHOTS_KEPT = 5

export async function listSnapshots(): Promise<Omit<Snapshot, 'payload'>[]> {
  const rows = await db.snapshots.orderBy('at').reverse().toArray()
  return rows.map(({ payload: _p, ...rest }) => rest)
}

export async function getSnapshot(id: number): Promise<Snapshot | undefined> {
  return db.snapshots.get(id)
}

export async function putSnapshot(s: Omit<Snapshot, 'id'>): Promise<number> {
  const id = (await db.snapshots.add(s)) as number
  const all = await db.snapshots.orderBy('at').toArray()
  const excess = all.length - SNAPSHOTS_KEPT
  if (excess > 0) {
    await db.snapshots.bulkDelete(
      all.slice(0, excess).map((r) => r.id).filter((x): x is number => x !== undefined),
    )
  }
  return id
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
  const [days, entries, foods, composites, usage, goals, tombstones, adjustments] =
    await Promise.all([
      db.days.count(),
      db.entries.count(),
      db.foods.count(),
      db.composites.count(),
      db.compositeUsage.count(),
      db.goals.count(),
      db.tombstones.count(),
      db.adjustments.count(),
    ])
  return { days, entries, foods, composites, usage, goals, tombstones, adjustments }
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
