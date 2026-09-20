/**
 * Target resolution.
 *
 * `resolveTargets()` returns a target set where every field carries
 * `{ value, source, rationale }`. The UI can always answer "why is this
 * number what it is", for any number on any screen.
 *
 * Layers, applied in order:
 *
 *   1. formula   -- Mifflin-St Jeor x activity, a starting hypothesis only
 *   2. preset    -- the shipped presets, if one is selected
 *   3. observed  -- measured TDEE, once it exists (phase 2; the seam is here)
 *   4. user      -- explicit edits from settings, each timestamped
 *   5. clamped   -- the guardrails, applied last and unconditionally
 */

import type {
  ActivityLevel,
  PresetName,
  Profile,
  Settings,
  Sex,
  TargetKey,
  TargetOverride,
  TargetSet,
  TargetValue,
} from '../types.ts'
import {
  ACTIVITY_MULTIPLIERS,
  DEFAULT_SECONDARY_TARGETS,
  KCAL_PER_G,
  MACRO_BANDS,
  ageFromBirthYear,
  carbsFromRemainder,
  formulaTdee,
  gramsFromPctKcal,
  mifflinStJeorBmr,
} from '../nutrition/index.ts'
import { applyClamps, type ClampReport } from './clamps.ts'

export type Preset = {
  name: Exclude<PresetName, 'custom'>
  label: string
  description: string
  kcal: number
  proteinG: number
  fatG: number
  /** Carbs are always the remainder; stored here only for display. */
  carbsG: number
}

/**
 * Shipped presets, quoted at roughly 93 kg. They are starting points that
 * can be modified and saved, not constants.
 */
export const PRESETS: Record<Exclude<PresetName, 'custom'>, Preset> = {
  maintenance: {
    name: 'maintenance',
    label: 'Maintenance',
    description: 'Hold weight. Carbohydrate takes the remainder.',
    kcal: 2900,
    proteinG: 180,
    fatG: 85,
    carbsG: 355,
  },
  fatLoss: {
    name: 'fatLoss',
    label: 'Fat loss',
    description:
      'A 300–400 kcal deficit, around 0.5–0.75 lb per week. Deliberately slower than textbook.',
    kcal: 2500,
    proteinG: 195,
    fatG: 70,
    carbsG: 260,
  },
  leanGain: {
    name: 'leanGain',
    label: 'Lean gain',
    description: 'A small surplus with protein held high.',
    kcal: 3200,
    proteinG: 175,
    fatG: 90,
    carbsG: 410,
  },
}

/** The default on a fresh install: fat loss at its conservative end. */
export const DEFAULT_PRESET: Exclude<PresetName, 'custom'> = 'fatLoss'

export type ObservedTdee = {
  kcal: number
  standardError: number
  sufficient: boolean
  windowDays: number
}

export type ResolveTargetsInput = {
  profile: Pick<
    Profile,
    'sex' | 'birthYear' | 'heightCm' | 'activityLevel'
  >
  weightKg: number
  settings: Pick<
    Settings,
    'preset' | 'overrides' | 'secondary' | 'proteinGPerKg' | 'fatGPerKg'
  >
  goalDirection?: 'loss' | 'maintain' | 'gain'
  /** Present from phase 2 onward. When sufficient, it replaces the formula. */
  observedTdee?: ObservedTdee
  /** Defaults to now; injected in tests. */
  now?: number
}

export type ResolvedTargets = {
  targets: TargetSet
  /** The maintenance figure the deficit was measured against. */
  maintenanceKcal: number
  maintenanceSource: 'formula' | 'observed'
  bmr: number
  clamped: ClampReport[]
}

function tv(
  value: number,
  source: TargetValue['source'],
  rationale: string,
  updatedAt?: number,
): TargetValue {
  return updatedAt === undefined
    ? { value, source, rationale }
    : { value, source, rationale, updatedAt }
}

/**
 * Protein band in g/kg, widened in a deficit. Returns the configured
 * setting clamped into the band that applies to the current goal.
 */
export function proteinGPerKgForGoal(
  configured: number,
  direction: 'loss' | 'maintain' | 'gain',
): number {
  const b = MACRO_BANDS.protein
  const lo = direction === 'loss' ? b.deficitMin : b.min
  const hi = direction === 'loss' ? b.deficitMax : b.max
  return Math.min(hi, Math.max(lo, configured))
}

export function resolveTargets(input: ResolveTargetsInput): ResolvedTargets {
  const {
    profile,
    weightKg,
    settings,
    goalDirection = 'maintain',
    observedTdee,
    now = Date.now(),
  } = input

  const age = ageFromBirthYear(profile.birthYear, new Date(now))
  const bmr = mifflinStJeorBmr({
    weightKg,
    heightCm: profile.heightCm,
    age,
    sex: profile.sex as Sex,
  })
  const formulaMaintenance = formulaTdee({
    weightKg,
    heightCm: profile.heightCm,
    age,
    sex: profile.sex,
    activityLevel: profile.activityLevel as ActivityLevel,
  })

  // --- Layer 1/3: maintenance energy. Observed replaces formula for good.
  const useObserved = observedTdee !== undefined && observedTdee.sufficient
  const maintenanceKcal = useObserved ? observedTdee.kcal : formulaMaintenance
  const maintenanceSource: 'formula' | 'observed' = useObserved
    ? 'observed'
    : 'formula'

  const multiplier = ACTIVITY_MULTIPLIERS[profile.activityLevel]
  const maintenanceRationale = useObserved
    ? `Measured from ${observedTdee.windowDays} days of logged intake against the weight trend: about ${Math.round(observedTdee.kcal)} kcal, ±${Math.round(observedTdee.standardError)}. The formula is no longer used.`
    : `Mifflin-St Jeor BMR of ${Math.round(bmr)} kcal × ${multiplier} activity multiplier. A starting hypothesis — it is ±10% in individuals and will be replaced by measured expenditure after three weeks of logging.`

  // --- Layer 2: preset, expressed as a delta from maintenance.
  let kcal: TargetValue
  let proteinG: number
  let fatG: number
  let proteinSource: TargetValue['source'] = 'formula'
  let fatSource: TargetValue['source'] = 'formula'
  let proteinRationale: string
  let fatRationale: string

  const proteinPerKg = proteinGPerKgForGoal(settings.proteinGPerKg, goalDirection)
  const fatPerKg = Math.min(
    MACRO_BANDS.fat.max,
    Math.max(MACRO_BANDS.fat.min, settings.fatGPerKg),
  )

  if (settings.preset === 'custom') {
    kcal = tv(
      maintenanceKcal,
      maintenanceSource === 'observed' ? 'observed' : 'formula',
      maintenanceRationale,
    )
    proteinG = proteinPerKg * weightKg
    fatG = fatPerKg * weightKg
    proteinRationale = `${proteinPerKg} g/kg at ${weightKg.toFixed(1)} kg.`
    fatRationale = `${fatPerKg} g/kg at ${weightKg.toFixed(1)} kg.`
  } else {
    const preset = PRESETS[settings.preset]
    // Presets are quoted at ~93 kg. Scale the energy delta, not the absolute
    // figure, so the preset means the same thing at a different body weight.
    const presetDelta = preset.kcal - PRESETS.maintenance.kcal
    const kcalValue = maintenanceKcal + presetDelta
    kcal = tv(
      kcalValue,
      'preset',
      presetDelta === 0
        ? `${preset.label}: maintenance energy. ${maintenanceRationale}`
        : `${preset.label}: ${presetDelta > 0 ? '+' : ''}${presetDelta} kcal against maintenance of ${Math.round(maintenanceKcal)} kcal. ${maintenanceRationale}`,
    )
    proteinG = proteinPerKg * weightKg
    fatG = fatPerKg * weightKg
    proteinSource = 'preset'
    fatSource = 'preset'
    proteinRationale = `${preset.label} preset: ${proteinPerKg} g/kg at ${weightKg.toFixed(1)} kg${goalDirection === 'loss' ? ', raised because energy is below maintenance' : ''}.`
    fatRationale = `${preset.label} preset: ${fatPerKg} g/kg at ${weightKg.toFixed(1)} kg.`
  }

  const carbsG = carbsFromRemainder({
    kcal: kcal.value,
    proteinG,
    fatG,
  })

  let targets: TargetSet = {
    kcal,
    protein: tv(proteinG, proteinSource, proteinRationale),
    fat: tv(fatG, fatSource, fatRationale),
    carbs: tv(
      carbsG,
      'formula',
      'The adjustable remainder. Protein and fat hold steady; carbohydrate absorbs every calorie change.',
    ),
    fibre: tv(
      settings.secondary.fibreG,
      'preset',
      `${DEFAULT_SECONDARY_TARGETS.fibreG} g is the DRI for men under 50. Editable in settings.`,
    ),
    satFat: tv(
      gramsFromPctKcal(settings.secondary.satFatPctKcal, kcal.value, KCAL_PER_G.fat),
      'preset',
      `${settings.secondary.satFatPctKcal}% of ${Math.round(kcal.value)} kcal, the standard population guideline. Moves with the calorie target.`,
    ),
    sodium: tv(
      settings.secondary.sodiumMg,
      'preset',
      'The standard population guideline. Editable in settings.',
    ),
    addedSugar: tv(
      gramsFromPctKcal(
        settings.secondary.addedSugarPctKcal,
        kcal.value,
        KCAL_PER_G.carbs,
      ),
      'preset',
      `${settings.secondary.addedSugarPctKcal}% of ${Math.round(kcal.value)} kcal. Moves with the calorie target.`,
    ),
    alcohol: tv(
      settings.secondary.alcoholGCeiling,
      'preset',
      'The conventional ceiling. Alcohol remains a tracked calorie source.',
    ),
  }

  // --- Layer 4: user overrides. Each edit is timestamped and resettable.
  targets = applyOverrides(targets, settings.overrides)

  // --- Layer 5: clamps. Last, after everything, with no override path.
  const clampResult = applyClamps({
    targets,
    weightKg,
    maintenanceKcal,
  })

  return {
    targets: clampResult.targets,
    maintenanceKcal,
    maintenanceSource,
    bmr,
    clamped: clampResult.clamped,
  }
}

/**
 * Apply user edits. An edited calorie target re-derives carbohydrate unless
 * carbohydrate itself was edited, so the set stays internally coherent.
 */
export function applyOverrides(
  base: TargetSet,
  overrides: readonly TargetOverride[],
): TargetSet {
  if (overrides.length === 0) return base

  const out: TargetSet = { ...base }
  // Later edits of the same key win.
  const latest = new Map<TargetKey, TargetOverride>()
  for (const o of overrides) {
    const prev = latest.get(o.key)
    if (!prev || o.setAt >= prev.setAt) latest.set(o.key, o)
  }

  for (const [key, o] of latest) {
    out[key] = {
      value: o.value,
      source: 'user',
      rationale: o.note?.trim()
        ? `Set by you on ${new Date(o.setAt).toLocaleDateString()}: ${o.note.trim()}`
        : `Set by you on ${new Date(o.setAt).toLocaleDateString()}.`,
      updatedAt: o.setAt,
    }
  }

  if (!latest.has('carbs')) {
    out.carbs = {
      ...out.carbs,
      value: carbsFromRemainder({
        kcal: out.kcal.value,
        proteinG: out.protein.value,
        fatG: out.fat.value,
      }),
    }
  }

  // Percentage-derived secondary targets follow an edited calorie figure.
  if (latest.has('kcal') && !latest.has('satFat')) {
    out.satFat = { ...out.satFat, value: (out.kcal.value * 0.1) / KCAL_PER_G.fat }
  }
  if (latest.has('kcal') && !latest.has('addedSugar')) {
    out.addedSugar = {
      ...out.addedSugar,
      value: (out.kcal.value * 0.1) / KCAL_PER_G.carbs,
    }
  }

  return out
}

export const TARGET_LABELS: Record<TargetKey, string> = {
  kcal: 'Calories',
  protein: 'Protein',
  fat: 'Fat',
  carbs: 'Carbs',
  fibre: 'Fibre',
  satFat: 'Saturated fat',
  sodium: 'Sodium',
  addedSugar: 'Added sugar',
  alcohol: 'Alcohol',
}

export const TARGET_UNITS: Record<TargetKey, string> = {
  kcal: 'kcal',
  protein: 'g',
  fat: 'g',
  carbs: 'g',
  fibre: 'g',
  satFat: 'g',
  sodium: 'mg',
  addedSugar: 'g',
  alcohol: 'g',
}

/** Targets that are ceilings rather than things to reach. */
export const CEILING_TARGETS: ReadonlySet<TargetKey> = new Set<TargetKey>([
  'satFat',
  'sodium',
  'addedSugar',
  'alcohol',
])

export function sourceLabel(source: TargetValue['source']): string {
  switch (source) {
    case 'formula':
      return 'Computed'
    case 'preset':
      return 'Preset'
    case 'observed':
      return 'Measured'
    case 'user':
      return 'Set by you'
    case 'clamped':
      return 'At a floor'
  }
}
