/**
 * Local-date arithmetic.
 *
 * Every date in this app is a 'YYYY-MM-DD' string in the user's local
 * timezone. Never a Date, never a UTC timestamp -- a day boundary that
 * shifts with the timezone would silently reassign meals.
 */

import type { LocalDate } from './types.ts'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function isLocalDate(s: string): s is LocalDate {
  if (!DATE_RE.test(s)) return false
  const [y, m, d] = s.split('-').map(Number) as [number, number, number]
  if (m < 1 || m > 12 || d < 1 || d > 31) return false
  const dt = new Date(y, m - 1, d)
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d
}

export function toLocalDate(d: Date): LocalDate {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function today(now: Date = new Date()): LocalDate {
  return toLocalDate(now)
}

/** Midday local, so DST transitions cannot shift the calendar day. */
export function fromLocalDate(s: LocalDate): Date {
  const [y, m, d] = s.split('-').map(Number) as [number, number, number]
  return new Date(y, m - 1, d, 12, 0, 0, 0)
}

export function addDays(s: LocalDate, n: number): LocalDate {
  const d = fromLocalDate(s)
  d.setDate(d.getDate() + n)
  return toLocalDate(d)
}

export function daysBetween(a: LocalDate, b: LocalDate): number {
  const ms = fromLocalDate(b).getTime() - fromLocalDate(a).getTime()
  return Math.round(ms / 86_400_000)
}

/** Inclusive range, ascending. */
export function dateRange(start: LocalDate, end: LocalDate): LocalDate[] {
  const out: LocalDate[] = []
  const n = daysBetween(start, end)
  if (n < 0) return out
  for (let i = 0; i <= n; i++) out.push(addDays(start, i))
  return out
}

export function compareDates(a: LocalDate, b: LocalDate): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Minutes since local midnight, from an 'HH:MM' string. */
export function minutesOfDay(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return (h ?? 0) * 60 + (m ?? 0)
}

export function formatTime(d: Date = new Date()): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function formatDisplayDate(s: LocalDate, now: Date = new Date()): string {
  const t = today(now)
  if (s === t) return 'Today'
  if (s === addDays(t, -1)) return 'Yesterday'
  if (s === addDays(t, 1)) return 'Tomorrow'
  const d = fromLocalDate(s)
  const sameYear = d.getFullYear() === now.getFullYear()
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
}

/** ISO week start, Monday. Used for weekly rollups and the narrative. */
export function startOfWeek(s: LocalDate): LocalDate {
  const d = fromLocalDate(s)
  const dow = (d.getDay() + 6) % 7
  return addDays(s, -dow)
}

export function isSunday(s: LocalDate): boolean {
  return fromLocalDate(s).getDay() === 0
}
