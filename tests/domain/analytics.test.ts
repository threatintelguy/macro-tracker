import { describe, expect, it } from 'vitest'
import {
  adherencePct,
  bucketOccasions,
  buildSeries,
  dayConfidence,
  meanIntakeKcal,
  occasionsClearingProtein,
  rollingMean,
  rollupDay,
} from '../../src/domain/analytics/index.ts'
import type { DayRecord, Entry, Fidelity } from '../../src/domain/types.ts'
import { makeNutrients } from '../../src/domain/nutrition/index.ts'
import {
  addDays,
  dateRange,
  daysBetween,
  formatDisplayDate,
  isLocalDate,
  minutesOfDay,
  startOfWeek,
} from '../../src/domain/dates.ts'
import { calibrationProgress } from '../../src/domain/phase/index.ts'

let seq = 0
function entry(over: Partial<Entry> = {}): Entry {
  seq++
  return {
    id: `e${seq}`,
    date: '2026-09-20',
    source: { kind: 'food', foodId: 'f', name: 'Food' },
    grams: 100,
    nutrients: makeNutrients({ kcal: 100, protein: 10 }),
    fidelity: 'weighed',
    createdAt: seq,
    ...over,
  }
}

function day(over: Partial<DayRecord> = {}): DayRecord {
  return {
    date: '2026-09-20',
    phase: 'calibration',
    precisionMode: 'weighed',
    entries: [],
    training: [],
    ...over,
  }
}

describe('occasion bucketing', () => {
  it('groups entries inside the window into one occasion', () => {
    const occ = bucketOccasions([
      entry({ at: '08:00' }),
      entry({ at: '08:20' }),
      entry({ at: '09:15' }),
    ])
    expect(occ).toHaveLength(1)
    expect(occ[0]!.entryIds).toHaveLength(3)
    expect(occ[0]!.startsAt).toBe('08:00')
  })

  it('splits when the gap exceeds the window', () => {
    const occ = bucketOccasions([
      entry({ at: '08:00' }),
      entry({ at: '12:30' }),
      entry({ at: '19:00' }),
    ])
    expect(occ).toHaveLength(3)
  })

  it('anchors to the bucket start so a long graze does not chain', () => {
    // 08:00, 09:20, 10:40 — each 80 min from the last, but 160 from the
    // first, so this is two occasions rather than one continuous one.
    const occ = bucketOccasions([
      entry({ at: '08:00' }),
      entry({ at: '09:20' }),
      entry({ at: '10:40' }),
    ])
    expect(occ).toHaveLength(2)
  })

  it('honours the configured window', () => {
    const entries = [entry({ at: '08:00' }), entry({ at: '10:00' })]
    expect(bucketOccasions(entries, 90)).toHaveLength(2)
    expect(bucketOccasions(entries, 180)).toHaveLength(1)
  })

  it('keeps a manual occasion assignment', () => {
    const occ = bucketOccasions([
      entry({ at: '08:00', occasion: 'breakfast' }),
      entry({ at: '19:00', occasion: 'breakfast' }),
    ])
    expect(occ).toHaveLength(1)
    expect(occ[0]!.id).toBe('breakfast')
  })

  it('sums protein per occasion', () => {
    const occ = bucketOccasions([
      entry({ at: '08:00', nutrients: makeNutrients({ protein: 25 }) }),
      entry({ at: '08:10', nutrients: makeNutrients({ protein: 20 }) }),
    ])
    expect(occ[0]!.proteinG).toBe(45)
  })

  it('returns nothing for no entries', () => {
    expect(bucketOccasions([])).toEqual([])
  })
})

describe('rollupDay', () => {
  it('sums the day and buckets its occasions', () => {
    const entries = [
      entry({ at: '08:00', nutrients: makeNutrients({ kcal: 500, protein: 40 }) }),
      entry({ at: '13:00', nutrients: makeNutrients({ kcal: 700, protein: 45 }) }),
    ]
    const r = rollupDay({ day: day({ entries: entries.map((e) => e.id) }), entries })
    expect(r.totals.kcal.value).toBe(1200)
    expect(r.totals.protein.value).toBe(85)
    expect(r.occasions).toHaveLength(2)
    expect(r.confidence).toBe('logged')
  })

  it('marks a day containing an estimate as partial', () => {
    const entries = [entry(), entry({ fidelity: 'estimated' })]
    const r = rollupDay({ day: day(), entries })
    expect(r.confidence).toBe('partial')
  })

  it('marks an unlogged day empty', () => {
    expect(rollupDay({ day: day(), entries: [] }).confidence).toBe('empty')
  })

  it('handles a minimal-mode day with protein entered directly', () => {
    const r = rollupDay({
      day: day({ precisionMode: 'minimal', proteinOverride: 165, satFatFlag: 'low' }),
      entries: [],
    })
    expect(r.confidence).toBe('minimal')
    expect(r.totals.protein.value).toBe(165)
    // Unknown, not zero: a minimal day records protein only.
    expect(r.totals.kcal.complete).toBe(false)
    expect(r.totals.kcal.knownEntries).toBe(0)
    expect(r.satFatFlag).toBe('low')
  })

  it('keeps a weighed meal at full fidelity inside a minimal-mode day', () => {
    // Precision is per entry; the mode is a default rather than a ceiling.
    const entries = [entry({ fidelity: 'weighed' })]
    const r = rollupDay({ day: day({ precisionMode: 'minimal' }), entries })
    expect(r.confidence).toBe('logged')
    expect(r.fidelities).toEqual(['weighed'])
  })

  it('carries the weight reading through', () => {
    const r = rollupDay({ day: day({ weightKg: { value: 85.4 } }), entries: [] })
    expect(r.weightKg).toBe(85.4)
  })
})

describe('dayConfidence', () => {
  const cases: [Fidelity[], string][] = [
    [['weighed', 'weighed'], 'logged'],
    [['weighed', 'portioned'], 'logged'],
    [['weighed', 'estimated'], 'partial'],
    [['flagged'], 'partial'],
  ]
  for (const [fidelities, expected] of cases) {
    it(`is ${expected} for ${fidelities.join(' + ')}`, () => {
      const entries = fidelities.map((f) => entry({ fidelity: f }))
      expect(dayConfidence(day(), entries)).toBe(expected)
    })
  }
})

describe('rolling averages', () => {
  it('averages over the trailing window', () => {
    const s = [10, 20, 30, 40, 50].map((value, i) => ({
      date: addDays('2026-09-01', i),
      value,
    }))
    const out = rollingMean(s, 3)
    expect(out[0]!.value).toBe(10)
    expect(out[2]!.value).toBe(20)
    expect(out[4]!.value).toBe(40)
  })

  it('skips gaps rather than treating them as zero', () => {
    const s = [
      { date: '2026-09-01', value: 10 },
      { date: '2026-09-02', value: undefined },
      { date: '2026-09-03', value: 30 },
    ]
    expect(rollingMean(s, 3)[2]!.value).toBe(20)
  })

  it('returns undefined when the whole window is empty', () => {
    const s = [{ date: '2026-09-01', value: undefined }]
    expect(rollingMean(s, 7)[0]!.value).toBeUndefined()
  })
})

describe('buildSeries', () => {
  it('produces a dense series with gaps as undefined', () => {
    const rollups = [
      rollupDay({
        day: day({ date: '2026-09-01' }),
        entries: [entry({ date: '2026-09-01' })],
      }),
      rollupDay({
        day: day({ date: '2026-09-03' }),
        entries: [entry({ date: '2026-09-03' })],
      }),
    ]
    const s = buildSeries(rollups, '2026-09-01', '2026-09-03')
    expect(s.dates).toEqual(['2026-09-01', '2026-09-02', '2026-09-03'])
    expect(s.values.kcal[1]).toBeUndefined()
    expect(s.confidence[1]).toBe('empty')
  })
})

describe('protein distribution', () => {
  it('counts occasions clearing the threshold rather than averaging', () => {
    // Three light meals plus one enormous one: the average conceals it.
    const entries = [
      entry({ at: '08:00', nutrients: makeNutrients({ protein: 10 }) }),
      entry({ at: '12:00', nutrients: makeNutrients({ protein: 12 }) }),
      entry({ at: '16:00', nutrients: makeNutrients({ protein: 8 }) }),
      entry({ at: '20:00', nutrients: makeNutrients({ protein: 150 }) }),
    ]
    const r = rollupDay({ day: day(), entries })
    const { clearing, total, threshold } = occasionsClearingProtein(r, 85.0)
    // 0.4 g/kg is the per-occasion sufficiency threshold.
    expect(threshold).toBeCloseTo(0.4 * 85.0, 6)
    expect(total).toBe(4)
    expect(clearing).toBe(1)
    // The daily total looks fine; the distribution does not.
    expect(r.totals.protein.value).toBe(180)
  })

  it('counts an even distribution as four clearing', () => {
    const entries = [8, 12, 16, 20].map((h) =>
      entry({
        at: `${String(h).padStart(2, '0')}:00`,
        nutrients: makeNutrients({ protein: 45 }),
      }),
    )
    const r = rollupDay({ day: day(), entries })
    expect(occasionsClearingProtein(r, 85.0).clearing).toBe(4)
  })
})

describe('adherence', () => {
  it('counts only fully logged days', () => {
    const rollups = [
      rollupDay({ day: day({ date: '2026-09-01' }), entries: [entry()] }),
      rollupDay({
        day: day({ date: '2026-09-02' }),
        entries: [entry({ fidelity: 'estimated' })],
      }),
      rollupDay({ day: day({ date: '2026-09-03' }), entries: [] }),
    ]
    expect(adherencePct(rollups, 3)).toBeCloseTo(33.33, 1)
  })

  it('is zero over an empty range', () => {
    expect(adherencePct([], 0)).toBe(0)
  })

  it('excludes estimated days from mean intake', () => {
    const rollups = [
      rollupDay({
        day: day({ date: '2026-09-01' }),
        entries: [entry({ nutrients: makeNutrients({ kcal: 2000 }) })],
      }),
      rollupDay({
        day: day({ date: '2026-09-02' }),
        entries: [
          entry({ fidelity: 'estimated', nutrients: makeNutrients({ kcal: 9000 }) }),
        ],
      }),
    ]
    // Guessed intake would corrupt the one calculation that depends on
    // intake accuracy, so it is not averaged in.
    expect(meanIntakeKcal(rollups)).toBe(2000)
  })

  it('returns undefined when nothing is fully logged', () => {
    const rollups = [rollupDay({ day: day(), entries: [] })]
    expect(meanIntakeKcal(rollups)).toBeUndefined()
  })
})

describe('local dates', () => {
  it('validates the format and the calendar', () => {
    expect(isLocalDate('2026-09-20')).toBe(true)
    expect(isLocalDate('2026-02-30')).toBe(false)
    expect(isLocalDate('2026-13-01')).toBe(false)
    expect(isLocalDate('20260920')).toBe(false)
  })

  it('adds days across a month boundary', () => {
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01')
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31')
  })

  it('handles a leap day', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2)
  })

  it('counts days between dates', () => {
    expect(daysBetween('2026-09-01', '2026-09-24')).toBe(23)
    expect(daysBetween('2026-09-24', '2026-09-01')).toBe(-23)
  })

  it('builds an inclusive range', () => {
    expect(dateRange('2026-09-01', '2026-09-03')).toEqual([
      '2026-09-01',
      '2026-09-02',
      '2026-09-03',
    ])
    expect(dateRange('2026-09-03', '2026-09-01')).toEqual([])
  })

  it('starts the week on Monday', () => {
    // 2026-09-20 is a Sunday.
    expect(startOfWeek('2026-09-20')).toBe('2026-09-14')
    expect(startOfWeek('2026-09-14')).toBe('2026-09-14')
  })

  it('reads minutes from an HH:MM string', () => {
    expect(minutesOfDay('08:30')).toBe(510)
    expect(minutesOfDay('00:00')).toBe(0)
  })

  it('labels today and yesterday', () => {
    const now = new Date(2026, 8, 20, 12)
    expect(formatDisplayDate('2026-09-20', now)).toBe('Today')
    expect(formatDisplayDate('2026-09-19', now)).toBe('Yesterday')
  })
})

describe('calibration progress', () => {
  const NOW = new Date(2026, 8, 20, 12)

  it('reads as a countdown, with both day count and library coverage', () => {
    const rollups = Array.from({ length: 9 }, (_, i) =>
      rollupDay({
        day: day({ date: addDays('2026-09-12', i) }),
        entries: [entry({ date: addDays('2026-09-12', i) })],
      }),
    )
    const p = calibrationProgress({
      phase: 'calibration',
      phaseStartDate: '2026-09-12',
      rollups,
      compositesBuilt: 6,
      occasionsFromComposites: 12,
      totalOccasions: 30,
      now: NOW,
    })
    expect(p.dayNumber).toBe(9)
    expect(p.totalDays).toBe(24)
    expect(p.endDate).toBe('2026-10-05')
    expect(p.daysRemaining).toBe(15)
    expect(p.compositesBuilt).toBe(6)
    expect(p.libraryCoveragePct).toBe(40)
  })

  it('resumes the countdown after a missed day rather than resetting', () => {
    // Day 5 was not logged. The countdown still reads day 9 of 24.
    const dates = ['2026-09-12', '2026-09-13', '2026-09-14', '2026-09-15']
    const rollups = dates.map((d) =>
      rollupDay({ day: day({ date: d }), entries: [entry({ date: d })] }),
    )
    const p = calibrationProgress({
      phase: 'calibration',
      phaseStartDate: '2026-09-12',
      rollups,
      compositesBuilt: 2,
      occasionsFromComposites: 0,
      totalOccasions: 0,
      now: NOW,
    })
    expect(p.dayNumber).toBe(9)
    expect(p.daysLogged).toBe(4)
    expect(p.coveragePct).toBeCloseTo((4 / 9) * 100, 4)
  })

  it('clamps the day number to the phase length', () => {
    const p = calibrationProgress({
      phase: 'calibration',
      phaseStartDate: '2026-01-01',
      rollups: [],
      compositesBuilt: 0,
      occasionsFromComposites: 0,
      totalOccasions: 0,
      now: NOW,
    })
    expect(p.dayNumber).toBe(24)
    expect(p.daysRemaining).toBe(0)
  })
})
