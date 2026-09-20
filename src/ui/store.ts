/**
 * Application state, as signals.
 *
 * No state-management library: three tabs and a handful of signals is the
 * whole requirement. Anything derived lives in a computed so the data-dense
 * screens do not re-render more than they must on a mid-range phone.
 */

import { computed, signal } from '@preact/signals'
import type {
  Composite,
  DayRecord,
  Entry,
  Goal,
  LocalDate,
  Profile,
  Settings,
} from '../domain/types.ts'
import type { DayRollup } from '../domain/analytics/index.ts'
import { rollupDay } from '../domain/analytics/index.ts'
import type { TrendPoint } from '../domain/engine/weightTrend.ts'
import { currentTrend, weightTrend } from '../domain/engine/weightTrend.ts'
import { resolveTargets, type ResolvedTargets } from '../domain/engine/targets.ts'
import { rankComposites, type RankedComposite } from '../domain/composites/index.ts'
import { FoodSearchIndex } from '../food/search.ts'
import { curatedFoods } from '../food/curated.ts'
import { loadUsdaSubset } from '../food/usda.ts'
import { registerFoods } from '../food/registry.ts'
import { defaultSettings } from '../data/db.ts'
import * as repo from '../data/repositories.ts'
import { addDays, today } from '../domain/dates.ts'
import { calibrationProgress, type CalibrationProgress } from '../domain/phase/index.ts'

export type Tab = 'today' | 'log' | 'settings'

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
export const usage = signal<{ compositeId: string; loggedAt: number }[]>([])
export const weightReadings = signal<{ date: LocalDate; kg: number }[]>([])
export const recentRollups = signal<DayRollup[]>([])
export const searchIndex = signal<FoodSearchIndex>(new FoodSearchIndex())
export const foodIndexVersion = signal(0)
export const toast = signal<string | undefined>(undefined)
export const usdaLoaded = signal(false)

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

/**
 * Resolved targets with provenance. Undefined until onboarding has supplied
 * a profile and a first weight -- there is no honest number before then.
 */
export const targets = computed<ResolvedTargets | undefined>(() => {
  const p = profile.value
  const w = currentWeightKg.value
  if (!p || w === undefined) return undefined
  return resolveTargets({
    profile: p,
    weightKg: w,
    settings: settings.value,
    goalDirection: goal.value?.direction ?? 'maintain',
  })
})

export const rankedComposites = computed<RankedComposite[]>(() =>
  rankComposites({
    composites: composites.value,
    usage: usage.value,
    now: clock.value,
  }),
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

/** 7-day rolling averages, which are the headline figures everywhere. */
export const sevenDay = computed(() => {
  const window = recentRollups.value.filter(
    (r) => r.date > addDays(selectedDate.value, -7) && r.date <= selectedDate.value,
  )
  const counted = window.filter((r) => r.confidence !== 'empty')
  if (counted.length === 0) return undefined
  const mean = (pick: (r: DayRollup) => number): number =>
    counted.reduce((a, r) => a + pick(r), 0) / counted.length
  return {
    days: counted.length,
    kcal: mean((r) => r.totals.kcal),
    protein: mean((r) => r.totals.protein),
    carbs: mean((r) => r.totals.carbs),
    fat: mean((r) => r.totals.fat),
    satFat: mean((r) => r.totals.satFat),
    fibre: mean((r) => r.totals.fibre),
  }
})

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

export async function refreshDay(date: LocalDate = selectedDate.value): Promise<void> {
  const p = profile.value
  const d = await repo.ensureDay(
    date,
    p?.phase ?? 'calibration',
    p?.precisionMode ?? 'weighed',
  )
  day.value = d
  entries.value = await repo.getEntriesForDay(date)
}

export async function refreshHistory(): Promise<void> {
  const end = today()
  const start = addDays(end, -120)
  recentRollups.value = await repo.getRollupsBetween(start, end)
  weightReadings.value = await repo.getWeightReadings()
}

export async function refreshComposites(): Promise<void> {
  composites.value = await repo.getAllComposites()
  usage.value = await repo.getCompositeUsage()
}

export async function refreshAll(): Promise<void> {
  settings.value = await repo.getSettings()
  profile.value = await repo.getProfile()
  goal.value = await repo.getActiveGoal()
  await Promise.all([refreshDay(), refreshHistory(), refreshComposites()])
}

export async function boot(): Promise<void> {
  await loadFoodIndex()
  await refreshAll()
  ready.value = true
  setInterval(() => {
    clock.value = Date.now()
  }, 60_000)
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
  return h === 'log' || h === 'settings' || h === 'today' ? h : 'today'
}
