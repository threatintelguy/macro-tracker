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
vi.mock('../../src/ui/components/TimeChart.tsx', () => ({
  TimeChart: () => null,
}))

import { App } from '../../src/ui/App.tsx'
import { db, defaultSettings } from '../../src/data/db.ts'
import * as repo from '../../src/data/repositories.ts'
import * as store from '../../src/ui/store.ts'
import { curatedFoods } from '../../src/food/curated.ts'
import { makeNutrients } from '../../src/domain/nutrition/index.ts'
import { bandState } from '../../src/ui/components/common.tsx'
import { addDays, today } from '../../src/domain/dates.ts'

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
  store.selectedDate.value = today()
  // The shell reads the tab from the hash on mount; do not inherit one.
  location.hash = ''
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
    // Four tabs -- Trends is the parent document's own screen -- and no fifth.
    const tabs = host.querySelectorAll('.tabbar button')
    expect(tabs).toHaveLength(4)
    expect([...tabs].map((t) => t.textContent)).toEqual(['Today', 'Log', 'Trends', 'Settings'])
  })
})

describe('Today', () => {
  it("shows today's protein against target, with the 7-day average as a quiet second line", async () => {
    await seedProfile()
    await seedDayWithFood()
    await boot()

    expect(text()).toContain('Protein')
    expect(text()).toContain('Calories')
    expect(text()).toContain('g today ·')
    expect(text()).toContain('g avg')

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
    expect(text()).toContain('Every outbound call is on an explicit tap')
    expect(text()).toContain('no analytics')
    expect(text()).toContain('Offline mode turns every one of these off')
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

// --- Addendum 1 -------------------------------------------------------------

function button(label: string): HTMLButtonElement {
  const b = [...host.querySelectorAll('button')].find(
    (x) => x.textContent?.trim() === label || x.getAttribute('aria-label') === label,
  )
  if (!b) throw new Error(`No button "${label}"`)
  return b as HTMLButtonElement
}

describe('day navigation', () => {
  it('disables forward on today and pages back to a past day', async () => {
    await seedProfile()
    await repo.addEntry({
      date: addDays(today(), -2),
      at: '08:00',
      source: { kind: 'food', foodId: 'c_oats_dry', name: 'Oats, rolled, dry' },
      grams: 80,
      nutrients: makeNutrients({ kcal: 303, protein: 10.6 }),
      fidelity: 'weighed',
    })
    await boot()
    expect(button('Next day').disabled).toBe(true)
    expect(button('Previous day').disabled).toBe(false)

    button('Previous day').click()
    await until(() => store.selectedDate.value === addDays(today(), -1), 'step back')
    // A jump-to-today control appears whenever the view is off today.
    expect(text()).toContain('Today')
    expect(button('Next day').disabled).toBe(false)

    button('Previous day').click()
    await until(() => text().includes('Oats, rolled, dry'), 'past day entries')
    // Edit sits beside Delete on the entry.
    expect(button('Edit')).toBeTruthy()
    expect(button('Delete')).toBeTruthy()
    // The back limit is the earliest record.
    expect(button('Previous day').disabled).toBe(true)

    // Viewing a past day never created a record for the empty day between.
    expect(await repo.getDay(addDays(today(), -1))).toBeUndefined()

    button('Today').click()
    await until(() => store.selectedDate.value === today(), 'back to today')
  })

  it('shows the note field on the day', async () => {
    await seedProfile()
    await boot()
    expect(text()).toContain('Add a note about this day')
  })
})

describe('logging foods not in the database', () => {
  it('offers the four routes in order when search finds nothing', async () => {
    await seedProfile()
    await boot()
    await goTo('log', 'Search a single food')
    const input = host.querySelector('input[placeholder="Search foods"]') as HTMLInputElement
    input.value = 'zzqqxx nothing like this'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await until(() => text().includes('Four ways to log it anyway'), 'routes')
    const body = text()
    const order = [
      'Build it from ingredients',
      'Start from something close',
      'Enter only what you know',
      'Log a stand-in',
    ].map((t) => body.indexOf(t))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('offers "close, but not quite" beside each search result', async () => {
    await seedProfile()
    await boot()
    await goTo('log', 'Search a single food')
    const input = host.querySelector('input[placeholder="Search foods"]') as HTMLInputElement
    input.value = 'oats'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await until(() => text().includes('Close, but not quite'), 'clone action')
  })

  it('shows the needs-detail count quietly, without a badge', async () => {
    await seedProfile()
    await repo.addEntry({
      date: today(),
      source: { kind: 'food', foodId: 'x', name: 'Menu item' },
      grams: 300,
      nutrients: makeNutrients({ kcal: 640, protein: null }),
      fidelity: 'estimated',
    })
    await boot()
    await goTo('log', 'Search a single food')
    expect(text()).toContain('1 need detail')
    expect(host.querySelector('.quiet-count')).toBeTruthy()
    expect(host.querySelector('[data-tone="attention"].quiet-count')).toBeNull()
  })

  it('shows an incomplete protein total as a floor with coverage', async () => {
    await seedProfile()
    await seedDayWithFood()
    await repo.addEntry({
      date: today(),
      at: '12:00',
      source: { kind: 'food', foodId: 'x', name: 'Menu item' },
      grams: 300,
      nutrients: makeNutrients({ kcal: 640, protein: null }),
      fidelity: 'estimated',
    })
    await boot()
    expect(text()).toContain('at least 11 g')
    expect(text()).toContain('1 of 2 entries')
    expect(host.querySelector('.band-fill[data-state="unknown"]')).toBeTruthy()
  })
})

describe('Trends', () => {
  it('holds the analytics, adherence, adjustment history and note search', async () => {
    await seedProfile()
    await boot()
    await goTo('trends', 'Weight and expenditure')
    const body = text()
    expect(body).toContain('Calories')
    expect(body).toContain('Protein')
    expect(body).toContain('Adherence')
    expect(body).toContain('Why targets changed')
    expect(body).toContain('Search notes')
  })
})

describe('Settings: import beside export', () => {
  it('pairs Export with Import and states the CSV limits before a file is chosen', async () => {
    await seedProfile()
    await boot()
    await goTo('settings', 'Your data')
    expect(button('Export')).toBeTruthy()
    button('Import').click()
    await until(() => text().includes('CSV brings in day and entry rows only'), 'import sheet')
    expect(text()).toContain('not to move to a new phone')
    // No merge mode is offered, let alone preselected, before a file is read.
    expect(host.querySelector('[role="radio"][aria-checked="true"]')).toBeNull()
  })

  it('shows the precision mode switcher and the library sort', async () => {
    await seedProfile()
    await seedComposite()
    await boot()
    await goTo('settings', 'Phase and precision')
    expect(text()).toContain('Precision mode')
    expect(text()).toContain('Most used')
    expect(text()).toContain('Not used lately')
  })
})

// --- Addendum 2 -------------------------------------------------------------

describe('Today: today shows today, and the add control is in reach', () => {
  it('puts the add control between the calibration widget and protein', async () => {
    await seedProfile()
    await seedDayWithFood()
    await boot()
    const body = text()
    const calibration = body.indexOf('Calibration')
    const add = body.indexOf('Weigh and log')
    const protein = body.indexOf('Protein')
    expect(calibration).toBeGreaterThanOrEqual(0)
    expect(calibration).toBeLessThan(add)
    expect(add).toBeLessThan(protein)
  })

  it('keeps a floating add button, unless switched off', async () => {
    await seedProfile()
    await boot()
    expect(host.querySelector('.fab')).not.toBeNull()
    render(null, host)
    await repo.saveSettings({ ...defaultSettings(), floatingAdd: false })
    store.ready.value = false
    await boot()
    expect(host.querySelector('.fab')).toBeNull()
  })

  it("shows today's figures for fibre and saturated fat, with the average beneath", async () => {
    await seedProfile()
    await seedDayWithFood()
    await boot()
    expect(text()).not.toContain('7-day averages')
    expect(text()).toContain('Fibre')
    expect(text()).toContain('g avg')
  })

  it('shows body weight in both units, preferred first', async () => {
    await seedProfile()
    await boot()
    // 85 kg with the default pound preference.
    expect(text()).toContain('187.4 lb (85.0 kg)')
  })

  it('never colours an intake band red and never says over or under', async () => {
    await seedProfile()
    await seedDayWithFood()
    await boot()
    const body = text().toLowerCase()
    for (const word of [' over ', ' under ', 'blown', 'missed', 'exceeded']) {
      expect(body).not.toContain(word)
    }
    for (const el of host.querySelectorAll('.band-fill')) {
      expect((el as HTMLElement).style.background).not.toMatch(/red|#f00|rgb\(255, 0, 0\)/)
    }
  })
})

describe('no model, no network: still works', () => {
  it('hides online search in offline mode and keeps the manual routes', async () => {
    await seedProfile()
    const p = await repo.getProfile()
    await repo.saveProfile({ ...p!, offlineMode: true })
    await boot()
    await goTo('log', 'Search a single food')
    const input = host.querySelector('input[placeholder="Search foods"]') as HTMLInputElement
    input.value = 'zzqqxx nothing like this'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await until(() => text().includes('Four ways to log it anyway'), 'routes')
    expect(text()).not.toContain('Search online for')
    expect(text()).toContain('Offline mode is on')
  })

  it('offers the manual routes from Estimate when no model is set up', async () => {
    await seedProfile()
    await boot()
    await goTo('log', 'Estimate a meal')
    button('Estimate a meal').click()
    await until(() => text().includes('No model is set up'), 'estimate sheet')
    expect(text()).toContain('Build it from ingredients')
    expect(text()).toContain('Enter only what you know')
    // No photo capture without an external endpoint: absent, not failing.
    expect(text()).not.toContain('Add a photo')
  })

  it('offers online search only on a tap, after local results', async () => {
    await seedProfile()
    await boot()
    await goTo('log', 'Search a single food')
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const input = host.querySelector('input[placeholder="Search foods"]') as HTMLInputElement
    input.value = 'oats'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await until(() => text().includes('Search online for'), 'online search offer')
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})
