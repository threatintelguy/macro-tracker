/**
 * Search online: the library's tail.
 *
 * When local search falls short, an explicit "Search online" tap queries
 * Open Food Facts and the USDA FoodData Central API. Every result the user
 * accepts is written into the local library permanently, so the library
 * grows toward what is actually eaten and this path should rarely be
 * needed after a few months.
 *
 * Same rules as the barcode lookup, because a text query reveals more than
 * a barcode does:
 *
 *   - explicit tap only, never automatic, and only after local results;
 *   - the query string alone -- no identifier, no session, no cookie;
 *   - `credentials: 'omit'` and no referrer;
 *   - accepted results cached locally forever;
 *   - offline mode hard-disables it.
 *
 * FoodData Central requires an api.data.gov key on every request. This uses
 * DEMO_KEY, api.data.gov's shared public key: it identifies no one, and its
 * per-address rate limit is ample for a search made only after a local miss.
 */

import type { FoodItem, NutrientKey, NutrientVector, Portion } from '../domain/types.ts'
import { normaliseOffProduct, type OffProduct } from './barcode.ts'

const OFF_SEARCH = 'https://world.openfoodfacts.org/cgi/search.pl'
const FDC_SEARCH = 'https://api.nal.usda.gov/fdc/v1/foods/search'
const FDC_PUBLIC_KEY = 'DEMO_KEY'

const OFF_FIELDS = [
  'code',
  'product_name',
  'brands',
  'serving_size',
  'serving_quantity',
  'nutriments',
  'quantity',
].join(',')

export type OnlineDeps = {
  fetch: typeof fetch
  /** Hard off-switch: offline mode, or online search turned off. */
  enabled: boolean
  now?: () => number
  pageSize?: number
}

export type OnlineSearchResult =
  | { ok: true; foods: FoodItem[]; partial: boolean }
  | { ok: false; reason: 'offline' | 'network' | 'empty-query'; message: string }

const REQUEST: RequestInit = {
  credentials: 'omit',
  referrerPolicy: 'no-referrer',
  mode: 'cors',
  cache: 'no-store',
  headers: { Accept: 'application/json' },
}

/** The exact URLs a query produces. Exported so tests can audit them. */
export function onlineSearchUrls(query: string, pageSize = 15): { off: string; fdc: string } {
  const q = encodeURIComponent(query.trim())
  return {
    off: `${OFF_SEARCH}?search_terms=${q}&search_simple=1&action=process&json=1&page_size=${pageSize}&fields=${OFF_FIELDS}`,
    fdc: `${FDC_SEARCH}?query=${q}&pageSize=${pageSize}&dataType=Foundation,SR%20Legacy,Branded&api_key=${FDC_PUBLIC_KEY}`,
  }
}

export async function searchOnline(query: string, deps: OnlineDeps): Promise<OnlineSearchResult> {
  if (!deps.enabled) {
    return {
      ok: false,
      reason: 'offline',
      message: 'Online search is off, so nothing leaves this device.',
    }
  }
  if (query.trim().length === 0) {
    return { ok: false, reason: 'empty-query', message: 'Type what you are looking for first.' }
  }
  const now = deps.now?.() ?? Date.now()
  const urls = onlineSearchUrls(query, deps.pageSize)

  const [off, fdc] = await Promise.allSettled([
    getJson<{ products?: (OffProduct & { code?: string })[] }>(deps.fetch, urls.off),
    getJson<{ foods?: FdcSearchFood[] }>(deps.fetch, urls.fdc),
  ])

  if (off.status === 'rejected' && fdc.status === 'rejected') {
    return {
      ok: false,
      reason: 'network',
      message: 'Could not reach either food database. The routes below still work without a network.',
    }
  }

  const foods: FoodItem[] = []
  if (fdc.status === 'fulfilled') {
    for (const f of fdc.value.foods ?? []) {
      const food = normaliseFdcFood(f, now)
      if (food) foods.push(food)
    }
  }
  if (off.status === 'fulfilled') {
    for (const p of off.value.products ?? []) {
      if (!p.code) continue
      const food = normaliseOffProduct(p.code, p, now)
      if (food) foods.push({ ...food, tier: 'online', origin: 'online' })
    }
  }

  // The same product from both sources: keep the first (FDC) by barcode.
  const seen = new Set<string>()
  const unique = foods.filter((f) => {
    const key = f.barcode ? `b:${f.barcode.replace(/^0+/, '')}` : `i:${f.id}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  // Generic before branded here too: unbranded USDA rows first, then the
  // rest in the order the services ranked them.
  const ranked = [...unique.filter((f) => !f.brand), ...unique.filter((f) => f.brand)]

  return {
    ok: true,
    foods: ranked.slice(0, 24),
    partial: off.status === 'rejected' || fdc.status === 'rejected',
  }
}

async function getJson<T>(fetchImpl: typeof fetch, url: string): Promise<T> {
  const res = await fetchImpl(url, REQUEST)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as T
}

type FdcSearchNutrient = {
  nutrientId?: number
  nutrientNumber?: string
  unitName?: string
  value?: number
}

export type FdcSearchFood = {
  fdcId: number
  description?: string
  dataType?: string
  brandOwner?: string
  brandName?: string
  gtinUpc?: string
  servingSize?: number
  servingSizeUnit?: string
  foodNutrients?: FdcSearchNutrient[]
}

const FDC_IDS: Record<NutrientKey, number[]> = {
  kcal: [1008, 2047, 2048],
  protein: [1003],
  carbs: [1005],
  fat: [1004],
  satFat: [1258],
  fibre: [1079],
  sodium: [1093],
  addedSugar: [1235],
  alcohol: [1018],
}

/**
 * Normalise a FoodData Central search hit. Values are per 100 g for every
 * data type the search returns. Exported for tests: the mapping is where a
 * silently wrong value would enter years of data.
 */
export function normaliseFdcFood(f: FdcSearchFood, now: number): FoodItem | undefined {
  if (!f.description || !Number.isFinite(f.fdcId)) return undefined
  const value = (key: NutrientKey): number | null => {
    for (const n of f.foodNutrients ?? []) {
      if (n.nutrientId !== undefined && FDC_IDS[key].includes(n.nutrientId)) {
        if (key === 'kcal' && n.unitName && n.unitName.toUpperCase() === 'KJ') continue
        if (typeof n.value === 'number' && Number.isFinite(n.value)) return n.value
      }
    }
    return null
  }
  const per100g = {} as NutrientVector
  for (const k of Object.keys(FDC_IDS) as NutrientKey[]) per100g[k] = value(k)
  // Unknown is not zero -- except alcohol in the generic datasets, which
  // list it wherever it is present.
  if (per100g.alcohol === null && f.dataType !== 'Branded') per100g.alcohol = 0

  if (per100g.kcal === null && per100g.protein === null && per100g.carbs === null && per100g.fat === null) {
    return undefined
  }

  const unit = (f.servingSizeUnit ?? '').toLowerCase()
  const portions: Portion[] =
    typeof f.servingSize === 'number' && f.servingSize > 0 && (unit === 'g' || unit === 'ml' || unit === 'grm' || unit === 'mlt')
      ? [{ label: '1 serving', grams: f.servingSize }]
      : []
  const brand = (f.brandName || f.brandOwner || '').trim()
  const gtin = (f.gtinUpc ?? '').replace(/\D/g, '')

  return {
    id: `u_${f.fdcId}`,
    name: titleCase(f.description.trim()),
    ...(brand ? { brand: titleCase(brand) } : {}),
    tier: 'online',
    origin: 'online',
    per100g,
    portions,
    cookState: 'n/a',
    ...(gtin ? { barcode: gtin } : {}),
    createdAt: now,
  }
}

function titleCase(s: string): string {
  if (s !== s.toUpperCase()) return s
  return s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase())
}
