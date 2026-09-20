import { describe, expect, it } from 'vitest'
import {
  PRESETS,
  applyOverrides,
  proteinGPerKgForGoal,
  resolveTargets,
} from '../../src/domain/engine/targets.ts'
import { CLAMPS } from '../../src/domain/engine/clamps.ts'
import {
  DEFAULT_SECONDARY_TARGETS,
  mifflinStJeorBmr,
  formulaTdee,
  carbsFromRemainder,
  perOccasionProteinTarget,
} from '../../src/domain/nutrition/index.ts'
import type { Settings, TargetSet } from '../../src/domain/types.ts'

// The profile from the design document: 92.6 kg / 190.5 cm / age 43.
const PROFILE = {
  sex: 'male' as const,
  birthYear: 1983,
  heightCm: 190.5,
  activityLevel: 'moderate' as const,
}
const WEIGHT = 92.6
// Fixed clock so the age derivation is stable.
const NOW = new Date('2026-09-20T12:00:00').getTime()

function settings(over: Partial<Settings> = {}): Settings {
  return {
    id: 'settings',
    preset: 'fatLoss',
    overrides: [],
    secondary: { ...DEFAULT_SECONDARY_TARGETS },
    proteinGPerKg: 2.0,
    fatGPerKg: 0.8,
    occasionWindowMinutes: 90,
    barcodeLookupEnabled: true,
    ...over,
  }
}

describe('Mifflin-St Jeor', () => {
  it('produces a BMR near 1900 for the documented profile', () => {
    const bmr = mifflinStJeorBmr({
      weightKg: WEIGHT,
      heightCm: 190.5,
      age: 43,
      sex: 'male',
    })
    // 926 + 1190.625 - 215 + 5 = 1906.625
    expect(bmr).toBeCloseTo(1906.625, 3)
    expect(bmr).toBeGreaterThan(1850)
    expect(bmr).toBeLessThan(1950)
  })

  it('lands maintenance inside the documented 2900–3250 band', () => {
    // The document quotes a realistic maintenance band for this profile.
    const moderate = formulaTdee({ ...PROFILE, weightKg: WEIGHT, age: 43 })
    const active = formulaTdee({
      ...PROFILE,
      weightKg: WEIGHT,
      age: 43,
      activityLevel: 'active',
    })
    expect(moderate).toBeGreaterThan(2900)
    expect(active).toBeLessThan(3300)
  })

  it('applies the female offset', () => {
    const male = mifflinStJeorBmr({ weightKg: 70, heightCm: 170, age: 30, sex: 'male' })
    const female = mifflinStJeorBmr({
      weightKg: 70,
      heightCm: 170,
      age: 30,
      sex: 'female',
    })
    expect(male - female).toBe(166)
  })
})

describe('resolveTargets', () => {
  it('gives every field a source and a rationale', () => {
    const { targets } = resolveTargets({
      profile: PROFILE,
      weightKg: WEIGHT,
      settings: settings(),
      goalDirection: 'loss',
      now: NOW,
    })
    for (const [key, value] of Object.entries(targets) as [keyof TargetSet, TargetSet[keyof TargetSet]][]) {
      expect(value.source, `${key} source`).toBeTruthy()
      expect(value.rationale.length, `${key} rationale`).toBeGreaterThan(10)
      expect(Number.isFinite(value.value), `${key} value`).toBe(true)
    }
  })

  it('names the formula while it is still the source of maintenance', () => {
    const r = resolveTargets({
      profile: PROFILE,
      weightKg: WEIGHT,
      settings: settings(),
      now: NOW,
    })
    expect(r.maintenanceSource).toBe('formula')
    expect(r.targets.kcal.rationale).toMatch(/Mifflin-St Jeor/)
    expect(r.targets.kcal.rationale).toMatch(/starting hypothesis/)
  })

  it('abandons the formula once observed TDEE is sufficient', () => {
    const r = resolveTargets({
      profile: PROFILE,
      weightKg: WEIGHT,
      settings: settings({ preset: 'maintenance' }),
      observedTdee: {
        kcal: 3050,
        standardError: 180,
        sufficient: true,
        windowDays: 21,
      },
      now: NOW,
    })
    expect(r.maintenanceSource).toBe('observed')
    expect(r.maintenanceKcal).toBe(3050)
    expect(r.targets.kcal.rationale).toMatch(/no longer used/)
    expect(r.targets.kcal.rationale).not.toMatch(/Mifflin/)
  })

  it('ignores an insufficient observed estimate', () => {
    const r = resolveTargets({
      profile: PROFILE,
      weightKg: WEIGHT,
      settings: settings(),
      observedTdee: {
        kcal: 3050,
        standardError: 400,
        sufficient: false,
        windowDays: 21,
      },
      now: NOW,
    })
    expect(r.maintenanceSource).toBe('formula')
  })

  it('makes carbohydrate the remainder after protein and fat', () => {
    const { targets } = resolveTargets({
      profile: PROFILE,
      weightKg: WEIGHT,
      settings: settings(),
      goalDirection: 'loss',
      now: NOW,
    })
    const expected = carbsFromRemainder({
      kcal: targets.kcal.value,
      proteinG: targets.protein.value,
      fatG: targets.fat.value,
    })
    expect(targets.carbs.value).toBeCloseTo(expected, 4)
    expect(targets.carbs.rationale).toMatch(/remainder/)
  })

  it('holds protein and fat steady when only calories change', () => {
    const low = resolveTargets({
      profile: PROFILE,
      weightKg: WEIGHT,
      settings: settings({ preset: 'fatLoss' }),
      goalDirection: 'maintain',
      now: NOW,
    })
    const high = resolveTargets({
      profile: PROFILE,
      weightKg: WEIGHT,
      settings: settings({ preset: 'leanGain' }),
      goalDirection: 'maintain',
      now: NOW,
    })
    expect(high.targets.protein.value).toBeCloseTo(low.targets.protein.value, 6)
    expect(high.targets.fat.value).toBeCloseTo(low.targets.fat.value, 6)
    // The whole calorie difference lands on carbohydrate.
    const kcalDelta = high.targets.kcal.value - low.targets.kcal.value
    const carbDelta = high.targets.carbs.value - low.targets.carbs.value
    expect(carbDelta * 4).toBeCloseTo(kcalDelta, 4)
  })

  it('widens the protein band in a deficit', () => {
    expect(proteinGPerKgForGoal(1.6, 'maintain')).toBe(1.6)
    expect(proteinGPerKgForGoal(1.6, 'loss')).toBe(2.0)
    expect(proteinGPerKgForGoal(2.6, 'loss')).toBe(2.4)
  })

  it('lands protein and fat inside the documented bands at ~93 kg', () => {
    const { targets } = resolveTargets({
      profile: PROFILE,
      weightKg: WEIGHT,
      settings: settings(),
      goalDirection: 'loss',
      now: NOW,
    })
    // 150–205 g, up to 220 g cutting.
    expect(targets.protein.value).toBeGreaterThanOrEqual(150)
    expect(targets.protein.value).toBeLessThanOrEqual(225)
    // 75–110 g, never below 46 g.
    expect(targets.fat.value).toBeGreaterThanOrEqual(CLAMPS.minFatGPerKg * WEIGHT)
    expect(targets.fat.value).toBeLessThanOrEqual(115)
  })

  it('scales the preset energy delta rather than its absolute figure', () => {
    const light = resolveTargets({
      profile: PROFILE,
      weightKg: 60,
      settings: settings({ preset: 'fatLoss' }),
      now: NOW,
    })
    const heavy = resolveTargets({
      profile: PROFILE,
      weightKg: 110,
      settings: settings({ preset: 'fatLoss' }),
      now: NOW,
    })
    const delta = PRESETS.fatLoss.kcal - PRESETS.maintenance.kcal
    expect(light.targets.kcal.value).toBeCloseTo(light.maintenanceKcal + delta, 4)
    expect(heavy.targets.kcal.value).toBeCloseTo(heavy.maintenanceKcal + delta, 4)
    expect(heavy.targets.kcal.value).toBeGreaterThan(light.targets.kcal.value)
  })

  it('derives saturated fat and added sugar from the calorie target', () => {
    const { targets } = resolveTargets({
      profile: PROFILE,
      weightKg: WEIGHT,
      settings: settings(),
      now: NOW,
    })
    expect(targets.satFat.value).toBeCloseTo((targets.kcal.value * 0.1) / 9, 4)
    expect(targets.addedSugar.value).toBeCloseTo((targets.kcal.value * 0.1) / 4, 4)
  })

  it('ships the documented secondary defaults', () => {
    const { targets } = resolveTargets({
      profile: PROFILE,
      weightKg: WEIGHT,
      settings: settings(),
      now: NOW,
    })
    expect(targets.fibre.value).toBe(38)
    expect(targets.sodium.value).toBe(2300)
  })

  it('honours an edited secondary target', () => {
    const { targets } = resolveTargets({
      profile: PROFILE,
      weightKg: WEIGHT,
      settings: settings({
        secondary: { ...DEFAULT_SECONDARY_TARGETS, fibreG: 45, sodiumMg: 1500 },
      }),
      now: NOW,
    })
    expect(targets.fibre.value).toBe(45)
    expect(targets.sodium.value).toBe(1500)
  })

  it('applies the clamps last, after a user override', () => {
    const { targets } = resolveTargets({
      profile: PROFILE,
      weightKg: WEIGHT,
      settings: settings({
        overrides: [{ key: 'kcal', value: 1200, setAt: NOW }],
      }),
      now: NOW,
    })
    expect(targets.kcal.value).toBeGreaterThanOrEqual(CLAMPS.minKcal)
    expect(targets.kcal.source).toBe('clamped')
  })

  it('derives the percentage ceilings from the clamped calorie target', () => {
    // Regression: asking for 1200 kcal is held at the deficit floor, and the
    // saturated-fat ceiling must follow the figure the app will honour --
    // not the one it refused.
    const r = resolveTargets({
      profile: PROFILE,
      weightKg: WEIGHT,
      settings: settings({
        overrides: [{ key: 'kcal', value: 1200, setAt: NOW }],
      }),
      now: NOW,
    })
    const finalKcal = r.targets.kcal.value
    expect(finalKcal).toBeGreaterThan(2000)
    expect(r.targets.satFat.value).toBeCloseTo((finalKcal * 0.1) / 9, 4)
    expect(r.targets.addedSugar.value).toBeCloseTo((finalKcal * 0.1) / 4, 4)
    // And the rationale quotes the honoured figure, not the rejected one.
    expect(r.targets.satFat.rationale).toContain(String(Math.round(finalKcal)))
    expect(r.targets.satFat.rationale).not.toContain('1200')
  })

  it('leaves a hand-set ceiling alone after clamping', () => {
    const r = resolveTargets({
      profile: PROFILE,
      weightKg: WEIGHT,
      settings: settings({
        overrides: [
          { key: 'kcal', value: 1200, setAt: NOW },
          { key: 'satFat', value: 15, setAt: NOW },
        ],
      }),
      now: NOW,
    })
    expect(r.targets.satFat.value).toBe(15)
    expect(r.targets.satFat.source).toBe('user')
  })

  it('keeps the set internally coherent after a clamped override', () => {
    const r = resolveTargets({
      profile: PROFILE,
      weightKg: WEIGHT,
      settings: settings({
        overrides: [{ key: 'kcal', value: 1000, setAt: NOW }],
      }),
      now: NOW,
    })
    const { kcal, protein, fat, carbs } = r.targets
    const implied = protein.value * 4 + fat.value * 9 + carbs.value * 4
    expect(implied).toBeCloseTo(kcal.value, 4)
  })

  it('reports clamps so the UI can say a floor was reached', () => {
    const r = resolveTargets({
      profile: PROFILE,
      weightKg: WEIGHT,
      settings: settings({
        overrides: [
          { key: 'kcal', value: 1500, setAt: NOW },
          { key: 'fat', value: 20, setAt: NOW },
        ],
      }),
      now: NOW,
    })
    expect(r.clamped.length).toBeGreaterThan(0)
    expect(r.clamped.every((c) => c.reason.length > 10)).toBe(true)
  })
})

describe('applyOverrides', () => {
  const base = (): TargetSet =>
    ({
      kcal: { value: 2500, source: 'preset', rationale: 'x' },
      protein: { value: 190, source: 'preset', rationale: 'x' },
      fat: { value: 70, source: 'preset', rationale: 'x' },
      carbs: { value: 255, source: 'formula', rationale: 'x' },
      fibre: { value: 38, source: 'preset', rationale: 'x' },
      satFat: { value: 27.8, source: 'preset', rationale: 'x' },
      sodium: { value: 2300, source: 'preset', rationale: 'x' },
      addedSugar: { value: 62.5, source: 'preset', rationale: 'x' },
      alcohol: { value: 28, source: 'preset', rationale: 'x' },
    }) as TargetSet

  it('marks an edited field as set by the user, with a timestamp', () => {
    const out = applyOverrides(base(), [
      { key: 'protein', value: 210, setAt: NOW, note: 'training block' },
    ])
    expect(out.protein.value).toBe(210)
    expect(out.protein.source).toBe('user')
    expect(out.protein.updatedAt).toBe(NOW)
    expect(out.protein.rationale).toMatch(/training block/)
  })

  it('re-derives carbohydrate when calories are edited', () => {
    const out = applyOverrides(base(), [{ key: 'kcal', value: 3000, setAt: NOW }])
    expect(out.carbs.value).toBeCloseTo((3000 - 190 * 4 - 70 * 9) / 4, 4)
  })

  it('leaves carbohydrate alone when it was edited directly', () => {
    const out = applyOverrides(base(), [
      { key: 'kcal', value: 3000, setAt: NOW },
      { key: 'carbs', value: 300, setAt: NOW },
    ])
    expect(out.carbs.value).toBe(300)
    expect(out.carbs.source).toBe('user')
  })

  it('lets the later edit of a key win', () => {
    const out = applyOverrides(base(), [
      { key: 'protein', value: 200, setAt: NOW },
      { key: 'protein', value: 215, setAt: NOW + 1000 },
    ])
    expect(out.protein.value).toBe(215)
  })

  it('returns the base set untouched when there are no overrides', () => {
    const b = base()
    expect(applyOverrides(b, [])).toBe(b)
  })
})

describe('per-occasion protein target', () => {
  it('is the daily total over four, floored at 35 and ceilinged at 45', () => {
    expect(perOccasionProteinTarget(160)).toBe(40)
    expect(perOccasionProteinTarget(100)).toBe(35)
    expect(perOccasionProteinTarget(240)).toBe(45)
  })
})
