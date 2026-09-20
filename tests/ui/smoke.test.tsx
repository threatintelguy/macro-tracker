/**
 * @vitest-environment jsdom
 *
 * UI gets smoke tests only -- the risk in this app is wrong numbers, not
 * broken buttons. These check that the app boots, that onboarding leads to a
 * usable Today screen, and that the screen puts protein first with figures
 * that match the engine.
 */

import 'fake-indexeddb/auto'
import { render } from 'preact'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

// uPlot needs a real canvas, which jsdom does not provide. The chart is
// covered by the trend tests; here it is stubbed out.
vi.mock('../../src/ui/components/WeightChart.tsx', () => ({
  WeightChart: () => null,
  TrendSparkline: () => null,
}))

import { App } from '../../src/ui/App.tsx'
import { db, defaultSettings } from '../../src/data/db.ts'
import * as repo from '../../src/data/repositories.ts'
import * as store from '../../src/ui/store.ts'
import { curatedFoods } from '../../src/food/curated.ts'
import { makeNutrients } from '../../src/domain/nutrition/index.ts'
import { bandState } from '../../src/ui/components/common.tsx'
import { today } from '../../src/domain/dates.ts'

globalThis.ResizeObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
} as unknown as typeof ResizeObserver

let host: HTMLDivElement

async function tick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
}

/**
 * Wait for a condition rather than a fixed number of ticks. A tick count
 * that passes on an idle machine fails on a loaded one, and a flaky test is
 * worse than no test.
 */
async function until(
  predicate: () => boolean,
  label = 'condition',
  timeoutMs = 4000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`)
    await tick()
  }
  // Let the render that the condition triggered actually flush.
  await tick()
  await tick()
}

/** Render the app and wait until it has finished booting. */
async function boot(): Promise<void> {
  render(<App />, host)
  await until(() => store.ready.value, 'app boot')
}

/** Switch tab and wait for the new screen to render. */
async function goTo(next: store.Tab, marker: string): Promise<void> {
  store.setTab(next)
  await until(() => text().includes(marker), `${next} screen`)
}

function text(): string {
  return host.textContent ?? ''
}

beforeEach(async () => {
  await db.delete()
  await db.open()
  repo.invalidateAllRollups()
  await repo.saveSettings(defaultSettings())
  await repo.putFoods(curatedFoods())

  // Reset module state between renders.
  store.ready.value = false
  store.profile.value = undefined
  store.tab.value = 'today'
  store.entries.value = []
  store.composites.value = []
  store.usage.value = []
  store.weightReadings.value = []
  store.recentRollups.value = []

  host = document.createElement('div')
  document.body.appendChild(host)
})

afterEach(async () => {
  render(null, host)
  // Let any in-flight boot work settle before the next test closes the
  // database underneath it.
  await tick()
  await tick()
  host.remove()
})

describe('boot', () => {
  it('shows onboarding when there is no profile', async () => {
    await boot()
    expect(text()).toContain('Macro Tracker')
    expect(text()).toContain('calibration')
  })

  it('reaches the Today screen once a profile exists', async () => {
    await seedProfile()
    await boot()
    expect(text()).toContain('Today')
    // Three tabs, and no fourth.
    const tabs = host.querySelectorAll('.tabbar button')
    expect(tabs).toHaveLength(3)
    expect([...tabs].map((t) => t.textContent)).toEqual(['Today', 'Log', 'Settings'])
  })
})

describe('Today', () => {
  it('shows protein against target, with the 7-day average', async () => {
    await seedProfile()
    await seedDayWithFood()
    await boot()

    expect(text()).toContain('Protein')
    expect(text()).toContain('Calories')
    expect(text()).toContain('7-day average')

    // Protein appears before calories in the document order.
    const body = text()
    expect(body.indexOf('Protein')).toBeLessThan(body.indexOf('Calories'))
  })

  it('renders the logged entry and its occasion', async () => {
    await seedProfile()
    await seedDayWithFood()
    await boot()
    expect(text()).toContain('Oats, rolled, dry')
    expect(text()).toContain("Today's occasions")
  })

  it('shows the calibration countdown rather than a streak', async () => {
    await seedProfile()
    await boot()
    expect(text()).toMatch(/Day \d+/)
    expect(text()).toContain('of 24')
    expect(text().toLowerCase()).not.toContain('streak')
  })

  it('shows the weight trend, not today’s reading, as the headline', async () => {
    await seedProfile()
    await boot()
    expect(text()).toContain('Weight trend')
  })
})

describe('Log', () => {
  it('lands on the composite list', async () => {
    await seedProfile()
    await seedComposite()
    await boot()
    await goTo('log', 'Your meals')

    expect(text()).toContain('Your meals')
    expect(text()).toContain('Lincoln salad')
    // The weighing flow is one tap from here.
    expect(text()).toContain('Weigh and log')
  })

  it('explains the empty library rather than leaving a blank panel', async () => {
    await seedProfile()
    await boot()
    await goTo('log', 'Your meals')
    expect(text()).toContain('save this meal as a composite')
  })
})

describe('Settings', () => {
  it('lists every target with its provenance', async () => {
    await seedProfile()
    await boot()
    await goTo('settings', 'Targets')

    const body = text()
    for (const label of [
      'Calories',
      'Protein',
      'Fat',
      'Carbs',
      'Fibre',
      'Saturated fat',
      'Sodium',
    ]) {
      expect(body, label).toContain(label)
    }
    expect(body).toContain('Maintenance')
    expect(body).toContain('Composite library')
  })

  it('states the network posture plainly', async () => {
    await seedProfile()
    await boot()
    await goTo('settings', 'Privacy')
    expect(text()).toContain('one outbound call')
    expect(text()).toContain('no analytics')
  })

  it('warns that the app holds the only copy', async () => {
    await seedProfile()
    await boot()
    await goTo('settings', 'Storage')
    expect(text()).toContain('No backup yet')
  })
})

describe('guardrails are absent by construction', () => {
  it('uses none of the banned words anywhere on screen', async () => {
    await seedProfile()
    await seedDayWithFood()
    await seedComposite()
    await boot()

    let body = text()
    await goTo('log', 'Your meals')
    body += text()
    await goTo('settings', 'Targets')
    body += text()

    const banned = ['streak', 'cheat', 'burn off', 'earn back']
    for (const word of banned) {
      expect(body.toLowerCase(), word).not.toContain(word)
    }
  })
})

describe('band state', () => {
  it('reads distance from a band, never pass or fail', () => {
    expect(bandState(100, 100, false)).toBe('in')
    expect(bandState(95, 100, false)).toBe('in')
    expect(bandState(80, 100, false)).toBe('near')
    expect(bandState(50, 100, false)).toBe('beyond')
    expect(bandState(120, 100, false)).toBe('near')
  })

  it('treats a ceiling as satisfied when under it', () => {
    expect(bandState(20, 28, true)).toBe('in')
    expect(bandState(28, 28, true)).toBe('in')
    expect(bandState(32, 28, true)).toBe('near')
    expect(bandState(60, 28, true)).toBe('beyond')
  })
})

// --- Seeds ----------------------------------------------------------------

async function seedProfile(): Promise<void> {
  const start = today()
  await repo.saveProfile({
    id: 'profile',
    sex: 'male',
    birthYear: 1983,
    heightCm: 180.0,
    activityLevel: 'moderate',
    startDate: start,
    phase: 'calibration',
    phaseStartDate: start,
    precisionMode: 'weighed',
    units: 'metric',
    offlineMode: false,
    theme: 'dark',
  })
  await repo.ensureDay(start, 'calibration', 'weighed')
  await repo.setWeight(start, 85.0)
}

async function seedDayWithFood(): Promise<void> {
  await repo.addEntry({
    date: today(),
    at: '08:00',
    source: { kind: 'food', foodId: 'c_oats_dry', name: 'Oats, rolled, dry' },
    grams: 80,
    nutrients: makeNutrients({ kcal: 303, protein: 10.6, carbs: 54.2, fat: 5.2 }),
    fidelity: 'weighed',
  })
}

async function seedComposite(): Promise<void> {
  await repo.putComposite({
    id: 'c_salad',
    name: 'Lincoln salad',
    version: 1,
    components: [
      {
        kind: 'food',
        ref: { kind: 'food', foodId: 'c_spinach_raw', name: 'Spinach, raw' },
        grams: 100,
      },
      {
        kind: 'food',
        ref: {
          kind: 'food',
          foodId: 'c_salmon_cooked',
          name: 'Salmon, Atlantic, cooked',
        },
        grams: 150,
      },
    ],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
}
