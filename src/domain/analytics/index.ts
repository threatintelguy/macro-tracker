/**
 * Rollups, occasions, and rolling averages.
 *
 * Every headline figure in the app is a 7-day rolling average. Daily values
 * exist and are inspectable, but they are never the primary display: daily
 * targets invite all-or-nothing thinking and daily variance is mostly noise.
 */

import type {
  DayRecord,
  Entry,
  Fidelity,
  LocalDate,
  NutrientVector,
  OccasionId,
} from '../types.ts'
import { NUTRIENT_KEYS, ZERO_NUTRIENTS } from '../types.ts'
import {
  occasionSufficiencyThreshold,
  sumNutrients,
} from '../nutrition/index.ts'
import { addDays, minutesOfDay } from '../dates.ts'

/**
 * How much a day's data can be trusted.
 *
 * `logged` days are the only ones that may feed observed-TDEE computation:
 * guessed intake would corrupt the one calculation that depends on intake
 * accuracy. `partial` days still appear in every trend line.
 */
export type DayConfidence = 'logged' | 'partial' | 'minimal' | 'empty'

export const DEFAULT_OCCASION_WINDOW_MINUTES = 90

export type Occasion = {
  id: OccasionId
  /** 'HH:MM' of the first entry in the bucket. */
  startsAt: string
  entryIds: string[]
  nutrients: NutrientVector
  proteinG: number
}

export type DayRollup = {
  date: LocalDate
  totals: NutrientVector
  confidence: DayConfidence
  /** The lowest fidelity present, which is what sets the day's confidence. */
  fidelities: Fidelity[]
  entryCount: number
  occasions: Occasion[]
  weightKg?: number
  /** minimal mode days carry protein only. */
  proteinOverride?: number
  satFatFlag?: 'low' | 'high'
}

/**
 * Bucket entries into occasions. Entries within the window group together;
 * the window sits inside the 3–4 hour spacing target -- tight enough to
 * detect the gap, loose enough to keep a grazed breakfast together.
 *
 * Occasion count is never itself a target.
 */
export function bucketOccasions(
  entries: readonly Entry[],
  windowMinutes = DEFAULT_OCCASION_WINDOW_MINUTES,
): Occasion[] {
  if (entries.length === 0) return []

  // Entries with an explicit occasion keep it; the rest bucket by time.
  const explicit = new Map<OccasionId, Entry[]>()
  const timed: Entry[] = []

  for (const e of entries) {
    if (e.occasion) {
      const list = explicit.get(e.occasion)
      if (list) list.push(e)
      else explicit.set(e.occasion, [e])
    } else {
      timed.push(e)
    }
  }

  timed.sort((a, b) => {
    const at = a.at ? minutesOfDay(a.at) : Number.MAX_SAFE_INTEGER
    const bt = b.at ? minutesOfDay(b.at) : Number.MAX_SAFE_INTEGER
    if (at !== bt) return at - bt
    return a.createdAt - b.createdAt
  })

  const buckets: Entry[][] = []
  let current: Entry[] = []
  let anchor: number | undefined

  for (const e of timed) {
    const t = e.at ? minutesOfDay(e.at) : undefined
    if (current.length === 0) {
      current = [e]
      anchor = t
      continue
    }
    if (t === undefined || anchor === undefined || t - anchor <= windowMinutes) {
      current.push(e)
      // Anchor to the bucket's start, not the last entry, so a long graze
      // does not chain indefinitely into the next meal.
      if (anchor === undefined && t !== undefined) anchor = t
    } else {
      buckets.push(current)
      current = [e]
      anchor = t
    }
  }
  if (current.length > 0) buckets.push(current)

  const out: Occasion[] = []
  for (const [id, list] of explicit) {
    out.push(makeOccasion(id, list))
  }
  buckets.forEach((list, i) => {
    out.push(makeOccasion(`auto-${i}`, list))
  })

  out.sort((a, b) => (a.startsAt < b.startsAt ? -1 : a.startsAt > b.startsAt ? 1 : 0))
  return out
}

function makeOccasion(id: OccasionId, entries: Entry[]): Occasion {
  const nutrients = sumNutrients(entries.map((e) => e.nutrients))
  const first = entries.reduce((best, e) => {
    if (!e.at) return best
    if (!best) return e.at
    return e.at < best ? e.at : best
  }, undefined as string | undefined)
  return {
    id,
    startsAt: first ?? '--:--',
    entryIds: entries.map((e) => e.id),
    nutrients,
    proteinG: nutrients.protein,
  }
}

/**
 * Roll a day up from its record and entries.
 *
 * Nothing computed is persisted except this, memoised and invalidated on
 * edit, which keeps history correct when a target or formula changes
 * retroactively.
 */
export function rollupDay(input: {
  day: DayRecord
  entries: readonly Entry[]
  occasionWindowMinutes?: number
}): DayRollup {
  const { day, entries } = input
  const window = input.occasionWindowMinutes ?? DEFAULT_OCCASION_WINDOW_MINUTES

  const totals = sumNutrients(entries.map((e) => e.nutrients))
  const fidelities = entries.map((e) => e.fidelity)

  // minimal mode: protein entered directly, bypassing entries entirely.
  if (day.proteinOverride !== undefined && entries.length === 0) {
    const t = { ...ZERO_NUTRIENTS, protein: day.proteinOverride }
    return {
      date: day.date,
      totals: t,
      confidence: 'minimal',
      fidelities: ['flagged'],
      entryCount: 0,
      occasions: [],
      ...(day.weightKg ? { weightKg: day.weightKg.value } : {}),
      proteinOverride: day.proteinOverride,
      ...(day.satFatFlag ? { satFatFlag: day.satFatFlag } : {}),
    }
  }

  return {
    date: day.date,
    totals,
    confidence: dayConfidence(day, entries),
    fidelities,
    entryCount: entries.length,
    occasions: bucketOccasions(entries, window),
    ...(day.weightKg ? { weightKg: day.weightKg.value } : {}),
    ...(day.proteinOverride !== undefined
      ? { proteinOverride: day.proteinOverride }
      : {}),
    ...(day.satFatFlag ? { satFatFlag: day.satFatFlag } : {}),
  }
}

export function dayConfidence(
  day: DayRecord,
  entries: readonly Entry[],
): DayConfidence {
  if (entries.length === 0) {
    return day.proteinOverride !== undefined ? 'minimal' : 'empty'
  }
  const hasEstimate = entries.some(
    (e) => e.fidelity === 'estimated' || e.fidelity === 'flagged',
  )
  if (hasEstimate) return 'partial'
  return 'logged'
}

/** Rolling mean over a trailing window, aligned to the given dates. */
export function rollingMean(
  series: readonly { date: LocalDate; value: number | undefined }[],
  windowDays: number,
): { date: LocalDate; value: number | undefined }[] {
  return series.map((point, i) => {
    const from = Math.max(0, i - windowDays + 1)
    const slice = series.slice(from, i + 1)
    const vals = slice
      .map((s) => s.value)
      .filter((v): v is number => v !== undefined)
    return {
      date: point.date,
      value:
        vals.length === 0
          ? undefined
          : vals.reduce((a, b) => a + b, 0) / vals.length,
    }
  })
}

export type NutrientSeries = {
  dates: LocalDate[]
  values: Record<keyof NutrientVector, (number | undefined)[]>
  confidence: DayConfidence[]
}

/** Build a dense day-by-day series over a range, gaps included as undefined. */
export function buildSeries(
  rollups: readonly DayRollup[],
  start: LocalDate,
  end: LocalDate,
): NutrientSeries {
  const byDate = new Map(rollups.map((r) => [r.date, r]))
  const dates: LocalDate[] = []
  let cursor = start
  while (cursor <= end) {
    dates.push(cursor)
    cursor = addDays(cursor, 1)
  }

  const values = {} as NutrientSeries['values']
  for (const k of NUTRIENT_KEYS) values[k] = []
  const confidence: DayConfidence[] = []

  for (const d of dates) {
    const r = byDate.get(d)
    confidence.push(r?.confidence ?? 'empty')
    for (const k of NUTRIENT_KEYS) {
      values[k].push(r && r.confidence !== 'empty' ? r.totals[k] : undefined)
    }
  }

  return { dates, values, confidence }
}

/**
 * The count of occasions clearing the per-occasion protein threshold.
 * A count rather than an average, because an average conceals the common
 * failure of three light meals plus one enormous one.
 */
export function occasionsClearingProtein(
  rollup: DayRollup,
  bodyWeightKg: number,
): { clearing: number; total: number; threshold: number } {
  const threshold = occasionSufficiencyThreshold(bodyWeightKg)
  const clearing = rollup.occasions.filter((o) => o.proteinG >= threshold).length
  return { clearing, total: rollup.occasions.length, threshold }
}

/**
 * Logging adherence over a range: the share of days at full `logged`
 * fidelity. This is the figure the 70% adjustment threshold reads.
 */
export function adherencePct(
  rollups: readonly DayRollup[],
  totalDays: number,
): number {
  if (totalDays <= 0) return 0
  const logged = rollups.filter((r) => r.confidence === 'logged').length
  return (logged / totalDays) * 100
}

export function meanIntakeKcal(rollups: readonly DayRollup[]): number | undefined {
  const vals = rollups
    .filter((r) => r.confidence === 'logged')
    .map((r) => r.totals.kcal)
  if (vals.length === 0) return undefined
  return vals.reduce((a, b) => a + b, 0) / vals.length
}

export function confidenceLabel(c: DayConfidence): string {
  switch (c) {
    case 'logged':
      return 'Weighed'
    case 'partial':
      return 'Includes estimates'
    case 'minimal':
      return 'Protein only'
    case 'empty':
      return 'Not logged'
  }
}

export function fidelityLabel(f: Fidelity): string {
  switch (f) {
    case 'weighed':
      return 'Weighed'
    case 'portioned':
      return 'Listed serving'
    case 'estimated':
      return 'Estimated'
    case 'flagged':
      return 'Flagged'
  }
}
