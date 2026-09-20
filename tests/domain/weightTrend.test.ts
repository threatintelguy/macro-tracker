/**
 * The trend function gets tests against synthetic weight series of known
 * ground truth: a flat series, a known linear slope, and a noisy series
 * whose signal is buried in day-to-day water movement.
 */

import { describe, expect, it } from 'vitest'
import {
  TREND_ALPHA,
  currentTrend,
  linearRateKgPerDay,
  trendChangeKgPerWeek,
  trendOn,
  trendRateStandardError,
  weightTrend,
  type WeightReading,
} from '../../src/domain/engine/weightTrend.ts'
import { addDays } from '../../src/domain/dates.ts'

const START = '2026-09-01'

function series(
  values: (number | null)[],
  start = START,
): WeightReading[] {
  const out: WeightReading[] = []
  values.forEach((v, i) => {
    if (v !== null) out.push({ date: addDays(start, i), kg: v })
  })
  return out
}

/** Deterministic pseudo-noise, so a failure is reproducible. */
function lcg(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return s / 4294967296
  }
}

describe('weightTrend', () => {
  it('returns nothing for no readings', () => {
    expect(weightTrend([])).toEqual([])
    expect(currentTrend([])).toBeUndefined()
  })

  it('holds flat on a constant series', () => {
    const points = weightTrend(series(Array(30).fill(92.6)))
    expect(points).toHaveLength(30)
    for (const p of points) expect(p.trend).toBeCloseTo(92.6, 9)
  })

  it('seeds from the first week rather than the first reading', () => {
    // An unusual first weigh-in must not anchor the whole series.
    const readings = series([95, 92, 92, 92, 92, 92, 92])
    const points = weightTrend(readings)
    const seed = (95 + 92 * 6) / 7
    // First point is one EWMA step from the seed toward 95.
    expect(points[0]!.trend).toBeCloseTo(TREND_ALPHA * 95 + (1 - TREND_ALPHA) * seed, 9)
    expect(points[0]!.trend).toBeLessThan(95)
  })

  it('tracks a known linear loss and lags it, as a smoother must', () => {
    // 0.1 kg/day for 60 days, starting at 95.
    const values = Array.from({ length: 60 }, (_, i) => 95 - 0.1 * i)
    const points = weightTrend(series(values))
    const last = points[points.length - 1]!
    expect(last.raw).toBeCloseTo(95 - 0.1 * 59, 9)
    // The trend lags the reading, and by a stable amount once settled.
    expect(last.trend).toBeGreaterThan(last.raw!)
    expect(last.trend - last.raw!).toBeLessThan(1.0)
  })

  it('recovers a known rate of change within a tolerance', () => {
    const values = Array.from({ length: 60 }, (_, i) => 95 - 0.1 * i)
    const points = weightTrend(series(values))
    const rate = trendChangeKgPerWeek(points, 21)!
    // Ground truth is -0.7 kg/week.
    expect(rate).toBeCloseTo(-0.7, 1)
  })

  it('sees through daily noise to the underlying trend', () => {
    const rand = lcg(42)
    // Real signal: -0.5 kg/week. Noise: +/-1 kg of water movement.
    const values = Array.from(
      { length: 56 },
      (_, i) => 92.6 - (0.5 / 7) * i + (rand() - 0.5) * 2,
    )
    const points = weightTrend(series(values))
    const rate = trendChangeKgPerWeek(points, 28)!
    expect(rate).toBeGreaterThan(-0.9)
    expect(rate).toBeLessThan(-0.1)
  })

  it('marks gapped days as interpolated and holds the trend across them', () => {
    const readings = series([92.6, null, null, 92.4, null, 92.2])
    const points = weightTrend(readings)
    expect(points).toHaveLength(6)
    expect(points[1]!.interpolated).toBe(true)
    expect(points[1]!.raw).toBeUndefined()
    expect(points[1]!.trend).toBeCloseTo(points[0]!.trend, 9)
    expect(points[3]!.interpolated).toBe(false)
  })

  it('collapses duplicate readings on one date to their mean', () => {
    const points = weightTrend([
      { date: '2026-09-01', kg: 92 },
      { date: '2026-09-01', kg: 94 },
      { date: '2026-09-02', kg: 93 },
    ])
    expect(points).toHaveLength(2)
    // Seed is the mean of both days' means: (93 + 93) / 2 = 93.
    expect(points[0]!.raw).toBe(93)
  })

  it('accepts readings in any order', () => {
    const shuffled: WeightReading[] = [
      { date: '2026-09-03', kg: 92.4 },
      { date: '2026-09-01', kg: 92.8 },
      { date: '2026-09-02', kg: 92.6 },
    ]
    const points = weightTrend(shuffled)
    expect(points.map((p) => p.date)).toEqual([
      '2026-09-01',
      '2026-09-02',
      '2026-09-03',
    ])
  })

  it('reads the trend on a given date', () => {
    const points = weightTrend(series([92.6, 92.5, 92.4, 92.3]))
    expect(trendOn(points, '2026-09-02')).toBeCloseTo(points[1]!.trend, 9)
    // Before the series starts there is nothing to report.
    expect(trendOn(points, '2026-08-01')).toBeUndefined()
  })
})

describe('trendChangeKgPerWeek', () => {
  it('needs at least two points', () => {
    expect(trendChangeKgPerWeek(weightTrend(series([92.6])), 21)).toBeUndefined()
  })

  it('is zero on a flat series', () => {
    const points = weightTrend(series(Array(30).fill(92.6)))
    expect(trendChangeKgPerWeek(points, 21)).toBeCloseTo(0, 9)
  })

  it('is positive when gaining', () => {
    const values = Array.from({ length: 30 }, (_, i) => 80 + 0.05 * i)
    const rate = trendChangeKgPerWeek(weightTrend(series(values)), 21)!
    expect(rate).toBeGreaterThan(0)
  })
})

describe('standard error', () => {
  it('is near zero for a perfectly linear series', () => {
    const values = Array.from({ length: 21 }, (_, i) => 95 - 0.1 * i)
    const se = trendRateStandardError(series(values), 21)!
    expect(se).toBeLessThan(0.01)
  })

  it('grows with noise, so the UI can show an honest band', () => {
    const rand = lcg(7)
    const clean = Array.from({ length: 21 }, (_, i) => 95 - 0.1 * i)
    const noisy = clean.map((v) => v + (rand() - 0.5) * 3)
    const seClean = trendRateStandardError(series(clean), 21)!
    const seNoisy = trendRateStandardError(series(noisy), 21)!
    expect(seNoisy).toBeGreaterThan(seClean)
  })

  it('declines to report on too few readings', () => {
    expect(trendRateStandardError(series([92, 92]), 21)).toBeUndefined()
  })
})

describe('linearRateKgPerDay', () => {
  it('recovers a known slope exactly on clean data', () => {
    const values = Array.from({ length: 21 }, (_, i) => 95 - 0.1 * i)
    expect(linearRateKgPerDay(series(values), 21)).toBeCloseTo(-0.1, 9)
  })

  it('handles gaps in the window', () => {
    const values: (number | null)[] = Array.from({ length: 21 }, (_, i) =>
      i % 3 === 0 ? 95 - 0.1 * i : null,
    )
    expect(linearRateKgPerDay(series(values), 21)).toBeCloseTo(-0.1, 6)
  })

  it('needs two readings', () => {
    expect(linearRateKgPerDay(series([92]), 21)).toBeUndefined()
  })
})
