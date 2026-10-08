/**
 * The weight trend chart.
 *
 * Smoothed trend as the headline series, raw readings as faint dots. The
 * design document is explicit that the headline weight is the trend value
 * and today's reading is a dot -- it is easy to regress on, so the raw
 * series is deliberately drawn without a connecting line.
 *
 * Noted days carry a marker; tapping it shows the note under the chart.
 */

import { useEffect, useMemo, useState } from 'preact/hooks'
import type { TrendPoint } from '../../domain/engine/weightTrend.ts'
import type { LocalDate } from '../../domain/types.ts'
import { formatDisplayDate } from '../../domain/dates.ts'
import * as repo from '../../data/repositories.ts'
import * as store from '../store.ts'
import { TimeChart, type AltAxis, type Marker, type SeriesSpec } from './TimeChart.tsx'
import { formatBodyWeight, kgToLb, lbToKg, type BodyWeightUnit } from '../../domain/units.ts'

/**
 * Weight series in the preferred unit, with legend values in both. Stored
 * values are kilograms; the conversion happens here, at display time.
 */
export function weightDisplay(unit: BodyWeightUnit): {
  toDisplay: (kg: number) => number
  format: (v: number) => string
  alt: AltAxis
} {
  const toDisplay = unit === 'lb' ? kgToLb : (kg: number) => kg
  const toKg = unit === 'lb' ? lbToKg : (v: number) => v
  return {
    toDisplay,
    format: (v) => formatBodyWeight(toKg(v), unit),
    alt: {
      convert: unit === 'lb' ? lbToKg : kgToLb,
      unit: unit === 'lb' ? 'kg' : 'lb',
      // Ticks a pound apart are under half a kilogram apart: whole numbers
      // would repeat.
      dp: 1,
    },
  }
}

export type Horizon = 30 | 90 | 365 | 0

/** Every day note, keyed by date, reloaded whenever history changes. */
export function useNotes(): Map<LocalDate, string> {
  const [notes, setNotes] = useState<Map<LocalDate, string>>(new Map())
  useEffect(() => {
    let live = true
    void repo.searchNotes('').then((list) => {
      if (live) setNotes(new Map(list.map((n) => [n.date, n.note])))
    })
    return () => {
      live = false
    }
  }, [store.recentRollups.value])
  return notes
}

export function WeightChart(props: {
  points: TrendPoint[]
  horizonDays: Horizon
  height?: number
}) {
  const notes = useNotes()
  const [picked, setPicked] = useState<Marker | undefined>(undefined)

  const points = useMemo(
    () => (props.horizonDays === 0 ? props.points : props.points.slice(-props.horizonDays)),
    [props.points, props.horizonDays],
  )
  const dates = useMemo(() => points.map((p) => p.date), [points])
  const unit = store.units.value.bodyWeight
  const display = useMemo(() => weightDisplay(unit), [unit])
  const series = useMemo<SeriesSpec[]>(
    () => [
      {
        label: 'Trend',
        values: points.map((p) => display.toDisplay(p.trend)),
        color: '--accent',
        kind: 'line',
        scale: 'left',
        unit,
        format: display.format,
      },
      {
        // Dots only: the raw series is never the headline.
        label: 'Reading',
        values: points.map((p) => (p.raw === undefined ? null : display.toDisplay(p.raw))),
        color: '--text-faint',
        kind: 'dots',
        scale: 'left',
        unit,
        format: display.format,
      },
    ],
    [points, display, unit],
  )
  const markers = useMemo<Marker[]>(() => {
    const first = dates[0]
    const last = dates[dates.length - 1]
    if (!first || !last) return []
    return [...notes.keys()]
      .filter((d) => d >= first && d <= last)
      .map((date) => ({ date, kind: 'note' as const }))
  }, [notes, dates])

  if (props.points.length < 2) {
    return (
      <div class="empty">
        Two weight readings will draw a trend. One reading is a number; the
        trend is what every calculation uses.
      </div>
    )
  }

  return (
    <>
      <TimeChart
        dates={dates}
        series={series}
        markers={markers}
        onMarker={setPicked}
        height={props.height ?? 190}
        altAxis={display.alt}
      />
      {picked && notes.get(picked.date) && (
        <div class="picked-note" role="status">
          <div class="row-between">
            <strong>{formatDisplayDate(picked.date)}</strong>
            <button class="btn btn-small btn-ghost" onClick={() => setPicked(undefined)}>
              Close
            </button>
          </div>
          <p class="note-text">{notes.get(picked.date)}</p>
        </div>
      )}
    </>
  )
}

/** Compact sparkline of the trend value, for the home screen. */
export function TrendSparkline(props: { points: TrendPoint[]; days?: number }) {
  const days = props.days ?? 30
  const slice = props.points.slice(-days)
  if (slice.length < 2) return <div class="faint">No trend yet</div>

  const values = slice.map((p) => p.trend)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const w = 120
  const h = 30
  const d = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * w
      const y = h - ((v - min) / span) * h
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')

  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <path d={d} fill="none" stroke="var(--accent)" stroke-width="1.8" />
    </svg>
  )
}
