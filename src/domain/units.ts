/**
 * Units: display and input only.
 *
 * Storage never changes -- grams, kilograms, centimetres, internally,
 * always. A unit preference is a lens on stored values and must never reach
 * a record: storing what the user typed in would turn every historical
 * comparison into a conversion problem. Rounding happens here, at display
 * time; stored values keep full precision.
 *
 * Preferences are per domain rather than one global switch, because the
 * natural configuration is mixed: the kitchen scale reads grams and the
 * bathroom scale reads pounds.
 */

export type BodyWeightUnit = 'lb' | 'kg'
export type FoodUnit = 'g' | 'oz'
export type HeightUnit = 'ftin' | 'cm'
export type WaistUnit = 'in' | 'cm'

export type UnitPrefs = {
  bodyWeight: BodyWeightUnit
  food: FoodUnit
  height: HeightUnit
  waist: WaistUnit
}

export const DEFAULT_UNIT_PREFS: Readonly<UnitPrefs> = {
  bodyWeight: 'lb',
  food: 'g',
  height: 'ftin',
  waist: 'in',
}

export const KG_PER_LB = 0.45359237
export const G_PER_OZ = 28.349523125
export const CM_PER_IN = 2.54

export const kgToLb = (kg: number): number => kg / KG_PER_LB
export const lbToKg = (lb: number): number => lb * KG_PER_LB
export const gToOz = (g: number): number => g / G_PER_OZ
export const ozToG = (oz: number): number => oz * G_PER_OZ
export const cmToIn = (cm: number): number => cm / CM_PER_IN
export const inToCm = (inches: number): number => inches * CM_PER_IN

// --- Formatting -----------------------------------------------------------

function num(n: number, dp: number): string {
  return n.toLocaleString(undefined, {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  })
}

/**
 * Body weight in both units, preferred first: "204.2 lb (92.6 kg)".
 *
 * Body weight earns the dual display because the engine's arithmetic is
 * metric -- targets per kilogram, 7,700 kcal per kilogram -- so showing both
 * keeps the displayed and the computed numbers legible as the same thing.
 */
export function formatBodyWeight(kg: number, unit: BodyWeightUnit, dp = 1): string {
  const parts = bodyWeightParts(kg, unit, dp)
  return `${parts.primary} (${parts.secondary})`
}

/** The two halves of a dual weight, for layouts that size them differently. */
export function bodyWeightParts(
  kg: number,
  unit: BodyWeightUnit,
  dp = 1,
): { primary: string; secondary: string } {
  const lb = `${num(kgToLb(kg), dp)} lb`
  const metric = `${num(kg, dp)} kg`
  return unit === 'lb'
    ? { primary: lb, secondary: metric }
    : { primary: metric, secondary: lb }
}

/** A body-weight rate, e.g. per week, in both units. */
export function formatBodyWeightRate(kgPerWeek: number, unit: BodyWeightUnit): string {
  const lb = `${num(kgToLb(kgPerWeek), 2)} lb`
  const kg = `${num(kgPerWeek, 2)} kg`
  return unit === 'lb' ? `${lb} (${kg}) per week` : `${kg} (${lb}) per week`
}

/** The preferred body-weight number alone, for an editable field. */
export function bodyWeightInputValue(kg: number, unit: BodyWeightUnit): string {
  const v = unit === 'lb' ? kgToLb(kg) : kg
  return String(Math.round(v * 10) / 10)
}

export function formatFood(grams: number, unit: FoodUnit): string {
  if (unit === 'oz') return `${num(gToOz(grams), gToOz(grams) < 10 ? 1 : 0)} oz`
  return `${num(grams, 0)} g`
}

/** The preferred food amount alone, for an editable field. */
export function foodInputValue(grams: number, unit: FoodUnit): string {
  if (unit === 'oz') return String(Math.round(gToOz(grams) * 10) / 10)
  return String(Math.round(grams * 10) / 10)
}

export function formatHeight(cm: number, unit: HeightUnit): string {
  if (unit === 'cm') return `${num(cm, 0)} cm`
  const totalIn = Math.round(cmToIn(cm))
  return `${Math.floor(totalIn / 12)}′${totalIn % 12}″`
}

export function heightInputValue(cm: number, unit: HeightUnit): string {
  if (unit === 'cm') return String(Math.round(cm * 10) / 10)
  const totalIn = Math.round(cmToIn(cm))
  return `${Math.floor(totalIn / 12)}'${totalIn % 12}"`
}

export function formatWaist(cm: number, unit: WaistUnit): string {
  return unit === 'cm' ? `${num(cm, 0)} cm` : `${num(cmToIn(cm), 1)} in`
}

export function waistInputValue(cm: number, unit: WaistUnit): string {
  const v = unit === 'cm' ? cm : cmToIn(cm)
  return String(Math.round(v * 10) / 10)
}

// --- Parsing --------------------------------------------------------------
//
// Any weight field accepts either unit. A bare number uses the preferred
// unit; an explicit suffix overrides it, so "92.6kg" typed into a field
// that prefers pounds converts rather than fails.

const NUMBER = String.raw`(\d+(?:[.,]\d+)?|[.,]\d+)`

function toNumber(s: string): number {
  return Number(s.replace(',', '.'))
}

type Suffix = 'lb' | 'kg' | 'g' | 'oz' | 'cm' | 'in' | 'ft'

const SUFFIXES: Record<string, Suffix> = {
  lb: 'lb',
  lbs: 'lb',
  pound: 'lb',
  pounds: 'lb',
  '#': 'lb',
  kg: 'kg',
  kgs: 'kg',
  kilo: 'kg',
  kilos: 'kg',
  g: 'g',
  gr: 'g',
  gram: 'g',
  grams: 'g',
  oz: 'oz',
  ounce: 'oz',
  ounces: 'oz',
  cm: 'cm',
  in: 'in',
  inch: 'in',
  inches: 'in',
  '"': 'in',
  '″': 'in',
  ft: 'ft',
  foot: 'ft',
  feet: 'ft',
  "'": 'ft',
  '′': 'ft',
}

/** "5", "5kg", "5 lbs", "5.5 oz" -> value and optional suffix. */
function splitQuantity(raw: string): { value: number; suffix?: Suffix } | undefined {
  const m = new RegExp(`^\\s*${NUMBER}\\s*([a-z#"'′″]*)\\s*$`, 'i').exec(raw)
  if (!m) return undefined
  const value = toNumber(m[1]!)
  if (!Number.isFinite(value)) return undefined
  const word = m[2]!.toLowerCase()
  if (word === '') return { value }
  const suffix = SUFFIXES[word]
  return suffix ? { value, suffix } : undefined
}

/** Parse a body-weight field to kilograms. Undefined when unreadable. */
export function parseBodyWeight(raw: string, preferred: BodyWeightUnit): number | undefined {
  const q = splitQuantity(raw)
  if (!q || !(q.value > 0)) return undefined
  const unit = q.suffix ?? preferred
  if (unit === 'kg') return q.value
  if (unit === 'lb') return lbToKg(q.value)
  return undefined
}

/** Parse a food-amount field to grams. Body-weight suffixes are accepted too. */
export function parseFoodAmount(raw: string, preferred: FoodUnit): number | undefined {
  const q = splitQuantity(raw)
  if (!q || !(q.value > 0)) return undefined
  const unit = q.suffix ?? preferred
  switch (unit) {
    case 'g':
      return q.value
    case 'oz':
      return ozToG(q.value)
    case 'kg':
      return q.value * 1000
    case 'lb':
      return lbToKg(q.value) * 1000
    default:
      return undefined
  }
}

/**
 * Parse a length to centimetres: "180", "180cm", "71in", "5'11\"",
 * "5 ft 11 in", "5′11″". A bare number uses the preferred unit; for feet
 * and inches a bare number under 9 is read as feet, which is the only
 * sensible reading of "6" in a height field.
 */
export function parseLength(
  raw: string,
  preferred: 'cm' | 'in' | 'ftin',
): number | undefined {
  const s = raw.trim().toLowerCase()
  if (s === '') return undefined

  const feetInches = new RegExp(
    `^${NUMBER}\\s*(?:'|′|ft|foot|feet)\\s*(?:${NUMBER}\\s*(?:"|″|in|inch|inches)?)?$`,
  ).exec(s)
  if (feetInches) {
    const ft = toNumber(feetInches[1]!)
    const inches = feetInches[2] !== undefined ? toNumber(feetInches[2]) : 0
    const total = ft * 12 + inches
    return total > 0 ? inToCm(total) : undefined
  }

  // "5 11" in a feet-and-inches field.
  if (preferred === 'ftin') {
    const pair = new RegExp(`^${NUMBER}\\s+${NUMBER}$`).exec(s)
    if (pair) {
      const total = toNumber(pair[1]!) * 12 + toNumber(pair[2]!)
      return total > 0 ? inToCm(total) : undefined
    }
  }

  const q = splitQuantity(s)
  if (!q || !(q.value > 0)) return undefined
  switch (q.suffix) {
    case 'cm':
      return q.value
    case 'in':
      return inToCm(q.value)
    case 'ft':
      return inToCm(q.value * 12)
    case undefined:
      if (preferred === 'cm') return q.value
      if (preferred === 'in') return inToCm(q.value)
      // ft/in preferred: a small bare number is feet, a larger one inches.
      return q.value < 9 ? inToCm(q.value * 12) : inToCm(q.value)
    default:
      return undefined
  }
}

/** Short unit labels for field captions. */
export const BODY_WEIGHT_LABEL: Record<BodyWeightUnit, string> = { lb: 'lb', kg: 'kg' }
export const FOOD_LABEL: Record<FoodUnit, string> = { g: 'g', oz: 'oz' }
export const HEIGHT_LABEL: Record<HeightUnit, string> = { ftin: 'ft/in', cm: 'cm' }
export const WAIST_LABEL: Record<WaistUnit, string> = { in: 'in', cm: 'cm' }
