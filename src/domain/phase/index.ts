/**
 * Calibration progress.
 *
 * Calibration does two jobs. The obvious one is establishing real intake.
 * The second is easy to overlook and is worth more: it builds a library of
 * accurately weighed composite meals. Every meal weighed properly in weeks
 * 1–4 becomes a one-tap entry for the next two years.
 *
 * So the completion meter measures library coverage as much as day count,
 * and it reads "day 9 of 24", never "9-day streak". A countdown that gets
 * broken resumes at day 10; a streak that gets broken is lost, and taking it
 * away is a punishment.
 *
 * The phase state machine itself — the dual gate, the extensions, the
 * transitions — lands in phase 2. This module holds what the phase-1 home
 * screen needs and nothing more.
 */

import type { LocalDate, Phase } from '../types.ts'
import type { DayRollup } from '../analytics/index.ts'
import { addDays, daysBetween, today } from '../dates.ts'

export const CALIBRATION_DAYS = 24
export const RECALIBRATION_DAYS = 17

export function defaultPhaseLength(phase: Phase): number {
  switch (phase) {
    case 'calibration':
      return CALIBRATION_DAYS
    case 'recalibration':
      return RECALIBRATION_DAYS
    case 'steady':
      return 0
  }
}

export type CalibrationProgress = {
  phase: Phase
  /** 1-based, so the UI reads "day 9 of 24". */
  dayNumber: number
  totalDays: number
  endDate: LocalDate
  daysRemaining: number
  /** Days logged at weighed fidelity, over days elapsed. */
  daysLogged: number
  coveragePct: number
  /** Meals saved as composites so far — the number worth being proud of. */
  compositesBuilt: number
  /** Share of logged occasions that came from a saved composite. */
  libraryCoveragePct: number
  weightEntries: number
}

export function calibrationProgress(input: {
  phase: Phase
  phaseStartDate: LocalDate
  phaseEndDate?: LocalDate
  rollups: readonly DayRollup[]
  compositesBuilt: number
  /** Occasions logged from a composite, over all occasions logged. */
  occasionsFromComposites: number
  totalOccasions: number
  now?: Date
}): CalibrationProgress {
  const now = input.now ?? new Date()
  const t = today(now)
  const totalDays =
    input.phaseEndDate !== undefined
      ? daysBetween(input.phaseStartDate, input.phaseEndDate) + 1
      : defaultPhaseLength(input.phase)
  const endDate =
    input.phaseEndDate ?? addDays(input.phaseStartDate, Math.max(0, totalDays - 1))

  const elapsed = daysBetween(input.phaseStartDate, t) + 1
  const dayNumber = Math.min(Math.max(1, elapsed), Math.max(1, totalDays))
  const daysRemaining = Math.max(0, daysBetween(t, endDate))

  const inPhase = input.rollups.filter(
    (r) => r.date >= input.phaseStartDate && r.date <= endDate,
  )
  const daysLogged = inPhase.filter((r) => r.confidence === 'logged').length
  const elapsedClamped = Math.max(1, Math.min(elapsed, totalDays))

  return {
    phase: input.phase,
    dayNumber,
    totalDays,
    endDate,
    daysRemaining,
    daysLogged,
    coveragePct: (daysLogged / elapsedClamped) * 100,
    compositesBuilt: input.compositesBuilt,
    libraryCoveragePct:
      input.totalOccasions > 0
        ? (input.occasionsFromComposites / input.totalOccasions) * 100
        : 0,
    weightEntries: inPhase.filter((r) => r.weightKg !== undefined).length,
  }
}

export function phaseLabel(phase: Phase): string {
  switch (phase) {
    case 'calibration':
      return 'Calibration'
    case 'steady':
      return 'Steady state'
    case 'recalibration':
      return 'Recalibration'
  }
}

export function precisionModeLabel(mode: 'weighed' | 'composite' | 'minimal'): string {
  switch (mode) {
    case 'weighed':
      return 'Weighed'
    case 'composite':
      return 'Composite'
    case 'minimal':
      return 'Minimal'
  }
}

/**
 * What each mode logs and roughly how long a day takes. Stated plainly at
 * the point of switching. All three are legitimate — a lighter mode is a
 * setting change, never a degraded state or a confession.
 */
export const PRECISION_MODE_INFO = {
  weighed: {
    logs: 'Everything on the scale, entered in grams.',
    effort: '3–5 min a day',
    feeds: 'Feeds every calculation in the app, including measured expenditure.',
  },
  composite: {
    logs: 'One tap per known meal. Weigh only what is new.',
    effort: '30–60 sec a day',
    feeds: 'Feeds every calculation in the app, including measured expenditure.',
  },
  minimal: {
    logs: 'Protein grams and a saturated-fat high/low flag.',
    effort: '15 sec a day',
    feeds:
      'Keeps the protein and weight series continuous. Cannot feed measured expenditure, which needs full intake.',
  },
} as const
