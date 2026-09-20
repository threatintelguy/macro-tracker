/**
 * Guardrail clamps.
 *
 * Applied LAST in target resolution, after every other layer including
 * manual override. There is no setting, no advanced mode, and no override
 * path -- if a computed target falls below a clamp, the clamp wins, the
 * event is recorded with `clamped: true`, and the UI says plainly that a
 * floor was reached and why.
 *
 * This module has no dependencies on purpose, and it is the most heavily
 * tested file in the codebase.
 */

import type { TargetSet, TargetValue } from '../types.ts'

export const CLAMPS = {
  minKcal: 1800,
  minFatGPerKg: 0.5,
  minProteinGPerKg: 1.2,
  maxDeficitKcal: 750,
  maxLossRatePctPerWeek: 1.0,
  maxGainRateLbPerWeek: 0.5,
  /** Goals below this BMI are refused at input, never merely clamped. */
  minGoalBmi: 18.5,
} as const

export const LB_PER_KG = 2.20462

export type ClampReport = {
  key: string
  from: number
  to: number
  reason: string
}

export type ClampResult = {
  targets: TargetSet
  clamped: ClampReport[]
}

function clampField(
  current: TargetValue,
  floor: number,
  reason: string,
  report: ClampReport[],
  key: string,
): TargetValue {
  if (current.value >= floor) return current
  report.push({ key, from: current.value, to: floor, reason })
  return {
    value: floor,
    source: 'clamped',
    rationale: reason,
    clampedFrom: current.value,
    updatedAt: current.updatedAt ?? Date.now(),
  }
}

/**
 * Apply every hard clamp to a resolved target set.
 *
 * Order matters: the energy floors run first, then the macro floors, then
 * carbohydrate is recomputed from whatever energy survived so the set stays
 * internally coherent. A clamped protein or fat floor can push implied
 * energy above the stated kcal target; in that case kcal is raised to match
 * rather than carbs being driven negative.
 */
export function applyClamps(input: {
  targets: TargetSet
  weightKg: number
  /** Maintenance estimate, formula or observed. Gates the deficit clamp. */
  maintenanceKcal?: number
}): ClampResult {
  const { weightKg, maintenanceKcal } = input
  const clamped: ClampReport[] = []
  const t: TargetSet = { ...input.targets }

  // 1. Absolute calorie floor.
  t.kcal = clampField(
    t.kcal,
    CLAMPS.minKcal,
    `Calories will not go below ${CLAMPS.minKcal} kcal. This is a fixed floor with no override.`,
    clamped,
    'kcal',
  )

  // 2. Maximum deficit, measured against maintenance.
  if (maintenanceKcal !== undefined && Number.isFinite(maintenanceKcal)) {
    const deficitFloor = maintenanceKcal - CLAMPS.maxDeficitKcal
    if (t.kcal.value < deficitFloor) {
      const floor = Math.max(deficitFloor, CLAMPS.minKcal)
      t.kcal = clampField(
        t.kcal,
        floor,
        `A deficit larger than ${CLAMPS.maxDeficitKcal} kcal below maintenance is not available. Raised to ${Math.round(floor)} kcal.`,
        clamped,
        'kcal',
      )
    }
  }

  // 3. Macro floors, in g/kg of body weight.
  const proteinFloor = CLAMPS.minProteinGPerKg * weightKg
  t.protein = clampField(
    t.protein,
    proteinFloor,
    `Protein will not go below ${CLAMPS.minProteinGPerKg} g/kg (${Math.round(proteinFloor)} g at ${weightKg.toFixed(1)} kg).`,
    clamped,
    'protein',
  )

  const fatFloor = CLAMPS.minFatGPerKg * weightKg
  t.fat = clampField(
    t.fat,
    fatFloor,
    `Fat will not go below ${CLAMPS.minFatGPerKg} g/kg (${Math.round(fatFloor)} g at ${weightKg.toFixed(1)} kg).`,
    clamped,
    'fat',
  )

  // 4. Keep the set coherent. Protein and fat are fixed by the clamps above;
  //    carbohydrate takes the remainder, and if there is none, energy rises.
  const proteinKcal = t.protein.value * 4
  const fatKcal = t.fat.value * 9
  const floorKcal = proteinKcal + fatKcal

  if (floorKcal > t.kcal.value) {
    const reason = `Protein and fat floors together require ${Math.round(floorKcal)} kcal, so the calorie target was raised to match.`
    clamped.push({ key: 'kcal', from: t.kcal.value, to: floorKcal, reason })
    t.kcal = {
      value: floorKcal,
      source: 'clamped',
      rationale: reason,
      clampedFrom: t.kcal.value,
      updatedAt: Date.now(),
    }
  }

  const remainderCarbs = Math.max(0, (t.kcal.value - floorKcal) / 4)
  if (Math.abs(remainderCarbs - t.carbs.value) > 0.5) {
    t.carbs = {
      value: remainderCarbs,
      source: t.carbs.source === 'user' ? 'clamped' : t.carbs.source,
      rationale:
        t.carbs.source === 'user'
          ? 'Carbohydrate recomputed from the clamped energy and macro floors.'
          : t.carbs.rationale,
      ...(t.carbs.source === 'user' ? { clampedFrom: t.carbs.value } : {}),
      updatedAt: t.carbs.updatedAt ?? Date.now(),
    }
  }

  return { targets: t, clamped }
}

/** The fastest loss rate permitted, in kg/week, at a given body weight. */
export function maxLossRateKgPerWeek(weightKg: number): number {
  return (weightKg * CLAMPS.maxLossRatePctPerWeek) / 100
}

/** The fastest gain rate permitted, in kg/week. Body-weight independent. */
export function maxGainRateKgPerWeek(): number {
  return CLAMPS.maxGainRateLbPerWeek / LB_PER_KG
}

export type GoalValidation = {
  ok: boolean
  /** Populated when ok is false. Refused at input, not accepted then clamped. */
  problems: string[]
}

/**
 * Goal-setting limits. These refuse at input rather than accepting and then
 * clamping, so the app never displays a number it will not honour.
 */
export function validateGoal(input: {
  direction: 'loss' | 'maintain' | 'gain'
  rateKgPerWeek: number
  currentWeightKg: number
  heightCm: number
  targetWeightKg?: number
  plannedKcal?: number
  maintenanceKcal?: number
}): GoalValidation {
  const problems: string[] = []
  const {
    direction,
    rateKgPerWeek,
    currentWeightKg,
    heightCm,
    targetWeightKg,
    plannedKcal,
    maintenanceKcal,
  } = input

  const magnitude = Math.abs(rateKgPerWeek)

  if (direction === 'loss') {
    const cap = maxLossRateKgPerWeek(currentWeightKg)
    if (magnitude > cap + 1e-9) {
      problems.push(
        `A loss rate of ${magnitude.toFixed(2)} kg/week is above the ${CLAMPS.maxLossRatePctPerWeek}% of body weight limit (${cap.toFixed(2)} kg/week at ${currentWeightKg.toFixed(1)} kg).`,
      )
    }
  }

  if (direction === 'gain') {
    const cap = maxGainRateKgPerWeek()
    if (magnitude > cap + 1e-9) {
      problems.push(
        `A gain rate of ${magnitude.toFixed(2)} kg/week is above the ${CLAMPS.maxGainRateLbPerWeek} lb/week limit (${cap.toFixed(2)} kg/week).`,
      )
    }
  }

  if (targetWeightKg !== undefined) {
    const m = heightCm / 100
    const targetBmi = targetWeightKg / (m * m)
    if (targetBmi < CLAMPS.minGoalBmi) {
      const floorWeight = CLAMPS.minGoalBmi * m * m
      problems.push(
        `A target weight of ${targetWeightKg.toFixed(1)} kg is below a BMI of ${CLAMPS.minGoalBmi} for this height (${floorWeight.toFixed(1)} kg).`,
      )
    }
  }

  if (plannedKcal !== undefined && maintenanceKcal !== undefined) {
    const deficit = maintenanceKcal - plannedKcal
    if (deficit > CLAMPS.maxDeficitKcal + 1e-9) {
      problems.push(
        `A deficit of ${Math.round(deficit)} kcal is above the ${CLAMPS.maxDeficitKcal} kcal limit.`,
      )
    }
    if (plannedKcal < CLAMPS.minKcal) {
      problems.push(
        `A calorie target of ${Math.round(plannedKcal)} kcal is below the ${CLAMPS.minKcal} kcal floor.`,
      )
    }
  }

  return { ok: problems.length === 0, problems }
}
