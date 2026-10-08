/**
 * Food search across every tier.
 *
 * Database quality -- not size -- is where trackers earn or lose trust. With
 * a bundled index six times larger than before, ranking is the real work,
 * and the order is:
 *
 *   1. the curated personal table
 *   2. anything previously logged, by recency and frequency
 *   3. foods saved on this device: custom, scanned, and accepted online results
 *   4. bundled USDA generic foods
 *   5. bundled USDA branded foods
 *   6. online results -- not here: they are not local until accepted, and
 *      the UI shows them separately, labelled as such
 *
 * Generic foods must not drown under branded near-duplicates. For a query
 * that names no brand, a branded hit never outranks a generic hit that
 * matched every query term. Near-duplicates -- same normalised name, similar
 * nutrients -- collapse into the higher-ranked one, with the rest reachable
 * as alternatives.
 */

import MiniSearch from 'minisearch'
import type { FoodId, FoodItem, FoodOrigin, FoodTier } from '../domain/types.ts'

export type SearchResult = {
  food: FoodItem
  score: number
  tier: FoodTier
  origin: FoodOrigin
  /** Near-duplicates collapsed into this result, lower-ranked first-come. */
  alternatives: FoodItem[]
}

/** How often and how recently each food has been logged. */
export type FoodUsage = Map<FoodId, { count: number; lastAt: number }>

/** Origin weight applied to the text score. */
const ORIGIN_WEIGHT: Record<FoodOrigin, number> = {
  curated: 3.0,
  custom: 2.3,
  barcode: 2.2,
  online: 2.2,
  'usda-generic': 1.0,
  'usda-branded': 0.55,
}

/** Previously logged foods sit between curated and the rest of the local table. */
const LOGGED_BASE = 2.4
const LOGGED_SPAN = 0.4
const LOGGED_HALF_LIFE_DAYS = 60

/** The origin of a food, for rows written before origins existed. */
export function foodOrigin(f: FoodItem): FoodOrigin {
  if (f.origin) return f.origin
  switch (f.tier) {
    case 'curated':
      return 'curated'
    case 'usda':
      return 'usda-generic'
    case 'barcode':
      return 'barcode'
    case 'online':
      return 'online'
    case 'custom':
      return 'custom'
  }
}

type IndexedDoc = {
  id: string
  name: string
  brand: string
  aliases: string
}

export class FoodSearchIndex {
  private mini: MiniSearch<IndexedDoc>
  private byId = new Map<string, FoodItem>()
  private byBarcode = new Map<string, FoodItem>()
  private byName: Map<string, FoodItem[]> | null = null
  private usage: FoodUsage = new Map()
  private now: () => number = () => Date.now()

  constructor() {
    this.mini = new MiniSearch<IndexedDoc>({
      fields: ['name', 'aliases', 'brand'],
      storeFields: [],
      searchOptions: {
        prefix: true,
        fuzzy: 0.2,
        boost: { name: 3, aliases: 2, brand: 1 },
      },
    })
  }

  add(foods: readonly FoodItem[]): void {
    const docs: IndexedDoc[] = []
    for (const f of foods) {
      if (this.byId.has(f.id)) continue
      this.byId.set(f.id, f)
      if (f.barcode) {
        for (const code of barcodeVariants(f.barcode)) {
          if (!this.byBarcode.has(code)) this.byBarcode.set(code, f)
        }
      }
      docs.push({
        id: f.id,
        name: f.name,
        brand: f.brand ?? '',
        aliases: (f.aliases ?? []).join(' '),
      })
    }
    if (docs.length > 0) {
      this.mini.addAll(docs)
      this.byName = null
    }
  }

  /** Replace a single food in the index, e.g. after an edit. */
  replace(food: FoodItem): void {
    this.remove(food.id)
    this.add([food])
  }

  remove(id: string): void {
    const existing = this.byId.get(id)
    if (!existing) return
    this.mini.discard(id)
    this.byId.delete(id)
    if (existing.barcode) {
      for (const code of barcodeVariants(existing.barcode)) {
        if (this.byBarcode.get(code)?.id === id) this.byBarcode.delete(code)
      }
    }
    this.byName = null
  }

  /** Logging history, which lifts previously logged foods. */
  setUsage(usage: FoodUsage, now?: () => number): void {
    this.usage = usage
    if (now) this.now = now
  }

  get size(): number {
    return this.byId.size
  }

  get(id: string): FoodItem | undefined {
    return this.byId.get(id)
  }

  all(): FoodItem[] {
    return [...this.byId.values()]
  }

  /** A food carrying this barcode, from any tier, in any GTIN spelling. */
  barcode(code: string): FoodItem | undefined {
    for (const v of barcodeVariants(code)) {
      const hit = this.byBarcode.get(v)
      if (hit) return hit
    }
    return undefined
  }

  private weight(food: FoodItem): number {
    const base = ORIGIN_WEIGHT[foodOrigin(food)]
    const used = this.usage.get(food.id)
    if (!used || used.count === 0) return base
    const ageDays = Math.max(0, (this.now() - used.lastAt) / 86_400_000)
    const recency = Math.pow(0.5, ageDays / LOGGED_HALF_LIFE_DAYS)
    const frequency = Math.min(1, Math.log1p(used.count) / Math.log(20))
    return Math.max(base, LOGGED_BASE + LOGGED_SPAN * 0.5 * (recency + frequency) * 0.999)
  }

  search(query: string, limit = 30): SearchResult[] {
    const q = query.trim()
    if (q.length === 0) {
      // No query: show the curated table, which is the useful default.
      return this.all()
        .filter((f) => f.tier === 'curated')
        .slice(0, limit)
        .map((food) => result(food, 0))
    }

    const hits = this.mini.search(q)
    const termCount = new Set(normalise(q).split(' ').filter((t) => t.length > 0)).size
    // A query is "qualified" when one of its terms matched a brand: then
    // the user is asking for the branded product and it may rank freely.
    let qualified = false
    const scored: { food: FoodItem; score: number; complete: boolean }[] = []
    // Every hit is weighed before anything is cut: at tens of thousands of
    // foods, a generic food can sit below hundreds of branded near-matches
    // on raw text score alone, and must still be found to rank first.
    for (const hit of hits) {
      const food = this.byId.get(hit.id as string)
      if (!food) continue
      const fields = Object.values(hit.match).flat()
      if (fields.includes('brand')) qualified = true
      scored.push({
        food,
        score: hit.score * this.weight(food),
        complete: hit.queryTerms.length >= termCount,
      })
    }

    if (!qualified) {
      // Generic over branded, for a query that names no brand: cap every
      // branded hit just under the weakest generic hit that matched in full.
      const floor = scored
        .filter((s) => s.complete && foodOrigin(s.food) === 'usda-generic')
        .reduce((m, s) => Math.min(m, s.score), Number.POSITIVE_INFINITY)
      if (Number.isFinite(floor)) {
        for (const s of scored) {
          if (foodOrigin(s.food) === 'usda-branded' && !this.usage.has(s.food.id)) {
            s.score = Math.min(s.score, floor * 0.999)
          }
        }
      }
    }

    scored.sort((a, b) => b.score - a.score)
    return collapseDuplicates(scored.map((s) => result(s.food, s.score))).slice(0, limit)
  }

  /**
   * Exact-ish match for the deterministic parser and the estimate matcher:
   * name or alias, case and punctuation insensitive. Returns undefined
   * rather than a near miss -- an unmatched fragment becomes a gap the user
   * fills, which is safer than a confident wrong food.
   */
  exact(phrase: string, accept: (f: FoodItem) => boolean = () => true): FoodItem | undefined {
    const norm = normalise(phrase)
    if (norm.length === 0) return undefined
    let best: FoodItem | undefined
    for (const f of this.names().get(norm) ?? []) {
      if (!accept(f)) continue
      if (!best || this.weight(f) > this.weight(best)) best = f
    }
    return best
  }

  private names(): Map<string, FoodItem[]> {
    if (this.byName) return this.byName
    const map = new Map<string, FoodItem[]>()
    const put = (key: string, f: FoodItem): void => {
      if (key.length === 0) return
      const list = map.get(key)
      if (list) {
        if (!list.includes(f)) list.push(f)
      } else map.set(key, [f])
    }
    for (const f of this.byId.values()) {
      put(normalise(f.name), f)
      for (const a of f.aliases ?? []) put(normalise(a), f)
    }
    this.byName = map
    return map
  }
}

function result(food: FoodItem, score: number): SearchResult {
  return { food, score, tier: food.tier, origin: foodOrigin(food), alternatives: [] }
}

/**
 * Collapse near-duplicates into the first (highest-ranked) occurrence. Two
 * foods are duplicates when their names normalise to the same set of words
 * and their energy and macros agree closely. Input must be ranked.
 */
export function collapseDuplicates(ranked: readonly SearchResult[]): SearchResult[] {
  const out: (SearchResult & { key: string })[] = []
  for (const r of ranked) {
    const key = dedupeKey(r.food.name)
    const keeper = out.find((o) => o.key === key && nutrientsSimilar(o.food, r.food))
    if (keeper) keeper.alternatives.push(r.food)
    else out.push({ ...r, alternatives: [...r.alternatives], key })
  }
  return out.map(({ key: _key, ...r }) => r)
}

const FILLER = new Set(['and', 'with', 'the', 'of', 'a', 'raw', 'nfs', 'ns', 'includes'])

/** Word-order-insensitive name key: "Yogurt, Greek, plain" = "Plain greek yogurt". */
export function dedupeKey(name: string): string {
  return [...new Set(normalise(name).split(' ').filter((w) => w && !FILLER.has(w)))]
    .sort()
    .join(' ')
}

function close(a: number | null, b: number | null, abs: number, rel: number): boolean {
  if (a === null || b === null) return true
  return Math.abs(a - b) <= Math.max(abs, rel * Math.max(Math.abs(a), Math.abs(b)))
}

export function nutrientsSimilar(a: FoodItem, b: FoodItem): boolean {
  const x = a.per100g
  const y = b.per100g
  return (
    close(x.kcal, y.kcal, 8, 0.08) &&
    close(x.protein, y.protein, 1.5, 0.12) &&
    close(x.carbs, y.carbs, 2, 0.12) &&
    close(x.fat, y.fat, 1.5, 0.12)
  )
}

/**
 * The spellings one product code goes by. A UPC-A scanned as EAN-13 gains a
 * leading zero; a GTIN-14 from a database gains two. All name one product.
 */
export function barcodeVariants(code: string): string[] {
  const digits = code.trim().replace(/\D/g, '')
  if (digits.length === 0) return []
  const stripped = digits.replace(/^0+/, '')
  const out = new Set<string>([digits])
  if (stripped.length > 0) {
    out.add(stripped)
    for (const len of [8, 12, 13, 14]) {
      if (stripped.length <= len) out.add(stripped.padStart(len, '0'))
    }
  }
  return [...out]
}

export function normalise(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
