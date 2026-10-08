/**
 * Addendum 2, the pure parts: units, the food library's ranking and format,
 * barcode resolution, online search, the estimation pipeline, label OCR
 * parsing, and the rule that estimates never reach observed TDEE.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { DayRecord, Entry, FoodItem, LookupRecord, NutrientVector } from '../../src/domain/types.ts'
import { ESTIMATED_FIDELITIES, FIDELITIES } from '../../src/domain/types.ts'
import {
  bodyWeightParts,
  formatBodyWeight,
  formatFood,
  formatHeight,
  kgToLb,
  parseBodyWeight,
  parseFoodAmount,
  parseLength,
} from '../../src/domain/units.ts'
import { makeNutrients } from '../../src/domain/nutrition/index.ts'
import {
  FoodSearchIndex,
  barcodeVariants,
  collapseDuplicates,
  foodOrigin,
  type SearchResult,
} from '../../src/food/search.ts'
import { decodeUsdaSubset } from '../../src/food/usda.ts'
import { encode, streamRecords, type Row } from '../../scripts/build-food-index.ts'
import { resolveBarcode, type BarcodeLookupResult } from '../../src/food/barcode.ts'
import { normaliseFdcFood, onlineSearchUrls, searchOnline } from '../../src/food/online.ts'
import {
  SYSTEM_PROMPT,
  buildDraft,
  linePer100g,
  makeLibraryMatcher,
  parseModelOutput,
  regramLine,
  rematchLine,
  type EstimateRequest,
  type ModelOutput,
} from '../../src/estimate/pipeline.ts'
import { buildRequestBody, completionsUrl, endpointProblem, estimateExternal } from '../../src/estimate/external.ts'
import { runChain } from '../../src/estimate/chain.ts'
import { pickModel } from '../../src/estimate/onDevice.ts'
import { parseNutritionLabel } from '../../src/food/labelParse.ts'
import { fitWithin } from '../../src/platform/image.ts'
import { dayConfidence, fidelityLabel, lowestFidelity, rollupDay } from '../../src/domain/analytics/index.ts'
import { observedTdee } from '../../src/domain/engine/tdee.ts'
import { addDays } from '../../src/domain/dates.ts'

function food(over: Partial<FoodItem> & Pick<FoodItem, 'id' | 'name'>): FoodItem {
  return {
    tier: 'usda',
    per100g: makeNutrients({ kcal: 100, protein: 10, carbs: 5, fat: 4 }),
    portions: [],
    cookState: 'n/a',
    ...over,
  }
}

// --- §6 Units ---------------------------------------------------------------

describe('units: display and input only', () => {
  it('shows body weight in both units, preferred first', () => {
    expect(formatBodyWeight(92.6, 'lb')).toBe('204.1 lb (92.6 kg)')
    expect(formatBodyWeight(92.6, 'kg')).toBe('92.6 kg (204.1 lb)')
    expect(bodyWeightParts(92.6, 'lb')).toEqual({ primary: '204.1 lb', secondary: '92.6 kg' })
  })

  it('reads a bare number in the preferred unit and converts it to kilograms', () => {
    expect(parseBodyWeight('204.2', 'lb')).toBeCloseTo(92.62, 2)
    expect(parseBodyWeight('92.6', 'kg')).toBe(92.6)
  })

  it('lets a suffix override the preference rather than fail', () => {
    expect(parseBodyWeight('92.6kg', 'lb')).toBe(92.6)
    expect(parseBodyWeight('204.2 lbs', 'kg')).toBeCloseTo(92.62, 2)
    expect(parseBodyWeight('204,2 lb', 'kg')).toBeCloseTo(92.62, 2)
    expect(parseFoodAmount('6 oz', 'g')).toBeCloseTo(170.1, 1)
    expect(parseFoodAmount('170g', 'oz')).toBe(170)
    expect(parseFoodAmount('6', 'oz')).toBeCloseTo(170.1, 1)
  })

  it('refuses what it cannot read rather than guessing', () => {
    expect(parseBodyWeight('heavy', 'lb')).toBeUndefined()
    expect(parseBodyWeight('92.6 stone', 'lb')).toBeUndefined()
    expect(parseBodyWeight('0', 'lb')).toBeUndefined()
    expect(parseFoodAmount('-5', 'g')).toBeUndefined()
  })

  it('reads heights in feet and inches, inches, or centimetres', () => {
    expect(parseLength(`5'11"`, 'ftin')).toBeCloseTo(180.34, 2)
    expect(parseLength('5 ft 11 in', 'ftin')).toBeCloseTo(180.34, 2)
    expect(parseLength('5′11″', 'ftin')).toBeCloseTo(180.34, 2)
    expect(parseLength('5 11', 'ftin')).toBeCloseTo(180.34, 2)
    expect(parseLength('71in', 'cm')).toBeCloseTo(180.34, 2)
    expect(parseLength('180cm', 'ftin')).toBe(180)
    expect(parseLength('180', 'cm')).toBe(180)
    expect(parseLength('34', 'in')).toBeCloseTo(86.36, 2)
    expect(formatHeight(180.34, 'ftin')).toBe('5′11″')
  })

  it('rounds only at display time', () => {
    const kg = parseBodyWeight('204.2', 'lb')!
    // Full precision is kept for storage...
    expect(kg).not.toBe(Math.round(kg * 10) / 10)
    // ...and converts back exactly.
    expect(kgToLb(kg)).toBeCloseTo(204.2, 10)
    expect(formatFood(170.0971, 'g')).toBe('170 g')
    expect(formatFood(170.0971, 'oz')).toBe('6.0 oz')
  })
})

// --- §2 Library ---------------------------------------------------------------

describe('food library: ranking at scale', () => {
  const generic = food({
    id: 'u_1',
    name: 'Yogurt, Greek, plain, nonfat',
    origin: 'usda-generic',
    per100g: makeNutrients({ kcal: 59, protein: 10.2, carbs: 3.6, fat: 0.4 }),
  })
  const branded = food({
    id: 'u_2',
    name: 'Greek Yogurt',
    brand: 'Fage',
    origin: 'usda-branded',
    per100g: makeNutrients({ kcal: 60, protein: 10, carbs: 4, fat: 0 }),
  })
  const brandedOther = food({
    id: 'u_3',
    name: 'Greek Yogurt Honey',
    brand: 'Chobani',
    origin: 'usda-branded',
    per100g: makeNutrients({ kcal: 120, protein: 8, carbs: 16, fat: 2 }),
  })

  function index(...foods: FoodItem[]): FoodSearchIndex {
    const idx = new FoodSearchIndex()
    idx.add(foods)
    return idx
  }

  it('ranks generic foods above branded near-duplicates for a query that names no brand', () => {
    const results = index(branded, brandedOther, generic).search('greek yogurt')
    expect(results[0]!.food.id).toBe('u_1')
    const brandedPositions = results.filter((r) => r.origin === 'usda-branded')
    expect(brandedPositions.every((r) => r.score < results[0]!.score)).toBe(true)
  })

  it('lets a branded product rank freely when the query names its brand', () => {
    const results = index(branded, brandedOther, generic).search('chobani greek yogurt')
    expect(results[0]!.food.id).toBe('u_3')
  })

  it('keeps that ordering at six times the index size', () => {
    const filler: FoodItem[] = []
    for (let i = 0; i < 3000; i++) {
      filler.push(
        food({
          id: `b_${i}`,
          name: `Greek Yogurt ${['Vanilla', 'Strawberry', 'Plain', 'Blueberry'][i % 4]} ${i}`,
          brand: `Brand ${i % 40}`,
          origin: 'usda-branded',
          per100g: makeNutrients({ kcal: 80 + (i % 50), protein: 8, carbs: 10, fat: 2 }),
        }),
      )
    }
    const results = index(...filler, generic).search('greek yogurt')
    expect(results[0]!.food.id).toBe('u_1')
  })

  it('collapses duplicates into the higher-ranked source and keeps the rest reachable', () => {
    const generic2 = food({ ...generic, id: 'u_9', name: 'Plain nonfat Greek yogurt', origin: 'usda-branded' })
    const ranked: SearchResult[] = [generic, generic2, brandedOther].map((f, i) => ({
      food: f,
      score: 10 - i,
      tier: f.tier,
      origin: foodOrigin(f),
      alternatives: [],
    }))
    const collapsed = collapseDuplicates(ranked)
    expect(collapsed.map((r) => r.food.id)).toEqual(['u_1', 'u_3'])
    expect(collapsed[0]!.alternatives.map((f) => f.id)).toEqual(['u_9'])
  })

  it('does not collapse foods whose nutrients differ', () => {
    const fullFat = food({
      ...generic,
      id: 'u_10',
      name: 'Greek yogurt plain nonfat',
      per100g: makeNutrients({ kcal: 97, protein: 9, carbs: 4, fat: 5 }),
    })
    const ranked = [generic, fullFat].map((f, i) => ({
      food: f,
      score: 2 - i,
      tier: f.tier,
      origin: foodOrigin(f),
      alternatives: [],
    }))
    expect(collapseDuplicates(ranked)).toHaveLength(2)
  })

  it('ranks previously logged foods above the rest of the bundled index', () => {
    const rice = food({ id: 'u_rice', name: 'Rice, white, cooked', origin: 'usda-generic' })
    const riceBrown = food({ id: 'u_brown', name: 'Rice, brown, cooked', origin: 'usda-generic' })
    const idx = index(rice, riceBrown)
    idx.setUsage(new Map([['u_brown', { count: 12, lastAt: Date.now() }]]))
    expect(idx.search('rice cooked')[0]!.food.id).toBe('u_brown')
  })

  it('ranks the curated table first, then local foods, then the bundled index', () => {
    const curated = food({ id: 'c_1', name: 'Salmon fillet', tier: 'curated', origin: 'curated' })
    const local = food({ id: 'x_1', name: 'Salmon fillet smoked', tier: 'custom', origin: 'custom' })
    const usda = food({ id: 'u_5', name: 'Salmon fillet', origin: 'usda-generic', per100g: makeNutrients({ kcal: 300 }) })
    const results = index(usda, local, curated).search('salmon fillet')
    expect(results.map((r) => r.food.id)).toEqual(['c_1', 'x_1', 'u_5'])
  })

  it('derives an origin for rows written before origins existed', () => {
    expect(foodOrigin(food({ id: 'a', name: 'a', tier: 'barcode' }))).toBe('barcode')
    expect(foodOrigin(food({ id: 'a', name: 'a', tier: 'usda' }))).toBe('usda-generic')
    expect(foodOrigin(food({ id: 'a', name: 'a', tier: 'custom' }))).toBe('custom')
  })

  it('finds a bundled product by any spelling of its barcode', () => {
    const product = food({ id: 'u_7', name: 'Oat bar', origin: 'usda-branded', barcode: '012345678905' })
    const idx = index(product)
    expect(idx.barcode('0012345678905')?.id).toBe('u_7')
    expect(idx.barcode('12345678905')?.id).toBe('u_7')
    expect(barcodeVariants('012345678905')).toContain('00012345678905')
  })
})

describe('the bundled index format', () => {
  const rows: Row[] = [
    {
      fdcId: 1001,
      name: 'Yogurt, Greek, plain',
      branded: false,
      brand: '',
      gtin: '',
      servingDg: 0,
      values: [590, 1020, 360, 40, 10, 0, 36, 0xffff, 0],
    },
    {
      fdcId: 2002,
      name: 'Greek Yogurt',
      branded: true,
      brand: 'Fage',
      gtin: '689544080350',
      servingDg: 1700,
      values: [600, 1000, 400, 0, 0, 0xffff, 40, 0xffff, 0xffff],
    },
  ]

  it('round-trips generic and branded rows, with unknown kept unknown', () => {
    const buf = encode(rows)
    const foods = decodeUsdaSubset(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer)
    expect(foods).toHaveLength(2)
    const [g, b] = foods
    expect(g!.origin).toBe('usda-generic')
    expect(g!.per100g.kcal).toBe(59)
    expect(g!.per100g.addedSugar).toBeNull()
    expect(b!.origin).toBe('usda-branded')
    expect(b!.brand).toBe('Fage')
    expect(b!.barcode).toBe('689544080350')
    expect(b!.portions).toEqual([{ label: '1 serving', grams: 170 }])
    expect(b!.per100g.fibre).toBeNull()
    expect(b!.per100g.alcohol).toBeNull()
  })

  it('streams records out of an export too large to parse whole', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fdc-'))
    try {
      const file = join(dir, 'branded.json')
      const records = [
        { fdcId: 1, description: 'Braces { in } a "quoted" string', foodNutrients: [] },
        { fdcId: 2, description: 'Second', foodNutrients: [{ nutrient: { id: 1008 }, amount: 5 }] },
      ]
      writeFileSync(file, JSON.stringify({ BrandedFoods: records }))
      const seen: number[] = []
      for await (const r of streamRecords(file)) seen.push(r.fdcId)
      expect(seen).toEqual([1, 2])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('barcodes: one network request, ever', () => {
  function harness(lookup: (code: string) => Promise<BarcodeLookupResult>, bundled?: FoodItem) {
    const stored = new Map<string, FoodItem>()
    const lookups = new Map<string, LookupRecord>()
    const network = vi.fn(lookup)
    const deps = {
      local: async (variants: string[]) =>
        [...stored.values()].find((f) => f.barcode && variants.includes(f.barcode)),
      bundled: (code: string) => (bundled && barcodeVariants(code).includes(bundled.barcode!) ? bundled : undefined),
      previous: async (key: string) => lookups.get(key),
      remember: async (r: LookupRecord) => void lookups.set(r.key, r),
      save: async (f: FoodItem) => void stored.set(f.id, f),
      lookup: network,
    }
    return { deps, network, stored }
  }

  const product = food({ id: 'bc_5000159407236', name: 'Crisps', tier: 'barcode', barcode: '5000159407236' })

  it('fetches a found product once, then serves it locally', async () => {
    const h = harness(async () => ({ ok: true, food: product }))
    expect((await resolveBarcode('5000159407236', h.deps)).ok).toBe(true)
    const second = await resolveBarcode('5000159407236', h.deps)
    expect(second.ok && second.from).toBe('local')
    expect(h.network).toHaveBeenCalledTimes(1)
  })

  it('remembers a code with no product, so it is not asked again', async () => {
    const h = harness(async () => ({ ok: false, reason: 'not-found', message: 'none' }))
    await resolveBarcode('5000159407236', h.deps)
    const second = await resolveBarcode('05000159407236', h.deps)
    expect(second.ok).toBe(false)
    expect(!second.ok && second.from).toBe('remembered')
    expect(h.network).toHaveBeenCalledTimes(1)
  })

  it('does not remember a transient failure', async () => {
    const h = harness(async () => ({ ok: false, reason: 'network', message: 'down' }))
    await resolveBarcode('5000159407236', h.deps)
    await resolveBarcode('5000159407236', h.deps)
    expect(h.network).toHaveBeenCalledTimes(2)
  })

  it('resolves a bundled product with no network call at all', async () => {
    const bundled = food({ id: 'u_9', name: 'Oats', origin: 'usda-branded', barcode: '012345678905' })
    const h = harness(async () => ({ ok: true, food: product }), bundled)
    const r = await resolveBarcode('0012345678905', h.deps)
    expect(r.ok && r.from).toBe('bundled')
    expect(h.network).not.toHaveBeenCalled()
  })
})

describe('search online', () => {
  it('sends the query and nothing else that identifies anyone', () => {
    const { off, fdc } = onlineSearchUrls('greek yogurt')
    for (const url of [off, fdc]) {
      const u = new URL(url)
      expect(u.protocol).toBe('https:')
      const params = [...u.searchParams.keys()]
      expect(params.some((p) => /user|session|id$|token/i.test(p) && p !== 'api_key')).toBe(false)
    }
    // api.data.gov's shared public key: identifies no one.
    expect(new URL(fdc).searchParams.get('api_key')).toBe('DEMO_KEY')
  })

  it('makes no request when switched off', async () => {
    const fetchImpl = vi.fn()
    const r = await searchOnline('rice', { fetch: fetchImpl as unknown as typeof fetch, enabled: false })
    expect(r.ok).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('omits cookies and the referrer', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ products: [], foods: [] })))
    await searchOnline('rice', { fetch: fetchImpl as unknown as typeof fetch, enabled: true })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    for (const call of fetchImpl.mock.calls as unknown as [string, RequestInit][]) {
      expect(call[1].credentials).toBe('omit')
      expect(call[1].referrerPolicy).toBe('no-referrer')
    }
  })

  it('maps a FoodData Central hit per 100 g, unknown kept unknown', () => {
    const f = normaliseFdcFood(
      {
        fdcId: 2035482,
        description: 'GREEK YOGURT',
        dataType: 'Branded',
        brandName: 'OCEAN SPRAY',
        gtinUpc: '031200037206',
        servingSize: 30,
        servingSizeUnit: 'g',
        foodNutrients: [
          { nutrientId: 1003, value: 3.33 },
          { nutrientId: 1004, value: 20 },
          { nutrientId: 1005, value: 70 },
          { nutrientId: 1008, value: 467, unitName: 'KCAL' },
        ],
      },
      1,
    )!
    expect(f.name).toBe('Greek Yogurt')
    expect(f.tier).toBe('online')
    expect(f.origin).toBe('online')
    expect(f.per100g.kcal).toBe(467)
    expect(f.per100g.fibre).toBeNull()
    expect(f.per100g.alcohol).toBeNull()
    expect(f.barcode).toBe('031200037206')
    expect(f.portions).toEqual([{ label: '1 serving', grams: 30 }])
  })
})

// --- §3–4 Estimation ------------------------------------------------------------

const MODEL: ModelOutput = {
  components: [
    { name: 'white rice, cooked', grams: 200, per100g: { kcal: 150, protein: 3, carbs: 32, fat: 1, satFat: 0, fibre: 0.5, sodium: 5 } },
    { name: 'grilled chicken', grams: 150, per100g: { kcal: 220, protein: 30, carbs: 0, fat: 10, satFat: 3, fibre: 0, sodium: 400 } },
    { name: 'pico de gallo', grams: 60, per100g: { kcal: 25, protein: 1, carbs: 5, fat: 0, satFat: 0, fibre: 1, sodium: 300 } },
  ],
  preparation: {
    description: 'Cooking oil and salt',
    grams: 14,
    nutrients: { kcal: 110, protein: 0, carbs: 0, fat: 12, satFat: 2, fibre: 0, sodium: 1200 },
  },
}

const PROV = { tier: 'on-device' as const, model: 'Llama-3.2-3B-Instruct-q4f16_1-MLC', at: '2026-10-07T12:00:00.000Z' }

describe('estimation: the model proposes, the library prices', () => {
  const rice = food({
    id: 'u_rice',
    name: 'Rice, white, cooked',
    aliases: ['white rice, cooked'],
    origin: 'usda-generic',
    per100g: makeNutrients({ kcal: 130, protein: 2.7, carbs: 28, fat: 0.3, satFat: 0.1, fibre: 0.4, sodium: 1 }),
  })
  const chickenThigh = food({
    id: 'c_thigh',
    name: 'Grilled chicken thigh',
    tier: 'curated',
    origin: 'curated',
    per100g: makeNutrients({ kcal: 210, protein: 26, carbs: 0, fat: 11, satFat: 3, fibre: 0, sodium: 90 }),
  })
  const modelMade = food({
    id: 'x_pico',
    name: 'Pico de gallo',
    tier: 'custom',
    origin: 'custom',
    estimate: { line: 'model', ...PROV },
  })

  function matcher(...foods: FoodItem[]) {
    const idx = new FoodSearchIndex()
    idx.add(foods)
    return makeLibraryMatcher(idx)
  }

  it('takes database values wherever the library has the component', () => {
    const draft = buildDraft({
      output: MODEL,
      request: { description: 'burrito bowl', pinned: [] },
      match: matcher(rice),
      provenance: PROV,
    })
    const riceLine = draft.lines.find((l) => l.name === 'Rice, white, cooked')!
    expect(riceLine.source).toBe('db')
    expect(riceLine.nutrients.kcal).toBeCloseTo(260)
    const chicken = draft.lines.find((l) => l.name === 'Grilled chicken')!
    expect(chicken.source).toBe('model')
    expect(chicken.nutrients.kcal).toBeCloseTo(330)
  })

  it('never counts a model-made food as a library match', () => {
    const draft = buildDraft({
      output: MODEL,
      request: { description: 'bowl', pinned: [] },
      match: matcher(modelMade),
      provenance: PROV,
    })
    expect(draft.lines.find((l) => /pico/i.test(l.name))!.source).toBe('model')
  })

  it('always keeps the preparation allowance as its own labelled line', () => {
    const draft = buildDraft({ output: MODEL, request: { description: 'bowl', pinned: [] }, match: matcher(), provenance: PROV })
    const prep = draft.lines.filter((l) => l.source === 'prep')
    expect(prep).toHaveLength(1)
    expect(prep[0]!.nutrients.sodium).toBe(1200)
    // 1,200 of the meal's sodium is visibly the allowance, not the components.
    const componentSodium = draft.lines
      .filter((l) => l.source !== 'prep')
      .reduce((a, l) => a + (l.nutrients.sodium ?? 0), 0)
    expect(componentSodium).toBeCloseTo(2 * 5 + 1.5 * 400 + 0.6 * 300)
  })

  it('keeps a pinned weighed component exact and drops the model\'s version of it', () => {
    const draft = buildDraft({
      output: MODEL,
      request: { description: 'bowl', pinned: [{ food: chickenThigh, grams: 170 }] },
      match: matcher(rice, chickenThigh),
      provenance: PROV,
    })
    const chickenLines = draft.lines.filter((l) => /chicken/i.test(l.name))
    expect(chickenLines).toHaveLength(1)
    expect(chickenLines[0]!.pinned).toBe(true)
    expect(chickenLines[0]!.grams).toBe(170)
    expect(chickenLines[0]!.nutrients.kcal).toBeCloseTo(357)
  })

  it('leaves untracked nutrients unknown on model lines, never zero', () => {
    const draft = buildDraft({ output: MODEL, request: { description: 'bowl', pinned: [] }, match: matcher(), provenance: PROV })
    expect(draft.lines[0]!.nutrients.addedSugar).toBeNull()
  })

  it('lets every line be regrammed, rematched and saved per 100 g', () => {
    const draft = buildDraft({ output: MODEL, request: { description: 'bowl', pinned: [] }, match: matcher(), provenance: PROV })
    const line = draft.lines[1]!
    const doubled = regramLine(line, line.grams * 2)
    expect(doubled.nutrients.kcal).toBeCloseTo(line.nutrients.kcal! * 2)
    expect(linePer100g(doubled).kcal).toBeCloseTo(220)
    const rematched = rematchLine(line, chickenThigh)
    expect(rematched.source).toBe('db')
    expect(rematched.nutrients.kcal).toBeCloseTo(315)
  })

  it('treats model text as untrusted: bounds it and drops what does not fit', () => {
    expect(parseModelOutput('not json')).toBeUndefined()
    const parsed = parseModelOutput(
      '```json\n' +
        JSON.stringify({
          components: [
            { name: 'ok', grams: 100, per100g: MODEL.components[0]!.per100g },
            { name: 'huge', grams: 1e9, per100g: { ...MODEL.components[0]!.per100g, kcal: 5000 } },
            { name: '', grams: 50, per100g: MODEL.components[0]!.per100g },
            { name: 'negative', grams: -5, per100g: MODEL.components[0]!.per100g },
          ],
          preparation: MODEL.preparation,
        }) +
        '\n```',
    )!
    expect(parsed.components.map((c) => c.name)).toEqual(['ok', 'huge'])
    expect(parsed.components[1]!.grams).toBe(2000)
    expect(parsed.components[1]!.per100g.kcal).toBe(900)
  })
})

describe('estimation: the outbound request', () => {
  it('carries the fixed instruction, the description and pinned weights -- nothing else', () => {
    const body = buildRequestBody(
      {
        description: 'Large burrito bowl',
        pinned: [{ food: food({ id: 'c', name: 'Chicken thigh' }), grams: 170 }],
      },
      'some-model',
      'json_schema',
    )
    expect(Object.keys(body).sort()).toEqual(['messages', 'model', 'response_format', 'temperature'])
    const messages = body['messages'] as { role: string; content: unknown }[]
    expect(messages).toHaveLength(2)
    expect(messages[0]!.content).toBe(SYSTEM_PROMPT)
    expect(messages[1]!.content).toBe('Meal: Large burrito bowl\nAlready weighed (exclude these): Chicken thigh, 170 g')
    const text = JSON.stringify(body)
    for (const leak of ['profile', 'weightKg', 'target', 'history', 'birth', 'heightCm', 'user_id']) {
      expect(text).not.toContain(leak)
    }
  })

  it('attaches the photo only when one is given', () => {
    const withPhoto = buildRequestBody({ description: 'x', pinned: [], photo: 'data:image/jpeg;base64,AAA' }, 'm', 'json_object')
    const content = (withPhoto['messages'] as { content: unknown }[])[1]!.content as { type: string }[]
    expect(content.map((c) => c.type)).toEqual(['text', 'image_url'])
  })

  it('insists on https and a model name', () => {
    expect(endpointProblem({ baseUrl: 'http://example.org/v1', model: 'm' })).toMatch(/https/)
    expect(endpointProblem({ baseUrl: 'https://example.org/v1', model: '' })).toMatch(/model/)
    expect(endpointProblem({ baseUrl: 'https://example.org/v1', model: 'm' })).toBeUndefined()
    expect(completionsUrl('https://example.org/v1/')).toBe('https://example.org/v1/chat/completions')
  })

  it('sends no cookies or referrer, and the key only as a bearer header', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(MODEL) } }] })),
    )
    const out = await estimateExternal(
      { description: 'bowl', pinned: [] },
      { id: 'external', baseUrl: 'https://example.org/v1', model: 'm', apiKey: 'k', enabled: true },
      fetchImpl as unknown as typeof fetch,
    )
    expect(out.components).toHaveLength(3)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://example.org/v1/chat/completions')
    expect(init.credentials).toBe('omit')
    expect(init.referrerPolicy).toBe('no-referrer')
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer k')
    expect(String(init.body)).not.toContain('"k"')
  })
})

describe('estimation: the fallback chain', () => {
  const ok = async () => MODEL
  const fail = async (): Promise<ModelOutput> => {
    throw new Error('rate limited')
  }

  it('falls back from the external endpoint to the on-device model, silently', async () => {
    const r = await runChain({ description: 'bowl', pinned: [] }, [
      { tier: 'external', model: 'big', run: fail },
      { tier: 'on-device', model: 'small', run: ok },
    ])
    expect(r.ok && r.provenance.tier).toBe('on-device')
    expect(r.ok && r.provenance.model).toBe('small')
    expect(r.ok && r.fellBackFrom).toBe('external')
  })

  it('ends at manual entry when no model is present', async () => {
    const r = await runChain({ description: 'bowl', pinned: [] }, [])
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toBe('no-model')
  })

  it('never sends the photo to the on-device model', async () => {
    const seen = vi.fn(async (_req: EstimateRequest) => MODEL)
    await runChain({ description: 'bowl', pinned: [], photo: 'data:x' }, [{ tier: 'on-device', model: 's', run: seen }])
    expect(seen.mock.calls[0]![0]).not.toHaveProperty('photo')
  })

  it('picks the 3B model only where the device can carry it', () => {
    const big = 2 * 1024 ** 3
    expect(pickModel({ f16: true, maxStorageBinding: big, deviceMemoryGb: 8 })).toMatchObject({ size: '3b' })
    expect(pickModel({ f16: true, maxStorageBinding: big, deviceMemoryGb: 4 })).toMatchObject({ size: '1b' })
    expect(pickModel({ f16: false, maxStorageBinding: big, deviceMemoryGb: 8 })).toMatchObject({ size: '1b', f16: false })
    expect(pickModel({ f16: true, maxStorageBinding: 256 * 1024 ** 2, deviceMemoryGb: undefined })).toMatchObject({ size: '1b' })
  })
})

describe('estimated entries never reach observed TDEE', () => {
  const nutrients = (kcal: number): NutrientVector => makeNutrients({ kcal, protein: 150, carbs: 250, fat: 80 })

  function day(date: string): DayRecord {
    return { date, phase: 'steady', precisionMode: 'weighed', entries: [], training: [], weightKg: { value: 90 } }
  }
  function entry(date: string, kcal: number, fidelity: Entry['fidelity']): Entry {
    return {
      id: `${date}-${fidelity}`,
      date,
      source: { kind: 'food', foodId: 'f', name: 'f' },
      grams: 100,
      nutrients: nutrients(kcal),
      fidelity,
      createdAt: 1,
    }
  }

  it('excludes ai_estimated days from the window and keeps weighed ones', () => {
    const end = '2026-09-21'
    const rollups = []
    const readings = []
    for (let i = 0; i < 21; i++) {
      const date = addDays(end, -i)
      // Every third day is a restaurant day with a wildly high estimate.
      const estimated = i % 3 === 0
      const e = estimated ? entry(date, 6000, 'ai_estimated') : entry(date, 2500, 'weighed')
      rollups.push(rollupDay({ day: day(date), entries: [e] }))
      readings.push({ date, kg: 90 })
    }
    const r = observedTdee({ rollups, readings, windowEnd: end })
    expect(r.loggedDays).toBe(14)
    expect(r.meanIntakeKcal).toBe(2500)
  })

  it('treats a day with any estimated entry as partial, through the existing path', () => {
    const d = day('2026-09-01')
    expect(dayConfidence(d, [entry(d.date, 500, 'weighed'), entry(d.date, 900, 'ai_estimated')])).toBe('partial')
    expect(dayConfidence(d, [entry(d.date, 500, 'weighed')])).toBe('logged')
  })

  it('knows every fidelity, and which are estimates', () => {
    for (const f of FIDELITIES) expect(fidelityLabel(f).length).toBeGreaterThan(0)
    expect(ESTIMATED_FIDELITIES.has('ai_estimated')).toBe(true)
    expect(ESTIMATED_FIDELITIES.has('weighed')).toBe(false)
    expect(lowestFidelity(['weighed', 'ai_estimated'])).toBe('ai_estimated')
  })
})

// --- §5 Images ------------------------------------------------------------------

describe('label OCR parsing', () => {
  it('reads a US Nutrition Facts panel, per serving', () => {
    const r = parseNutritionLabel(`Nutrition Facts
8 servings per container
Serving size 2/3 cup (55g)
Calories 230
Total Fat 8g 10%
Saturated Fat 1g 5%
Trans Fat 0g
Cholesterol 0mg 0%
Sodium 160mg 7%
Total Carbohydrate 37g 13%
Dietary Fiber 4g 14%
Total Sugars 12g
Includes 10g Added Sugars 20%
Protein 3g`)
    expect(r.basis).toBe('serving')
    expect(r.basisGrams).toBe(55)
    expect(r.values).toEqual({ kcal: 230, fat: 8, satFat: 1, sodium: 160, carbs: 37, fibre: 4, addedSugar: 10, protein: 3 })
  })

  it('reads an EU panel per 100 g, converting salt to sodium', () => {
    const r = parseNutritionLabel(`Typical values per 100g
Energy 1046kJ / 250kcal
Fat 8.0g
of which saturates 1.2g
Carbohydrate 37g
Fibre 4.1g
Protein 3.0g
Salt 0.40g`)
    expect(r.basis).toBe('100g')
    expect(r.values.kcal).toBe(250)
    expect(r.values.satFat).toBe(1.2)
    expect(r.values.sodium).toBeCloseTo(160)
  })

  it('repairs the common OCR confusions inside numbers', () => {
    const r = parseNutritionLabel(`Serving size 1 bar (4Og)
Calories 19O
Sodium l20mg
Protein 1Og`)
    expect(r.basisGrams).toBe(40)
    expect(r.values).toMatchObject({ kcal: 190, sodium: 120, protein: 10 })
  })

  it('leaves what it cannot find unknown, for manual entry', () => {
    const r = parseNutritionLabel('Calories 120\nProtein 4g')
    expect(r.found).toEqual(['kcal', 'protein'])
    expect(r.values.fat).toBeUndefined()
    expect(parseNutritionLabel('a blurry photo of a jar').found).toEqual([])
  })

  it('does not read trans or unsaturated fat as total fat', () => {
    const r = parseNutritionLabel('Trans Fat 0.5g\nPolyunsaturated Fat 2g\nTotal Fat 9g')
    expect(r.values.fat).toBe(9)
  })
})

describe('plate photos', () => {
  it('compress to about 1024 px on the long edge, never enlarging', () => {
    expect(fitWithin(4032, 3024)).toEqual({ width: 1024, height: 768 })
    expect(fitWithin(3024, 4032)).toEqual({ width: 768, height: 1024 })
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 })
  })
})
