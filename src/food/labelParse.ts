/**
 * Reading a Nutrition Facts panel from OCR text.
 *
 * Numbers come from the label, not a model: this matches known field labels
 * and the serving-size line, and nothing else. OCR errors are mundane and
 * specific -- a lost decimal, 8 read as 3 -- and produce plausible numbers
 * rather than obvious failures, so every parsed value is presented for
 * confirmation and nothing here ever saves.
 *
 * Handles the US panel ("Serving size 2/3 cup (55g)", "Total Fat 8g") and
 * the EU/UK one ("Energy 1046kJ / 250kcal", "of which saturates", "Salt").
 * Anything not found stays unknown, never zero, and falls through to manual
 * entry with the found fields pre-filled.
 */

import type { NutrientKey } from '../domain/types.ts'

export type ParsedLabel = {
  /** The amount the values are for: a serving's grams, or 100 g. */
  basisGrams?: number
  basis: 'serving' | '100g' | 'unknown'
  values: Partial<Record<NutrientKey, number>>
  /** Fields found, in panel order. */
  found: NutrientKey[]
}

/** Common OCR confusions inside numbers: O for 0, l and I for 1, S for 5. */
function fixDigits(line: string): string {
  return line
    .replace(/(?<=\d)[oO](?=[\d.,oO]|\s*m?g\b|\s|%|$)/g, '0')
    .replace(/(?<=\d0)[oO](?=\s|%|$)/g, '0')
    .replace(/(?<=\s|^)[oO](?=[.,]\d)/g, '0')
    .replace(/(?<=\d)[lI](?=\d)/g, '1')
    .replace(/(?<=\s)[lI](?=\d)/g, '1')
    .replace(/(?<=\d)[S](?=\d)/g, '5')
}

const NUM = String.raw`(\d+(?:[.,]\d+)?)`

function toNum(s: string): number {
  return Number(s.replace(',', '.'))
}

/** The first amount with the given unit after a label, e.g. "8g" or "160 mg". */
function amount(rest: string, unit: 'g' | 'mg' | 'g-or-mg'): { value: number; unit: 'g' | 'mg' } | undefined {
  const re =
    unit === 'g'
      ? new RegExp(`${NUM}\\s*(g)\\b`, 'i')
      : unit === 'mg'
        ? new RegExp(`${NUM}\\s*(mg)\\b`, 'i')
        : new RegExp(`${NUM}\\s*(mg|g)\\b`, 'i')
  const m = re.exec(rest)
  if (!m) {
    // A bare number with the unit lost to OCR, not followed by a percent.
    const bare = new RegExp(`^\\s*:?\\s*${NUM}(?!\\s*%)\\b`).exec(rest)
    if (bare && unit !== 'g-or-mg') return { value: toNum(bare[1]!), unit }
    return undefined
  }
  return { value: toNum(m[1]!), unit: m[2]!.toLowerCase() === 'mg' ? 'mg' : 'g' }
}

type Field = {
  key: NutrientKey | 'salt'
  label: RegExp
  unit: 'g' | 'mg' | 'g-or-mg'
}

/** Order matters: saturated before fat, added sugar before sugars. */
const FIELDS: Field[] = [
  { key: 'satFat', label: /\b(?:sat(?:urated)?\.?\s*fat|(?:of which\s*)?saturates)\b/i, unit: 'g' },
  { key: 'fat', label: /\b(?:total\s*fat|fat)\b/i, unit: 'g' },
  { key: 'sodium', label: /\bsodium\b/i, unit: 'g-or-mg' },
  { key: 'salt', label: /\bsalt\b/i, unit: 'g' },
  { key: 'fibre', label: /\b(?:dietary\s*fib(?:er|re)|fib(?:er|re))\b/i, unit: 'g' },
  { key: 'addedSugar', label: /\badded\s*sugars?\b/i, unit: 'g' },
  { key: 'carbs', label: /\b(?:total\s*carb\w*|carbohydrates?)\b/i, unit: 'g' },
  { key: 'protein', label: /\bprotein\b/i, unit: 'g' },
  { key: 'alcohol', label: /\balcohol\b/i, unit: 'g' },
]

const SKIP = /\btrans\b|polyunsat|monounsat|\bunsaturat|cholest/i

export function parseNutritionLabel(text: string): ParsedLabel {
  const lines = text
    .split(/\r?\n/)
    .map((l) => fixDigits(l.trim()))
    .filter((l) => l.length > 0)

  const values: Partial<Record<NutrientKey, number>> = {}
  const found: NutrientKey[] = []
  const set = (k: NutrientKey, v: number): void => {
    if (values[k] !== undefined || !Number.isFinite(v) || v < 0) return
    values[k] = v
    found.push(k)
  }

  let basisGrams: number | undefined
  let basis: ParsedLabel['basis'] = 'unknown'
  const all = lines.join('\n')
  if (/per\s*100\s*(?:g|ml)\b/i.test(all)) {
    basis = '100g'
    basisGrams = 100
  }

  for (const line of lines) {
    // Serving size: "Serving size 2/3 cup (55g)" or "Serving size 30 g".
    if (/serving\s*size/i.test(line) && basis !== '100g') {
      const paren = new RegExp(`\\(\\s*${NUM}\\s*(g|ml)\\s*\\)`, 'i').exec(line)
      const plain = new RegExp(`serving\\s*size\\s*:?\\s*${NUM}\\s*(g|ml)\\b`, 'i').exec(line)
      const m = paren ?? plain
      if (m) {
        basisGrams = toNum(m[1]!)
        basis = 'serving'
      }
      continue
    }

    // Energy: "Calories 230", "Energy 1046kJ / 250kcal", "250 kcal".
    if (values.kcal === undefined) {
      const kcal = new RegExp(`${NUM}\\s*kcal\\b`, 'i').exec(line)
      const cal = new RegExp(`\\bcalories\\b[^\\d]*${NUM}`, 'i').exec(line)
      const kj = new RegExp(`${NUM}\\s*kj\\b`, 'i').exec(line)
      if (kcal) set('kcal', toNum(kcal[1]!))
      else if (cal && !/from\s*fat/i.test(line)) set('kcal', toNum(cal[1]!))
      else if (kj && /energy/i.test(line)) set('kcal', toNum(kj[1]!) / 4.184)
      if (values.kcal !== undefined) continue
    }

    // Trans, poly- and monounsaturated fat and cholesterol are not tracked;
    // their lines must not be read as total fat.
    if (SKIP.test(line)) continue

    for (const f of FIELDS) {
      const m = f.label.exec(line)
      if (!m) continue
      // "Total Sugars 12g" is not added sugar; "Includes 10g Added Sugars"
      // puts the number before the label.
      const rest = f.key === 'addedSugar' ? line : line.slice(m.index + m[0].length)
      const a = amount(rest, f.unit)
      if (!a) break
      if (f.key === 'salt') {
        set('sodium', (a.value / 2.5) * 1000)
      } else if (f.key === 'sodium') {
        set('sodium', a.unit === 'g' ? a.value * 1000 : a.value)
      } else {
        set(f.key, a.value)
      }
      break
    }
  }

  return { ...(basisGrams !== undefined ? { basisGrams } : {}), basis, values, found }
}
