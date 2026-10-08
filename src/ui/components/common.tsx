import type { ComponentChildren } from 'preact'
import { useEffect, useRef } from 'preact/hooks'
import type { TargetKey, TargetValue } from '../../domain/types.ts'
import type { Aggregate } from '../../domain/nutrition/index.ts'
import {
  CEILING_TARGETS,
  TARGET_LABELS,
  TARGET_UNITS,
  sourceLabel,
} from '../../domain/engine/targets.ts'
import { bodyWeightParts, type BodyWeightUnit } from '../../domain/units.ts'

/**
 * A dismissible sheet. Never a modal dialog for data entry -- it preserves
 * partial state and closes on backdrop tap or Escape.
 */
export function Sheet(props: {
  title: string
  onClose: () => void
  children: ComponentChildren
  actions?: ComponentChildren
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') props.onClose()
    }
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [props.onClose])

  return (
    <div
      class="sheet-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose()
      }}
    >
      <div class="sheet" ref={ref} role="dialog" aria-label={props.title}>
        <div class="sheet-grip" />
        <div class="sheet-head">
          <h2 style="font-size:1.05rem">{props.title}</h2>
          <div class="row">
            {props.actions}
            <button class="btn btn-small btn-ghost" onClick={props.onClose}>
              Close
            </button>
          </div>
        </div>
        {props.children}
      </div>
    </div>
  )
}

export type BandState = 'in' | 'near' | 'beyond' | 'unknown'

/**
 * Distance from a band, never pass/fail.
 *
 * For a target to reach, "in" means within 10% either side. For a ceiling,
 * "in" means under it. Nothing here is ever red, and nothing is labelled
 * over or under.
 */
export function bandState(
  value: number,
  target: number,
  isCeiling: boolean,
): BandState {
  if (target <= 0) return 'in'
  const ratio = value / target
  if (isCeiling) {
    if (ratio <= 1) return 'in'
    return ratio <= 1.25 ? 'near' : 'beyond'
  }
  if (ratio >= 0.9 && ratio <= 1.1) return 'in'
  if (ratio >= 0.75 && ratio <= 1.25) return 'near'
  return 'beyond'
}

/**
 * A band against a target.
 *
 * `incomplete` is for a total with unknown contributions. Below target it
 * renders as a partial fill in a neutral pattern, never as a shortfall: the
 * user has not missed the target, the app does not know yet, and the UI
 * must not conflate the two. A floor that already clears the target (or a
 * ceiling) is simply shown as what is known.
 */
export function Band(props: {
  value: number
  target: number
  isCeiling?: boolean
  incomplete?: boolean
}) {
  const { value, target, isCeiling = false, incomplete = false } = props
  const known = bandState(value, target, isCeiling)
  const state: BandState =
    incomplete && !isCeiling && value < target * 0.9 ? 'unknown' : known
  // The bar is scaled so the target marker sits at 75% of the width, which
  // leaves room to show a figure above target without the bar pinning.
  const pct = target > 0 ? Math.min(100, (value / target) * 75) : 0
  return (
    <div
      class="band"
      role="img"
      aria-label={`${incomplete ? 'at least ' : ''}${Math.round(value)} of ${Math.round(target)}`}
    >
      <div class="band-fill" data-state={state} style={`width:${pct}%`} />
      <div class="band-marker" style="left:75%" />
    </div>
  )
}

export function fmt(n: number | null | undefined, dp = 0): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return '—'
  return n.toLocaleString(undefined, {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  })
}

/**
 * The provenance sheet. Every number in the app is tappable and answers:
 * where it came from, which layer set it, and when it last changed.
 */
export function ProvenanceSheet(props: {
  targetKey: TargetKey
  target: TargetValue
  todayValue?: number
  sevenDayValue?: number
  onClose: () => void
  onEdit?: () => void
  onReset?: () => void
}) {
  const { target, targetKey } = props
  const unit = TARGET_UNITS[targetKey]
  const isCeiling = CEILING_TARGETS.has(targetKey)

  return (
    <Sheet title={TARGET_LABELS[targetKey]} onClose={props.onClose}>
      <div class="stat-hero">
        <span class="label">{isCeiling ? 'Ceiling' : 'Target'}</span>
        <span class="value">
          {fmt(target.value, targetKey === 'kcal' || targetKey === 'sodium' ? 0 : 0)}
          <span style="font-size:1rem;color:var(--text-dim)"> {unit}</span>
        </span>
      </div>

      {props.todayValue !== undefined && (
        <div class="row-between">
          <span class="muted">Today</span>
          <strong>
            {fmt(props.todayValue)} {unit}
          </strong>
        </div>
      )}
      {props.sevenDayValue !== undefined && (
        <div class="row-between">
          <span class="muted">7-day average</span>
          <strong>
            {fmt(props.sevenDayValue)} {unit}
          </strong>
        </div>
      )}

      <div class="divider" />

      <div>
        <div class="card-title">Where this number comes from</div>
        <div class="row" style="gap:8px;margin-bottom:8px">
          <span class="tier-tag">{sourceLabel(target.source)}</span>
          {target.updatedAt !== undefined && (
            <span class="faint">
              last changed {new Date(target.updatedAt).toLocaleDateString()}
            </span>
          )}
        </div>
        <p class="muted" style="margin:0;font-size:0.92rem">
          {target.rationale}
        </p>
      </div>

      {target.clampedFrom !== undefined && (
        <div class="notice" data-tone="attention">
          A floor was reached. The layers below this produced{' '}
          {fmt(target.clampedFrom)} {unit}, and the guardrail raised it to{' '}
          {fmt(target.value)} {unit}. This floor has no override.
        </div>
      )}

      <div class="row" style="gap:8px">
        {props.onEdit && (
          <button class="btn btn-small" onClick={props.onEdit}>
            Edit this target
          </button>
        )}
        {props.onReset && target.source === 'user' && (
          <button class="btn btn-small btn-ghost" onClick={props.onReset}>
            Reset to computed
          </button>
        )}
      </div>
    </Sheet>
  )
}

export function Meter(props: { pct: number; label?: string }) {
  const pct = Math.max(0, Math.min(100, props.pct))
  return (
    <div>
      <div class="meter">
        <div style={`width:${pct}%`} />
      </div>
      {props.label && <div class="faint" style="margin-top:4px">{props.label}</div>}
    </div>
  )
}

export function Empty(props: { children: ComponentChildren }) {
  return <div class="empty">{props.children}</div>
}

/**
 * A total with its coverage. Complete: the number. Incomplete: "at least"
 * the number, with "9 of 11 entries" beside it -- a more useful statement
 * than a confident wrong number.
 */
export function AggregateText(props: { agg: Aggregate; unit?: string; dp?: number }) {
  const { agg, unit = '', dp = 0 } = props
  if (agg.complete) {
    return (
      <>
        {fmt(agg.value, dp)}
        {unit && ` ${unit}`}
      </>
    )
  }
  if (agg.knownEntries === 0) return <span class="unknown-value">not known yet</span>
  return (
    <span class="floor-value">
      at least {fmt(agg.value, dp)}
      {unit && ` ${unit}`}
      <span class="coverage">
        {' '}
        · {agg.knownEntries} of {agg.totalEntries} entries
      </span>
    </span>
  )
}

/** A number input whose blank means unknown, not zero. */
export function parseOptionalNumber(raw: string | undefined): number | null {
  if (raw === undefined) return null
  const t = raw.trim()
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/**
 * Body weight in both units, preferred first and larger: "204.2 lb (92.6 kg)".
 * The engine's arithmetic is metric, so showing both keeps the displayed and
 * the computed numbers legible as the same thing.
 */
export function BodyWeight(props: { kg: number; dp?: number; unit: BodyWeightUnit }) {
  const { primary, secondary } = bodyWeightParts(props.kg, props.unit, props.dp ?? 1)
  return (
    <span class="dual-weight">
      {primary}
      <span class="dual-secondary"> ({secondary})</span>
    </span>
  )
}

/** "7-day avg 168 g": the quiet secondary line under each of today's figures. */
export function AverageLine(props: {
  today?: Aggregate
  mean?: { value: number; days: number }
  unit: string
  dp?: number
}) {
  const dp = props.dp ?? 0
  if (!props.mean) return null
  const todayText =
    props.today && props.today.knownEntries > 0
      ? `${props.today.complete ? '' : 'at least '}${fmt(props.today.value, dp)} ${props.unit} today · `
      : ''
  return (
    <span class="sub avg-line">
      {todayText}
      {fmt(props.mean.value, dp)} {props.unit} avg
    </span>
  )
}
