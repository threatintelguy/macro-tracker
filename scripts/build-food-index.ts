/**
 * FoodData Central -> compact indexed binary (format v2, see src/food/usda.ts).
 *
 * Run in CI rather than committed, which keeps the repo small and the
 * derivation reproducible.
 *
 *   npm run build:food-index -- --input <dir> [--branded <file|dir>]
 *                               [--branded-max 45000] [--out public/usda-subset.bin]
 *
 * `--input` is a directory holding the unzipped FoodData Central JSON
 * exports for the generic datasets, ingested in full:
 *
 *   FoodData_Central_foundation_food_json_*.zip   -> FoundationFoods
 *   FoodData_Central_sr_legacy_food_json_*.zip    -> SRLegacyFoods
 *
 * `--branded` is the Branded Foods JSON export. It is several gigabytes, so
 * it is streamed rather than parsed whole, and only a curated slice is kept:
 * products selected by how commonly they are sold rather than for
 * completeness. The proxy for "commonly sold" is what the export offers --
 * how many products share a description (a common product type) and how
 * large the brand owner's range is (a common brand) -- restricted to
 * current US-market products with a full macro panel, one row per GTIN.
 *
 * Download the exports from https://fdc.nal.usda.gov/download-datasets.html
 *
 * Without this artefact the app still runs: the loader treats an absent
 * file as an empty tier and search falls back to the curated table.
 */

import { createReadStream, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  FLAG_BRANDED,
  MAGIC_V2,
  NUTRIENT_ORDER,
  RECORD_BYTES_V2,
  UNKNOWN_U16,
} from '../src/food/usda.ts'

/** FoodData Central nutrient ids (and legacy nutrient numbers) for the fields tracked. */
const FDC_NUTRIENT_IDS = {
  kcal: [1008, 2047, 2048, 208],
  protein: [1003, 203],
  carbs: [1005, 205],
  fat: [1004, 204],
  satFat: [1258, 606],
  fibre: [1079, 291],
  sodium: [1093, 307],
  addedSugar: [1235, 539],
  alcohol: [1018, 221],
} as const

type FdcNutrient = {
  nutrient?: { id?: number; number?: string; unitName?: string }
  amount?: number
}

type FdcFood = {
  fdcId: number
  description?: string
  dataType?: string
  foodNutrients?: FdcNutrient[]
  // Branded only.
  brandOwner?: string
  brandName?: string
  gtinUpc?: string
  servingSize?: number
  servingSizeUnit?: string
  marketCountry?: string
  discontinuedDate?: string
  modifiedDate?: string
}

export type Row = {
  fdcId: number
  name: string
  branded: boolean
  brand: string
  gtin: string
  servingDg: number
  values: number[]
}

type Args = { input: string; branded: string; brandedMax: number; out: string }

function parseArgs(argv: string[]): Args {
  const args: Args = { input: '', branded: '', brandedMax: 45_000, out: 'public/usda-subset.bin' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--input') args.input = argv[++i] ?? ''
    else if (a === '--branded') args.branded = argv[++i] ?? ''
    else if (a === '--branded-max') args.brandedMax = Number(argv[++i] ?? args.brandedMax)
    else if (a === '--out') args.out = argv[++i] ?? args.out
  }
  if (!args.input) {
    console.error(
      'Usage: npm run build:food-index -- --input <fdc-json-dir> [--branded <file|dir>] [--branded-max N] [--out public/usda-subset.bin]',
    )
    process.exit(1)
  }
  return args
}

function collectJsonFiles(path: string): string[] {
  if (!statSync(path).isDirectory()) return path.toLowerCase().endsWith('.json') ? [path] : []
  const out: string[] = []
  for (const name of readdirSync(path)) out.push(...collectJsonFiles(join(path, name)))
  return out
}

/**
 * Stream the records of a FoodData Central export one object at a time.
 *
 * The exports are `{ "SomeFoods": [ {...}, {...} ] }`; the Branded one is
 * too large for JSON.parse. This tracks nesting and string state across
 * chunks and yields each element of the first array it meets.
 */
export async function* streamRecords(file: string): AsyncGenerator<FdcFood> {
  const stack: string[] = []
  let arrayDepth = -1
  let inString = false
  let escaped = false
  let capture: string[] | null = null
  let captureStart = 0

  for await (const chunk of createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 20 })) {
    const text = chunk as string
    captureStart = 0
    for (let i = 0; i < text.length; i++) {
      const c = text[i]!
      if (inString) {
        if (escaped) escaped = false
        else if (c === '\\') escaped = true
        else if (c === '"') inString = false
        continue
      }
      if (c === '"') {
        inString = true
      } else if (c === '[' || c === '{') {
        if (c === '[' && arrayDepth === -1) arrayDepth = stack.length + 1
        stack.push(c)
        if (c === '{' && capture === null && stack.length === arrayDepth + 1) {
          capture = []
          captureStart = i
        }
      } else if (c === ']' || c === '}') {
        stack.pop()
        if (c === '}' && capture !== null && stack.length === arrayDepth) {
          capture.push(text.slice(captureStart, i + 1))
          const json = capture.join('')
          capture = null
          yield JSON.parse(json) as FdcFood
        }
      }
    }
    if (capture !== null) {
      capture.push(text.slice(captureStart))
    }
  }
}

function nutrientValue(food: FdcFood, ids: readonly number[]): number | undefined {
  for (const n of food.foodNutrients ?? []) {
    const id = n.nutrient?.id ?? Number(n.nutrient?.number)
    if (id !== undefined && ids.includes(id)) {
      const amount = n.amount
      if (typeof amount === 'number' && Number.isFinite(amount)) return amount
    }
  }
  return undefined
}

let clipped = 0

function quantise(value: number | undefined, scale: number): number {
  // Unknown is not zero: an unreported field stays unknown.
  if (value === undefined) return UNKNOWN_U16
  const q = Math.round(value * scale)
  if (q < 0) return 0
  if (q >= UNKNOWN_U16) {
    clipped++
    return UNKNOWN_U16 - 1
  }
  return q
}

function quantisedValues(food: FdcFood, generic: boolean): number[] {
  return NUTRIENT_ORDER.map(([key, scale]) => {
    const raw = nutrientValue(food, FDC_NUTRIENT_IDS[key])
    // A generic food that reports no alcohol has none; the datasets list
    // it wherever it is present.
    if (raw === undefined && key === 'alcohol' && generic) return 0
    return quantise(raw, scale)
  })
}

/** A food with no energy and no macros is not loggable. */
function hasCoreMacros(values: number[], requireAll: boolean): boolean {
  const core = values.slice(0, 4)
  return requireAll
    ? core.every((v) => v !== UNKNOWN_U16)
    : core.some((v) => v !== UNKNOWN_U16 && v > 0)
}

function normaliseName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function titleCase(s: string): string {
  // Branded descriptions are usually shouted. Title case reads better and
  // costs nothing.
  if (s !== s.toUpperCase()) return s
  return s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase())
}

async function readGeneric(dir: string, seen: Set<number>): Promise<Row[]> {
  const rows: Row[] = []
  for (const file of collectJsonFiles(dir)) {
    console.log(`reading ${file}`)
    for await (const food of streamRecords(file)) {
      const dataType = (food.dataType ?? '').toLowerCase()
      // Guard against a Branded export being dropped in the same directory.
      if (dataType.includes('branded')) continue
      if (!food.description || seen.has(food.fdcId)) continue
      const values = quantisedValues(food, true)
      if (!hasCoreMacros(values, false)) continue
      seen.add(food.fdcId)
      rows.push({
        fdcId: food.fdcId,
        name: food.description.trim(),
        branded: false,
        brand: '',
        gtin: '',
        servingDg: 0,
        values,
      })
    }
  }
  return rows
}

type BrandedCandidate = Row & { descKey: string; owner: string; modified: string }

async function readBranded(path: string, max: number, seen: Set<number>): Promise<Row[]> {
  const candidates: BrandedCandidate[] = []
  const descCount = new Map<string, number>()
  const ownerCount = new Map<string, number>()

  for (const file of collectJsonFiles(path)) {
    console.log(`streaming ${file}`)
    let n = 0
    for await (const food of streamRecords(file)) {
      if (++n % 100_000 === 0) console.log(`  ${n} products`)
      if (!food.description || seen.has(food.fdcId)) continue
      if (food.discontinuedDate) continue
      const market = (food.marketCountry ?? 'United States').toLowerCase()
      if (!market.includes('united states')) continue
      const values = quantisedValues(food, false)
      // Completeness is a filter, not the selection: a slice row must have
      // a full macro panel to be worth bundling at all.
      if (!hasCoreMacros(values, true)) continue

      const descKey = normaliseName(food.description)
      const owner = normaliseName(food.brandOwner ?? food.brandName ?? '')
      descCount.set(descKey, (descCount.get(descKey) ?? 0) + 1)
      ownerCount.set(owner, (ownerCount.get(owner) ?? 0) + 1)

      const unit = (food.servingSizeUnit ?? '').toLowerCase()
      const serving =
        typeof food.servingSize === 'number' && (unit === 'g' || unit === 'grm' || unit === 'ml' || unit === 'mlt')
          ? Math.round(food.servingSize * 10)
          : 0

      candidates.push({
        fdcId: food.fdcId,
        name: titleCase(food.description.trim()),
        branded: true,
        brand: (food.brandName || food.brandOwner || '').trim(),
        gtin: (food.gtinUpc ?? '').replace(/\D/g, ''),
        servingDg: serving > 0 && serving < 65_535 ? serving : 0,
        values,
        descKey,
        owner,
        modified: food.modifiedDate ?? '',
      })
    }
  }

  // One row per GTIN: the most recently modified label wins.
  const byGtin = new Map<string, BrandedCandidate>()
  const noGtin: BrandedCandidate[] = []
  for (const c of candidates) {
    if (!c.gtin) {
      noGtin.push(c)
      continue
    }
    const existing = byGtin.get(c.gtin)
    if (!existing || c.modified > existing.modified) byGtin.set(c.gtin, c)
  }

  const score = (c: BrandedCandidate): number =>
    Math.log1p(descCount.get(c.descKey) ?? 0) * 2 + Math.log1p(ownerCount.get(c.owner) ?? 0)

  const ranked = [...byGtin.values(), ...noGtin].sort((a, b) => score(b) - score(a))
  const chosen = ranked.slice(0, max)
  for (const c of chosen) seen.add(c.fdcId)
  console.log(`branded: ${candidates.length} eligible, ${chosen.length} kept`)
  return chosen.map(({ descKey: _d, owner: _o, modified: _m, ...row }) => row)
}

export function encode(rows: Row[]): Buffer {
  const encoder = new TextEncoder()
  const chunks: Uint8Array[] = []
  const interned = new Map<string, { offset: number; length: number }>()
  let cursor = 0
  const intern = (s: string, maxLength: number): { offset: number; length: number } => {
    if (s.length === 0) return { offset: 0, length: 0 }
    const hit = interned.get(s)
    if (hit) return hit
    const bytes = encoder.encode(s)
    if (bytes.length > maxLength) throw new Error(`String too long for the index: ${s}`)
    const ref = { offset: cursor, length: bytes.length }
    chunks.push(bytes)
    cursor += bytes.length
    interned.set(s, ref)
    return ref
  }

  const refs = rows.map((r) => ({
    name: intern(r.name, 65_535),
    brand: intern(r.brand, 65_535),
    gtin: intern(r.gtin, 255),
  }))

  const total = 12 + cursor + rows.length * RECORD_BYTES_V2
  const buf = Buffer.alloc(total)
  for (let i = 0; i < 4; i++) buf[i] = MAGIC_V2.charCodeAt(i)
  buf.writeUInt32LE(rows.length, 4)
  buf.writeUInt32LE(cursor, 8)
  let at = 12
  for (const chunk of chunks) {
    buf.set(chunk, at)
    at += chunk.length
  }

  rows.forEach((r, i) => {
    const base = at + i * RECORD_BYTES_V2
    const ref = refs[i]!
    buf.writeUInt32LE(ref.name.offset, base)
    buf.writeUInt16LE(ref.name.length, base + 4)
    buf.writeUInt32LE(r.fdcId, base + 6)
    buf.writeUInt8(r.branded ? FLAG_BRANDED : 0, base + 10)
    buf.writeUInt32LE(ref.brand.offset, base + 11)
    buf.writeUInt16LE(ref.brand.length, base + 15)
    buf.writeUInt32LE(ref.gtin.offset, base + 17)
    buf.writeUInt8(ref.gtin.length, base + 21)
    buf.writeUInt16LE(r.servingDg, base + 22)
    r.values.forEach((v, n) => buf.writeUInt16LE(v, base + 24 + n * 2))
  })
  return buf
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const seen = new Set<number>()
  const generic = await readGeneric(resolve(args.input), seen)
  if (generic.length === 0) {
    console.error(`No generic foods found under ${args.input}`)
    process.exit(1)
  }
  const branded = args.branded ? await readBranded(resolve(args.branded), args.brandedMax, seen) : []

  const rows = [...generic, ...branded].sort((a, b) => a.name.localeCompare(b.name))
  const buf = encode(rows)
  writeFileSync(resolve(args.out), buf)
  writeFileSync(
    resolve(args.out.replace(/\.bin$/, '.meta.json')),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        format: MAGIC_V2,
        count: rows.length,
        generic: generic.length,
        branded: branded.length,
        bytes: buf.length,
      },
      null,
      2,
    ),
  )

  console.log(
    `wrote ${args.out}: ${rows.length} foods (${generic.length} generic, ${branded.length} branded), ${(buf.length / 1024 / 1024).toFixed(2)} MB`,
  )
  if (clipped > 0) console.warn(`warning: ${clipped} nutrient values clipped at the u16 ceiling`)
}

// Run only as a script, so tests can import the streaming reader.
if (process.argv[1] && /build-food-index\.ts$/.test(process.argv[1])) {
  void main()
}
