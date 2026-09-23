/**
 * The adjustment rule.
 *
 *   every day:
 *     if daysSinceLastEvaluation < 21: return
 *     if anySuppressor():             log SUPPRESSED, reset clock, return
 *     if not observedTdee.sufficient: log INSUFFICIENT, reset clock, return
 *
 *     actual   = trend change, kg/week, over the window
 *     intended = goal.targetRateKgPerWeek
 *
 *     if sign(actual) != sign(intended) or |actual| < |intended| * 0.5:
 *         apply ±225 kcal to carbohydrate only
 *     reset clock
 *
 * Three weeks, never shorter. Never on a single week, never on a single
 * day's weight. Every evaluation writes an event with its inputs and a
 * plain rationale, including the ones that changed nothing -- the survey's
 * finding was that an explained adjustment is trusted and an unexplained one
 * is resented.
 *
 * Runs only in steady state: calibration accumulates, recalibration pauses.
 *
 * Past events never change. If a later edit moves the inputs of a past
 * evaluation, `annotateEvent` appends a note instead. And the clock does not
 * reset on an edit, or routine corrections would postpone evaluation
 * indefinitely.
 */

import type {
  AdjustmentEvent,
  AdjustmentNote,
  Goal,
  LocalDate,
  Phase,
} from '../types.ts'
import type { DayRollup } from '../analytics/index.ts'
import { adherencePct } from '../analytics/index.ts'
import { addDays, daysBetween, formatDisplayDate } from '../dates.ts'
import type { WeightReading } from './weightTrend.ts'
import { weightTrend, trendOn } from './weightTrend.ts'
import { observedTdee, regressWeights, TDEE_WINDOW_DAYS, type TdeeResult } from './tdee.ts'

export const EVALUATION_INTERVAL_DAYS = 21
export const ADJUSTMENT_STEP_KCAL = 225
export const MIN_ADHERENCE_PCT = 70
export const MIN_WINDOW_READINGS = 8
/** Weight moving more than this share of body weight in one week flags review. */
export const MAX_WEEKLY_MOVE_PCT = 1
/** At maintenance, drift inside this band is noise and is left alone. */
export const MAINTENANCE_TOLERANCE_KG_PER_WEEK = 0.2

export type EvaluationInput = {
  /** The day being evaluated. The window is the 21 complete days before it. */
  date: LocalDate
  phase: Phase
  /** When the current phase started; the first clock runs from here. */
  phaseStartDate: LocalDate
  goal?: Goal
  lastEvaluationDate?: LocalDate
  rollups: readonly DayRollup[]
  readings: readonly WeightReading[]
  /** kcal and carbs targets as they stand before this evaluation. */
  before: { kcal: number; carbsG: number }
  /**
   * Resolve kcal and carbs after applying a delta, so the clamp is
   * honoured and reported. Injected so this module stays pure.
   */
  resolveAfter: (deltaKcal: number) => { kcal: number; carbsG: number; clamped: boolean }
  newId: () => string
  now?: number
}

export function isEvaluationDue(input: {
  date: LocalDate
  phase: Phase
  phaseStartDate: LocalDate
  lastEvaluationDate?: LocalDate
}): boolean {
  if (input.phase !== 'steady') return false
  const anchor = input.lastEvaluationDate ?? input.phaseStartDate
  return daysBetween(anchor, input.date) >= EVALUATION_INTERVAL_DAYS
}

export type WindowInputs = {
  windowStart: LocalDate
  windowEnd: LocalDate
  adherence: number
  readingsInWindow: number
  tdee: TdeeResult
  trendKgPerWeek?: number
  suppressors: string[]
}

/** Compute everything an evaluation reads, for the window ending the day before `date`. */
export function windowInputs(input: {
  date: LocalDate
  goal?: Goal
  phaseStartDate: LocalDate
  rollups: readonly DayRollup[]
  readings: readonly WeightReading[]
}): WindowInputs {
  const windowEnd = addDays(input.date, -1)
  const windowStart = addDays(windowEnd, -(TDEE_WINDOW_DAYS - 1))
  const inWindow = input.rollups.filter(
    (r) => r.date >= windowStart && r.date <= windowEnd,
  )
  const adherence = adherencePct(inWindow, TDEE_WINDOW_DAYS)
  const readings = input.readings.filter(
    (r) => r.date >= windowStart && r.date <= windowEnd,
  )
  const tdee = observedTdee({
    rollups: input.rollups,
    readings: input.readings,
    windowEnd,
  })
  const fit = regressWeights(readings)
  const trendKgPerWeek = fit ? fit.slope * 7 : undefined

  const suppressors: string[] = []
  if (adherence < MIN_ADHERENCE_PCT) {
    suppressors.push(
      `Logging covered ${Math.round(adherence)}% of the window's days at full fidelity, under the ${MIN_ADHERENCE_PCT}% the review needs.`,
    )
  }
  if (readings.length < MIN_WINDOW_READINGS) {
    suppressors.push(
      `${readings.length} weight readings in the window; the review needs ${MIN_WINDOW_READINGS}.`,
    )
  }
  const fastWeek = largestWeeklyMovePct(input.readings, windowStart, windowEnd)
  if (fastWeek !== undefined && fastWeek > MAX_WEEKLY_MOVE_PCT) {
    suppressors.push(
      `Weight moved ${fastWeek.toFixed(1)}% of body weight within a single week. Flagged for review rather than adjusted — a move that fast is usually water, and may have causes unrelated to diet.`,
    )
  }
  if (input.goal && input.goal.startDate >= windowStart && input.goal.startDate <= windowEnd) {
    suppressors.push('The goal changed inside the window, so the window measures two different plans.')
  }
  if (input.phaseStartDate > windowStart && input.phaseStartDate <= windowEnd) {
    suppressors.push('The phase changed inside the window.')
  }

  return {
    windowStart,
    windowEnd,
    adherence,
    readingsInWindow: readings.length,
    tdee,
    ...(trendKgPerWeek !== undefined ? { trendKgPerWeek } : {}),
    suppressors,
  }
}

/** The largest trend move across any 7-day span in the window, as % of weight. */
export function largestWeeklyMovePct(
  readings: readonly WeightReading[],
  start: LocalDate,
  end: LocalDate,
): number | undefined {
  const upToEnd = readings.filter((r) => r.date <= end)
  if (upToEnd.length < 2) return undefined
  const points = weightTrend(upToEnd)
  let worst: number | undefined
  let cursor = start
  while (addDays(cursor, 7) <= end) {
    const a = trendOn(points, cursor)
    const b = trendOn(points, addDays(cursor, 7))
    if (a !== undefined && b !== undefined && a > 0) {
      const pct = (Math.abs(b - a) / a) * 100
      if (worst === undefined || pct > worst) worst = pct
    }
    cursor = addDays(cursor, 1)
  }
  return worst
}

/**
 * The rule itself: given the actual and intended rates, the signed delta.
 * Loss wants a negative rate; gain a positive one; maintenance wants
 * neither, and drift inside a small tolerance is noise.
 */
export function ruleDelta(
  direction: Goal['direction'],
  actualKgPerWeek: number,
  intendedKgPerWeek: number,
): number {
  if (direction === 'maintain') {
    if (Math.abs(actualKgPerWeek) <= MAINTENANCE_TOLERANCE_KG_PER_WEEK) return 0
    return actualKgPerWeek > 0 ? -ADJUSTMENT_STEP_KCAL : ADJUSTMENT_STEP_KCAL
  }
  const wrongWay = Math.sign(actualKgPerWeek) !== Math.sign(intendedKgPerWeek)
  const tooSlow = Math.abs(actualKgPerWeek) < Math.abs(intendedKgPerWeek) * 0.5
  if (!wrongWay && !tooSlow) return 0
  return direction === 'loss' ? -ADJUSTMENT_STEP_KCAL : ADJUSTMENT_STEP_KCAL
}

/** Run one evaluation. Returns undefined when none is due. */
export function evaluateAdjustment(input: EvaluationInput): AdjustmentEvent | undefined {
  if (
    !isEvaluationDue({
      date: input.date,
      phase: input.phase,
      phaseStartDate: input.phaseStartDate,
      ...(input.lastEvaluationDate !== undefined
        ? { lastEvaluationDate: input.lastEvaluationDate }
        : {}),
    })
  ) {
    return undefined
  }

  const w = windowInputs({
    date: input.date,
    ...(input.goal ? { goal: input.goal } : {}),
    phaseStartDate: input.phaseStartDate,
    rollups: input.rollups,
    readings: input.readings,
  })

  const base = {
    id: input.newId(),
    at: input.now ?? Date.now(),
    date: input.date,
    trigger: 'scheduled' as const,
    windowStart: w.windowStart,
    windowEnd: w.windowEnd,
    adherencePct: w.adherence,
    weightReadings: w.readingsInWindow,
    before: input.before,
    ...(w.tdee.sufficient
      ? { observedTdee: w.tdee.kcal, observedTdeeSe: w.tdee.standardError }
      : {}),
    ...(w.trendKgPerWeek !== undefined ? { trendKgPerWeek: w.trendKgPerWeek } : {}),
    ...(input.goal ? { intendedKgPerWeek: input.goal.targetRateKgPerWeek } : {}),
  }

  if (w.suppressors.length > 0) {
    return {
      ...base,
      outcome: 'suppressed',
      after: input.before,
      deltaKcal: 0,
      suppressedBy: w.suppressors,
      rationale: `No change. ${w.suppressors.join(' ')}`,
    }
  }

  if (!w.tdee.sufficient) {
    return {
      ...base,
      outcome: 'insufficient',
      after: input.before,
      deltaKcal: 0,
      rationale:
        'No change. There was not enough logged intake to measure expenditure over the window.',
    }
  }

  const direction = input.goal?.direction ?? 'maintain'
  const intended = input.goal?.targetRateKgPerWeek ?? 0
  const actual = w.trendKgPerWeek ?? 0
  const delta = ruleDelta(direction, actual, intended)
  const rateText = `${actual >= 0 ? '+' : ''}${actual.toFixed(2)} kg/week`

  if (delta === 0) {
    return {
      ...base,
      outcome: 'held',
      after: input.before,
      deltaKcal: 0,
      rationale: `No change. Weight moved ${rateText} against an intended ${intended.toFixed(2)} kg/week, which is on course. Measured expenditure about ${Math.round(w.tdee.kcal)} kcal, ±${Math.round(w.tdee.standardError)}.`,
    }
  }

  const after = input.resolveAfter(delta)
  return {
    ...base,
    outcome: 'adjusted',
    after: { kcal: after.kcal, carbsG: after.carbsG },
    deltaKcal: delta,
    ...(after.clamped ? { clamped: true } : {}),
    rationale: `Weight moved ${rateText} against an intended ${intended.toFixed(2)} kg/week over three weeks, so carbohydrate moved by ${delta > 0 ? '+' : ''}${delta} kcal. Protein and fat hold.${after.clamped ? ' A guardrail floor limited the change.' : ''}`,
  }
}

/** The carbohydrate energy applied by every event so far. */
export function cumulativeAdjustment(events: readonly AdjustmentEvent[]): number {
  return events.reduce((a, e) => a + (e.outcome === 'adjusted' ? e.deltaKcal : 0), 0)
}

export function lastEvaluationDate(
  events: readonly AdjustmentEvent[],
): LocalDate | undefined {
  let last: LocalDate | undefined
  for (const e of events) if (last === undefined || e.date > last) last = e.date
  return last
}

/**
 * After an edit, re-read a past event's window with current data. If the
 * inputs moved, return a note to append -- the event itself never changes.
 * Returns undefined when nothing material moved, or when the note would
 * repeat the last one.
 */
export function annotateEvent(input: {
  event: AdjustmentEvent
  editedDates: readonly LocalDate[]
  goal?: Goal
  phaseStartDate: LocalDate
  rollups: readonly DayRollup[]
  readings: readonly WeightReading[]
  now?: number
}): AdjustmentNote | undefined {
  const { event } = input
  const touched = input.editedDates.filter(
    (d) => d >= event.windowStart && d <= event.windowEnd,
  )
  if (touched.length === 0) return undefined

  const w = windowInputs({
    date: event.date,
    ...(input.goal ? { goal: input.goal } : {}),
    phaseStartDate: input.phaseStartDate,
    rollups: input.rollups,
    readings: input.readings,
  })

  const last = event.notes?.[event.notes.length - 1]
  const prevAdherence = last?.adherencePct ?? event.adherencePct
  const prevTdee = last ? last.observedTdee : event.observedTdee
  const nowTdee = w.tdee.sufficient ? w.tdee.kcal : undefined

  const adherenceMoved = Math.round(w.adherence) !== Math.round(prevAdherence)
  const tdeeMoved =
    (nowTdee === undefined) !== (prevTdee === undefined) ||
    (nowTdee !== undefined && prevTdee !== undefined && Math.abs(nowTdee - prevTdee) >= 25)
  if (!adherenceMoved && !tdeeMoved) return undefined

  const parts = [
    `Edited ${touched.map((d) => formatDisplayDate(d)).join(', ')} after this review.`,
    `With current data the window's adherence reads ${Math.round(w.adherence)}%`,
  ]
  parts[1] += nowTdee !== undefined
    ? ` and expenditure about ${Math.round(nowTdee)} kcal.`
    : ' and expenditure cannot be measured.'
  parts.push('The decision stands as made on the evidence at the time.')

  return {
    at: input.now ?? Date.now(),
    text: parts.join(' '),
    adherencePct: w.adherence,
    ...(nowTdee !== undefined ? { observedTdee: nowTdee } : {}),
  }
}
