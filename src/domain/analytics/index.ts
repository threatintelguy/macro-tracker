/**
 * Rollups, occasions, and rolling averages.
 *
 * Today's screen shows today's figures, with the 7-day average as a quiet
 * secondary line; Trends stays rolling-average based. Today's protein is
 * actionable, averages are diagnostic. What guards against all-or-nothing
 * thinking is the treatment -- bands rather than thresholds, never red, no
 * language of over or under -- not hiding the day's number.
 *
 * Every total here is an `Aggregate`: the sum of known contributions plus
 * its coverage. Unknown is not zero, so an incomplete total is a floor --
 * "at least 145 g, from 9 of 11 entries" -- never a confident low number.
 */

import type {
  DayRecord,
  Entry,
  Fidelity,
  LocalDate,
  NutrientKey,
  OccasionId,
  Phase,
  PrecisionMode,
} from '../types.ts'
import { ESTIMATED_FIDELITIES, FIDELITIES, NUTRIENT_KEYS } from '../types.ts'
import {
  UNKNOWN_AGGREGATE,
  aggregateNutrients,
  knownAggregate,
  occasionSufficiencyThreshold,
  type Aggregate,
  type NutrientTotals,
} from '../nutrition/index.ts'
import { addDays, minutesOfDay } from '../dates.ts'

/**
 * How much a day's data can be trusted.
 *
 * `logged` days are the only ones that may feed observed-TDEE computation:
 * guessed intake would corrupt the one calculation that depends on intake
 * accuracy. `partial` days still appear in every trend line.
 *
 * A day whose calories are incomplete (an entry with unknown kcal) is
 * `partial` too. That reuses the estimated-day exclusion path rather than
 * adding a second one; a day with complete calories but missing
 * micronutrients still feeds TDEE fine.
 */
export type DayConfidence = 'logged' | 'partial' | 'minimal' | 'empty'

export const DEFAULT_OCCASION_WINDOW_MINUTES = 90

export type Occasion = {
  id: OccasionId
  /** 'HH:MM' of the first entry in the bucket. */
  startsAt: string
  entryIds: string[]
  nutrients: NutrientTotals
  /** Known protein. A floor when `proteinComplete` is false. */
  proteinG: number
  proteinComplete: boolean
}

export type DayRollup = {
  date: LocalDate
  /** The phase and precision mode the day was logged under. */
  phase: Phase
  precisionMode: PrecisionMode
  /** Each field is a value plus its coverage. Incomplete means a floor. */
  totals: NutrientTotals
  confidence: DayConfidence
  /** The lowest fidelity present, which is what sets the day's confidence. */
  fidelities: Fidelity[]
  entryCount: number
  occasions: Occasion[]
  weightKg?: number
  /** minimal mode days carry protein only. */
  proteinOverride?: number
  satFatFlag?: 'low' | 'high'
  /** Set when the day carries a note, so charts can mark it. */
  hasNote?: boolean
}

/** Named occasions an entry can be pinned to. Anything else buckets by time. */
export const NAMED_OCCASIONS = ['breakfast', 'lunch', 'dinner', 'snack'] as const

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
  const nutrients = aggregateNutrients(entries.map((e) => e.nutrients))
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
    proteinG: nutrients.protein.value,
    proteinComplete: nutrients.protein.complete,
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

  const common = {
    date: day.date,
    phase: day.phase,
    precisionMode: day.precisionMode,
    ...(day.weightKg ? { weightKg: day.weightKg.value } : {}),
    ...(day.satFatFlag ? { satFatFlag: day.satFatFlag } : {}),
    ...(day.note !== undefined && day.note.trim().length > 0 ? { hasNote: true } : {}),
  }

  // minimal mode: protein entered directly, bypassing entries entirely.
  // Everything else is unknown for the day -- not zero -- so it neither
  // drags an average down nor reads as a shortfall.
  if (day.proteinOverride !== undefined && entries.length === 0) {
    const t = {} as NutrientTotals
    for (const k of NUTRIENT_KEYS) t[k] = { ...UNKNOWN_AGGREGATE }
    t.protein = knownAggregate(day.proteinOverride)
    return {
      ...common,
      totals: t,
      confidence: 'minimal',
      fidelities: ['flagged'],
      entryCount: 0,
      occasions: [],
      proteinOverride: day.proteinOverride,
    }
  }

  return {
    ...common,
    totals: aggregateNutrients(entries.map((e) => e.nutrients)),
    confidence: dayConfidence(day, entries),
    fidelities: entries.map((e) => e.fidelity),
    entryCount: entries.length,
    occasions: bucketOccasions(entries, window),
    ...(day.proteinOverride !== undefined
      ? { proteinOverride: day.proteinOverride }
      : {}),
  }
}

export function dayConfidence(
  day: DayRecord,
  entries: readonly Entry[],
): DayConfidence {
  if (entries.length === 0) {
    return day.proteinOverride !== undefined ? 'minimal' : 'empty'
  }
  // AI estimates are excluded here, through the same path as any other
  // estimate: bookkeeping, not a penalty.
  const hasEstimate = entries.some(
    (e) =>
      ESTIMATED_FIDELITIES.has(e.fidelity) ||
      e.proxyFor !== undefined ||
      e.nutrients.kcal === null,
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
  /** Known sums. Where `complete` is false the value is a floor. */
  values: Record<NutrientKey, (number | undefined)[]>
  complete: Record<NutrientKey, boolean[]>
  confidence: DayConfidence[]
  /** Days carrying an AI estimate: included, drawn distinctly. */
  aiEstimated: boolean[]
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
  const complete = {} as NutrientSeries['complete']
  for (const k of NUTRIENT_KEYS) {
    values[k] = []
    complete[k] = []
  }
  const confidence: DayConfidence[] = []
  const aiEstimated: boolean[] = []

  for (const d of dates) {
    const r = byDate.get(d)
    confidence.push(r?.confidence ?? 'empty')
    aiEstimated.push(r?.fidelities.includes('ai_estimated') ?? false)
    for (const k of NUTRIENT_KEYS) {
      const agg = r && r.confidence !== 'empty' ? r.totals[k] : undefined
      // A field with no known contribution at all is a gap, not a zero.
      values[k].push(agg && agg.knownEntries > 0 ? agg.value : undefined)
      complete[k].push(agg?.complete ?? false)
    }
  }

  return { dates, values, complete, confidence, aiEstimated }
}

/**
 * The count of occasions clearing the per-occasion protein threshold.
 * A count rather than an average, because an average conceals the common
 * failure of three light meals plus one enormous one.
 *
 * A floor that already clears the threshold clears it. An incomplete
 * occasion below the threshold is unknown rather than short, and is
 * reported separately so the UI never renders it as a miss.
 */
export function occasionsClearingProtein(
  rollup: DayRollup,
  bodyWeightKg: number,
): { clearing: number; total: number; threshold: number; unknown: number } {
  const threshold = occasionSufficiencyThreshold(bodyWeightKg)
  const clearing = rollup.occasions.filter((o) => o.proteinG >= threshold).length
  const unknown = rollup.occasions.filter(
    (o) => !o.proteinComplete && o.proteinG < threshold,
  ).length
  return { clearing, total: rollup.occasions.length, threshold, unknown }
}

/**
 * Logging adherence over a range: the share of days at full `logged`
 * fidelity. This is the figure the 70% adjustment threshold reads, and it
 * is computed live -- backfilling a missed day legitimately lifts it.
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
  // `logged` already guarantees complete calories; the check is belt and
  // braces, because a floor averaged in here would corrupt TDEE.
  const vals = rollups
    .filter((r) => r.confidence === 'logged' && r.totals.kcal.complete)
    .map((r) => r.totals.kcal.value)
  if (vals.length === 0) return undefined
  return vals.reduce((a, b) => a + b, 0) / vals.length
}

export type RollingMean = {
  value: number
  /** Days whose figure for this nutrient was complete and counted. */
  days: number
  /** Days in the window with something logged but this nutrient incomplete. */
  incompleteDays: number
}

/**
 * Mean of one nutrient over a set of days, counting only days where that
 * nutrient is complete. A floor averaged in as if it were a total is
 * exactly the silent low number that unknown-is-not-zero exists to prevent.
 */
export function meanOfComplete(
  rollups: readonly DayRollup[],
  key: NutrientKey,
): RollingMean | undefined {
  const counted = rollups.filter((r) => r.confidence !== 'empty')
  const complete = counted.filter((r) => r.totals[key].complete)
  const incompleteDays = counted.length - complete.length
  if (complete.length === 0) return undefined
  return {
    value: complete.reduce((a, r) => a + r.totals[key].value, 0) / complete.length,
    days: complete.length,
    incompleteDays,
  }
}

/** How an aggregate reads: "145 g", or "at least 145 g, from 9 of 11 entries". */
export function describeAggregate(agg: Aggregate, unit: string, dp = 0): string {
  const n = agg.value.toLocaleString(undefined, {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  })
  const withUnit = unit.length > 0 ? `${n} ${unit}` : n
  if (agg.complete) return withUnit
  if (agg.knownEntries === 0) return 'not known yet'
  return `at least ${withUnit}, from ${agg.knownEntries} of ${agg.totalEntries} entries`
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
    case 'ai_estimated':
      return 'Estimated by model'
    case 'flagged':
      return 'Flagged'
  }
}

/** The least exact fidelity in a list, which is what describes the whole. */
export function lowestFidelity(fidelities: readonly Fidelity[]): Fidelity {
  let worst = 0
  for (const f of fidelities) worst = Math.max(worst, FIDELITIES.indexOf(f))
  return FIDELITIES[worst] ?? 'weighed'
}
