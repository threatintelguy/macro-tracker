/**
 * The engine service: where the pure calculation engine meets storage.
 *
 * Two entry points:
 *
 *   runDailyEngine()     -- on boot and after midnight. Freezes the TDEE
 *                           estimate for every completed window not yet
 *                           stored, and runs the adjustment rule if due.
 *   recomputeAfterEdit() -- after any write to a day. Re-derives what an
 *                           edit is allowed to move, and nothing else.
 *
 * The rules for an edit:
 *   - the edited day's rollup recomputes immediately;
 *   - observed TDEE recomputes only if the day is inside the current
 *     21-day window -- older estimates were right given what was known then;
 *   - past adjustments never change; a note is appended instead;
 *   - the adjustment clock does not reset;
 *   - adherence is always computed live, so a backfill can lift a window.
 */

import type { AdjustmentEvent, LocalDate, TdeeEstimate } from '../domain/types.ts'
import { addDays, today as todayOf } from '../domain/dates.ts'
import {
  observedTdee,
  toStoredEstimate,
  dateInCurrentWindow,
  latestSufficient,
  TDEE_WINDOW_DAYS,
} from '../domain/engine/tdee.ts'
import {
  annotateEvent,
  cumulativeAdjustment,
  evaluateAdjustment,
  lastEvaluationDate,
} from '../domain/engine/adjustment.ts'
import { resolveTargets, type ObservedTdee, type ResolvedTargets } from '../domain/engine/targets.ts'
import { currentTrend, weightTrend } from '../domain/engine/weightTrend.ts'
import { db } from './db.ts'
import * as repo from './repositories.ts'

/** The current window ends yesterday: today is still being logged. */
export function currentWindowEnd(now: Date = new Date()): LocalDate {
  return addDays(todayOf(now), -1)
}

async function history(): Promise<{
  rollups: Awaited<ReturnType<typeof repo.getRollupsBetween>>
  readings: Awaited<ReturnType<typeof repo.getWeightReadings>>
}> {
  const earliest = (await repo.earliestRecordDate()) ?? todayOf()
  const [rollups, readings] = await Promise.all([
    repo.getRollupsBetween(earliest, todayOf()),
    repo.getWeightReadings(),
  ])
  return { rollups, readings }
}

/**
 * The maintenance figure the targets should use right now.
 *
 * Targets move at decision points, not daily: in steady state the observed
 * TDEE is the latest sufficient estimate at or before the most recent
 * evaluation (or the start of steady state). During calibration it is the
 * formula -- calibration accumulates, it does not steer.
 */
export function maintenanceObserved(input: {
  phase: 'calibration' | 'steady' | 'recalibration'
  phaseStartDate: LocalDate
  estimates: readonly TdeeEstimate[]
  events: readonly AdjustmentEvent[]
}): ObservedTdee | undefined {
  if (input.phase !== 'steady') return undefined
  const lastEval = lastEvaluationDate(input.events)
  const anchor =
    lastEval !== undefined && lastEval > input.phaseStartDate
      ? lastEval
      : input.phaseStartDate
  const eligible = input.estimates.filter((e) => e.windowEnd < anchor)
  const best = latestSufficient(eligible)
  if (!best) return undefined
  return {
    kcal: best.kcal,
    standardError: best.standardError,
    sufficient: true,
    windowDays: best.windowDays,
  }
}

/** Resolve targets exactly as the app shows them, from storage. */
export async function resolveStoredTargets(): Promise<ResolvedTargets | undefined> {
  const [profile, settings, goal, readings, estimates, events] = await Promise.all([
    repo.getProfile(),
    repo.getSettings(),
    repo.getActiveGoal(),
    repo.getWeightReadings(),
    repo.getTdeeEstimates(),
    repo.getAdjustments(),
  ])
  const weightKg = currentTrend(weightTrend(readings))
  if (!profile || weightKg === undefined) return undefined
  const observed = maintenanceObserved({
    phase: profile.phase,
    phaseStartDate: profile.phaseStartDate,
    estimates,
    events,
  })
  return resolveTargets({
    profile,
    weightKg,
    settings,
    goalDirection: goal?.direction ?? 'maintain',
    ...(observed ? { observedTdee: observed } : {}),
    adjustmentKcal: cumulativeAdjustment(events),
  })
}

/**
 * Freeze an estimate for every completed window not yet stored, then run
 * the adjustment rule if an evaluation is due today.
 */
export async function runDailyEngine(now: Date = new Date()): Promise<{
  estimatesWritten: number
  event?: AdjustmentEvent
}> {
  const windowEnd = currentWindowEnd(now)
  const [stored, earliest] = await Promise.all([
    repo.getTdeeEstimates(),
    repo.earliestRecordDate(),
  ])
  if (earliest === undefined) return { estimatesWritten: 0 }

  const { rollups, readings } = await history()
  const have = new Set(stored.map((e) => e.windowEnd))
  const firstEnd = addDays(earliest, TDEE_WINDOW_DAYS - 1)
  const fresh: TdeeEstimate[] = []
  for (let d = firstEnd; d <= windowEnd; d = addDays(d, 1)) {
    // The current window is always recomputed; older ones only if absent.
    if (have.has(d) && d !== windowEnd) continue
    fresh.push(
      toStoredEstimate(
        observedTdee({ rollups, readings, windowEnd: d, now: now.getTime() }),
      ),
    )
  }
  if (fresh.length > 0) await repo.putTdeeEstimates(fresh)

  const event = await maybeEvaluate(now, rollups, readings)
  return { estimatesWritten: fresh.length, ...(event ? { event } : {}) }
}

async function maybeEvaluate(
  now: Date,
  rollups: Awaited<ReturnType<typeof repo.getRollupsBetween>>,
  readings: Awaited<ReturnType<typeof repo.getWeightReadings>>,
): Promise<AdjustmentEvent | undefined> {
  const [profile, goal, events, settings] = await Promise.all([
    repo.getProfile(),
    repo.getActiveGoal(),
    repo.getAdjustments(),
    repo.getSettings(),
  ])
  if (!profile) return undefined
  const before = await resolveStoredTargets()
  if (!before) return undefined

  const weightKg = currentTrend(weightTrend(readings))
  const estimates = await repo.getTdeeEstimates()
  const observed = maintenanceObserved({
    phase: profile.phase,
    phaseStartDate: profile.phaseStartDate,
    estimates,
    events,
  })
  const applied = cumulativeAdjustment(events)
  const lastEval = lastEvaluationDate(events)

  const event = evaluateAdjustment({
    date: todayOf(now),
    phase: profile.phase,
    phaseStartDate: profile.phaseStartDate,
    ...(goal ? { goal } : {}),
    ...(lastEval !== undefined ? { lastEvaluationDate: lastEval } : {}),
    rollups,
    readings,
    before: {
      kcal: before.targets.kcal.value,
      carbsG: before.targets.carbs.value,
    },
    resolveAfter: (delta) => {
      const after = resolveTargets({
        profile,
        weightKg: weightKg ?? 0,
        settings,
        goalDirection: goal?.direction ?? 'maintain',
        ...(observed ? { observedTdee: observed } : {}),
        adjustmentKcal: applied + delta,
      })
      return {
        kcal: after.targets.kcal.value,
        carbsG: after.targets.carbs.value,
        clamped: after.clamped.some((c) => c.key === 'kcal'),
      }
    },
    newId: () => repo.newId('adj'),
    now: now.getTime(),
  })
  if (event) await repo.putAdjustment(event)
  return event
}

/**
 * Re-derive what an edit to these dates is allowed to move. Call after any
 * write to a day: an entry added, edited or deleted, a weight, a note, an
 * import, a purge.
 */
export async function recomputeAfterEdit(
  dates: readonly LocalDate[],
  now: Date = new Date(),
): Promise<{ tdeeRecomputed: boolean; notesAppended: number }> {
  for (const d of dates) repo.invalidateRollup(d)
  if (dates.length === 0) return { tdeeRecomputed: false, notesAppended: 0 }

  const { rollups, readings } = await history()
  const windowEnd = currentWindowEnd(now)

  let tdeeRecomputed = false
  if (dates.some((d) => dateInCurrentWindow(d, windowEnd))) {
    await repo.putTdeeEstimates([
      toStoredEstimate(
        observedTdee({ rollups, readings, windowEnd, now: now.getTime() }),
      ),
    ])
    tdeeRecomputed = true
  }

  const [profile, goal, events] = await Promise.all([
    repo.getProfile(),
    repo.getActiveGoal(),
    repo.getAdjustments(),
  ])
  let notesAppended = 0
  if (profile) {
    for (const event of events) {
      const note = annotateEvent({
        event,
        editedDates: dates,
        ...(goal ? { goal } : {}),
        phaseStartDate: profile.phaseStartDate,
        rollups,
        readings,
        now: now.getTime(),
      })
      if (!note) continue
      // The event's decision is never rewritten; only its notes grow.
      await db.adjustments.put({ ...event, notes: [...(event.notes ?? []), note] })
      notesAppended++
    }
  }

  return { tdeeRecomputed, notesAppended }
}
