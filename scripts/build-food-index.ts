/**
 * FoodData Central -> compact indexed binary.
 *
 * Run in CI rather than committed, which keeps the repo small and the
 * derivation reproducible.
 *
 *   npm run build:food-index -- --input <dir> [--out public/usda-subset.bin]
 *
 * `--input` is a directory holding the unzipped FoodData Central JSON
 * exports. Download them from https://fdc.nal.usda.gov/download-datasets.html
 *
 *   FoodData_Central_foundation_food_json_*.zip   -> foundationFoods
 *   FoodData_Central_sr_legacy_food_json_*.zip    -> SRLegacyFoods
 *
 * The Branded dataset is deliberately NOT ingested. It is label-derived
 * rather than lab-verified, it is the bulk of FoodData Central's size, and
 * it duplicates what barcode lookup handles on demand.
 *
 * Without this artefact the app still runs: the loader treats an absent file
 * as an empty tier and search falls back to the curated table.
 */

import { readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  MAGIC,
  NUTRIENT_ORDER,
  RECORD_BYTES,
} from '../src/food/usda.ts'

/** FoodData Central nutrient numbers for the fields tracked. */
const FDC_NUTRIENT_IDS = {
  kcal: [1008],
  protein: [1003],
  carbs: [1005],
  fat: [1004],
  satFat: [1258],
  fibre: [1079],
  sodium: [1093],
  addedSugar: [1235],
  alcohol: [1018],
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
}

type Args = { input: string; out: string; maxFoods: number }

function parseArgs(argv: string[]): Args {
  const args: Args = {
    input: '',
    out: 'public/usda-subset.bin',
    maxFoods: 12_000,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--input') args.input = argv[++i] ?? ''
    else if (a === '--out') args.out = argv[++i] ?? args.out
    else if (a === '--max') args.maxFoods = Number(argv[++i] ?? args.maxFoods)
  }
  if (!args.input) {
    console.error(
      'Usage: npm run build:food-index -- --input <fdc-json-dir> [--out public/usda-subset.bin]',
    )
    process.exit(1)
  }
  return args
}

function collectJsonFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...collectJsonFiles(full))
    else if (name.toLowerCase().endsWith('.json')) out.push(full)
  }
  return out
}

function extractFoods(parsed: unknown): FdcFood[] {
  if (Array.isArray(parsed)) return parsed as FdcFood[]
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>
    for (const key of ['FoundationFoods', 'foundationFoods', 'SRLegacyFoods', 'srLegacyFoods']) {
      const v = obj[key]
      if (Array.isArray(v)) return v as FdcFood[]
    }
  }
  return []
}

function nutrientValue(food: FdcFood, ids: readonly number[]): number {
  for (const n of food.foodNutrients ?? []) {
    const id = n.nutrient?.id ?? Number(n.nutrient?.number)
    if (id !== undefined && ids.includes(id)) {
      const amount = n.amount
      if (typeof amount === 'number' && Number.isFinite(amount)) return amount
    }
  }
  return 0
}

function quantise(value: number, scale: number): number {
  const q = Math.round(value * scale)
  // u16 ceiling. A clipped value is wrong, so say so rather than wrap.
  if (q < 0) return 0
  return Math.min(65_535, q)
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const dir = resolve(args.input)
  const files = collectJsonFiles(dir)

  if (files.length === 0) {
    console.error(`No JSON files under ${dir}`)
    process.exit(1)
  }

  const seen = new Set<number>()
  const rows: { fdcId: number; name: string; values: number[] }[] = []
  let clipped = 0

  for (const file of files) {
    console.log(`reading ${file}`)
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    for (const food of extractFoods(parsed)) {
      const dataType = (food.dataType ?? '').toLowerCase()
      // Guard against a Branded export being dropped in the same directory.
      if (dataType.includes('branded')) continue
      if (!food.description || seen.has(food.fdcId)) continue
      seen.add(food.fdcId)

      const values: number[] = []
      for (const [key, scale] of NUTRIENT_ORDER) {
        const raw = nutrientValue(food, FDC_NUTRIENT_IDS[key])
        const q = quantise(raw, scale)
        if (q === 65_535 && raw * scale > 65_535) clipped++
        values.push(q)
      }

      // Drop rows with no energy and no macros; they are not loggable.
      if (values[0] === 0 && values[1] === 0 && values[2] === 0 && values[3] === 0) {
        continue
      }

      rows.push({ fdcId: food.fdcId, name: food.description.trim(), values })
      if (rows.length >= args.maxFoods) break
    }
    if (rows.length >= args.maxFoods) break
  }

  rows.sort((a, b) => a.name.localeCompare(b.name))

  const encoder = new TextEncoder()
  const nameChunks: Uint8Array[] = []
  const offsets: { offset: number; length: number }[] = []
  let nameCursor = 0
  for (const r of rows) {
    const bytes = encoder.encode(r.name)
    if (bytes.length > 65_535) throw new Error(`Name too long: ${r.name}`)
    nameChunks.push(bytes)
    offsets.push({ offset: nameCursor, length: bytes.length })
    nameCursor += bytes.length
  }

  const total = 12 + nameCursor + rows.length * RECORD_BYTES
  const buf = new ArrayBuffer(total)
  const view = new DataView(buf)
  const bytes = new Uint8Array(buf)

  for (let i = 0; i < 4; i++) bytes[i] = MAGIC.charCodeAt(i)
  view.setUint32(4, rows.length, true)
  view.setUint32(8, nameCursor, true)

  let cursor = 12
  for (const chunk of nameChunks) {
    bytes.set(chunk, cursor)
    cursor += chunk.length
  }

  for (let i = 0; i < rows.length; i++) {
    const base = cursor + i * RECORD_BYTES
    const { offset, length } = offsets[i]!
    view.setUint32(base, offset, true)
    view.setUint16(base + 4, length, true)
    view.setUint32(base + 6, rows[i]!.fdcId, true)
    rows[i]!.values.forEach((v, n) => view.setUint16(base + 10 + n * 2, v, true))
  }

  writeFileSync(resolve(args.out), Buffer.from(buf))
  writeFileSync(
    resolve(args.out.replace(/\.bin$/, '.meta.json')),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        count: rows.length,
        bytes: total,
        sources: files.map((f) => f.split(/[\\/]/).pop()),
        excluded: 'Branded Foods, deliberately',
      },
      null,
      2,
    ),
  )

  console.log(
    `wrote ${args.out}: ${rows.length} foods, ${(total / 1024 / 1024).toFixed(2)} MB`,
  )
  if (clipped > 0) console.warn(`warning: ${clipped} nutrient values clipped at u16 ceiling`)
}

main()
