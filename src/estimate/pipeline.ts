/**
 * Hybrid estimation: the model proposes components; the library prices them.
 *
 * A restaurant meal has no label, no recipe and nothing weighable. This
 * turns a short description -- optionally a photo, optionally weights
 * already taken -- into a draft that is reviewed line by line before
 * anything is saved:
 *
 *   1. The model decomposes the meal into components with gram estimates,
 *      plus a separate preparation allowance (oil, butter, salt).
 *   2. Every component found in the library takes the library's values.
 *      Only components the library lacks keep the model's numbers, and are
 *      marked as such.
 *   3. Anything already weighed is pinned: the model estimates around it
 *      and can never overwrite it.
 *
 * Decomposition -- what is in a burrito bowl -- holds up far better on a
 * small model than direct macro recall, which is why it is built this way.
 * As the library grows, lines shift from `model` to `db` with no change to
 * the workflow.
 *
 * Pure: no I/O. The model call and the library are injected.
 */

import type {
  EstimateSource,
  FoodItem,
  LineSource,
  NutrientKey,
  NutrientVector,
} from '../domain/types.ts'
import { NUTRIENT_KEYS } from '../domain/types.ts'
import { nutrientsForGrams } from '../domain/nutrition/index.ts'
import { dedupeKey } from '../food/search.ts'

/** The nutrients a model is asked for. The rest stay unknown, never zero. */
export const MODEL_NUTRIENTS = [
  'kcal',
  'protein',
  'carbs',
  'fat',
  'satFat',
  'fibre',
  'sodium',
] as const satisfies readonly NutrientKey[]

export type ModelNutrients = Record<(typeof MODEL_NUTRIENTS)[number], number>

/** The fixed shape every model response is constrained to. */
export type ModelOutput = {
  components: { name: string; grams: number; per100g: ModelNutrients }[]
  preparation: { description: string; grams: number; nutrients: ModelNutrients }
}

/** A component already weighed: exact, and never overwritten. */
export type PinnedComponent = { food: FoodItem; grams: number }

export type EstimateRequest = {
  /** Required. A photo alone is ambiguous about exactly what matters. */
  description: string
  pinned: PinnedComponent[]
  /** A JPEG data URL. Only ever sent to a configured external endpoint. */
  photo?: string
}

export type DraftLine = {
  key: string
  name: string
  grams: number
  /** For the grams shown, as eaten. */
  nutrients: NutrientVector
  source: LineSource
  /** The library food a `db` line is priced from. */
  food?: FoodItem
  /** Weighed by the user: exact. */
  pinned?: boolean
}

export type Draft = {
  lines: DraftLine[]
  provenance: EstimateSource
}

/**
 * The JSON schema the model's output is constrained to. On-device, grammar
 * sampling makes a malformed response impossible rather than unlikely; an
 * external endpoint is asked for the same schema and its output is checked
 * against it all the same.
 */
export const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['components', 'preparation'],
  properties: {
    components: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'grams', 'per100g'],
        properties: {
          name: { type: 'string' },
          grams: { type: 'number' },
          per100g: nutrientSchema(),
        },
      },
    },
    preparation: {
      type: 'object',
      additionalProperties: false,
      required: ['description', 'grams', 'nutrients'],
      properties: {
        description: { type: 'string' },
        grams: { type: 'number' },
        nutrients: nutrientSchema(),
      },
    },
  },
} as const

function nutrientSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: [...MODEL_NUTRIENTS],
    properties: Object.fromEntries(MODEL_NUTRIENTS.map((k) => [k, { type: 'number' }])),
  }
}

/**
 * The fixed instruction. It never varies with anything about the user:
 * no profile, weight, targets, history or other entries are ever included.
 */
export const SYSTEM_PROMPT = [
  'You estimate what is in a single meal, for a nutrition log.',
  'Break the meal into its distinct food components. For each, give a short plain name',
  '(for example "white rice, cooked" or "grilled chicken thigh"), an estimated weight in grams',
  'as served, and typical nutrient values per 100 g of that component as served:',
  'kcal, protein, carbs, fat, satFat (saturated fat) and fibre in grams, sodium in milligrams.',
  'Put everything added during preparation -- cooking oil, butter, salt, glazes -- in',
  '"preparation", with its total grams and the total nutrients it adds, never inside a component.',
  'Restaurant food is usually cooked with more oil and salt than home cooking; account for it there.',
  'Components the user has already weighed are listed separately: do not include them,',
  'but estimate everything else around them.',
  'Reply with JSON only.',
].join(' ')

/** The user turn: the description, and the names and weights of anything pinned. */
export function userPrompt(req: EstimateRequest): string {
  const lines = [`Meal: ${req.description.trim()}`]
  if (req.pinned.length > 0) {
    lines.push(
      'Already weighed (exclude these): ' +
        req.pinned.map((p) => `${p.food.name}, ${Math.round(p.grams)} g`).join('; '),
    )
  }
  return lines.join('\n')
}

// --- Checking model output ------------------------------------------------

const MAX_COMPONENT_GRAMS = 2000
const MAX_PREP_GRAMS = 200

function finite(v: unknown, max: number): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(v, max) : undefined
}

/** Per-100 g ceilings: nothing exceeds pure fat's energy, or salt's sodium. */
const PER100_MAX: ModelNutrients = {
  kcal: 900,
  protein: 100,
  carbs: 100,
  fat: 100,
  satFat: 100,
  fibre: 100,
  sodium: 40_000,
}

function nutrients(v: unknown, perHundred: boolean): ModelNutrients | undefined {
  if (typeof v !== 'object' || v === null) return undefined
  const src = v as Record<string, unknown>
  const out = {} as ModelNutrients
  for (const k of MODEL_NUTRIENTS) {
    const n = finite(src[k], perHundred ? PER100_MAX[k] : Number.MAX_SAFE_INTEGER)
    if (n === undefined) return undefined
    out[k] = n
  }
  return out
}

/**
 * Parse and bound a model response. Text from a model is untrusted input:
 * anything outside the schema or outside physical bounds is dropped rather
 * than believed. Returns undefined when nothing usable remains.
 */
export function parseModelOutput(raw: unknown): ModelOutput | undefined {
  let value = raw
  if (typeof raw === 'string') {
    const trimmed = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')
    try {
      value = JSON.parse(trimmed)
    } catch {
      return undefined
    }
  }
  if (typeof value !== 'object' || value === null) return undefined
  const v = value as { components?: unknown; preparation?: unknown }

  const components: ModelOutput['components'] = []
  if (Array.isArray(v.components)) {
    for (const c of v.components.slice(0, 20)) {
      if (typeof c !== 'object' || c === null) continue
      const item = c as Record<string, unknown>
      const name = typeof item['name'] === 'string' ? item['name'].trim().slice(0, 80) : ''
      const grams = finite(item['grams'], MAX_COMPONENT_GRAMS)
      const per100g = nutrients(item['per100g'], true)
      if (name.length === 0 || !grams || grams <= 0 || !per100g) continue
      components.push({ name, grams, per100g })
    }
  }

  let preparation: ModelOutput['preparation'] = {
    description: 'Preparation allowance',
    grams: 0,
    nutrients: { kcal: 0, protein: 0, carbs: 0, fat: 0, satFat: 0, fibre: 0, sodium: 0 },
  }
  if (typeof v.preparation === 'object' && v.preparation !== null) {
    const p = v.preparation as Record<string, unknown>
    const n = nutrients(p['nutrients'], false)
    if (n) {
      preparation = {
        description:
          typeof p['description'] === 'string' && p['description'].trim().length > 0
            ? p['description'].trim().slice(0, 120)
            : 'Preparation allowance',
        grams: finite(p['grams'], MAX_PREP_GRAMS) ?? 0,
        nutrients: n,
      }
    }
  }

  if (components.length === 0 && preparation.grams === 0 && preparation.nutrients.kcal === 0) {
    return undefined
  }
  return { components, preparation }
}

// --- Matching against the library -----------------------------------------

/**
 * Find a library food for a component name. Exact name or alias first; then
 * the best search hit whose name contains every word of the component's.
 * Foods that were themselves made from a model estimate never count -- a
 * model number must not come back dressed as a database value.
 */
export type LibraryMatcher = (name: string) => FoodItem | undefined

export function makeLibraryMatcher(index: {
  exact: (phrase: string, accept?: (f: FoodItem) => boolean) => FoodItem | undefined
  search: (q: string, limit?: number) => { food: FoodItem }[]
}): LibraryMatcher {
  const isLibrary = (f: FoodItem): boolean => f.estimate === undefined
  return (name) => {
    const exact = index.exact(name, isLibrary)
    if (exact) return exact
    const words = dedupeKey(name).split(' ').filter((w) => w.length > 0)
    if (words.length === 0) return undefined
    for (const { food } of index.search(name, 8)) {
      if (!isLibrary(food)) continue
      const foodWords = new Set(dedupeKey(food.name).split(' '))
      if (words.every((w) => foodWords.has(w))) return food
    }
    return undefined
  }
}

// --- Building the draft ---------------------------------------------------

function modelVector(per: ModelNutrients, factor: number): NutrientVector {
  const out = {} as NutrientVector
  for (const k of NUTRIENT_KEYS) out[k] = null
  for (const k of MODEL_NUTRIENTS) out[k] = per[k] * factor
  // A meal component with no stated alcohol has none.
  out.alcohol = 0
  return out
}

let lineCounter = 0
function lineKey(): string {
  lineCounter += 1
  return `l${Date.now().toString(36)}${lineCounter}`
}

/**
 * Turn a model's output into reviewable lines. Pinned components come first
 * and exactly as weighed; a model component naming a pinned food is dropped,
 * so a pin is never overwritten; library matches take database values; the
 * preparation allowance is always its own line.
 */
export function buildDraft(input: {
  output: ModelOutput
  request: EstimateRequest
  match: LibraryMatcher
  provenance: EstimateSource
}): Draft {
  const { output, request } = input
  const lines: DraftLine[] = request.pinned.map((p) => ({
    key: lineKey(),
    name: p.food.name,
    grams: p.grams,
    nutrients: nutrientsForGrams(p.food.per100g, p.grams),
    source: 'db',
    food: p.food,
    pinned: true,
  }))

  const pinnedKeys = request.pinned.map((p) => dedupeKey(p.food.name))
  const pinnedIds = new Set(request.pinned.map((p) => p.food.id))
  const coveredByPin = (name: string, food: FoodItem | undefined): boolean => {
    if (food && pinnedIds.has(food.id)) return true
    const key = dedupeKey(name)
    const words = key.split(' ')
    return pinnedKeys.some((pk) => {
      if (pk === key) return true
      const pinWords = new Set(pk.split(' '))
      return words.length > 0 && words.every((w) => pinWords.has(w))
    })
  }

  for (const c of output.components) {
    const food = input.match(c.name)
    if (coveredByPin(c.name, food)) continue
    if (food) {
      lines.push({
        key: lineKey(),
        name: food.name,
        grams: c.grams,
        nutrients: nutrientsForGrams(food.per100g, c.grams),
        source: 'db',
        food,
      })
    } else {
      lines.push({
        key: lineKey(),
        name: capitalise(c.name),
        grams: c.grams,
        nutrients: modelVector(c.per100g, c.grams / 100),
        source: 'model',
      })
    }
  }

  // Always present, even at zero, so the allowance is visible and editable:
  // 1,850 mg sodium with 1,200 from preparation is a different claim from
  // 1,850 spread across the components.
  const prep = output.preparation
  lines.push({
    key: lineKey(),
    name: prep.description || 'Preparation allowance',
    grams: Math.max(prep.grams, 1),
    nutrients: modelVector(prep.nutrients, 1),
    source: 'prep',
  })

  return { lines, provenance: input.provenance }
}

/** Change a line's grams. Nutrients scale with it; unknown stays unknown. */
export function regramLine(line: DraftLine, grams: number): DraftLine {
  if (!(grams > 0)) return line
  if (line.food) {
    return { ...line, grams, nutrients: nutrientsForGrams(line.food.per100g, grams) }
  }
  const factor = line.grams > 0 ? grams / line.grams : 1
  const nutrients = {} as NutrientVector
  for (const k of NUTRIENT_KEYS) {
    const v = line.nutrients[k]
    nutrients[k] = v === null ? null : v * factor
  }
  return { ...line, grams, nutrients }
}

/** Re-match a line to a library food: it becomes a database line. */
export function rematchLine(line: DraftLine, food: FoodItem): DraftLine {
  return {
    ...line,
    name: food.name,
    food,
    source: 'db',
    nutrients: nutrientsForGrams(food.per100g, line.grams),
  }
}

/** Overwrite one of a model or preparation line's values, as eaten. */
export function setLineNutrient(line: DraftLine, key: NutrientKey, value: number | null): DraftLine {
  if (line.source === 'db') return line
  return { ...line, nutrients: { ...line.nutrients, [key]: value } }
}

/** A line's per-100 g vector, for saving it as a food. */
export function linePer100g(line: DraftLine): NutrientVector {
  const out = {} as NutrientVector
  for (const k of NUTRIENT_KEYS) {
    const v = line.nutrients[k]
    out[k] = v === null || !(line.grams > 0) ? null : (v * 100) / line.grams
  }
  return out
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** A name for the meal, from its description. */
export function mealNameFrom(description: string): string {
  const first = description.trim().split(/[.\n]/)[0] ?? ''
  const name = first.length > 60 ? `${first.slice(0, 57)}…` : first
  return capitalise(name) || 'Estimated meal'
}
