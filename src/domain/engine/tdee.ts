/**
 * Observed TDEE.
 *
 *   observedTDEE = meanIntake(window) − (weight rate kg/day × 7700)
 *
 * Window: 21 days, sliding. The 7,700 kcal/kg figure is the conventional
 * energy density of tissue change -- poor over the first fortnight, where
 * glycogen and water dominate, and reasonable after, which is exactly why
 * the window is three weeks.
 *
 * Only `logged` days count. A day with an estimate, a stand-in, or unknown
 * calories is `partial` and excluded -- guessed intake would corrupt the one
 * calculation that depends on intake accuracy. Below 70% coverage the
 * estimate returns `sufficient: false` and the adjustment engine stands down.
 *
 * The weight rate is the least-squares slope of the raw readings in the
 * window, and the estimate carries the slope's standard error so the UI can
 * always show a band: "about 2,950 kcal, ±180".
 */

import type { LocalDate, TdeeEstimate } from '../types.ts'
import type { DayRollup } from '../analytics/index.ts'
import { meanIntakeKcal } from '../analytics/index.ts'
import { addDays, daysBetween } from '../dates.ts'
import { KCAL_PER_KG_TISSUE } from '../nutrition/index.ts'
import type { WeightReading } from './weightTrend.ts'

export const TDEE_WINDOW_DAYS = 21
/** Share of window days that must be `logged` for the estimate to stand. */
export const MIN_COVERAGE_PCT = 70
/** A regression needs at least this many readings to say anything. */
export const MIN_TDEE_READINGS = 3

export type TdeeResult = TdeeEstimate & {
  meanIntakeKcal?: number
  rateKgPerDay?: number
  readings: number
}

/** The window of `days` days ending on `end`, inclusive. */
export function windowFor(end: LocalDate, days = TDEE_WINDOW_DAYS): {
  start: LocalDate
  end: LocalDate
} {
  return { start: addDays(end, -(days - 1)), end }
}

/** Least-squares slope and its standard error, in kg per day. */
export function regressWeights(
  readings: readonly WeightReading[],
): { slope: number; se: number } | undefined {
  const sorted = [...readings].sort((a, b) => (a.date < b.date ? -1 : 1))
  if (sorted.length < 2) return undefined
  const x0 = sorted[0]!.date
  const xs = sorted.map((r) => daysBetween(x0, r.date))
  const ys = sorted.map((r) => r.kg)
  const n = xs.length
  const meanX = xs.reduce((a, b) => a + b, 0) / n
  const meanY = ys.reduce((a, b) => a + b, 0) / n
  let sxx = 0
  let sxy = 0
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - meanX
    sxx += dx * dx
    sxy += dx * (ys[i]! - meanY)
  }
  if (sxx === 0) return undefined
  const slope = sxy / sxx
  if (n <= 2) return { slope, se: Number.POSITIVE_INFINITY }
  const intercept = meanY - slope * meanX
  let sse = 0
  for (let i = 0; i < n; i++) {
    const resid = ys[i]! - (intercept + slope * xs[i]!)
    sse += resid * resid
  }
  return { slope, se: Math.sqrt(sse / (n - 2) / sxx) }
}

/**
 * Estimate expenditure for the window ending on `windowEnd`.
 *
 * Pure: the caller passes every rollup and reading it has, and this picks
 * out the window. Days absent from `rollups` count as not logged.
 */
export function observedTdee(input: {
  rollups: readonly DayRollup[]
  readings: readonly WeightReading[]
  windowEnd: LocalDate
  windowDays?: number
  now?: number
}): TdeeResult {
  const windowDays = input.windowDays ?? TDEE_WINDOW_DAYS
  const { start, end } = windowFor(input.windowEnd, windowDays)

  const inWindow = input.rollups.filter((r) => r.date >= start && r.date <= end)
  const logged = inWindow.filter(
    (r) => r.confidence === 'logged' && r.totals.kcal.complete,
  )
  const readings = input.readings.filter((r) => r.date >= start && r.date <= end)

  const meanIntake = meanIntakeKcal(logged)
  const fit = regressWeights(readings)
  const coveragePct = (logged.length / windowDays) * 100

  const base = {
    windowStart: start,
    windowEnd: end,
    loggedDays: logged.length,
    windowDays,
    computedAt: input.now ?? Date.now(),
    readings: readings.length,
  }

  if (meanIntake === undefined || !fit) {
    return {
      ...base,
      kcal: 0,
      standardError: Number.POSITIVE_INFINITY,
      sufficient: false,
      ...(meanIntake !== undefined ? { meanIntakeKcal: meanIntake } : {}),
    }
  }

  const kcal = meanIntake - fit.slope * KCAL_PER_KG_TISSUE
  const standardError = fit.se * KCAL_PER_KG_TISSUE

  return {
    ...base,
    kcal,
    standardError,
    sufficient:
      coveragePct >= MIN_COVERAGE_PCT &&
      readings.length >= MIN_TDEE_READINGS &&
      Number.isFinite(standardError),
    meanIntakeKcal: meanIntake,
    rateKgPerDay: fit.slope,
  }
}

/** Strip the working fields down to what is stored. */
export function toStoredEstimate(r: TdeeResult): TdeeEstimate {
  return {
    windowEnd: r.windowEnd,
    windowStart: r.windowStart,
    kcal: r.kcal,
    // Infinity does not survive JSON. A huge finite number reads the same.
    standardError: Number.isFinite(r.standardError) ? r.standardError : 1e9,
    sufficient: r.sufficient,
    loggedDays: r.loggedDays,
    windowDays: r.windowDays,
    computedAt: r.computedAt,
  }
}

/**
 * Does an edit on `date` move the current estimate? Only if the date sits
 * inside the current window. Older estimates were correct given what was
 * known then, and rewriting them would make the expenditure chart
 * unreproducible.
 */
export function dateInCurrentWindow(
  date: LocalDate,
  currentWindowEnd: LocalDate,
  windowDays = TDEE_WINDOW_DAYS,
): boolean {
  const { start, end } = windowFor(currentWindowEnd, windowDays)
  return date >= start && date <= end
}

/** The most recent sufficient estimate -- after 21 days the formula is gone for good. */
export function latestSufficient(
  estimates: readonly TdeeEstimate[],
): TdeeEstimate | undefined {
  let best: TdeeEstimate | undefined
  for (const e of estimates) {
    if (!e.sufficient) continue
    if (!best || e.windowEnd > best.windowEnd) best = e
  }
  return best
}
