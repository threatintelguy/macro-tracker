/**
 * Food search across the three tiers.
 *
 * Database quality -- not size -- is where trackers earn or lose trust, so
 * ranking is by tier before it is by text score: curated first, then the
 * user's own custom foods and cached barcode results, then the bundled USDA
 * subset. A prefix and fuzzy MiniSearch index over the lot.
 */

import MiniSearch from 'minisearch'
import type { FoodItem, FoodTier } from '../domain/types.ts'

export type SearchResult = {
  food: FoodItem
  score: number
  tier: FoodTier
}

/** Tier weight applied to the text score. Curated always outranks USDA. */
const TIER_WEIGHT: Record<FoodTier, number> = {
  curated: 3.0,
  custom: 2.4,
  barcode: 2.2,
  usda: 1.0,
}

type IndexedDoc = {
  id: string
  name: string
  brand: string
  aliases: string
  tier: FoodTier
}

export class FoodSearchIndex {
  private mini: MiniSearch<IndexedDoc>
  private byId = new Map<string, FoodItem>()

  constructor() {
    this.mini = new MiniSearch<IndexedDoc>({
      fields: ['name', 'aliases', 'brand'],
      storeFields: ['tier'],
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
      docs.push({
        id: f.id,
        name: f.name,
        brand: f.brand ?? '',
        aliases: (f.aliases ?? []).join(' '),
        tier: f.tier,
      })
    }
    if (docs.length > 0) this.mini.addAll(docs)
  }

  /** Replace a single food in the index, e.g. after an edit. */
  replace(food: FoodItem): void {
    if (this.byId.has(food.id)) {
      this.mini.discard(food.id)
      this.byId.delete(food.id)
    }
    this.add([food])
  }

  remove(id: string): void {
    if (!this.byId.has(id)) return
    this.mini.discard(id)
    this.byId.delete(id)
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

  search(query: string, limit = 30): SearchResult[] {
    const q = query.trim()
    if (q.length === 0) {
      // No query: show the curated table, which is the useful default.
      return this.all()
        .filter((f) => f.tier === 'curated')
        .slice(0, limit)
        .map((food) => ({ food, score: 0, tier: food.tier }))
    }

    const hits = this.mini.search(q)
    const out: SearchResult[] = []
    for (const hit of hits) {
      const food = this.byId.get(hit.id as string)
      if (!food) continue
      out.push({
        food,
        score: hit.score * TIER_WEIGHT[food.tier],
        tier: food.tier,
      })
    }
    out.sort((a, b) => b.score - a.score)
    return out.slice(0, limit)
  }

  /**
   * Exact-ish match for the deterministic parser: name or alias, case and
   * punctuation insensitive. Returns undefined rather than a near miss --
   * an unmatched fragment becomes a gap the user fills, which is safer than
   * a confident wrong food.
   */
  exact(phrase: string): FoodItem | undefined {
    const norm = normalise(phrase)
    if (norm.length === 0) return undefined
    let best: FoodItem | undefined
    for (const f of this.byId.values()) {
      if (normalise(f.name) === norm) {
        if (!best || TIER_WEIGHT[f.tier] > TIER_WEIGHT[best.tier]) best = f
        continue
      }
      for (const a of f.aliases ?? []) {
        if (normalise(a) === norm) {
          if (!best || TIER_WEIGHT[f.tier] > TIER_WEIGHT[best.tier]) best = f
          break
        }
      }
    }
    return best
  }
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
