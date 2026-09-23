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
//
// Unknown is not zero. Every function here carries `null` through rather
// than coercing it: scaling an unknown gives an unknown, and a sum over a
// list containing an unknown is itself unknown. The one place that sums
// known contributions while reporting what is missing is `aggregate`, and it
// always returns the coverage alongside the value.

export function scaleNutrients(v: NutrientVector, factor: number): NutrientVector {
  const out = { ...ZERO_NUTRIENTS }
  for (const k of NUTRIENT_KEYS) {
    const x = v[k]
    out[k] = x === null ? null : x * factor
  }
  return out
}

/** Scale a per-100g vector to an arbitrary gram amount. */
export function nutrientsForGrams(per100g: NutrientVector, grams: number): NutrientVector {
  return scaleNutrients(per100g, grams / 100)
}

/** Strict sum: a field unknown in either operand is unknown in the result. */
export function addNutrients(a: NutrientVector, b: NutrientVector): NutrientVector {
  const out = { ...ZERO_NUTRIENTS }
  for (const k of NUTRIENT_KEYS) {
    const x = a[k]
    const y = b[k]
    out[k] = x === null || y === null ? null : x + y
  }
  return out
}

/**
 * Strict sum over a list. Used where the result becomes a new stored vector
 * (a recipe's per-100 g, a composite preview): if one ingredient's protein
 * is unknown, the recipe's protein is unknown, not the sum of the rest.
 */
export function sumNutrients(list: readonly NutrientVector[]): NutrientVector {
  let out: NutrientVector = { ...ZERO_NUTRIENTS }
  for (const v of list) out = addNutrients(out, v)
  return out
}

export function roundNutrients(v: NutrientVector, dp = 1): NutrientVector {
  const f = 10 ** dp
  const out = { ...ZERO_NUTRIENTS }
  for (const k of NUTRIENT_KEYS) {
    const x = v[k]
    out[k] = x === null ? null : Math.round(x * f) / f
  }
  return out
}

export function makeNutrients(partial: Partial<NutrientVector>): NutrientVector {
  return { ...ZERO_NUTRIENTS, ...partial }
}

/** The fields of a vector that are unknown. */
export function missingNutrients(v: NutrientVector): NutrientKey[] {
  return NUTRIENT_KEYS.filter((k) => v[k] === null)
}

export function isCompleteVector(v: NutrientVector): boolean {
  return NUTRIENT_KEYS.every((k) => v[k] !== null)
}

/**
 * A rollup of one nutrient over a set of entries: the sum of the known
 * contributions, plus how many entries contributed. An incomplete aggregate
 * is a floor, not a total -- "at least 145 g, from 9 of 11 entries".
 */
export type Aggregate = {
  /** Sum of known contributions. */
  value: number
  knownEntries: number
  totalEntries: number
  /** knownEntries === totalEntries, unless the source is known to be partial. */
  complete: boolean
}

export type NutrientTotals = Record<NutrientKey, Aggregate>

export function aggregateOf(values: readonly (number | null)[]): Aggregate {
  let value = 0
  let known = 0
  for (const v of values) {
    if (v === null) continue
    value += v
    known++
  }
  return {
    value,
    knownEntries: known,
    totalEntries: values.length,
    complete: known === values.length,
  }
}

export function aggregateNutrients(list: readonly NutrientVector[]): NutrientTotals {
  const out = {} as NutrientTotals
  for (const k of NUTRIENT_KEYS) out[k] = aggregateOf(list.map((v) => v[k]))
  return out
}

/** A single known figure, as a complete aggregate of one. */
export function knownAggregate(value: number): Aggregate {
  return { value, knownEntries: 1, totalEntries: 1, complete: true }
}

/** Nothing is known about this field for the day. */
export const UNKNOWN_AGGREGATE: Readonly<Aggregate> = {
  value: 0,
  knownEntries: 0,
  totalEntries: 0,
  complete: false,
}

/**
 * Energy implied by a vector's macros. Used to sanity-check imported foods
 * whose stated kcal disagrees with their macros by more than a rounding gap.
 * Undefined when a macro is unknown: an implied figure from partial macros
 * would be confidently low.
 */
export function impliedKcal(v: NutrientVector): number | undefined {
  if (v.protein === null || v.fat === null || v.carbs === null) return undefined
  return kcalFromMacros({
    proteinG: v.protein,
    fatG: v.fat,
    carbsG: v.carbs,
    alcoholG: v.alcohol ?? 0,
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
