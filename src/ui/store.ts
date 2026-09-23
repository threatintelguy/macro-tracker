/**
 * Application state, as signals.
 *
 * No state-management library: four tabs and a handful of signals is the
 * whole requirement. Anything derived lives in a computed so the data-dense
 * screens do not re-render more than they must on a mid-range phone.
 */

import { computed, signal } from '@preact/signals'
import type {
  AdjustmentEvent,
  Composite,
  CompositeTombstone,
  DayRecord,
  Entry,
  Goal,
  LocalDate,
  NutrientKey,
  Profile,
  Settings,
  TdeeEstimate,
} from '../domain/types.ts'
import type { DayRollup, RollingMean } from '../domain/analytics/index.ts'
import { meanOfComplete, rollupDay } from '../domain/analytics/index.ts'
import type { TrendPoint } from '../domain/engine/weightTrend.ts'
import { currentTrend, weightTrend } from '../domain/engine/weightTrend.ts'
import { resolveTargets, type ResolvedTargets } from '../domain/engine/targets.ts'
import { cumulativeAdjustment } from '../domain/engine/adjustment.ts'
import { rankComposites, type RankedComposite } from '../domain/composites/index.ts'
import { FoodSearchIndex } from '../food/search.ts'
import { curatedFoods } from '../food/curated.ts'
import { loadUsdaSubset } from '../food/usda.ts'
import { registerFoods } from '../food/registry.ts'
import { defaultSettings } from '../data/db.ts'
import * as repo from '../data/repositories.ts'
import * as engine from '../data/engine.ts'
import { setRegisteredFoods } from '../data/transfer.ts'
import { addDays, today } from '../domain/dates.ts'
import { calibrationProgress, type CalibrationProgress } from '../domain/phase/index.ts'

export type Tab = 'today' | 'log' | 'trends' | 'settings'

// --- Raw state ------------------------------------------------------------

export const tab = signal<Tab>('today')
export const ready = signal(false)
export const profile = signal<Profile | undefined>(undefined)
export const settings = signal<Settings>(defaultSettings())
export const goal = signal<Goal | undefined>(undefined)
export const selectedDate = signal<LocalDate>(today())
export const day = signal<DayRecord | undefined>(undefined)
export const entries = signal<Entry[]>([])
export const composites = signal<Composite[]>([])
export const tombstones = signal<CompositeTombstone[]>([])
export const usage = signal<{ compositeId: string; loggedAt: number }[]>([])
export const weightReadings = signal<{ date: LocalDate; kg: number }[]>([])
export const recentRollups = signal<DayRollup[]>([])
export const adjustments = signal<AdjustmentEvent[]>([])
export const tdeeEstimates = signal<TdeeEstimate[]>([])
export const searchIndex = signal<FoodSearchIndex>(new FoodSearchIndex())
export const foodIndexVersion = signal(0)
export const toast = signal<string | undefined>(undefined)
export const usdaLoaded = signal(false)
/** The earliest date anything was recorded: the diary's back limit. */
export const earliestDate = signal<LocalDate | undefined>(undefined)
/** Items in the needs-detail queue. Shown as a quiet count, never a badge. */
export const needsDetailCount = signal(0)

/** Ticks every minute so time-of-day ranking stays current. */
export const clock = signal(Date.now())

// --- Derived --------------------------------------------------------------

export const rollup = computed<DayRollup | undefined>(() => {
  const d = day.value
  if (!d) return undefined
  return rollupDay({
    day: d,
    entries: entries.value,
    occasionWindowMinutes: settings.value.occasionWindowMinutes,
  })
})

export const trendPoints = computed<TrendPoint[]>(() =>
  weightTrend(weightReadings.value),
)

export const currentWeightKg = computed<number | undefined>(() => {
  const trend = currentTrend(trendPoints.value)
  if (trend !== undefined) return trend
  const readings = weightReadings.value
  return readings.length > 0 ? readings[readings.length - 1]!.kg : undefined
})

/** The latest estimate of expenditure, for display. Targets use the decision-point value. */
export const latestTdee = computed<TdeeEstimate | undefined>(() => {
  const list = tdeeEstimates.value
  return list.length > 0 ? list[list.length - 1] : undefined
})

/**
 * Resolved targets with provenance. Undefined until onboarding has supplied
 * a profile and a first weight -- there is no honest number before then.
 */
export const targets = computed<ResolvedTargets | undefined>(() => {
  const p = profile.value
  const w = currentWeightKg.value
  if (!p || w === undefined) return undefined
  const observed = engine.maintenanceObserved({
    phase: p.phase,
    phaseStartDate: p.phaseStartDate,
    estimates: tdeeEstimates.value,
    events: adjustments.value,
  })
  return resolveTargets({
    profile: p,
    weightKg: w,
    settings: settings.value,
    goalDirection: goal.value?.direction ?? 'maintain',
    ...(observed ? { observedTdee: observed } : {}),
    adjustmentKcal: cumulativeAdjustment(adjustments.value),
  })
})

export const rankedComposites = computed<RankedComposite[]>(() =>
  rankComposites({
    composites: composites.value,
    usage: usage.value,
    now: clock.value,
  }),
)

export const tombstoneById = computed(
  () => new Map(tombstones.value.map((t) => [t.id, t])),
)

export const progress = computed<CalibrationProgress | undefined>(() => {
  const p = profile.value
  if (!p || p.phase === 'steady') return undefined
  const occasionsFromComposites = recentRollups.value.reduce(
    (acc, r) => acc + r.occasions.filter((o) => o.entryIds.length > 1).length,
    0,
  )
  const totalOccasions = recentRollups.value.reduce(
    (acc, r) => acc + r.occasions.length,
    0,
  )
  return calibrationProgress({
    phase: p.phase,
    phaseStartDate: p.phaseStartDate,
    ...(p.phaseEndDate !== undefined ? { phaseEndDate: p.phaseEndDate } : {}),
    rollups: recentRollups.value,
    compositesBuilt: composites.value.filter((c) => !c.retired).length,
    occasionsFromComposites,
    totalOccasions,
  })
})

export type SevenDay = {
  kcal?: RollingMean
  protein?: RollingMean
  carbs?: RollingMean
  fat?: RollingMean
  satFat?: RollingMean
  fibre?: RollingMean
}

/**
 * 7-day rolling averages, which are the headline figures everywhere. Each
 * nutrient averages only the days where it is complete -- a floor averaged
 * in as a total would be a confident low number.
 */
export const sevenDay = computed<SevenDay | undefined>(() => {
  const window = recentRollups.value.filter(
    (r) => r.date > addDays(selectedDate.value, -7) && r.date <= selectedDate.value,
  )
  if (window.every((r) => r.confidence === 'empty')) return undefined
  const out: SevenDay = {}
  for (const k of ['kcal', 'protein', 'carbs', 'fat', 'satFat', 'fibre'] as const satisfies readonly NutrientKey[]) {
    const m = meanOfComplete(window, k)
    if (m) out[k] = m
  }
  return out
})

export const isToday = computed(() => selectedDate.value === today())

// --- Loading --------------------------------------------------------------

export async function loadFoodIndex(): Promise<void> {
  const index = new FoodSearchIndex()
  index.add(curatedFoods())
  // Custom foods and cached barcode results, which live only on this device.
  const stored = await repo.getAllFoods()
  const local = stored.filter((f) => f.tier === 'custom' || f.tier === 'barcode')
  index.add(local)
  // Everything searchable must also be resolvable by id, or a composite
  // built from it resolves to nothing.
  registerFoods(local)
  searchIndex.value = index
  foodIndexVersion.value++
  setRegisteredFoods(() => searchIndex.value.all())

  // Tier 2 loads in the background: it is optional, and search works without
  // it. No core path awaits it.
  void loadUsdaSubset().then((foods) => {
    if (foods.length === 0) return
    index.add(foods)
    registerFoods(foods)
    usdaLoaded.value = true
    foodIndexVersion.value++
  })
}

/**
 * The phase and mode a day record is created with. Today and later take the
 * profile's current values; a backfilled past day inherits the context of
 * the days around it, so it renders the way it was actually being logged.
 */
async function newDayRecord(date: LocalDate): Promise<DayRecord> {
  const p = profile.value
  const current = {
    phase: p?.phase ?? ('calibration' as const),
    precisionMode: p?.precisionMode ?? ('weighed' as const),
  }
  const ctx = date >= today() ? current : await repo.contextForDate(date, current)
  return repo.emptyDay(date, ctx.phase, ctx.precisionMode)
}

/**
 * Load the selected day. Viewing never creates a record -- the first write
 * does -- so paging back through empty history leaves nothing behind.
 */
export async function refreshDay(date: LocalDate = selectedDate.value): Promise<void> {
  const stored = await repo.getDay(date)
  day.value = stored ?? (await newDayRecord(date))
  entries.value = await repo.getEntriesForDay(date)
}

export async function refreshHistory(): Promise<void> {
  const end = today()
  const earliest = await repo.earliestRecordDate()
  earliestDate.value = earliest
  // Everything, not a trailing window: Trends offers "all", and a year of
  // rollups is small.
  const start = earliest && earliest < addDays(end, -120) ? earliest : addDays(end, -120)
  const [rollups, readings, adj, tdee, pending] = await Promise.all([
    repo.getRollupsBetween(start, end),
    repo.getWeightReadings(),
    repo.getAdjustments(),
    repo.getTdeeEstimates(),
    repo.needsDetailCount(),
  ])
  recentRollups.value = rollups
  weightReadings.value = readings
  adjustments.value = adj
  tdeeEstimates.value = tdee
  needsDetailCount.value = pending
}

export async function refreshComposites(): Promise<void> {
  const [c, u, t] = await Promise.all([
    repo.getAllComposites(),
    repo.getCompositeUsage(),
    repo.getTombstones(),
  ])
  composites.value = c
  usage.value = u
  tombstones.value = t
}

export async function refreshAll(): Promise<void> {
  settings.value = await repo.getSettings()
  profile.value = await repo.getProfile()
  goal.value = await repo.getActiveGoal()
  await Promise.all([refreshDay(), refreshHistory(), refreshComposites()])
}

/**
 * Call after any write to one or more days. Re-derives exactly what an edit
 * is allowed to move (see the engine service), then reloads the screens.
 */
export async function afterEdit(dates: readonly LocalDate[]): Promise<void> {
  await engine.recomputeAfterEdit(dates)
  await refreshDay()
  await refreshHistory()
}

let lastEngineDay: LocalDate | undefined

async function runEngineOncePerDay(): Promise<void> {
  const t = today()
  if (lastEngineDay === t) return
  lastEngineDay = t
  await engine.runDailyEngine()
}

export async function boot(): Promise<void> {
  repo.setDayFactory(newDayRecord)
  await loadFoodIndex()
  settings.value = await repo.getSettings()
  profile.value = await repo.getProfile()
  goal.value = await repo.getActiveGoal()
  await runEngineOncePerDay()
  await refreshAll()
  ready.value = true
  setInterval(() => {
    clock.value = Date.now()
    // Past midnight: freeze yesterday's estimate and run any due review.
    if (lastEngineDay !== today()) {
      void runEngineOncePerDay().then(refreshHistory)
    }
  }, 60_000)
}

// --- Day navigation -------------------------------------------------------

/** Move the diary to a date. Never into the future; never before the first record. */
export async function goToDate(date: LocalDate): Promise<void> {
  const t = today()
  let next = date > t ? t : date
  const earliest = earliestDate.value
  if (earliest !== undefined && next < earliest) next = earliest
  if (next === selectedDate.value) return
  selectedDate.value = next
  await refreshDay(next)
}

export function canStepBack(): boolean {
  const earliest = earliestDate.value
  return earliest !== undefined && selectedDate.value > earliest
}

export function canStepForward(): boolean {
  return selectedDate.value < today()
}

export async function stepDay(delta: 1 | -1): Promise<void> {
  if (delta === 1 && !canStepForward()) return
  if (delta === -1 && !canStepBack()) return
  await goToDate(addDays(selectedDate.value, delta))
}

export function notify(message: string): void {
  toast.value = message
  setTimeout(() => {
    if (toast.value === message) toast.value = undefined
  }, 4000)
}

export function setTab(next: Tab): void {
  tab.value = next
  location.hash = `#${next}`
}

export function tabFromHash(): Tab {
  const h = location.hash.replace('#', '')
  return h === 'log' || h === 'settings' || h === 'today' || h === 'trends' ? h : 'today'
}
