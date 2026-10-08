/**
 * Core domain types.
 *
 * Two rules govern everything in this file:
 *
 *   1. Days are the spine. Every analytics query is "give me days between X
 *      and Y", so `DayRecord` keyed by local date is the primary table.
 *   2. Store what was entered, derive everything else. Nothing computed is
 *      persisted except a memoised daily rollup, invalidated on edit. That
 *      keeps history correct when a target or formula changes retroactively.
 */

import type { UnitPrefs } from './units.ts'

export type EntryId = string
export type CompositeId = string
export type FoodId = string
export type OccasionId = string

/** 'YYYY-MM-DD' in the user's local timezone. */
export type LocalDate = string

/** Persisted state machine. Phase 1 ships calibration and steady. */
export type Phase = 'calibration' | 'steady' | 'recalibration'

/** The precision dial. A default for new entries, never a ceiling. */
export type PrecisionMode = 'weighed' | 'composite' | 'minimal'

/**
 * What actually happened for a single value, independent of the day's mode.
 * A weighed meal inside a minimal week keeps its full fidelity -- this field
 * is what makes precision-as-a-dial work rather than precision-as-a-ratchet.
 */
export type Fidelity = 'weighed' | 'portioned' | 'estimated' | 'flagged' | 'ai_estimated'

/**
 * Every fidelity, in order from most to least exact. Anything that ranks or
 * lists fidelities reads this rather than its own copy, so widening the
 * enum cannot leave a stale list behind.
 */
export const FIDELITIES: readonly Fidelity[] = [
  'weighed',
  'portioned',
  'estimated',
  'ai_estimated',
  'flagged',
]

/**
 * Fidelities whose intake figure is a guess rather than a measurement. A day
 * carrying any of them is excluded from observed TDEE -- the one calculation
 * that depends on intake accuracy -- while still counting in every trend.
 */
export const ESTIMATED_FIDELITIES: ReadonlySet<Fidelity> = new Set<Fidelity>([
  'estimated',
  'ai_estimated',
  'flagged',
])

/** Which model tier produced an estimate. */
export type EstimateTier = 'on-device' | 'external'

/**
 * Provenance of an AI-estimated entry. If an external model reads sodium
 * high and the local one low, a year of mixed entries is uninterpretable
 * without knowing which produced which.
 */
export type EstimateSource = {
  tier: EstimateTier
  model: string
  /** ISO timestamp. */
  at: string
}

/** Where one line of an estimate got its numbers. */
export type LineSource = 'db' | 'model' | 'prep'

/** Where a resolved target number came from. Every field carries one. */
export type TargetSource = 'formula' | 'observed' | 'user' | 'clamped' | 'preset'

/**
 * The nutrients tracked. Values are always for the stated gram amount.
 *
 * Unknown is not zero. A field the user did not know is stored as `null`,
 * never 0 -- a blank protein field stored as zero would silently drag the
 * protein average down, and protein is the anchor metric. Every read path
 * that sums, averages or compares a nutrient must handle the null.
 */
export type NutrientVector = {
  kcal: number | null
  protein: number | null
  carbs: number | null
  fat: number | null
  satFat: number | null
  fibre: number | null
  sodium: number | null
  addedSugar: number | null
  alcohol: number | null
}

export const NUTRIENT_KEYS = [
  'kcal',
  'protein',
  'carbs',
  'fat',
  'satFat',
  'fibre',
  'sodium',
  'addedSugar',
  'alcohol',
] as const

export type NutrientKey = (typeof NUTRIENT_KEYS)[number]

export const ZERO_NUTRIENTS: Readonly<NutrientVector> = {
  kcal: 0,
  protein: 0,
  carbs: 0,
  fat: 0,
  satFat: 0,
  fibre: 0,
  sodium: 0,
  addedSugar: 0,
  alcohol: 0,
}

/**
 * Where a food is stored. Curated and USDA rows ship with the app; custom,
 * barcode and online rows live only on this device.
 */
export type FoodTier = 'curated' | 'usda' | 'custom' | 'barcode' | 'online'

/**
 * Where a food came from, which drives search ranking and the library
 * badge. Finer than the tier: the bundled USDA index holds both generic
 * foods and a curated slice of branded ones, and generic foods must not
 * drown under branded near-duplicates.
 */
export type FoodOrigin =
  | 'curated'
  | 'usda-generic'
  | 'usda-branded'
  | 'barcode'
  | 'online'
  | 'custom'

/** Raw vs cooked state, for the foods where it materially differs. */
export type CookState = 'raw' | 'cooked' | 'n/a'

export type Portion = {
  label: string
  grams: number
}

export type RecipeDefinition = {
  ingredients: { ref: FoodRef; grams: number }[]
  yieldGrams: number
}

export type FoodItem = {
  id: FoodId
  name: string
  brand?: string
  tier: FoodTier
  /** Per 100 g. The single canonical representation; grams internally, always. */
  per100g: NutrientVector
  portions: Portion[]
  cookState: CookState
  /** Links raw and cooked variants of the same food. */
  pairedWith?: FoodId
  barcode?: string
  /** Free-text aliases feeding search and the deterministic parser. */
  aliases?: string[]
  createdAt?: number
  /** Recipes: a per-100g vector derived from ingredients and a yield weight. */
  recipe?: RecipeDefinition
  /**
   * Set when this custom food was forked from a near match ("close, but not
   * quite"). Records the origin and which fields the user changed.
   */
  derivedFrom?: { ref: FoodRef; adjustedFields: string[] }
  /** Ranking and badge. Absent on rows written before Addendum 2; see `foodOrigin`. */
  origin?: FoodOrigin
  /**
   * Set on a food created from a model's estimate rather than a database or
   * label: a component the library did not have, or a preparation allowance.
   */
  estimate?: { line: 'model' | 'prep' } & EstimateSource
}

/** A pointer to a food plus enough identity to survive the food table changing. */
export type FoodRef = {
  kind: 'food'
  foodId: FoodId
  /** Denormalised so an entry still reads correctly if the food is deleted. */
  name: string
}

export type Component =
  | { kind: 'food'; ref: FoodRef; grams: number }
  | { kind: 'composite'; ref: CompositeId; multiplier: number }

export type Override =
  | { componentIndex: number; action: 'skip' }
  | { componentIndex: number; action: 'swap'; ref: FoodRef; grams?: number }
  | { componentIndex: number; action: 'regram'; grams: number }

export type CompositeVersionRecord = {
  version: number
  components: Component[]
  replacedAt: number
}

export type Composite = {
  id: CompositeId
  name: string
  /** Bumped on every definition edit. Instances pin the version as logged. */
  version: number
  components: Component[]
  /** Set when the composite was saved from an already-logged meal. */
  createdFrom?: EntryId[]
  defaultOccasion?: OccasionId
  createdAt: number
  updatedAt: number
  retired?: boolean
  /** Prior definitions, so instances pinned to old versions still resolve. */
  history?: CompositeVersionRecord[]
  /** Saved from an accepted AI estimate: logs at `ai_estimated` fidelity. */
  estimateSource?: EstimateSource
}

export type CompositeInstance = {
  kind: 'composite'
  compositeId: CompositeId
  /** The definition AS LOGGED. */
  version: number
  /** 0.5, 1.5, 2 -- scales the instance, never the definition. */
  multiplier: number
  overrides: Override[]
  /** Denormalised for display when the composite is later retired. */
  name: string
}

export type EntrySource = FoodRef | CompositeInstance

export type Entry = {
  id: EntryId
  date: LocalDate
  occasion?: OccasionId
  /** 'HH:MM' local. Drives occasion bucketing and time-of-day ranking. */
  at?: string
  source: EntrySource
  grams: number
  /** Snapshotted at log time. Never recomputed from the food table. */
  nutrients: NutrientVector
  fidelity: Fidelity
  parsedFrom?: string
  /** Set when this entry was produced by resolving a composite instance. */
  fromCompositeEntryId?: EntryId
  /**
   * On a composite's root row: the food the row's own grams and nutrients
   * belong to. The root carries the instance as its source, so without this
   * an "explode into components" could not name the first component.
   */
  componentRef?: FoodRef
  /**
   * Set when a similar food stood in for something not in the database.
   * Logged at estimated fidelity, and findable in the needs-detail queue.
   */
  proxyFor?: { note: string }
  note?: string
  createdAt: number
  /** AI-estimated entries: which tier and model produced the numbers. */
  estimateSource?: EstimateSource
  /** AI-estimated entries: where this line's numbers came from. */
  lineSource?: LineSource
  /** A plate photo attached to the entry, by id in the photo store. */
  photoRef?: string
}

export type TrainingSession = {
  kind: string
  minutes?: number
  note?: string
}

export type DayRecord = {
  date: LocalDate
  phase: Phase
  /** As of this day; historical, not global. */
  precisionMode: PrecisionMode
  entries: EntryId[]
  weightKg?: { value: number; time?: string }
  waistCm?: number
  training: TrainingSession[]
  /** minimal mode: grams entered directly, bypassing entries. */
  proteinOverride?: number
  /** minimal mode only. */
  satFatFlag?: 'low' | 'high'
  note?: string
}

export type CompositeUsage = {
  id?: number
  compositeId: CompositeId
  loggedAt: number
}

export type GoalDirection = 'loss' | 'maintain' | 'gain'

export type Goal = {
  id?: number
  direction: GoalDirection
  /** Signed: negative for loss, positive for gain. kg per week. */
  targetRateKgPerWeek: number
  startDate: LocalDate
  anchorWeightKg: number
  targetWeightKg?: number
  active: boolean
  createdAt: number
}

export type Sex = 'male' | 'female'

export type ActivityLevel =
  | 'sedentary'
  | 'light'
  | 'moderate'
  | 'active'
  | 'veryActive'

/**
 * The user's profile is data, not code -- a height or training-frequency
 * change is an edit in settings rather than a rebuild.
 */
export type Profile = {
  id: 'profile'
  sex: Sex
  birthYear: number
  heightCm: number
  activityLevel: ActivityLevel
  /** Onboarding start; the calibration countdown is measured from it. */
  startDate: LocalDate
  phase: Phase
  phaseStartDate: LocalDate
  phaseEndDate?: LocalDate
  precisionMode: PrecisionMode
  units: 'metric' | 'imperial'
  offlineMode: boolean
  theme: 'dark' | 'light'
  reminderTime?: string
  lastBackupAt?: number
}

/** A single resolved target with its provenance. */
export type TargetValue = {
  value: number
  source: TargetSource
  rationale: string
  /** Set when a clamp modified the value the layers below produced. */
  clampedFrom?: number
  updatedAt?: number
}

export type TargetKey =
  | 'kcal'
  | 'protein'
  | 'fat'
  | 'carbs'
  | 'fibre'
  | 'satFat'
  | 'sodium'
  | 'addedSugar'
  | 'alcohol'

export type TargetSet = {
  [K in TargetKey]: TargetValue
}

/** A user's explicit edit of one target. Recorded with a timestamp. */
export type TargetOverride = {
  key: TargetKey
  value: number
  setAt: number
  note?: string
}

export type PresetName = 'maintenance' | 'fatLoss' | 'leanGain' | 'custom'

export type Settings = {
  id: 'settings'
  preset: PresetName
  overrides: TargetOverride[]
  /** Secondary target bands, editable. */
  secondary: {
    fibreG: number
    satFatPctKcal: number
    sodiumMg: number
    addedSugarPctKcal: number
    alcoholGCeiling: number
  }
  proteinGPerKg: number
  fatGPerKg: number
  occasionWindowMinutes: number
  barcodeLookupEnabled: boolean
  /** Display and input units, per domain. Never stored on a record. */
  units?: UnitPrefs
  /** The floating add button on Today. On unless switched off. */
  floatingAdd?: boolean
  /** Search online, on explicit tap, when local search falls short. */
  onlineSearchEnabled?: boolean
  /** Keep plate photos attached to entries. On unless switched off. */
  retainPhotos?: boolean
  /** The on-device model downloaded, by WebLLM model id, if any. */
  onDeviceModelId?: string
}

export type OnDeviceModelSize = '3b' | '1b'

/**
 * The optional external model endpoint. Off until configured: no default
 * endpoint, no suggested provider, no shipped key. Kept in its own table so
 * it never travels in a backup.
 */
export type ExternalEndpoint = {
  id: 'external'
  baseUrl: string
  model: string
  apiKey: string
  enabled: boolean
  /** When the user acknowledged what is sent. Shown before first use. */
  disclosureAcceptedAt?: number
}

/** A plate photo, compressed on save, attached to one entry. */
export type Photo = {
  id: string
  blob: Blob
  createdAt: number
}

/**
 * A network lookup that has been made, kept forever so it is never made
 * again -- including the ones that found nothing.
 */
export type LookupRecord = {
  key: string
  at: number
  found: boolean
}

/**
 * What remains of a deleted composite. Entries pin `compositeId` and
 * `version`, so a hard delete would orphan history; the tombstone keeps the
 * name so past days render as "Lincoln salad (deleted)". Past totals never
 * lived in the definition, so nothing recalculates.
 */
export type CompositeTombstone = {
  id: CompositeId
  /** Preserved for historical display. */
  name: string
  /** ISO timestamp. */
  deletedAt: string
}

export type AdjustmentTrigger = 'scheduled'

/** The inputs as they stood when a note was appended, so notes do not repeat. */
export type AdjustmentNote = {
  at: number
  text: string
  adherencePct: number
  observedTdee?: number
}

export type AdjustmentOutcome = 'adjusted' | 'held' | 'suppressed' | 'insufficient'

/**
 * Every evaluation of the adjustment rule, with its inputs and rationale.
 * Append-only and never pruned: an event records a decision made on the
 * evidence available at the time. A later edit that changes its inputs
 * appends a note rather than rewriting it.
 */
export type AdjustmentEvent = {
  id: string
  /** Epoch ms. */
  at: number
  /** The evaluation date the event belongs to. */
  date: LocalDate
  trigger: AdjustmentTrigger
  outcome: AdjustmentOutcome
  windowStart: LocalDate
  windowEnd: LocalDate
  observedTdee?: number
  observedTdeeSe?: number
  trendKgPerWeek?: number
  intendedKgPerWeek?: number
  adherencePct: number
  weightReadings: number
  /** kcal/carbs target before and after. Equal when nothing was applied. */
  before: { kcal: number; carbsG: number }
  after: { kcal: number; carbsG: number }
  /** The carbohydrate energy applied by this event, signed. */
  deltaKcal: number
  rationale: string
  suppressedBy?: string[]
  clamped?: boolean
  /** Appended when a later edit changed this event's inputs. */
  notes?: AdjustmentNote[]
}

/**
 * A stored observed-TDEE estimate for the 21-day window ending on
 * `windowEnd`. Estimates outside the current window are frozen: they were
 * correct given what was known then, and rewriting them would make the
 * expenditure chart unreproducible.
 */
export type TdeeEstimate = {
  windowEnd: LocalDate
  windowStart: LocalDate
  kcal: number
  standardError: number
  sufficient: boolean
  loggedDays: number
  windowDays: number
  computedAt: number
}

/** A full copy of the database, written before an import or a purge. */
export type Snapshot = {
  id?: number
  at: number
  reason: 'import' | 'purge'
  /** JSON of a BackupPayload. */
  payload: string
}

export type BackupMeta = {
  id?: number
  at: number
  recordCounts: Record<string, number>
  encrypted: boolean
  schemaVersion: number
}
