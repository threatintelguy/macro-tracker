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
export type Fidelity = 'weighed' | 'portioned' | 'estimated' | 'flagged'

/** Where a resolved target number came from. Every field carries one. */
export type TargetSource = 'formula' | 'observed' | 'user' | 'clamped' | 'preset'

/** The nutrients tracked. Values are always for the stated gram amount. */
export type NutrientVector = {
  kcal: number
  protein: number
  carbs: number
  fat: number
  satFat: number
  fibre: number
  sodium: number
  addedSugar: number
  alcohol: number
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

export const ZERO_NUTRIENTS: NutrientVector = {
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

/** Which tier a food came from, ranked by trustworthiness. */
export type FoodTier = 'curated' | 'usda' | 'custom' | 'barcode'

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
  note?: string
  createdAt: number
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
}

export type BackupMeta = {
  id?: number
  at: number
  recordCounts: Record<string, number>
  encrypted: boolean
  schemaVersion: number
}
