/**
 * Weight trend.
 *
 * Everything downstream uses a trend, never a reading. An exponentially
 * weighted moving average at alpha = 0.10 (roughly a 10-day half-life),
 * seeded with the first week's mean.
 *
 * The headline weight on any screen is the trend value; today's raw reading
 * is a faint dot on the chart. Easy to regress on, so it is stated here too.
 */

import type { LocalDate } from '../types.ts'
import { addDays, daysBetween } from '../dates.ts'

export const TREND_ALPHA = 0.1
/** Days of readings averaged to seed the series. */
export const SEED_DAYS = 7

export type WeightReading = {
  date: LocalDate
  kg: number
}

export type TrendPoint = {
  date: LocalDate
  /** The smoothed value. This is the number the UI shows. */
  trend: number
  /** The raw reading for this date, when there was one. */
  raw?: number
  /** True when no reading existed and the value was carried/interpolated. */
  interpolated: boolean
}

/**
 * Compute the trend series over the full span of the readings.
 *
 * Gaps are filled for display -- the EWMA decays toward the last known value
 * rather than jumping -- and every filled point is marked `interpolated` so
 * TDEE arithmetic can exclude them.
 */
export function weightTrend(
  readings: readonly WeightReading[],
  alpha = TREND_ALPHA,
): TrendPoint[] {
  if (readings.length === 0) return []

  const sorted = [...readings].sort((a, b) => (a.date < b.date ? -1 : 1))
  // Collapse duplicate dates to their mean.
  const byDate = new Map<LocalDate, number[]>()
  for (const r of sorted) {
    const list = byDate.get(r.date)
    if (list) list.push(r.kg)
    else byDate.set(r.date, [r.kg])
  }
  const dated: WeightReading[] = [...byDate.entries()].map(([date, vals]) => ({
    date,
    kg: vals.reduce((a, b) => a + b, 0) / vals.length,
  }))

  const first = dated[0]!
  const last = dated[dated.length - 1]!

  // Seed with the mean of the first week's readings, which stops a single
  // unusual first weigh-in from anchoring the whole series.
  const seedCutoff = addDays(first.date, SEED_DAYS - 1)
  const seedVals = dated.filter((r) => r.date <= seedCutoff).map((r) => r.kg)
  let trend = seedVals.reduce((a, b) => a + b, 0) / seedVals.length

  const lookup = new Map(dated.map((r) => [r.date, r.kg]))
  const out: TrendPoint[] = []
  const span = daysBetween(first.date, last.date)

  for (let i = 0; i <= span; i++) {
    const date = addDays(first.date, i)
    const raw = lookup.get(date)
    if (raw !== undefined) {
      trend = alpha * raw + (1 - alpha) * trend
      out.push({ date, trend, raw, interpolated: false })
    } else {
      // No reading: hold the trend rather than inventing a data point.
      out.push({ date, trend, interpolated: true })
    }
  }

  return out
}

/** The current trend value, or undefined when there are no readings. */
export function currentTrend(points: readonly TrendPoint[]): number | undefined {
  return points.length > 0 ? points[points.length - 1]!.trend : undefined
}

export function trendOn(
  points: readonly TrendPoint[],
  date: LocalDate,
): number | undefined {
  // Points are ascending and contiguous; a linear scan is fine at this size.
  let best: TrendPoint | undefined
  for (const p of points) {
    if (p.date > date) break
    best = p
  }
  return best?.trend
}

/**
 * Rate of change of the trend, in kg per week, over a window ending at the
 * last point. Returns undefined when the window is not covered.
 */
export function trendChangeKgPerWeek(
  points: readonly TrendPoint[],
  windowDays: number,
): number | undefined {
  if (points.length < 2) return undefined
  const last = points[points.length - 1]!
  const startDate = addDays(last.date, -(windowDays - 1))
  const start = points.find((p) => p.date >= startDate)
  if (!start) return undefined
  const days = daysBetween(start.date, last.date)
  if (days <= 0) return undefined
  return ((last.trend - start.trend) / days) * 7
}

/**
 * Standard error of the trend rate, from the residual variance of a least
 * squares fit over the window. The UI always shows a band -- a bare single
 * figure invites over-reaction to noise.
 */
export function trendRateStandardError(
  readings: readonly WeightReading[],
  windowDays: number,
): number | undefined {
  if (readings.length < 3) return undefined
  const sorted = [...readings].sort((a, b) => (a.date < b.date ? -1 : 1))
  const last = sorted[sorted.length - 1]!
  const startDate = addDays(last.date, -(windowDays - 1))
  const win = sorted.filter((r) => r.date >= startDate)
  if (win.length < 3) return undefined

  const xs = win.map((r) => daysBetween(win[0]!.date, r.date))
  const ys = win.map((r) => r.kg)
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
  const intercept = meanY - slope * meanX

  let sse = 0
  for (let i = 0; i < n; i++) {
    const resid = ys[i]! - (intercept + slope * xs[i]!)
    sse += resid * resid
  }
  if (n <= 2) return undefined
  const mse = sse / (n - 2)
  // Standard error of the slope, in kg/day, converted to kg/week.
  return Math.sqrt(mse / sxx) * 7
}

/** Least squares slope in kg/day over a window. Used by observed TDEE. */
export function linearRateKgPerDay(
  readings: readonly WeightReading[],
  windowDays: number,
): number | undefined {
  const sorted = [...readings].sort((a, b) => (a.date < b.date ? -1 : 1))
  if (sorted.length < 2) return undefined
  const last = sorted[sorted.length - 1]!
  const startDate = addDays(last.date, -(windowDays - 1))
  const win = sorted.filter((r) => r.date >= startDate)
  if (win.length < 2) return undefined

  const xs = win.map((r) => daysBetween(win[0]!.date, r.date))
  const ys = win.map((r) => r.kg)
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
  return sxx === 0 ? undefined : sxy / sxx
}
