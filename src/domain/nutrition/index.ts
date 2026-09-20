/**
 * Person-agnostic nutrition formulas and reference values.
 *
 * Nothing in this module knows who the user is. The profile is data, passed
 * in; a height or training-frequency change is an edit in settings rather
 * than a rebuild. Every function here is pure.
 */

import type {
  ActivityLevel,
  NutrientKey,
  NutrientVector,
  Sex,
} from '../types.ts'
import { NUTRIENT_KEYS, ZERO_NUTRIENTS } from '../types.ts'

/** Atwater factors. Alcohol at 7 kcal/g is a tracked calorie source. */
export const KCAL_PER_G = {
  protein: 4,
  carbs: 4,
  fat: 9,
  alcohol: 7,
} as const

/**
 * The conventional energy density of tissue change. A convention, not a
 * constant of nature -- poor over the first fortnight where glycogen and
 * water dominate, reasonable after, which is why the TDEE window is 3 weeks.
 */
export const KCAL_PER_KG_TISSUE = 7700

export const ACTIVITY_MULTIPLIERS: Record<ActivityLevel, number> = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  veryActive: 1.9,
}

export const ACTIVITY_LABELS: Record<ActivityLevel, string> = {
  sedentary: 'Sedentary — desk work, little deliberate movement',
  light: 'Light — training 1–3 days a week',
  moderate: 'Moderate — training 3–5 days a week',
  active: 'Active — training 6–7 days a week',
  veryActive: 'Very active — physical job or twice-daily training',
}

/**
 * Mifflin-St Jeor. A starting hypothesis only: it is +/-10% in individuals,
 * and after 21 days of real data the engine abandons it permanently.
 */
export function mifflinStJeorBmr(input: {
  weightKg: number
  heightCm: number
  age: number
  sex: Sex
}): number {
  const { weightKg, heightCm, age, sex } = input
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age
  return sex === 'male' ? base + 5 : base - 161
}

export function formulaTdee(input: {
  weightKg: number
  heightCm: number
  age: number
  sex: Sex
  activityLevel: ActivityLevel
}): number {
  return mifflinStJeorBmr(input) * ACTIVITY_MULTIPLIERS[input.activityLevel]
}

export function ageFromBirthYear(birthYear: number, on: Date = new Date()): number {
  return on.getFullYear() - birthYear
}

export function bmi(weightKg: number, heightCm: number): number {
  const m = heightCm / 100
  return weightKg / (m * m)
}

/** The weight at a given BMI for this height. Used to refuse unsafe goals. */
export function weightAtBmi(target: number, heightCm: number): number {
  const m = heightCm / 100
  return target * m * m
}

export function waistToHeight(waistCm: number, heightCm: number): number {
  return waistCm / heightCm
}

/**
 * Carbohydrate absorbs every calorie change. Protein and fat hold steady.
 * This one rule keeps the adjustment engine simple.
 */
export function carbsFromRemainder(input: {
  kcal: number
  proteinG: number
  fatG: number
  alcoholG?: number
}): number {
  const { kcal, proteinG, fatG, alcoholG = 0 } = input
  const used =
    proteinG * KCAL_PER_G.protein +
    fatG * KCAL_PER_G.fat +
    alcoholG * KCAL_PER_G.alcohol
  return Math.max(0, (kcal - used) / KCAL_PER_G.carbs)
}

/** Calories implied by a macro split. Used to keep edited targets coherent. */
export function kcalFromMacros(input: {
  proteinG: number
  fatG: number
  carbsG: number
  alcoholG?: number
}): number {
  return (
    input.proteinG * KCAL_PER_G.protein +
    input.fatG * KCAL_PER_G.fat +
    input.carbsG * KCAL_PER_G.carbs +
    (input.alcoholG ?? 0) * KCAL_PER_G.alcohol
  )
}

/** Grams of saturated fat at a given percentage of a calorie target. */
export function gramsFromPctKcal(
  pct: number,
  kcal: number,
  kcalPerGram: number,
): number {
  return (kcal * (pct / 100)) / kcalPerGram
}

/**
 * Per-occasion protein target. Floored at 35 g and ceilinged at 45 g: the
 * concern is per-occasion sufficiency, and an average conceals the common
 * failure of three light meals plus one enormous one.
 */
export const OCCASION_PROTEIN_DIVISOR = 4
export const OCCASION_PROTEIN_FLOOR = 35
export const OCCASION_PROTEIN_CEILING = 45

export function perOccasionProteinTarget(dailyProteinG: number): number {
  const raw = dailyProteinG / OCCASION_PROTEIN_DIVISOR
  return Math.min(
    OCCASION_PROTEIN_CEILING,
    Math.max(OCCASION_PROTEIN_FLOOR, raw),
  )
}

/** The per-occasion sufficiency threshold: 0.4 g/kg body weight. */
export const OCCASION_SUFFICIENCY_G_PER_KG = 0.4

export function occasionSufficiencyThreshold(weightKg: number): number {
  return OCCASION_SUFFICIENCY_G_PER_KG * weightKg
}

/**
 * Population guideline defaults. Ordinary references, not clinical
 * adjustments, and every one of them is editable in settings.
 */
export const DEFAULT_SECONDARY_TARGETS = {
  /** DRI for men under 50. */
  fibreG: 38,
  satFatPctKcal: 10,
  sodiumMg: 2300,
  addedSugarPctKcal: 10,
  /** Conventional ceiling; alcohol remains a tracked calorie source. */
  alcoholGCeiling: 28,
} as const

/** Protein and fat bands from the framework, in g/kg. */
export const MACRO_BANDS = {
  protein: { min: 1.6, max: 2.2, deficitMin: 2.0, deficitMax: 2.4 },
  fat: { min: 0.8, max: 1.2, floor: 0.5 },
} as const

// --- NutrientVector arithmetic -------------------------------------------

export function scaleNutrients(v: NutrientVector, factor: number): NutrientVector {
  const out = { ...ZERO_NUTRIENTS }
  for (const k of NUTRIENT_KEYS) out[k] = v[k] * factor
  return out
}

/** Scale a per-100g vector to an arbitrary gram amount. */
export function nutrientsForGrams(per100g: NutrientVector, grams: number): NutrientVector {
  return scaleNutrients(per100g, grams / 100)
}

export function addNutrients(a: NutrientVector, b: NutrientVector): NutrientVector {
  const out = { ...ZERO_NUTRIENTS }
  for (const k of NUTRIENT_KEYS) out[k] = a[k] + b[k]
  return out
}

export function sumNutrients(list: readonly NutrientVector[]): NutrientVector {
  const out = { ...ZERO_NUTRIENTS }
  for (const v of list) {
    for (const k of NUTRIENT_KEYS) out[k] += v[k]
  }
  return out
}

export function roundNutrients(v: NutrientVector, dp = 1): NutrientVector {
  const f = 10 ** dp
  const out = { ...ZERO_NUTRIENTS }
  for (const k of NUTRIENT_KEYS) out[k] = Math.round(v[k] * f) / f
  return out
}

export function makeNutrients(partial: Partial<NutrientVector>): NutrientVector {
  return { ...ZERO_NUTRIENTS, ...partial }
}

/**
 * Energy implied by a vector's macros. Used to sanity-check imported foods
 * whose stated kcal disagrees with their macros by more than a rounding gap.
 */
export function impliedKcal(v: NutrientVector): number {
  return kcalFromMacros({
    proteinG: v.protein,
    fatG: v.fat,
    carbsG: v.carbs,
    alcoholG: v.alcohol,
  })
}

export function nutrientLabel(key: NutrientKey): string {
  switch (key) {
    case 'kcal':
      return 'Calories'
    case 'protein':
      return 'Protein'
    case 'carbs':
      return 'Carbs'
    case 'fat':
      return 'Fat'
    case 'satFat':
      return 'Saturated fat'
    case 'fibre':
      return 'Fibre'
    case 'sodium':
      return 'Sodium'
    case 'addedSugar':
      return 'Added sugar'
    case 'alcohol':
      return 'Alcohol'
  }
}

export function nutrientUnit(key: NutrientKey): string {
  if (key === 'kcal') return 'kcal'
  if (key === 'sodium') return 'mg'
  return 'g'
}
