/**
 * Observed TDEE and the adjustment rule, against synthetic series of known
 * ground truth.
 */

import { describe, expect, it } from 'vitest'
import { rollupDay, type DayRollup } from '../../src/domain/analytics/index.ts'
import { makeNutrients } from '../../src/domain/nutrition/index.ts'
import { addDays, dateRange } from '../../src/domain/dates.ts'
import {
  dateInCurrentWindow,
  latestSufficient,
  observedTdee,
  TDEE_WINDOW_DAYS,
} from '../../src/domain/engine/tdee.ts'
import {
  ADJUSTMENT_STEP_KCAL,
  annotateEvent,
  cumulativeAdjustment,
  evaluateAdjustment,
  isEvaluationDue,
  ruleDelta,
  type EvaluationInput,
} from '../../src/domain/engine/adjustment.ts'
import { graduationGate } from '../../src/domain/phase/index.ts'
import type { Goal, TdeeEstimate } from '../../src/domain/types.ts'
import type { WeightReading } from '../../src/domain/engine/weightTrend.ts'

const END = '2026-09-21'

/** A run of days: intake per day (null for not logged) and a weight line. */
function history(input: {
  days: number
  end?: string
  intake: (i: number) => number | null
  kg: (i: number) => number | null
  kcalUnknownOn?: (i: number) => boolean
}): { rollups: DayRollup[]; readings: WeightReading[] } {
  const end = input.end ?? END
  const dates = dateRange(addDays(end, -(input.days - 1)), end)
  const rollups: DayRollup[] = []
  const readings: WeightReading[] = []
  dates.forEach((date, i) => {
    const kcal = input.intake(i)
    const w = input.kg(i)
    if (w !== null) readings.push({ date, kg: w })
    if (kcal === null) return
    rollups.push(
      rollupDay({
        day: { date, phase: 'steady', precisionMode: 'weighed', entries: [], training: [] },
        entries: [
          {
            id: `e${date}`,
            date,
            source: { kind: 'food', foodId: 'f', name: 'Food' },
            grams: 100,
            nutrients: makeNutrients({ kcal: input.kcalUnknownOn?.(i) ? null : kcal }),
            fidelity: 'weighed',
            createdAt: i,
          },
        ],
      }),
    )
  })
  return { rollups, readings }
}

describe('observed TDEE', () => {
  it('recovers expenditure from a steady loss of known size', () => {
    // 2,500 kcal a day while losing 0.5 kg a week: 2500 + 0.5/7 × 7700 = 3050.
    const h = history({ days: 21, intake: () => 2500, kg: (i) => 90 - (0.5 / 7) * i })
    const r = observedTdee({ ...h, windowEnd: END })
    expect(r.sufficient).toBe(true)
    expect(r.kcal).toBeCloseTo(3050, 3)
    expect(r.standardError).toBeLessThan(1)
  })

  it('carries a band that widens with noisy weights', () => {
    const noise = [0.6, -0.4, 0.2, -0.7, 0.5, -0.1, 0.3]
    const h = history({ days: 21, intake: () => 2500, kg: (i) => 90 + noise[i % 7]! })
    const r = observedTdee({ ...h, windowEnd: END })
    expect(r.standardError).toBeGreaterThan(50)
  })

  it('is insufficient below 70% coverage', () => {
    // 14 of 21 days logged is 66.7%.
    const h = history({ days: 21, intake: (i) => (i < 14 ? 2500 : null), kg: () => 90 })
    expect(observedTdee({ ...h, windowEnd: END }).sufficient).toBe(false)
    const h2 = history({ days: 21, intake: (i) => (i < 15 ? 2500 : null), kg: () => 90 })
    expect(observedTdee({ ...h2, windowEnd: END }).sufficient).toBe(true)
  })

  it('excludes days whose calories are unknown', () => {
    // A floor of 900 on eight days would drag the mean down if it counted.
    const h = history({
      days: 21,
      intake: (i) => (i % 3 === 0 ? 900 : 2500),
      kcalUnknownOn: (i) => i % 3 === 0,
      kg: () => 90,
    })
    const r = observedTdee({ ...h, windowEnd: END })
    expect(r.loggedDays).toBe(14)
    expect(r.meanIntakeKcal).toBe(2500)
  })

  it('knows which dates the current window covers', () => {
    expect(dateInCurrentWindow(END, END)).toBe(true)
    expect(dateInCurrentWindow(addDays(END, -(TDEE_WINDOW_DAYS - 1)), END)).toBe(true)
    expect(dateInCurrentWindow(addDays(END, -TDEE_WINDOW_DAYS), END)).toBe(false)
  })

  it('picks the latest sufficient estimate', () => {
    const e = (windowEnd: string, sufficient: boolean): TdeeEstimate => ({
      windowEnd,
      windowStart: addDays(windowEnd, -20),
      kcal: 3000,
      standardError: 100,
      sufficient,
      loggedDays: 21,
      windowDays: 21,
      computedAt: 0,
    })
    expect(latestSufficient([e('2026-09-01', true), e('2026-09-10', false), e('2026-09-05', true)])!.windowEnd).toBe(
      '2026-09-05',
    )
  })
})

describe('the adjustment rule', () => {
  it('adjusts when loss is under half the intended rate, and toward the goal', () => {
    expect(ruleDelta('loss', -0.1, -0.35)).toBe(-ADJUSTMENT_STEP_KCAL)
    expect(ruleDelta('loss', 0.1, -0.35)).toBe(-ADJUSTMENT_STEP_KCAL)
    expect(ruleDelta('loss', -0.3, -0.35)).toBe(0)
    expect(ruleDelta('gain', 0.02, 0.2)).toBe(ADJUSTMENT_STEP_KCAL)
    expect(ruleDelta('maintain', 0.1, 0)).toBe(0)
    expect(ruleDelta('maintain', 0.5, 0)).toBe(-ADJUSTMENT_STEP_KCAL)
  })

  it('runs every 21 days, in steady state only', () => {
    expect(isEvaluationDue({ date: '2026-09-21', phase: 'steady', phaseStartDate: '2026-08-31' })).toBe(true)
    expect(isEvaluationDue({ date: '2026-09-20', phase: 'steady', phaseStartDate: '2026-08-31' })).toBe(false)
    expect(isEvaluationDue({ date: '2026-09-21', phase: 'calibration', phaseStartDate: '2026-08-31' })).toBe(false)
    expect(
      isEvaluationDue({
        date: '2026-09-21',
        phase: 'steady',
        phaseStartDate: '2026-01-01',
        lastEvaluationDate: '2026-09-10',
      }),
    ).toBe(false)
  })

  const goal: Goal = {
    direction: 'loss',
    targetRateKgPerWeek: -0.35,
    startDate: '2026-01-01',
    anchorWeightKg: 90,
    active: true,
    createdAt: 0,
  }

  function input(over: Partial<EvaluationInput>, h: ReturnType<typeof history>): EvaluationInput {
    return {
      date: '2026-09-22',
      phase: 'steady',
      phaseStartDate: '2026-06-01',
      goal,
      lastEvaluationDate: '2026-09-01',
      rollups: h.rollups,
      readings: h.readings,
      before: { kcal: 2500, carbsG: 250 },
      resolveAfter: (d) => ({ kcal: 2500 + d, carbsG: 250 + d / 4, clamped: false }),
      newId: () => 'adj_1',
      now: 0,
      ...over,
    }
  }

  it('applies a carbohydrate change on a stall, and explains it', () => {
    const h = history({ days: 30, intake: () => 2500, kg: () => 90 })
    const e = evaluateAdjustment(input({}, h))!
    expect(e.outcome).toBe('adjusted')
    expect(e.deltaKcal).toBe(-ADJUSTMENT_STEP_KCAL)
    expect(e.after.kcal).toBe(2500 - ADJUSTMENT_STEP_KCAL)
    expect(e.rationale).toContain('carbohydrate')
    expect(cumulativeAdjustment([e])).toBe(-ADJUSTMENT_STEP_KCAL)
  })

  it('holds when on course', () => {
    const h = history({ days: 30, intake: () => 2500, kg: (i) => 92 - (0.4 / 7) * i })
    expect(evaluateAdjustment(input({}, h))!.outcome).toBe('held')
  })

  it('is suppressed below 70% adherence, and says so', () => {
    const h = history({ days: 30, intake: (i) => (i % 2 === 0 ? 2500 : null), kg: () => 90 })
    const e = evaluateAdjustment(input({}, h))!
    expect(e.outcome).toBe('suppressed')
    expect(e.deltaKcal).toBe(0)
    expect(e.suppressedBy!.join(' ')).toContain('70%')
  })

  it('flags a fast weekly move for review rather than adjusting', () => {
    const h = history({ days: 30, intake: () => 2500, kg: (i) => (i < 15 ? 90 : 86) })
    const e = evaluateAdjustment(input({}, h))!
    expect(e.outcome).toBe('suppressed')
    expect(e.suppressedBy!.join(' ')).toContain('single week')
  })

  it('appends a note when a later edit moves a past window, and never rewrites the event', () => {
    const before = history({ days: 30, intake: (i) => (i % 2 === 0 ? 2500 : null), kg: () => 90 })
    const event = evaluateAdjustment(input({}, before))!
    expect(event.outcome).toBe('suppressed')

    // Backfill the missed days: adherence over the same window rises.
    const after = history({ days: 30, intake: () => 2500, kg: () => 90 })
    const note = annotateEvent({
      event,
      editedDates: ['2026-09-10'],
      goal,
      phaseStartDate: '2026-06-01',
      rollups: after.rollups,
      readings: after.readings,
      now: 1,
    })!
    expect(note.text).toContain('stands as made')
    expect(note.adherencePct).toBe(100)
    expect(event.outcome).toBe('suppressed')

    // The same state does not produce a second note.
    const again = annotateEvent({
      event: { ...event, notes: [note] },
      editedDates: ['2026-09-10'],
      goal,
      phaseStartDate: '2026-06-01',
      rollups: after.rollups,
      readings: after.readings,
    })
    expect(again).toBeUndefined()

    // An edit outside the window touches nothing.
    expect(
      annotateEvent({
        event,
        editedDates: ['2026-01-01'],
        goal,
        phaseStartDate: '2026-06-01',
        rollups: after.rollups,
        readings: after.readings,
      }),
    ).toBeUndefined()
  })
})

describe('the calibration gate', () => {
  const progress = {
    phase: 'calibration' as const,
    dayNumber: 24,
    totalDays: 24,
    endDate: '2026-09-01',
    daysRemaining: 0,
    daysLogged: 20,
    coveragePct: 83,
    compositesBuilt: 10,
    libraryCoveragePct: 50,
    weightEntries: 12,
  }

  it('opens only when the date has passed and the data suffices', () => {
    const now = new Date(2026, 8, 5, 12)
    expect(graduationGate({ progress, tdeeSe: 120, now }).passes).toBe(true)
    expect(graduationGate({ progress, tdeeSe: 180, now }).passes).toBe(false)
    expect(graduationGate({ progress, now }).passes).toBe(false)
    expect(graduationGate({ progress, tdeeSe: 120, now: new Date(2026, 7, 20, 12) }).passes).toBe(false)
    expect(graduationGate({ progress: { ...progress, weightEntries: 5 }, tdeeSe: 120, now }).passes).toBe(false)
  })
})
