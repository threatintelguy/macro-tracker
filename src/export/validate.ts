/**
 * Structural validation of an imported payload.
 *
 * Every record is REBUILT from a whitelist of known fields rather than
 * passed through. That does three jobs at once: a malformed file is caught
 * before any write (and rejected whole, never half imported); unknown keys
 * never reach IndexedDB; and nothing from the file is ever merged into an
 * existing object with a prototype-sensitive assignment.
 *
 * Accepts every schema version up to the current one. Fields added in later
 * versions are optional here, and `migratePayload` fills the defaults.
 */

import type { BackupPayload } from './backup.ts'
import { isLocalDate } from '../domain/dates.ts'
import { NUTRIENT_KEYS } from '../domain/types.ts'

type Problems = string[]
/** A validator returns the rebuilt value, or FAIL after recording why. */
type V<T> = (v: unknown, path: string, p: Problems) => T | typeof FAIL

const FAIL = Symbol('invalid')
const MAX_PROBLEMS = 50

function fail(p: Problems, path: string, what: string): typeof FAIL {
  if (p.length < MAX_PROBLEMS) p.push(`${path} ${what}`)
  return FAIL
}

const num: V<number> = (v, path, p) =>
  typeof v === 'number' && Number.isFinite(v) ? v : fail(p, path, 'is not a number')

const nonNeg: V<number> = (v, path, p) =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0
    ? v
    : fail(p, path, 'is not a non-negative number')

const positive: V<number> = (v, path, p) =>
  typeof v === 'number' && Number.isFinite(v) && v > 0
    ? v
    : fail(p, path, 'is not a positive number')

const int: V<number> = (v, path, p) =>
  typeof v === 'number' && Number.isInteger(v) ? v : fail(p, path, 'is not an integer')

const bool: V<boolean> = (v, path, p) =>
  typeof v === 'boolean' ? v : fail(p, path, 'is not true or false')

const str: V<string> = (v, path, p) =>
  typeof v === 'string' ? v : fail(p, path, 'is not text')

const id: V<string> = (v, path, p) =>
  typeof v === 'string' && v.length > 0 && v.length <= 200
    ? v
    : fail(p, path, 'is not a valid id')

const date: V<string> = (v, path, p) =>
  typeof v === 'string' && isLocalDate(v) ? v : fail(p, path, 'is not a YYYY-MM-DD date')

const time: V<string> = (v, path, p) =>
  typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v)
    ? v
    : fail(p, path, 'is not an HH:MM time')

function lit<T extends string>(...values: T[]): V<T> {
  return (v, path, p) =>
    typeof v === 'string' && (values as string[]).includes(v)
      ? (v as T)
      : fail(p, path, `is not one of ${values.join(', ')}`)
}

const nullableNum: V<number | null> = (v, path, p) =>
  v === null ? null : num(v, path, p)

function arr<T>(item: V<T>): V<T[]> {
  return (v, path, p) => {
    if (!Array.isArray(v)) return fail(p, path, 'is not a list')
    const out: T[] = []
    let ok = true
    v.forEach((x, i) => {
      const r = item(x, `${path}[${i}]`, p)
      if (r === FAIL) ok = false
      else out.push(r)
    })
    return ok ? out : FAIL
  }
}

type Shape = Record<string, V<unknown>>
/** Keys ending in `?` are optional; absent or undefined values are omitted. */
function obj<T>(shape: Shape): V<T> {
  return (v, path, p) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      return fail(p, path, 'is not a record')
    }
    const src = v as Record<string, unknown>
    const out: Record<string, unknown> = {}
    let ok = true
    for (const [rawKey, check] of Object.entries(shape)) {
      const optional = rawKey.endsWith('?')
      const key = optional ? rawKey.slice(0, -1) : rawKey
      const has = Object.prototype.hasOwnProperty.call(src, key)
      const value = has ? src[key] : undefined
      if (value === undefined) {
        if (!optional) {
          fail(p, `${path}.${key}`, 'is missing')
          ok = false
        }
        continue
      }
      const r = check(value, `${path}.${key}`, p)
      if (r === FAIL) ok = false
      else out[key] = r
    }
    return ok ? (out as T) : FAIL
  }
}

/** Choose a validator by a discriminant field. */
function tagged<T>(field: string, cases: Record<string, V<unknown>>): V<T> {
  return (v, path, p) => {
    if (typeof v !== 'object' || v === null) return fail(p, path, 'is not a record')
    const tag = (v as Record<string, unknown>)[field]
    // Own properties only: a tag of "constructor" must not find Object.
    const check =
      typeof tag === 'string' && Object.prototype.hasOwnProperty.call(cases, tag)
        ? cases[tag]
        : undefined
    if (!check) return fail(p, `${path}.${field}`, 'is not a recognised kind')
    return check(v, path, p) as T | typeof FAIL
  }
}

function record(value: V<number>): V<Record<string, number>> {
  return (v, path, p) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      return fail(p, path, 'is not a record')
    }
    const out: Record<string, number> = {}
    let ok = true
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue
      const r = value(x, `${path}.${k}`, p)
      if (r === FAIL) ok = false
      else out[k] = r
    }
    return ok ? out : FAIL
  }
}

// --- Domain shapes --------------------------------------------------------

const phase = lit('calibration', 'steady', 'recalibration')
const precisionMode = lit('weighed', 'composite', 'minimal')
const fidelity = lit('weighed', 'portioned', 'estimated', 'flagged')

const nutrients: V<unknown> = (() => {
  const shape: Shape = {}
  for (const k of NUTRIENT_KEYS) shape[k] = nullableNum
  return obj(shape)
})()

const foodRef = obj({ kind: lit('food'), foodId: str, name: str })

const override = tagged('action', {
  skip: obj({ componentIndex: int, action: lit('skip') }),
  swap: obj({ componentIndex: int, action: lit('swap'), ref: foodRef, 'grams?': positive }),
  regram: obj({ componentIndex: int, action: lit('regram'), grams: positive }),
})

const compositeInstance = obj({
  kind: lit('composite'),
  compositeId: id,
  version: int,
  multiplier: positive,
  overrides: arr(override),
  name: str,
})

const entrySource = tagged('kind', { food: foodRef, composite: compositeInstance })

const entry = obj({
  id,
  date,
  'occasion?': str,
  'at?': time,
  source: entrySource,
  grams: nonNeg,
  nutrients,
  fidelity,
  'parsedFrom?': str,
  'fromCompositeEntryId?': id,
  'componentRef?': foodRef,
  'proxyFor?': obj({ note: str }),
  'note?': str,
  createdAt: num,
})

const day = obj({
  date,
  phase,
  precisionMode,
  entries: arr(id),
  'weightKg?': obj({ value: positive, 'time?': str }),
  'waistCm?': positive,
  training: arr(obj({ kind: str, 'minutes?': nonNeg, 'note?': str })),
  'proteinOverride?': nonNeg,
  'satFatFlag?': lit('low', 'high'),
  'note?': str,
})

const component = tagged('kind', {
  food: obj({ kind: lit('food'), ref: foodRef, grams: nonNeg }),
  composite: obj({ kind: lit('composite'), ref: id, multiplier: positive }),
})

const composite = obj({
  id,
  name: str,
  version: int,
  components: arr(component),
  'createdFrom?': arr(id),
  'defaultOccasion?': str,
  createdAt: num,
  updatedAt: num,
  'retired?': bool,
  'history?': arr(obj({ version: int, components: arr(component), replacedAt: num })),
})

const food = obj({
  id,
  name: str,
  'brand?': str,
  tier: lit('curated', 'usda', 'custom', 'barcode'),
  per100g: nutrients,
  portions: arr(obj({ label: str, grams: positive })),
  cookState: lit('raw', 'cooked', 'n/a'),
  'pairedWith?': str,
  'barcode?': str,
  'aliases?': arr(str),
  'createdAt?': num,
  'recipe?': obj({
    ingredients: arr(obj({ ref: foodRef, grams: nonNeg })),
    yieldGrams: positive,
  }),
  'derivedFrom?': obj({ ref: foodRef, adjustedFields: arr(str) }),
})

const targetKey = lit(
  'kcal',
  'protein',
  'fat',
  'carbs',
  'fibre',
  'satFat',
  'sodium',
  'addedSugar',
  'alcohol',
)

const profile = obj({
  id: lit('profile'),
  sex: lit('male', 'female'),
  birthYear: int,
  heightCm: positive,
  activityLevel: lit('sedentary', 'light', 'moderate', 'active', 'veryActive'),
  startDate: date,
  phase,
  phaseStartDate: date,
  'phaseEndDate?': date,
  precisionMode,
  units: lit('metric', 'imperial'),
  offlineMode: bool,
  theme: lit('dark', 'light'),
  'reminderTime?': str,
  'lastBackupAt?': num,
})

const settings = obj({
  id: lit('settings'),
  preset: lit('maintenance', 'fatLoss', 'leanGain', 'custom'),
  overrides: arr(obj({ key: targetKey, value: nonNeg, setAt: num, 'note?': str })),
  secondary: obj({
    fibreG: nonNeg,
    satFatPctKcal: nonNeg,
    sodiumMg: nonNeg,
    addedSugarPctKcal: nonNeg,
    alcoholGCeiling: nonNeg,
  }),
  proteinGPerKg: nonNeg,
  fatGPerKg: nonNeg,
  occasionWindowMinutes: positive,
  barcodeLookupEnabled: bool,
})

const goal = obj({
  'id?': int,
  direction: lit('loss', 'maintain', 'gain'),
  targetRateKgPerWeek: num,
  startDate: date,
  anchorWeightKg: positive,
  'targetWeightKg?': positive,
  active: bool,
  createdAt: num,
})

const usage = obj({ 'id?': int, compositeId: id, loggedAt: num })

const backupMeta = obj({
  'id?': int,
  at: num,
  recordCounts: record(nonNeg),
  encrypted: bool,
  schemaVersion: int,
})

const tombstone = obj({ id, name: str, deletedAt: str })

const kcalCarbs = obj({ kcal: num, carbsG: num })

const adjustment = obj({
  id,
  at: num,
  date,
  trigger: lit('scheduled'),
  outcome: lit('adjusted', 'held', 'suppressed', 'insufficient'),
  windowStart: date,
  windowEnd: date,
  'observedTdee?': num,
  'observedTdeeSe?': num,
  'trendKgPerWeek?': num,
  'intendedKgPerWeek?': num,
  adherencePct: num,
  weightReadings: int,
  before: kcalCarbs,
  after: kcalCarbs,
  deltaKcal: num,
  rationale: str,
  'suppressedBy?': arr(str),
  'clamped?': bool,
  'notes?': arr(obj({ at: num, text: str, adherencePct: num, 'observedTdee?': num })),
})

const tdeeEstimate = obj({
  windowEnd: date,
  windowStart: date,
  kcal: num,
  standardError: num,
  sufficient: bool,
  loggedDays: int,
  windowDays: int,
  computedAt: num,
})

const payloadShape = obj<BackupPayload>({
  schemaVersion: int,
  exportedAt: num,
  'profile?': profile,
  'settings?': settings,
  goals: arr(goal),
  days: arr(day),
  entries: arr(entry),
  foods: arr(food),
  composites: arr(composite),
  compositeUsage: arr(usage),
  backups: arr(backupMeta),
  // v2 onward; absent in a v1 file and filled by the migration.
  'tombstones?': arr(tombstone),
  'adjustments?': arr(adjustment),
  'tdeeEstimates?': arr(tdeeEstimate),
})

export type ValidationResult =
  | { ok: true; payload: BackupPayload }
  | { ok: false; problems: string[] }

export function validatePayload(raw: unknown): ValidationResult {
  const problems: string[] = []
  const r = payloadShape(raw, 'backup', problems)
  if (r === FAIL || problems.length > 0) {
    return { ok: false, problems: problems.length > 0 ? problems : ['backup is malformed'] }
  }
  const out = r as BackupPayload
  return {
    ok: true,
    payload: {
      ...out,
      tombstones: out.tombstones ?? [],
      adjustments: out.adjustments ?? [],
      tdeeEstimates: out.tdeeEstimates ?? [],
    },
  }
}
