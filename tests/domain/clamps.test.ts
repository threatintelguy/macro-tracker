/**
 * The guardrail clamps are the most heavily tested file in the codebase,
 * including property-based tests asserting that no input produces a target
 * below a clamp. There is no override path, and these tests are what make
 * that claim true rather than merely intended.
 */

import { describe, expect, it } from 'vitest'
import {
  CLAMPS,
  applyClamps,
  maxGainRateKgPerWeek,
  maxLossRateKgPerWeek,
  validateGoal,
} from '../../src/domain/engine/clamps.ts'
import type { TargetSet, TargetValue } from '../../src/domain/types.ts'

function tv(value: number, source: TargetValue['source'] = 'formula'): TargetValue {
  return { value, source, rationale: 'test' }
}

function targets(over: Partial<Record<keyof TargetSet, number>> = {}): TargetSet {
  const base = {
    kcal: 2500,
    protein: 190,
    fat: 70,
    carbs: 250,
    fibre: 38,
    satFat: 28,
    sodium: 2300,
    addedSugar: 62,
    alcohol: 28,
  }
  const merged = { ...base, ...over }
  return Object.fromEntries(
    Object.entries(merged).map(([k, v]) => [k, tv(v)]),
  ) as TargetSet
}

const WEIGHT = 92.6

describe('applyClamps', () => {
  it('leaves a compliant target set alone apart from carb coherence', () => {
    const result = applyClamps({ targets: targets(), weightKg: WEIGHT })
    expect(result.clamped).toEqual([])
    expect(result.targets.kcal.value).toBe(2500)
    expect(result.targets.protein.value).toBe(190)
    expect(result.targets.fat.value).toBe(70)
  })

  it('raises calories to the absolute floor', () => {
    const result = applyClamps({
      targets: targets({ kcal: 1400, carbs: 40 }),
      weightKg: WEIGHT,
    })
    expect(result.targets.kcal.value).toBeGreaterThanOrEqual(CLAMPS.minKcal)
    expect(result.targets.kcal.source).toBe('clamped')
    expect(result.targets.kcal.clampedFrom).toBe(1400)
    expect(result.clamped.some((c) => c.key === 'kcal')).toBe(true)
  })

  it('refuses a deficit deeper than the maximum below maintenance', () => {
    const result = applyClamps({
      targets: targets({ kcal: 2000 }),
      weightKg: WEIGHT,
      maintenanceKcal: 3100,
    })
    expect(result.targets.kcal.value).toBe(3100 - CLAMPS.maxDeficitKcal)
    expect(result.targets.kcal.source).toBe('clamped')
  })

  it('never lets the deficit clamp push calories below the absolute floor', () => {
    // A very low maintenance would otherwise produce a floor under 1800.
    const result = applyClamps({
      targets: targets({ kcal: 1200 }),
      weightKg: 50,
      maintenanceKcal: 1900,
    })
    expect(result.targets.kcal.value).toBeGreaterThanOrEqual(CLAMPS.minKcal)
  })

  it('applies the protein floor in g/kg', () => {
    const result = applyClamps({
      targets: targets({ protein: 80 }),
      weightKg: WEIGHT,
    })
    expect(result.targets.protein.value).toBeCloseTo(
      CLAMPS.minProteinGPerKg * WEIGHT,
      6,
    )
    expect(result.targets.protein.source).toBe('clamped')
  })

  it('applies the fat floor in g/kg', () => {
    const result = applyClamps({
      targets: targets({ fat: 20 }),
      weightKg: WEIGHT,
    })
    expect(result.targets.fat.value).toBeCloseTo(CLAMPS.minFatGPerKg * WEIGHT, 6)
    // 46 g at 92.6 kg, as the design document states.
    expect(result.targets.fat.value).toBeCloseTo(46.3, 1)
  })

  it('raises energy rather than driving carbohydrate negative', () => {
    const result = applyClamps({
      targets: targets({ kcal: 1800, protein: 300, fat: 120, carbs: 0 }),
      weightKg: WEIGHT,
    })
    const floorKcal = result.targets.protein.value * 4 + result.targets.fat.value * 9
    expect(result.targets.kcal.value).toBeGreaterThanOrEqual(floorKcal)
    expect(result.targets.carbs.value).toBeGreaterThanOrEqual(0)
  })

  it('cannot be bypassed by a user override', () => {
    // A user-sourced value is still clamped: the clamp runs last, after
    // every other layer including manual override.
    const t = targets()
    t.kcal = { value: 1200, source: 'user', rationale: 'set by you' }
    t.protein = { value: 60, source: 'user', rationale: 'set by you' }
    const result = applyClamps({ targets: t, weightKg: WEIGHT })
    expect(result.targets.kcal.value).toBeGreaterThanOrEqual(CLAMPS.minKcal)
    expect(result.targets.protein.value).toBeGreaterThanOrEqual(
      CLAMPS.minProteinGPerKg * WEIGHT,
    )
  })

  it('records what was clamped and why, for the audit log', () => {
    const result = applyClamps({
      targets: targets({ kcal: 1000, protein: 50, fat: 10 }),
      weightKg: WEIGHT,
    })
    const keys = result.clamped.map((c) => c.key)
    expect(keys).toContain('kcal')
    expect(keys).toContain('protein')
    expect(keys).toContain('fat')
    for (const c of result.clamped) {
      expect(c.reason.length).toBeGreaterThan(10)
      expect(c.to).toBeGreaterThan(c.from)
    }
  })

  it('keeps the set internally coherent after clamping', () => {
    const result = applyClamps({
      targets: targets({ kcal: 1500, protein: 100, fat: 30 }),
      weightKg: WEIGHT,
    })
    const { kcal, protein, fat, carbs } = result.targets
    const implied = protein.value * 4 + fat.value * 9 + carbs.value * 4
    expect(implied).toBeCloseTo(kcal.value, 4)
  })
})

describe('property: no input produces a target below a clamp', () => {
  // Deterministic pseudo-random sweep. A fixed seed keeps failures
  // reproducible, which matters more here than statistical purity.
  function lcg(seed: number): () => number {
    let s = seed
    return () => {
      s = (s * 1664525 + 1013904223) % 4294967296
      return s / 4294967296
    }
  }

  it('holds across 5000 random target sets and body weights', () => {
    const rand = lcg(20260920)
    for (let i = 0; i < 5000; i++) {
      const weightKg = 40 + rand() * 120
      const maintenance = 1200 + rand() * 2800
      const t = targets({
        // Deliberately includes absurd inputs: zero, negative, enormous.
        kcal: Math.round(-500 + rand() * 6000),
        protein: Math.round(-50 + rand() * 400),
        fat: Math.round(-20 + rand() * 250),
        carbs: Math.round(-100 + rand() * 700),
      })
      const useMaintenance = rand() > 0.5

      const result = applyClamps({
        targets: t,
        weightKg,
        ...(useMaintenance ? { maintenanceKcal: maintenance } : {}),
      })

      const { kcal, protein, fat, carbs } = result.targets
      expect(kcal.value).toBeGreaterThanOrEqual(CLAMPS.minKcal)
      expect(protein.value).toBeGreaterThanOrEqual(
        CLAMPS.minProteinGPerKg * weightKg - 1e-6,
      )
      expect(fat.value).toBeGreaterThanOrEqual(CLAMPS.minFatGPerKg * weightKg - 1e-6)
      expect(carbs.value).toBeGreaterThanOrEqual(0)
      expect(Number.isFinite(kcal.value)).toBe(true)

      if (useMaintenance) {
        const deficit = maintenance - kcal.value
        // Either the deficit is within the cap, or the absolute floor bound.
        expect(
          deficit <= CLAMPS.maxDeficitKcal + 1e-6 || kcal.value <= CLAMPS.minKcal + 1e-6,
        ).toBe(true)
      }
    }
  })

  it('is idempotent — clamping an already-clamped set changes nothing', () => {
    const rand = lcg(7)
    for (let i = 0; i < 500; i++) {
      const weightKg = 45 + rand() * 90
      const once = applyClamps({
        targets: targets({
          kcal: Math.round(rand() * 4000),
          protein: Math.round(rand() * 300),
          fat: Math.round(rand() * 150),
        }),
        weightKg,
      })
      const twice = applyClamps({ targets: once.targets, weightKg })
      expect(twice.clamped).toEqual([])
      expect(twice.targets.kcal.value).toBeCloseTo(once.targets.kcal.value, 6)
      expect(twice.targets.protein.value).toBeCloseTo(once.targets.protein.value, 6)
      expect(twice.targets.fat.value).toBeCloseTo(once.targets.fat.value, 6)
    }
  })
})

describe('rate guardrails', () => {
  it('caps loss at 1% of body weight per week', () => {
    expect(maxLossRateKgPerWeek(92.6)).toBeCloseTo(0.926, 6)
  })

  it('caps gain at half a pound per week', () => {
    expect(maxGainRateKgPerWeek()).toBeCloseTo(0.2268, 3)
  })
})

describe('validateGoal', () => {
  const base = { currentWeightKg: 92.6, heightCm: 190.5 }

  it('accepts a conservative fat-loss goal', () => {
    const v = validateGoal({
      ...base,
      direction: 'loss',
      rateKgPerWeek: -0.35,
      targetWeightKg: 85,
      plannedKcal: 2500,
      maintenanceKcal: 2900,
    })
    expect(v.ok).toBe(true)
    expect(v.problems).toEqual([])
  })

  it('refuses a loss rate above 1% of body weight per week', () => {
    const v = validateGoal({ ...base, direction: 'loss', rateKgPerWeek: -1.2 })
    expect(v.ok).toBe(false)
    expect(v.problems[0]).toMatch(/1% of body weight/)
  })

  it('refuses a gain rate above half a pound per week', () => {
    const v = validateGoal({ ...base, direction: 'gain', rateKgPerWeek: 0.5 })
    expect(v.ok).toBe(false)
    expect(v.problems[0]).toMatch(/0\.5 lb\/week/)
  })

  it('refuses a target weight below a BMI of 18.5', () => {
    const v = validateGoal({
      ...base,
      direction: 'loss',
      rateKgPerWeek: -0.3,
      targetWeightKg: 60,
    })
    expect(v.ok).toBe(false)
    expect(v.problems.some((p) => p.includes('BMI'))).toBe(true)
  })

  it('refuses a deficit above the maximum', () => {
    const v = validateGoal({
      ...base,
      direction: 'loss',
      rateKgPerWeek: -0.3,
      plannedKcal: 2000,
      maintenanceKcal: 3000,
    })
    expect(v.ok).toBe(false)
    expect(v.problems.some((p) => p.includes('750 kcal'))).toBe(true)
  })

  it('refuses calories below the floor at input rather than clamping later', () => {
    const v = validateGoal({
      ...base,
      direction: 'loss',
      rateKgPerWeek: -0.3,
      plannedKcal: 1500,
      maintenanceKcal: 2100,
    })
    expect(v.ok).toBe(false)
    expect(v.problems.some((p) => p.includes('1800'))).toBe(true)
  })

  it('reports every problem at once rather than one at a time', () => {
    const v = validateGoal({
      ...base,
      direction: 'loss',
      rateKgPerWeek: -2,
      targetWeightKg: 55,
      plannedKcal: 1200,
      maintenanceKcal: 3000,
    })
    expect(v.problems.length).toBeGreaterThanOrEqual(3)
  })
})
