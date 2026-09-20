/**
 * The weight trend chart.
 *
 * Smoothed trend as the headline series, raw readings as faint dots. The
 * design document is explicit that the headline weight is the trend value
 * and today's reading is a dot -- it is easy to regress on, so the raw
 * series is deliberately drawn without a connecting line.
 */

import { useEffect, useRef } from 'preact/hooks'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import type { TrendPoint } from '../../domain/engine/weightTrend.ts'
import { fromLocalDate } from '../../domain/dates.ts'

export type Horizon = 30 | 90 | 365 | 0

export function WeightChart(props: {
  points: TrendPoint[]
  horizonDays: Horizon
  height?: number
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const points =
      props.horizonDays === 0
        ? props.points
        : props.points.slice(-props.horizonDays)

    if (points.length < 2) {
      plotRef.current?.destroy()
      plotRef.current = null
      host.innerHTML = ''
      return
    }

    const xs = points.map((p) => fromLocalDate(p.date).getTime() / 1000)
    const trend = points.map((p) => p.trend)
    const raw = points.map((p) => p.raw ?? null)

    const css = getComputedStyle(document.documentElement)
    const accent = css.getPropertyValue('--accent').trim() || '#7aa2f7'
    const faint = css.getPropertyValue('--text-faint').trim() || '#6b7688'
    const line = css.getPropertyValue('--line').trim() || '#2c3341'
    const dim = css.getPropertyValue('--text-dim').trim() || '#9aa5b5'

    const opts: uPlot.Options = {
      width: host.clientWidth || 320,
      height: props.height ?? 190,
      padding: [8, 6, 0, 0],
      legend: { show: true, live: true },
      cursor: { drag: { x: true, y: false }, points: { size: 6 } },
      scales: { x: { time: true } },
      axes: [
        {
          stroke: dim,
          grid: { stroke: line, width: 1 },
          ticks: { stroke: line },
          font: '11px system-ui',
        },
        {
          stroke: dim,
          grid: { stroke: line, width: 1 },
          ticks: { stroke: line },
          font: '11px system-ui',
          size: 44,
        },
      ],
      series: [
        { label: 'Date' },
        {
          label: 'Trend',
          stroke: accent,
          width: 2,
          points: { show: false },
          value: (_u, v) => (v == null ? '—' : `${v.toFixed(2)} kg`),
        },
        {
          label: 'Reading',
          // Dots only: the raw series is never the headline.
          stroke: faint,
          width: 0,
          points: { show: true, size: 4, stroke: faint, fill: faint },
          value: (_u, v) => (v == null ? '—' : `${v.toFixed(1)} kg`),
        },
      ],
    }

    plotRef.current?.destroy()
    host.innerHTML = ''
    plotRef.current = new uPlot(opts, [xs, trend, raw], host)

    const onResize = (): void => {
      if (plotRef.current && host.clientWidth > 0) {
        plotRef.current.setSize({
          width: host.clientWidth,
          height: props.height ?? 190,
        })
      }
    }
    const observer = new ResizeObserver(onResize)
    observer.observe(host)

    return () => {
      observer.disconnect()
      plotRef.current?.destroy()
      plotRef.current = null
    }
  }, [props.points, props.horizonDays, props.height])

  if (props.points.length < 2) {
    return (
      <div class="empty">
        Two weight readings will draw a trend. One reading is a number; the
        trend is what every calculation uses.
      </div>
    )
  }

  return <div class="chart-wrap" ref={hostRef} />
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
