/**
 * Onboarding.
 *
 * The profile is data, not code -- it is entered here and lives in
 * IndexedDB, never in the codebase. That is what lets the repo be public
 * and removes the private-repo question entirely.
 */

import { useState } from 'preact/hooks'
import type { ActivityLevel, Sex } from '../../domain/types.ts'
import * as repo from '../../data/repositories.ts'
import * as store from '../store.ts'
import {
  ACTIVITY_LABELS,
  ACTIVITY_MULTIPLIERS,
} from '../../domain/nutrition/index.ts'
import { CALIBRATION_DAYS } from '../../domain/phase/index.ts'
import { addDays, today } from '../../domain/dates.ts'
import { capabilities } from '../../platform/index.ts'
import { fmt } from '../components/common.tsx'

export function Onboarding() {
  const [step, setStep] = useState(0)
  const [sex, setSex] = useState<Sex>('male')
  const [birthYear, setBirthYear] = useState('')
  const [heightCm, setHeightCm] = useState('')
  const [weightKg, setWeightKg] = useState('')
  const [activityLevel, setActivityLevel] = useState<ActivityLevel>('moderate')

  const profileValid =
    Number(birthYear) > 1900 && Number(heightCm) > 50 && Number(weightKg) > 20

  async function finish(): Promise<void> {
    const start = today()
    await repo.saveProfile({
      id: 'profile',
      sex,
      birthYear: Number(birthYear),
      heightCm: Number(heightCm),
      activityLevel,
      startDate: start,
      // Calibration is where the composite library gets built, so it is the
      // phase a fresh install starts in.
      phase: 'calibration',
      phaseStartDate: start,
      phaseEndDate: addDays(start, CALIBRATION_DAYS - 1),
      precisionMode: 'weighed',
      units: 'metric',
      offlineMode: false,
      theme: 'dark',
    })
    await repo.ensureDay(start, 'calibration', 'weighed')
    await repo.setWeight(start, Number(weightKg))
    // Installed PWAs are generally granted persistence, which exempts the
    // origin from routine eviction.
    void capabilities.requestPersistentStorage()
    await store.refreshAll()
  }

  return (
    <div class="screen" style="padding-top:28px">
      {step === 0 && (
        <>
          <h1 style="font-size:1.6rem">Macro Tracker</h1>
          <p class="muted">
            It logs food, computes energy and macronutrient totals, tracks body
            weight, and shows how both move over time. Nothing else.
          </p>
          <div class="card">
            <div class="card-title">How this works</div>
            <p style="margin:0 0 10px">
              The first {CALIBRATION_DAYS} days are <strong>calibration</strong>
              : everything weighed to the gram. That does two jobs — it
              establishes what you actually eat, and it builds a library of
              weighed meals you can log in one tap for years afterwards.
            </p>
            <p class="muted" style="margin:0">
              The weighing is an investment, not a tax. After it, a day of
              logging is about thirty seconds.
            </p>
          </div>
          <div class="card">
            <div class="card-title">Where your data lives</div>
            <p class="muted" style="margin:0">
              On this device, in this browser. No account, no server, no cloud
              sync. That removes every cloud risk and introduces one: this app
              holds the only copy, so back it up. The app will keep reminding
              you.
            </p>
          </div>
          <button class="btn btn-primary btn-wide" onClick={() => setStep(1)}>
            Start
          </button>
        </>
      )}

      {step === 1 && (
        <>
          <h1>About you</h1>
          <p class="muted" style="margin-top:-6px">
            Used for the starting formula only. After three weeks of real data
            the app measures your expenditure and stops using the equation.
          </p>

          <div class="chip-row">
            {(['male', 'female'] as Sex[]).map((s) => (
              <button
                key={s}
                class="chip"
                aria-pressed={sex === s}
                onClick={() => setSex(s)}
              >
                {s === 'male' ? 'Male' : 'Female'}
              </button>
            ))}
          </div>

          <div class="field-row">
            <label>
              Birth year
              <input
                type="number"
                inputMode="numeric"
                placeholder="1983"
                value={birthYear}
                onInput={(e) => setBirthYear((e.target as HTMLInputElement).value)}
              />
            </label>
            <label>
              Height (cm)
              <input
                type="number"
                inputMode="decimal"
                placeholder="180.0"
                value={heightCm}
                onInput={(e) => setHeightCm((e.target as HTMLInputElement).value)}
              />
            </label>
          </div>

          <label>
            Weight today (kg)
            <input
              type="number"
              inputMode="decimal"
              step="0.1"
              placeholder="85.0"
              value={weightKg}
              onInput={(e) => setWeightKg((e.target as HTMLInputElement).value)}
            />
          </label>

          <label>
            Activity
            <select
              value={activityLevel}
              onChange={(e) =>
                setActivityLevel(
                  (e.target as HTMLSelectElement).value as ActivityLevel,
                )
              }
            >
              {(Object.keys(ACTIVITY_MULTIPLIERS) as ActivityLevel[]).map((a) => (
                <option key={a} value={a}>
                  {ACTIVITY_LABELS[a]}
                </option>
              ))}
            </select>
          </label>

          {profileValid && (
            <div class="faint">
              Starting maintenance estimate will be near{' '}
              {fmt(
                (10 * Number(weightKg) +
                  6.25 * Number(heightCm) -
                  5 * (new Date().getFullYear() - Number(birthYear)) +
                  (sex === 'male' ? 5 : -161)) *
                  ACTIVITY_MULTIPLIERS[activityLevel],
              )}{' '}
              kcal. Mifflin-St Jeor is ±10% in individuals, which is exactly why
              it gets replaced.
            </div>
          )}

          <button
            class="btn btn-primary btn-wide"
            disabled={!profileValid}
            onClick={() => void finish()}
          >
            Begin calibration
          </button>
        </>
      )}
    </div>
  )
}
