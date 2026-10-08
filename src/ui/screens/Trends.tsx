/**
 * Trends.
 *
 * Steady state logs so little that the value has to come from what the app
 * does with the history. This screen holds:
 *
 *   - Weight and expenditure: the smoothed trend with raw readings as faint
 *     dots, measured expenditure, intake behind, adjustment markers.
 *   - Intake: calories and protein by day, with days carrying unknown
 *     values drawn fainter -- included, but visibly not whole.
 *   - Adherence over the current window, which is what the 70% threshold
 *     reads, and the adjustment history with every decision explained.
 *   - Note search: a plain substring match over the day notes.
 *
 * Noted days carry a marker on the charts; tapping it shows the note.
 * Rolling averages, never daily scores, and no chart uses red.
 */

import { useEffect, useMemo, useState } from 'preact/hooks'
import type { LocalDate } from '../../domain/types.ts'
import * as store from '../store.ts'
import * as repo from '../../data/repositories.ts'
import { addDays, dateRange, formatDisplayDate, today } from '../../domain/dates.ts'
import {
  adherencePct,
  buildSeries,
  confidenceLabel,
  rollingMean,
  type DayConfidence,
} from '../../domain/analytics/index.ts'
import { MIN_ADHERENCE_PCT } from '../../domain/engine/adjustment.ts'
import { TDEE_WINDOW_DAYS, windowFor } from '../../domain/engine/tdee.ts'
import { currentWindowEnd } from '../../data/engine.ts'
import { Empty, fmt } from '../components/common.tsx'
import { TimeChart, type Marker, type SeriesSpec } from '../components/TimeChart.tsx'
import { useNotes, weightDisplay, type Horizon } from '../components/WeightChart.tsx'

export function Trends() {
  const [horizon, setHorizon] = useState<Horizon>(90)
  const notes = useNotes()
  const [picked, setPicked] = useState<Marker | undefined>(undefined)

  const rollups = store.recentRollups.value
  const trend = store.trendPoints.value
  const estimates = store.tdeeEstimates.value
  const events = store.adjustments.value

  const end = today()
  const earliest = store.earliestDate.value ?? end
  const start =
    horizon === 0 ? earliest : addDays(end, -(horizon - 1)) < earliest ? earliest : addDays(end, -(horizon - 1))
  const dates = useMemo(() => dateRange(start, end), [start, end])

  const markers = useMemo<Marker[]>(() => {
    const inRange = (d: LocalDate): boolean => d >= start && d <= end
    return [
      ...[...notes.keys()].filter(inRange).map((date) => ({ date, kind: 'note' as const })),
      ...events
        .filter((e) => e.outcome === 'adjusted' && inRange(e.date))
        .map((e) => ({ date: e.date, kind: 'adjustment' as const })),
    ]
  }, [notes, events, start, end])

  const weightUnit = store.units.value.bodyWeight
  const weightSeries = useMemo<SeriesSpec[]>(() => {
    const display = weightDisplay(weightUnit)
    const byDate = new Map(trend.map((p) => [p.date, p]))
    const est = new Map(estimates.filter((e) => e.sufficient).map((e) => [e.windowEnd, e.kcal]))
    const series = buildSeries(rollups, start, end)
    return [
      {
        label: 'Trend',
        values: dates.map((d) => {
          const t = byDate.get(d)?.trend
          return t === undefined ? null : display.toDisplay(t)
        }),
        color: '--accent',
        kind: 'line',
        scale: 'left',
        unit: weightUnit,
        format: display.format,
      },
      {
        label: 'Reading',
        values: dates.map((d) => {
          const r = byDate.get(d)?.raw
          return r === undefined ? null : display.toDisplay(r)
        }),
        color: '--text-faint',
        kind: 'dots',
        scale: 'left',
        unit: weightUnit,
        format: display.format,
      },
      {
        label: 'Expenditure',
        values: dates.map((d) => est.get(d) ?? null),
        color: '--in-band',
        kind: 'line',
        scale: 'right',
        unit: 'kcal',
        width: 1.5,
      },
      {
        label: 'Intake',
        values: dates.map((_, i) =>
          series.complete.kcal[i] ? (series.values.kcal[i] ?? null) : null,
        ),
        color: '--neutral',
        kind: 'area',
        scale: 'right',
        unit: 'kcal',
        width: 1,
        alpha: 0.6,
      },
    ]
  }, [trend, estimates, rollups, dates, start, end, weightUnit])

  const intakeSeries = useMemo(() => {
    const series = buildSeries(rollups, start, end)
    const build = (key: 'kcal' | 'protein', unit: string, color: string): SeriesSpec[] => {
      const values = series.values[key]
      const complete = series.complete[key]
      const mean = rollingMean(
        dates.map((d, i) => ({ date: d, value: complete[i] ? values[i] : undefined })),
        7,
      )
      return [
        {
          label: 'Day',
          values: values.map((v, i) =>
            v !== undefined && complete[i] && !series.aiEstimated[i] ? v : null,
          ),
          color,
          kind: 'dots',
          scale: 'left',
          unit,
        },
        {
          // Days with a model estimate: included in every trend, drawn
          // lighter -- a distinction, never a warning colour.
          label: 'Estimated',
          values: values.map((v, i) =>
            v !== undefined && complete[i] && series.aiEstimated[i] ? v : null,
          ),
          color,
          kind: 'dots',
          scale: 'left',
          unit,
          alpha: 0.55,
        },
        {
          // Days with unknown values: included, drawn fainter, and read as floors.
          label: 'At least',
          values: values.map((v, i) => (v !== undefined && !complete[i] ? v : null)),
          color,
          kind: 'dots',
          scale: 'left',
          unit,
          alpha: 0.35,
        },
        {
          label: '7-day',
          values: mean.map((m) => m.value ?? null),
          color,
          kind: 'line',
          scale: 'left',
          unit,
        },
      ]
    }
    return {
      kcal: build('kcal', 'kcal', '--neutral'),
      protein: build('protein', 'g', '--accent'),
    }
  }, [rollups, dates, start, end])

  const latest = store.latestTdee.value
  const windowEnd = currentWindowEnd()
  const win = windowFor(windowEnd)
  const windowRollups = rollups.filter((r) => r.date >= win.start && r.date <= win.end)
  const adherence = adherencePct(windowRollups, TDEE_WINDOW_DAYS)
  const counts = countConfidence(windowRollups.map((r) => r.confidence), TDEE_WINDOW_DAYS)

  function openDay(date: LocalDate): void {
    void store.goToDate(date).then(() => store.setTab('today'))
  }

  return (
    <div class="screen">
      <div class="screen-head">
        <h1>Trends</h1>
      </div>

      <div class="chip-row sticky-horizon">
        {([30, 90, 365, 0] as Horizon[]).map((h) => (
          <button key={h} class="chip" aria-pressed={horizon === h} onClick={() => setHorizon(h)}>
            {h === 0 ? 'All' : h === 365 ? '1 year' : `${h} days`}
          </button>
        ))}
      </div>

      <div class="card">
        <div class="card-title">Weight and expenditure</div>
        <TimeChart
          dates={dates}
          series={weightSeries}
          markers={markers}
          onMarker={setPicked}
          height={220}
        />
        <div class="faint" style="margin-top:8px">
          {latest && latest.sufficient
            ? `Measured expenditure about ${fmt(latest.kcal)} kcal, ±${fmt(latest.standardError)}, from ${latest.loggedDays} logged days.`
            : `Expenditure is not measurable yet: it needs ${Math.ceil((TDEE_WINDOW_DAYS * MIN_ADHERENCE_PCT) / 100)} of the last ${TDEE_WINDOW_DAYS} days fully logged, and a few weight readings.`}
        </div>
      </div>

      {picked && (
        <PickedMarker marker={picked} note={notes.get(picked.date)} onOpen={openDay} onClose={() => setPicked(undefined)} />
      )}

      <div class="card">
        <div class="card-title">Calories</div>
        <TimeChart
          dates={dates}
          series={intakeSeries.kcal}
          markers={markers}
          onMarker={setPicked}
          height={170}
        />
        <div class="card-title" style="margin-top:14px">
          Protein
        </div>
        <TimeChart
          dates={dates}
          series={intakeSeries.protein}
          markers={markers}
          onMarker={setPicked}
          height={170}
        />
        <div class="faint" style="margin-top:8px">
          Lighter dots are days that include a model estimate; they count in
          every trend here. Fainter dots are days with something logged as
          unknown: the figure is a floor, and the 7-day line leaves those days
          out.
        </div>
      </div>

      <div class="card">
        <div class="card-title">Adherence, last {TDEE_WINDOW_DAYS} days</div>
        <div class="stat">
          <span class="value">{fmt(adherence)}%</span>
          <span class="sub">
            of days fully logged · the three-week review needs {MIN_ADHERENCE_PCT}%
          </span>
        </div>
        <div class="faint" style="margin-top:6px">
          {(['logged', 'partial', 'minimal', 'empty'] as DayConfidence[])
            .map((c) => `${counts[c]} ${confidenceLabel(c).toLowerCase()}`)
            .join(' · ')}
        </div>
        <div class="faint" style="margin-top:6px">
          Filling in a missed day counts: backfilled days are logged days.
        </div>
      </div>

      <AdjustmentHistory />

      <NoteSearch onOpen={openDay} />
    </div>
  )
}

function countConfidence(list: DayConfidence[], windowDays: number): Record<DayConfidence, number> {
  const out: Record<DayConfidence, number> = { logged: 0, partial: 0, minimal: 0, empty: 0 }
  for (const c of list) out[c]++
  out.empty += Math.max(0, windowDays - list.length)
  return out
}

function PickedMarker(props: {
  marker: Marker
  note: string | undefined
  onOpen: (d: LocalDate) => void
  onClose: () => void
}) {
  const event = store.adjustments.value.find(
    (e) => e.date === props.marker.date && e.outcome === 'adjusted',
  )
  return (
    <div class="card picked-marker" role="status">
      <div class="row-between">
        <strong>{formatDisplayDate(props.marker.date)}</strong>
        <button class="btn btn-small btn-ghost" onClick={props.onClose}>
          Close
        </button>
      </div>
      {props.note && <p class="note-text">{props.note}</p>}
      {event && <p class="faint">{event.rationale}</p>}
      <button class="btn btn-small" onClick={() => props.onOpen(props.marker.date)}>
        Open this day
      </button>
    </div>
  )
}

function AdjustmentHistory() {
  const events = [...store.adjustments.value].reverse()
  return (
    <div class="card">
      <div class="card-title">Why targets changed</div>
      {events.length === 0 ? (
        <Empty>
          No reviews yet. In steady state, targets are reviewed every three
          weeks, and every review — including the ones that change nothing — is
          explained here.
        </Empty>
      ) : (
        <div class="list">
          {events.map((e) => (
            <div class="list-item" key={e.id} style="flex-direction:column;align-items:stretch;gap:4px">
              <div class="row-between">
                <strong>{formatDisplayDate(e.date)}</strong>
                <span class="faint">
                  {e.outcome === 'adjusted'
                    ? `${e.deltaKcal > 0 ? '+' : ''}${e.deltaKcal} kcal`
                    : e.outcome === 'held'
                      ? 'no change'
                      : e.outcome === 'suppressed'
                        ? 'held for review'
                        : 'not enough data'}
                </span>
              </div>
              <div class="meta">{e.rationale}</div>
              {e.notes?.map((n) => (
                <div class="meta faint" key={n.at}>
                  {n.text}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function NoteSearch(props: { onOpen: (d: LocalDate) => void }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{ date: LocalDate; note: string }[]>([])

  useEffect(() => {
    let live = true
    const q = query.trim()
    if (q.length === 0) {
      setResults([])
      return
    }
    void repo.searchNotes(q).then((r) => {
      if (live) setResults(r)
    })
    return () => {
      live = false
    }
  }, [query])

  return (
    <div class="card">
      <div class="card-title">Search notes</div>
      <input
        type="search"
        placeholder="run down, travel, Chicago…"
        value={query}
        onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
      />
      {query.trim().length > 0 && results.length === 0 && (
        <div class="faint" style="margin-top:8px">
          No note mentions that.
        </div>
      )}
      <div class="list" style="margin-top:8px">
        {results.map((r) => (
          <button key={r.date} class="list-item" onClick={() => props.onOpen(r.date)}>
            <div style="flex:1;min-width:0;text-align:left">
              <div class="title">{formatDisplayDate(r.date)}</div>
              <div class="meta note-snippet">{r.note}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
