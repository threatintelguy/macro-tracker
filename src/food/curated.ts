/**
 * Tier 1: the curated personal table.
 *
 * Hand-built JSON in the repo -- the foods actually eaten. This is the only
 * tier where values can be verified rather than merely sourced, so search
 * ranks it first, always. It realistically serves most entries, which is the
 * reason steady-state logging can fit in fifteen seconds.
 */

import type { CookState, FoodItem, Portion } from '../domain/types.ts'
import curatedRaw from '../../data/curated-foods.json'

/** The compact on-disk row. Short keys keep the bundled file small. */
type CuratedRow = {
  id: string
  n: string
  k: number
  p: number
  c: number
  f: number
  sf: number
  fb: number
  na: number
  as: number
  al: number
  cook: 'r' | 'c' | 'n'
  pair?: string
  portions: [string, number][]
  alias: string[]
}

const COOK_STATE: Record<CuratedRow['cook'], CookState> = {
  r: 'raw',
  c: 'cooked',
  n: 'n/a',
}

function expand(row: CuratedRow): FoodItem {
  const portions: Portion[] = row.portions.map(([label, grams]) => ({
    label,
    grams,
  }))
  return {
    id: row.id,
    name: row.n,
    tier: 'curated',
    per100g: {
      kcal: row.k,
      protein: row.p,
      carbs: row.c,
      fat: row.f,
      satFat: row.sf,
      fibre: row.fb,
      sodium: row.na,
      addedSugar: row.as,
      alcohol: row.al,
    },
    portions,
    cookState: COOK_STATE[row.cook],
    ...(row.pair !== undefined ? { pairedWith: row.pair } : {}),
    ...(row.alias.length > 0 ? { aliases: row.alias } : {}),
  }
}

let cache: FoodItem[] | null = null

export function curatedFoods(): FoodItem[] {
  if (cache) return cache
  const data = curatedRaw as unknown as { schema: number; foods: CuratedRow[] }
  cache = data.foods.map(expand)
  return cache
}

export const CURATED_SCHEMA = (curatedRaw as unknown as { schema: number }).schema
