import { describe, expect, it, vi } from 'vitest'
import { curatedFoods } from '../../src/food/curated.ts'
import { FoodSearchIndex, normalise } from '../../src/food/search.ts'
import {
  isPlausibleBarcode,
  lookupBarcode,
  normaliseOffProduct,
} from '../../src/food/barcode.ts'
import { decodeUsdaSubset, loadUsdaSubset, MAGIC, NUTRIENT_ORDER, RECORD_BYTES } from '../../src/food/usda.ts'
import { impliedKcal, nutrientsForGrams } from '../../src/domain/nutrition/index.ts'
import type { FoodItem } from '../../src/domain/types.ts'

describe('curated table', () => {
  const foods = curatedFoods()

  it('loads the hand-built tier', () => {
    expect(foods.length).toBeGreaterThan(140)
    expect(foods.every((f) => f.tier === 'curated')).toBe(true)
  })

  it('has unique ids', () => {
    expect(new Set(foods.map((f) => f.id)).size).toBe(foods.length)
  })

  it('carries a complete nutrient vector on every row', () => {
    for (const f of foods) {
      for (const [key, value] of Object.entries(f.per100g)) {
        expect(Number.isFinite(value), `${f.id}.${key}`).toBe(true)
        expect(value, `${f.id}.${key}`).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('keeps stated energy consistent with its macros', () => {
    // Fibre yields less energy than the Atwater carbohydrate factor, so a
    // high-fibre row legitimately reads below its macro sum. Everything else
    // should agree within a rounding margin.
    for (const f of foods) {
      const implied = impliedKcal(f.per100g)
      const fibreAllowance = f.per100g.fibre * 4
      if (f.per100g.kcal < 20) continue
      expect(implied - fibreAllowance, f.id).toBeLessThan(f.per100g.kcal * 1.25 + 10)
    }
  })

  it('links raw and cooked pairs in both directions', () => {
    const byId = new Map(foods.map((f) => [f.id, f]))
    for (const f of foods) {
      if (!f.pairedWith) continue
      const other = byId.get(f.pairedWith)
      expect(other, `${f.id} -> ${f.pairedWith}`).toBeDefined()
      expect(other!.pairedWith).toBe(f.id)
      expect(f.cookState).not.toBe(other!.cookState)
    }
  })

  it('gives portion labels a positive gram weight', () => {
    for (const f of foods) {
      for (const p of f.portions) {
        expect(p.grams, `${f.id}: ${p.label}`).toBeGreaterThan(0)
        expect(p.label.length).toBeGreaterThan(0)
      }
    }
  })

  it('includes the foods the design document names', () => {
    const names = foods.map((f) => f.name.toLowerCase())
    for (const needle of [
      'oats',
      'egg',
      'banana',
      'blueberries',
      'salmon',
      'potato',
      'broccoli',
      'whey protein',
    ]) {
      expect(names.some((n) => n.includes(needle)), needle).toBe(true)
    }
  })
})

describe('search', () => {
  function index(): FoodSearchIndex {
    const idx = new FoodSearchIndex()
    idx.add(curatedFoods())
    return idx
  }

  it('finds a food by name', () => {
    const results = index().search('salmon')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]!.food.name.toLowerCase()).toContain('salmon')
  })

  it('matches a prefix', () => {
    const results = index().search('blueb')
    expect(results[0]!.food.name).toBe('Blueberries')
  })

  it('tolerates a typo', () => {
    const results = index().search('brocoli')
    expect(results.some((r) => r.food.name.includes('Broccoli'))).toBe(true)
  })

  it('finds a food by alias', () => {
    const results = index().search('protein powder')
    expect(results[0]!.food.name).toContain('Whey protein')
  })

  it('ranks the curated tier above USDA for the same text', () => {
    const idx = index()
    const usdaLookalike: FoodItem = {
      id: 'u_1',
      name: 'Salmon',
      tier: 'usda',
      per100g: curatedFoods()[0]!.per100g,
      portions: [],
      cookState: 'n/a',
    }
    idx.add([usdaLookalike])
    const results = idx.search('salmon')
    expect(results[0]!.tier).toBe('curated')
  })

  it('shows the curated table when the query is empty', () => {
    const results = index().search('')
    expect(results.length).toBeGreaterThan(0)
    expect(results.every((r) => r.tier === 'curated')).toBe(true)
  })

  it('resolves an exact name or alias for the parser', () => {
    const idx = index()
    expect(idx.exact('Blueberries')?.id).toBe('c_blueberries')
    expect(idx.exact('  blueberries ')?.id).toBe('c_blueberries')
    expect(idx.exact('oatmeal')?.id).toBe('c_oats_dry')
  })

  it('returns nothing rather than a confident near miss', () => {
    expect(index().exact('blueberry pancake surprise')).toBeUndefined()
  })

  it('replaces and removes a food', () => {
    const idx = index()
    const before = idx.size
    const custom: FoodItem = {
      id: 'x_1',
      name: 'My protein loaf',
      tier: 'custom',
      per100g: curatedFoods()[0]!.per100g,
      portions: [],
      cookState: 'n/a',
    }
    idx.add([custom])
    expect(idx.size).toBe(before + 1)
    expect(idx.search('protein loaf')[0]!.food.id).toBe('x_1')

    idx.replace({ ...custom, name: 'Renamed loaf' })
    expect(idx.search('Renamed loaf')[0]!.food.id).toBe('x_1')
    expect(idx.size).toBe(before + 1)

    idx.remove('x_1')
    expect(idx.size).toBe(before)
    expect(idx.search('Renamed loaf').some((r) => r.food.id === 'x_1')).toBe(false)
  })

  it('normalises punctuation and case', () => {
    expect(normalise('Oats, rolled (dry)')).toBe('oats rolled dry')
  })
})

describe('portion arithmetic', () => {
  it('scales a per-100g vector to a gram amount', () => {
    const oats = curatedFoods().find((f) => f.id === 'c_oats_dry')!
    const n = nutrientsForGrams(oats.per100g, 80)
    expect(n.kcal).toBeCloseTo(oats.per100g.kcal * 0.8, 6)
    expect(n.protein).toBeCloseTo(oats.per100g.protein * 0.8, 6)
  })
})

describe('barcode normalisation', () => {
  const NOW = 1_758_000_000_000

  it('accepts EAN-8, UPC-A and EAN-13', () => {
    expect(isPlausibleBarcode('12345678')).toBe(true)
    expect(isPlausibleBarcode('012345678905')).toBe(true)
    expect(isPlausibleBarcode('5000159407236')).toBe(true)
    expect(isPlausibleBarcode('abc')).toBe(false)
    expect(isPlausibleBarcode('123')).toBe(false)
  })

  it('maps a product to a local food row', () => {
    const food = normaliseOffProduct(
      '5000159407236',
      {
        product_name: 'Oat bar',
        brands: 'Example Co, Other',
        serving_size: '40 g bar',
        serving_quantity: 40,
        quantity: '5 x 40 g',
        nutriments: {
          'energy-kcal_100g': 420,
          proteins_100g: 8.5,
          carbohydrates_100g: 60,
          fat_100g: 15,
          'saturated-fat_100g': 3.2,
          fiber_100g: 5,
          salt_100g: 0.5,
        },
      },
      NOW,
    )!
    expect(food.id).toBe('bc_5000159407236')
    expect(food.tier).toBe('barcode')
    expect(food.brand).toBe('Example Co')
    expect(food.per100g.kcal).toBe(420)
    expect(food.per100g.protein).toBe(8.5)
    // 0.5 g salt -> 200 mg sodium.
    expect(food.per100g.sodium).toBeCloseTo(200, 6)
    expect(food.portions[0]).toEqual({ label: '40 g bar', grams: 40 })
  })

  it('prefers a stated sodium figure over deriving it from salt', () => {
    const food = normaliseOffProduct(
      '12345678',
      { product_name: 'X', nutriments: { proteins_100g: 5, sodium_100g: 0.3, salt_100g: 2 } },
      NOW,
    )!
    expect(food.per100g.sodium).toBeCloseTo(300, 6)
  })

  it('converts kJ when kcal is absent', () => {
    const food = normaliseOffProduct(
      '12345678',
      { product_name: 'X', nutriments: { energy_100g: 1000, proteins_100g: 5 } },
      NOW,
    )!
    expect(food.per100g.kcal).toBeCloseTo(1000 / 4.184, 4)
  })

  it('parses a pack size into a portion', () => {
    const food = normaliseOffProduct(
      '12345678',
      { product_name: 'X', quantity: '330 ml', nutriments: { 'energy-kcal_100g': 40 } },
      NOW,
    )!
    expect(food.portions.some((p) => p.grams === 330)).toBe(true)
  })

  it('refuses a product with no usable nutrition data', () => {
    expect(
      normaliseOffProduct('12345678', { product_name: 'Mystery', nutriments: {} }, NOW),
    ).toBeUndefined()
  })

  it('names a product that has no name', () => {
    const food = normaliseOffProduct(
      '12345678',
      { nutriments: { 'energy-kcal_100g': 100 } },
      NOW,
    )!
    expect(food.name).toBe('Product 12345678')
  })
})

describe('barcode lookup', () => {
  it('makes no request at all when lookup is switched off', async () => {
    const fetchMock = vi.fn()
    const result = await lookupBarcode('5000159407236', {
      fetch: fetchMock as unknown as typeof fetch,
      enabled: false,
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('offline')
  })

  it('sends only the product code, with no credentials or referrer', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        status: 1,
        product: {
          product_name: 'Oat bar',
          nutriments: { 'energy-kcal_100g': 420, proteins_100g: 8 },
        },
      }),
    })
    const result = await lookupBarcode('5000159407236', {
      fetch: fetchMock as unknown as typeof fetch,
      enabled: true,
    })
    expect(result.ok).toBe(true)

    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toContain('5000159407236')
    expect(init.credentials).toBe('omit')
    expect(init.referrerPolicy).toBe('no-referrer')
    // Nothing identifying is attached.
    expect(JSON.stringify(init)).not.toMatch(/cookie|token|auth|user/i)
  })

  it('reports a miss plainly and points at manual entry', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404 })
    const result = await lookupBarcode('5000159407236', {
      fetch: fetchMock as unknown as typeof fetch,
      enabled: true,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('not-found')
      expect(result.message).toMatch(/manually/)
    }
  })

  it('survives a network failure without throwing', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('offline'))
    const result = await lookupBarcode('5000159407236', {
      fetch: fetchMock as unknown as typeof fetch,
      enabled: true,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('network')
  })

  it('does not call out for something that is not a barcode', async () => {
    const fetchMock = vi.fn()
    const result = await lookupBarcode('not-a-code', {
      fetch: fetchMock as unknown as typeof fetch,
      enabled: true,
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
  })
})

describe('USDA subset', () => {
  /** Build a small index in the same layout the build script emits. */
  function encode(rows: { fdcId: number; name: string; values: number[] }[]): ArrayBuffer {
    const encoder = new TextEncoder()
    const chunks = rows.map((r) => encoder.encode(r.name))
    const nameBytes = chunks.reduce((a, c) => a + c.length, 0)
    const buf = new ArrayBuffer(12 + nameBytes + rows.length * RECORD_BYTES)
    const view = new DataView(buf)
    const bytes = new Uint8Array(buf)
    for (let i = 0; i < 4; i++) bytes[i] = MAGIC.charCodeAt(i)
    view.setUint32(4, rows.length, true)
    view.setUint32(8, nameBytes, true)

    let cursor = 12
    const offsets: number[] = []
    for (const chunk of chunks) {
      offsets.push(cursor - 12)
      bytes.set(chunk, cursor)
      cursor += chunk.length
    }
    rows.forEach((r, i) => {
      const base = cursor + i * RECORD_BYTES
      view.setUint32(base, offsets[i]!, true)
      view.setUint16(base + 4, chunks[i]!.length, true)
      view.setUint32(base + 6, r.fdcId, true)
      r.values.forEach((v, n) => view.setUint16(base + 10 + n * 2, v, true))
    })
    return buf
  }

  it('decodes what the build script encodes', () => {
    const buf = encode([
      { fdcId: 12345, name: 'Kale, raw', values: [490, 430, 880, 90, 10, 360, 38, 0, 0] },
      { fdcId: 999, name: 'Rice, white', values: [1300, 270, 2820, 30, 10, 40, 1, 0, 0] },
    ])
    const foods = decodeUsdaSubset(buf)
    expect(foods).toHaveLength(2)
    expect(foods[0]!.id).toBe('u_12345')
    expect(foods[0]!.name).toBe('Kale, raw')
    expect(foods[0]!.tier).toBe('usda')
    // kcal is quantised at a scale of 10.
    expect(foods[0]!.per100g.kcal).toBeCloseTo(49, 6)
    // protein at a scale of 100.
    expect(foods[0]!.per100g.protein).toBeCloseTo(4.3, 6)
    expect(foods[0]!.per100g.sodium).toBe(38)
    expect(foods[1]!.name).toBe('Rice, white')
  })

  it('handles a name with multi-byte characters', () => {
    const buf = encode([
      { fdcId: 1, name: 'Crème fraîche', values: [3000, 200, 300, 3000, 2000, 0, 50, 0, 0] },
    ])
    expect(decodeUsdaSubset(buf)[0]!.name).toBe('Crème fraîche')
  })

  it('names the nine nutrients in the record order the script writes', () => {
    expect(NUTRIENT_ORDER.map(([k]) => k)).toEqual([
      'kcal', 'protein', 'carbs', 'fat', 'satFat', 'fibre', 'sodium', 'addedSugar', 'alcohol',
    ])
  })

  it('refuses a file that is not a food index', () => {
    expect(() => decodeUsdaSubset(new Uint8Array([1, 2, 3, 4, 0, 0, 0, 0, 0, 0, 0, 0]).buffer)).toThrow(
      /Not a food index/,
    )
  })

  it('refuses a truncated file rather than reading past the end', () => {
    const buf = encode([{ fdcId: 1, name: 'X', values: Array(9).fill(0) }])
    expect(() => decodeUsdaSubset(buf.slice(0, buf.byteLength - 4))).toThrow(/truncated/)
  })

  it('treats an absent subset as an empty tier rather than an error', async () => {
    const missing = vi.fn().mockResolvedValue({ ok: false, status: 404 })
    await expect(
      loadUsdaSubset('usda-subset.bin', missing as unknown as typeof fetch),
    ).resolves.toEqual([])

    const throwing = vi.fn().mockRejectedValue(new Error('no network'))
    await expect(
      loadUsdaSubset('usda-subset.bin', throwing as unknown as typeof fetch),
    ).resolves.toEqual([])
  })

  it('loads a subset when the build produced one', async () => {
    const buf = encode([
      { fdcId: 7, name: 'Oats', values: [3790, 1320, 6770, 650, 110, 1010, 6, 0, 0] },
    ])
    const ok = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => buf,
    })
    const foods = await loadUsdaSubset('usda-subset.bin', ok as unknown as typeof fetch)
    expect(foods).toHaveLength(1)
    expect(foods[0]!.per100g.kcal).toBeCloseTo(379, 6)
  })
})
