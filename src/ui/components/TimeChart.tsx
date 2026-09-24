/**
 * A day-by-day time chart with markers.
 *
 * Noted days carry a small marker under the plot; tapping near one hands
 * the date back so the screen can show the note. This is what turns notes
 * from a write-only diary into something useful: an unexplained jump six
 * months ago becomes legible when its marker says why. Adjustment events
 * carry a marker too, so a moved target is explained where it shows.
 *
 * No series here is ever drawn in red.
 */

import { useEffect, useRef } from 'preact/hooks'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import type { LocalDate } from '../../domain/types.ts'
import { fromLocalDate } from '../../domain/dates.ts'

export type SeriesSpec = {
  label: string
  values: (number | null)[]
  /** A CSS custom property name, e.g. '--accent'. */
  color: string
  kind: 'line' | 'dots' | 'area'
  scale: 'left' | 'right'
  unit: string
  dp?: number
  width?: number
  /** 0–1. Lower for lower-confidence series. */
  alpha?: number
  dash?: number[]
}

export type Marker = { date: LocalDate; kind: 'note' | 'adjustment' }

function cssColor(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

function withAlpha(color: string, alpha: number): string {
  if (alpha >= 1) return color
  const m = /^#([0-9a-f]{6})$/i.exec(color)
  if (!m) return color
  const n = Number.parseInt(m[1]!, 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`
}

export function TimeChart(props: {
  dates: LocalDate[]
  series: SeriesSpec[]
  markers?: Marker[]
  onMarker?: (m: Marker) => void
  height?: number
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  const onMarkerRef = useRef(props.onMarker)
  onMarkerRef.current = props.onMarker

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    if (props.dates.length < 2) {
      plotRef.current?.destroy()
      plotRef.current = null
      host.innerHTML = ''
      return
    }

    const height = props.height ?? 200
    const xs = props.dates.map((d) => fromLocalDate(d).getTime() / 1000)
    const markers = props.markers ?? []
    const markerXs = markers.map((m) => ({ m, x: fromLocalDate(m.date).getTime() / 1000 }))

    const line = cssColor('--line', '#2c3341')
    const dim = cssColor('--text-dim', '#9aa5b5')
    const noteColor = cssColor('--text-dim', '#9aa5b5')
    const adjColor = cssColor('--accent', '#7aa2f7')
    const usesRight = props.series.some((s) => s.scale === 'right')

    const axis = (scale: string, side: 0 | 1): uPlot.Axis => ({
      scale,
      side: side === 0 ? 3 : 1,
      stroke: dim,
      grid: side === 0 ? { stroke: line, width: 1 } : { show: false },
      ticks: { stroke: line },
      font: '11px system-ui',
      size: 48,
    })

    const opts: uPlot.Options = {
      width: host.clientWidth || 320,
      height,
      padding: [8, 6, 14, 0],
      legend: { show: true, live: true },
      cursor: { drag: { x: true, y: false }, points: { size: 6 } },
      scales: { x: { time: true }, left: {}, right: {} },
      axes: [
        {
          stroke: dim,
          grid: { stroke: line, width: 1 },
          ticks: { stroke: line },
          font: '11px system-ui',
        },
        axis('left', 0),
        ...(usesRight ? [axis('right', 1)] : []),
      ],
      series: [
        { label: 'Date' },
        ...props.series.map((s): uPlot.Series => {
          const base = cssColor(s.color, '#7aa2f7')
          const color = withAlpha(base, s.alpha ?? 1)
          const value = (_u: uPlot, v: number | null): string =>
            v == null ? '—' : `${v.toFixed(s.dp ?? 0)} ${s.unit}`.trim()
          if (s.kind === 'dots') {
            return {
              label: s.label,
              scale: s.scale,
              stroke: color,
              width: 0,
              points: { show: true, size: 5, stroke: color, fill: color },
              value,
            }
          }
          return {
            label: s.label,
            scale: s.scale,
            stroke: color,
            width: s.width ?? 2,
            ...(s.dash ? { dash: s.dash } : {}),
            ...(s.kind === 'area' ? { fill: withAlpha(base, 0.12) } : {}),
            points: { show: false },
            spanGaps: false,
            value,
          }
        }),
      ],
      hooks: {
        draw: [
          (u) => {
            const ctx = u.ctx
            const { top, height: h } = u.bbox
            const bottom = top + h
            ctx.save()
            for (const { m, x } of markerXs) {
              const px = u.valToPos(x, 'x', true)
              if (px < u.bbox.left || px > u.bbox.left + u.bbox.width) continue
              ctx.fillStyle = m.kind === 'note' ? noteColor : adjColor
              ctx.beginPath()
              const r = 5 * devicePixelRatio
              if (m.kind === 'note') {
                // A small upward triangle under the plot.
                ctx.moveTo(px, bottom + 2 * devicePixelRatio)
                ctx.lineTo(px - r, bottom + 2 * devicePixelRatio + r * 1.4)
                ctx.lineTo(px + r, bottom + 2 * devicePixelRatio + r * 1.4)
              } else {
                ctx.arc(px, top + r, r * 0.8, 0, Math.PI * 2)
              }
              ctx.closePath()
              ctx.fill()
            }
            ctx.restore()
          },
        ],
      },
    }

    const data: uPlot.AlignedData = [xs, ...props.series.map((s) => s.values)]
    plotRef.current?.destroy()
    host.innerHTML = ''
    const plot = new uPlot(opts, data, host)
    plotRef.current = plot

    // A tap near a marker selects it -- including on the marker itself, which
    // sits under the plot area, so the whole chart listens. Tolerance is
    // generous: fingers are wide.
    const onClick = (e: MouseEvent): void => {
      if (markerXs.length === 0) return
      const rect = plot.over.getBoundingClientRect()
      const left = e.clientX - rect.left
      if (left < -16 || left > rect.width + 16) return
      let best: { m: Marker; d: number } | undefined
      for (const { m, x } of markerXs) {
        const d = Math.abs(plot.valToPos(x, 'x') - left)
        if (d <= 16 && (!best || d < best.d)) best = { m, d }
      }
      if (best) onMarkerRef.current?.(best.m)
    }
    host.addEventListener('click', onClick)

    const observer = new ResizeObserver(() => {
      if (plotRef.current && host.clientWidth > 0) {
        plotRef.current.setSize({ width: host.clientWidth, height })
      }
    })
    observer.observe(host)

    return () => {
      observer.disconnect()
      host.removeEventListener('click', onClick)
      plotRef.current?.destroy()
      plotRef.current = null
    }
  }, [props.dates, props.series, props.markers, props.height])

  if (props.dates.length < 2) {
    return <div class="empty">Not enough days to draw yet.</div>
  }
  return <div class="chart-wrap" ref={hostRef} />
}
