/**
 * Today -- and, through the date header, any past day.
 *
 * Today shows today. Every headline figure is the day's own value against
 * its band, with the 7-day average as a small, quiet secondary line; the
 * averages proper live in Trends. The treatment is unchanged: bands rather
 * than thresholds, colour encoding distance rather than virtue, never red
 * on an intake value, and no language of over or under.
 *
 * Priority order, following the guidance:
 *   0. The add control -- between calibration and protein, where it cannot
 *      scroll out of view, plus a floating button that persists.
 *   1. Protein — the day against target. Largest.
 *   2. Calories — the day against target.
 *   3. Weight trend — the trend value, not the day's reading, in both units.
 *   4. Carbs and fat — compact, secondary.
 *   5. Fibre and saturated fat — the day against their bands.
 *
 * A past day is fully editable -- add, edit, delete, weight, note -- and
 * renders in the phase and precision mode it was actually logged under. A
 * minimal-mode day shows protein, the saturated-fat flag and the weight
 * trend, and looks designed for three numbers rather than missing the rest.
 */

import { useRef, useState } from 'preact/hooks'
import type { Entry, TargetKey } from '../../domain/types.ts'
import { ESTIMATED_FIDELITIES } from '../../domain/types.ts'
import {
  bodyWeightInputValue,
  formatFood,
  parseBodyWeight,
  parseLength,
  waistInputValue,
  BODY_WEIGHT_LABEL,
  WAIST_LABEL,
} from '../../domain/units.ts'
import * as store from '../store.ts'
import * as repo from '../../data/repositories.ts'
import {
  CEILING_TARGETS,
  TARGET_UNITS,
} from '../../domain/engine/targets.ts'
import {
  occasionsClearingProtein,
  fidelityLabel,
  lowestFidelity,
} from '../../domain/analytics/index.ts'
import { perOccasionProteinTarget } from '../../domain/nutrition/index.ts'
import { formatDisplayDate, today } from '../../domain/dates.ts'
import { phaseLabel, precisionModeLabel } from '../../domain/phase/index.ts'
import {
  AggregateText,
  AverageLine,
  Band,
  BodyWeight,
  Empty,
  Meter,
  ProvenanceSheet,
  Sheet,
  fmt,
} from '../components/common.tsx'
import { TrendSparkline, WeightChart, type Horizon } from '../components/WeightChart.tsx'
import { WeighFlow } from '../components/WeighFlow.tsx'
import { CompositeLogSheet } from '../components/CompositeLogSheet.tsx'
import { EditEntrySheet } from '../components/EditEntrySheet.tsx'
import { DayNote } from '../components/DayNote.tsx'
import { MinimalEntrySheet } from '../components/MinimalEntrySheet.tsx'

export function Today() {
  const [explain, setExplain] = useState<TargetKey | undefined>(undefined)
  const [showWeight, setShowWeight] = useState(false)
  const [horizon, setHorizon] = useState<Horizon>(90)
  const [weighing, setWeighing] = useState(false)
  const [minimalEntry, setMinimalEntry] = useState(false)
  const [logComposite, setLogComposite] = useState<string | undefined>(undefined)
  const swipe = useSwipe()

  const rollup = store.rollup.value
  const resolved = store.targets.value
  const seven = store.sevenDay.value
  const progress = store.progress.value
  const isToday = store.isToday.value
  const dayRecord = store.day.value
  // The day's own context, not today's.
  const dayMode = dayRecord?.precisionMode ?? store.profile.value?.precisionMode ?? 'weighed'
  const dayPhase = dayRecord?.phase ?? store.profile.value?.phase ?? 'calibration'
  const minimal = dayMode === 'minimal'
  const inCalibration = store.profile.value?.phase !== 'steady'

  const totals = rollup?.totals
  const composite = store.composites.value.find((c) => c.id === logComposite)
  const units = store.units.value
  const floatingAdd = store.settings.value.floatingAdd !== false

  function openAdd(): void {
    if (minimal) setMinimalEntry(true)
    else setWeighing(true)
  }

  function value(key: TargetKey): number {
    return totals ? totals[key].value : 0
  }
  function complete(key: TargetKey): boolean {
    return totals ? totals[key].complete : true
  }

  return (
    <div class="screen" {...swipe}>
      <DateHeader />

      {!isToday && (
        <div class="faint day-context">
          Logged in {phaseLabel(dayPhase).toLowerCase()} · {precisionModeLabel(dayMode).toLowerCase()} mode
        </div>
      )}

      {!resolved && (
        <div class="notice">
          Enter your weight to set targets. Everything downstream uses the
          weight trend, so the first reading is where the app starts.
        </div>
      )}

      {isToday && inCalibration && progress && (
        <div class="card">
          <div class="card-title">
            {progress.phase === 'calibration' ? 'Calibration' : 'Recalibration'}
          </div>
          <div class="row-between" style="align-items:flex-end">
            <div class="stat-hero">
              <span class="value">
                Day {progress.dayNumber}
                <span style="font-size:1.1rem;color:var(--text-dim)">
                  {' '}
                  of {progress.totalDays}
                </span>
              </span>
              <span class="sub">
                {progress.daysRemaining} days left · ends{' '}
                {formatDisplayDate(progress.endDate)}
              </span>
            </div>
          </div>

          <div style="margin-top:12px;display:flex;flex-direction:column;gap:10px">
            <Meter
              pct={(progress.dayNumber / progress.totalDays) * 100}
              label={`${progress.daysLogged} of ${progress.dayNumber} days weighed · ${progress.weightEntries} weight readings`}
            />
            <Meter
              pct={Math.min(100, progress.compositesBuilt * 8)}
              label={`${progress.compositesBuilt} meals saved to your library`}
            />
          </div>

          <p class="faint" style="margin:10px 0 0">
            The library is the number that matters. Every meal weighed properly
            now is a one-tap entry for the next two years — that is what these
            weeks are buying.
          </p>
        </div>
      )}

      {/* The add control sits here, between calibration and protein: lower
          down it scrolled out of view, and a control you cannot see is
          worse than one you must stretch for. */}
      <button class="btn btn-primary btn-wide add-inline" onClick={openAdd}>
        {minimal
          ? 'Protein and saturated fat'
          : isToday
            ? 'Weigh and log'
            : `Weigh and log to ${formatDisplayDate(store.selectedDate.value)}`}
      </button>

      {/* 1. Protein — the largest element on the screen. */}
      {resolved && (
        <div class="card">
          <div class="row-between" style="align-items:flex-start">
            <button
              class="stat-hero explainable"
              onClick={() => setExplain('protein')}
            >
              <span class="label">Protein</span>
              <span class="value">
                {complete('protein') ? (
                  fmt(value('protein'))
                ) : (
                  <span class="floor-value">≥ {fmt(value('protein'))}</span>
                )}
                <span style="font-size:1.2rem;color:var(--text-dim)">
                  {' '}
                  / {fmt(resolved.targets.protein.value)} g
                </span>
              </span>
              {totals && !totals.protein.complete && (
                <span class="sub">
                  <AggregateText agg={totals.protein} unit="g" /> — the rest is not
                  known yet
                </span>
              )}
              <AverageLine
                {...(totals ? { today: totals.protein } : {})}
                {...(seven?.protein ? { mean: seven.protein } : {})}
                unit="g"
              />
            </button>
          </div>
          <div style="margin-top:10px">
            <Band
              value={value('protein')}
              target={resolved.targets.protein.value}
              incomplete={!complete('protein')}
            />
          </div>

          {!minimal &&
            rollup &&
            rollup.occasions.length > 0 &&
            store.currentWeightKg.value !== undefined && <ProteinDistribution />}
        </div>
      )}

      {/* Minimal mode: the saturated-fat flag stands in for the full panel. */}
      {minimal && (
        <div class="card">
          <div class="row-between">
            <div class="stat">
              <span class="label">Saturated fat</span>
              <span class="value">
                {rollup?.satFatFlag === 'high'
                  ? 'High'
                  : rollup?.satFatFlag === 'low'
                    ? 'Low'
                    : '—'}
              </span>
            </div>
            <button class="btn btn-small" onClick={() => setMinimalEntry(true)}>
              {rollup?.proteinOverride !== undefined || rollup?.satFatFlag ? 'Edit' : 'Enter'}
            </button>
          </div>
        </div>
      )}

      {/* 2. Calories. */}
      {resolved && !minimal && (
        <div class="card">
          <button class="stat-hero explainable" onClick={() => setExplain('kcal')}>
            <span class="label">Calories</span>
            <span class="value" style="font-size:2rem">
              {complete('kcal') ? (
                fmt(value('kcal'))
              ) : (
                <span class="floor-value">≥ {fmt(value('kcal'))}</span>
              )}
              <span style="font-size:1.05rem;color:var(--text-dim)">
                {' '}
                / {fmt(resolved.targets.kcal.value)}
              </span>
            </span>
            {totals && !totals.kcal.complete && (
              <span class="sub">
                <AggregateText agg={totals.kcal} unit="kcal" />
              </span>
            )}
            <AverageLine
              {...(totals ? { today: totals.kcal } : {})}
              {...(seven?.kcal ? { mean: seven.kcal } : {})}
              unit="kcal"
            />
          </button>
          <div style="margin-top:10px">
            <Band
              value={value('kcal')}
              target={resolved.targets.kcal.value}
              incomplete={!complete('kcal')}
            />
          </div>
        </div>
      )}

      {/* 3. Weight trend — the trend value, never the day's reading. */}
      <div class="card">
        <div class="row-between">
          <div class="stat">
            <span class="label">Weight trend</span>
            <span class="value">
              {store.currentWeightKg.value !== undefined ? (
                <BodyWeight kg={store.currentWeightKg.value} unit={units.bodyWeight} />
              ) : (
                '—'
              )}
            </span>
            <span class="sub">
              {rollup?.weightKg !== undefined ? (
                <>
                  {isToday ? "today's" : "this day's"} reading{' '}
                  <BodyWeight kg={rollup.weightKg} unit={units.bodyWeight} />
                </>
              ) : (
                `no reading ${isToday ? 'today' : 'this day'}`
              )}
            </span>
          </div>
          <div class="row" style="gap:10px">
            <TrendSparkline points={store.trendPoints.value} />
            <button class="btn btn-small" onClick={() => setShowWeight(true)}>
              {rollup?.weightKg !== undefined ? 'Edit' : 'Add'}
            </button>
          </div>
        </div>

        <div style="margin-top:10px">
          <div class="chip-row" style="margin-bottom:8px">
            {([30, 90, 365, 0] as Horizon[]).map((h) => (
              <button
                key={h}
                class="chip"
                aria-pressed={horizon === h}
                onClick={() => setHorizon(h)}
              >
                {h === 0 ? 'All' : h === 365 ? '1 year' : `${h} days`}
              </button>
            ))}
          </div>
          <WeightChart points={store.trendPoints.value} horizonDays={horizon} />
        </div>
      </div>

      {/* 4. Carbs and fat — compact, secondary. */}
      {resolved && !minimal && (
        <div class="grid-2">
          {(['carbs', 'fat'] as const).map((key) => (
            <div class="card" key={key}>
              <button class="stat explainable" onClick={() => setExplain(key)}>
                <span class="label">{key === 'carbs' ? 'Carbs' : 'Fat'}</span>
                <span class="value">
                  {complete(key) ? fmt(value(key)) : `≥ ${fmt(value(key))}`}
                  <span style="font-size:0.85rem;color:var(--text-dim)">
                    {' '}
                    / {fmt(resolved.targets[key].value)} g
                  </span>
                </span>
                <AverageLine
                  {...(seven?.[key] ? { mean: seven[key]! } : {})}
                  unit="g"
                />
              </button>
              <div style="margin-top:8px">
                <Band
                  value={value(key)}
                  target={resolved.targets[key].value}
                  incomplete={!complete(key)}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 5. Fibre and saturated fat — the day against their bands. */}
      {resolved && !minimal && rollup && rollup.entryCount > 0 && (
        <div class="card">
          <div class="grid-2">
            {(['fibre', 'satFat'] as const).map((key) => {
              const agg = totals![key]
              const mean = seven?.[key]
              return (
                <div key={key}>
                  <button class="stat explainable" onClick={() => setExplain(key)}>
                    <span class="label">
                      {key === 'fibre' ? 'Fibre' : 'Saturated fat'}
                    </span>
                    <span class="value" style="font-size:1.1rem">
                      {agg.knownEntries === 0
                        ? '—'
                        : `${agg.complete ? '' : '≥ '}${fmt(agg.value, 1)}`}
                      <span style="font-size:0.8rem;color:var(--text-dim)">
                        {' '}
                        / {fmt(resolved.targets[key].value)} {TARGET_UNITS[key]}
                      </span>
                    </span>
                    {mean && (
                      <span class="sub avg-line">
                        {fmt(mean.value, 1)} {TARGET_UNITS[key]} avg
                      </span>
                    )}
                  </button>
                  {agg.knownEntries > 0 && (
                    <div style="margin-top:6px">
                      <Band
                        value={agg.value}
                        target={resolved.targets[key].value}
                        isCeiling={CEILING_TARGETS.has(key)}
                        incomplete={!agg.complete}
                      />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* The day's occasions, with their protein totals. */}
      <div class="card">
        <div class="row-between" style="margin-bottom:8px">
          <div class="card-title" style="margin:0">
            {isToday ? "Today's occasions" : 'Occasions'}
          </div>
          <span class="faint">
            {rollup && rollup.entryCount > 0
              ? fidelityLabel(lowestFidelity(rollup.fidelities))
              : ''}
          </span>
        </div>
        <Occasions />
        <div class="divider" />
        <DayNote />
      </div>

      {/* Composites ranked most likely for the current hour. */}
      {isToday && !minimal && (
        <div class="card">
          <div class="card-title">Likely now</div>
          <div class="list">
            {store.rankedComposites.value.slice(0, 4).map((r) => (
              <button
                key={r.composite.id}
                class="list-item"
                onClick={() => setLogComposite(r.composite.id)}
              >
                <div style="flex:1;min-width:0">
                  <div class="title">{r.composite.name}</div>
                  <div class="meta">
                    {r.composite.components.length} components
                    {r.usageCount > 0 && ` · logged ${r.usageCount}×`}
                  </div>
                </div>
                <span class="faint">Log</span>
              </button>
            ))}
            {store.rankedComposites.value.length === 0 && (
              <Empty>
                Nothing saved yet. Weigh a meal and save it — that is how the
                library builds itself.
              </Empty>
            )}
          </div>
        </div>
      )}

      {/* Persists while scrolling; switch it off in settings if it reads as clutter. */}
      {floatingAdd && (
        <button
          class="fab"
          aria-label={minimal ? 'Enter protein and saturated fat' : 'Weigh and log'}
          onClick={openAdd}
        >
          +
        </button>
      )}

      {explain && resolved && (
        <ProvenanceSheet
          targetKey={explain}
          target={resolved.targets[explain]}
          todayValue={value(explain)}
          {...(seven && isSevenKey(explain) && seven[explain]
            ? { sevenDayValue: seven[explain]!.value }
            : {})}
          onClose={() => setExplain(undefined)}
        />
      )}

      {showWeight && <WeightSheet onClose={() => setShowWeight(false)} />}
      {weighing && <WeighFlow onClose={() => setWeighing(false)} />}
      {minimalEntry && <MinimalEntrySheet onClose={() => setMinimalEntry(false)} />}
      {composite && (
        <CompositeLogSheet
          composite={composite}
          onClose={() => setLogComposite(undefined)}
        />
      )}
    </div>
  )
}

function isSevenKey(k: TargetKey): k is 'kcal' | 'protein' | 'carbs' | 'fat' | 'fibre' | 'satFat' {
  return k === 'kcal' || k === 'protein' || k === 'carbs' || k === 'fat' || k === 'fibre' || k === 'satFat'
}

/**
 * Back and forward arrows flanking the date; a tap on the date opens a
 * picker. Forward stops at today -- no logging into the future -- and back
 * stops at the earliest record.
 */
function DateHeader() {
  const date = store.selectedDate.value
  const isToday = store.isToday.value
  const pickerRef = useRef<HTMLInputElement>(null)

  function openPicker(): void {
    const input = pickerRef.current
    if (!input) return
    try {
      input.showPicker()
    } catch {
      input.focus()
      input.click()
    }
  }

  return (
    <div class="screen-head date-nav">
      <button
        class="btn btn-small btn-ghost nav-arrow"
        aria-label="Previous day"
        disabled={!store.canStepBack()}
        onClick={() => void store.stepDay(-1)}
      >
        ‹
      </button>
      <div class="date-title">
        <button class="date-button" onClick={openPicker} aria-label="Choose a date">
          <h1>{formatDisplayDate(date)}</h1>
        </button>
        <input
          ref={pickerRef}
          class="visually-hidden-input"
          type="date"
          tabIndex={-1}
          aria-hidden="true"
          value={date}
          max={today()}
          {...(store.earliestDate.value ? { min: store.earliestDate.value } : {})}
          onChange={(e) => {
            const v = (e.target as HTMLInputElement).value
            if (v) void store.goToDate(v)
          }}
        />
      </div>
      <button
        class="btn btn-small btn-ghost nav-arrow"
        aria-label="Next day"
        disabled={!store.canStepForward()}
        onClick={() => void store.stepDay(1)}
      >
        ›
      </button>
      {!isToday && (
        <button class="btn btn-small" onClick={() => void store.goToDate(today())}>
          Today
        </button>
      )}
    </div>
  )
}

/**
 * Swipe left for the next day, right for the previous one -- arrows on a
 * phone are a small target. Ignored when the gesture starts on a chart,
 * which pans on drag, or in a field.
 */
function useSwipe(): {
  onTouchStart: (e: TouchEvent) => void
  onTouchEnd: (e: TouchEvent) => void
} {
  const start = useRef<{ x: number; y: number } | undefined>(undefined)
  return {
    onTouchStart: (e) => {
      const t = e.touches[0]
      const target = e.target as HTMLElement | null
      if (!t || target?.closest('.chart-wrap, input, textarea, select, .sheet')) {
        start.current = undefined
        return
      }
      start.current = { x: t.clientX, y: t.clientY }
    },
    onTouchEnd: (e) => {
      const s = start.current
      const t = e.changedTouches[0]
      start.current = undefined
      if (!s || !t) return
      const dx = t.clientX - s.x
      const dy = t.clientY - s.y
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 2) return
      void store.stepDay(dx < 0 ? 1 : -1)
    },
  }
}

function ProteinDistribution() {
  const rollup = store.rollup.value
  const weightKg = store.currentWeightKg.value
  const resolved = store.targets.value
  if (!rollup || weightKg === undefined || !resolved) return null

  const { clearing, total, threshold, unknown } = occasionsClearingProtein(rollup, weightKg)
  const perOccasion = perOccasionProteinTarget(resolved.targets.protein.value)

  return (
    <div style="margin-top:12px">
      <div class="row-between" style="margin-bottom:6px">
        <span class="faint">
          {clearing} of {total} occasions past {fmt(threshold)} g
          {unknown > 0 && ` · ${unknown} not known yet`}
        </span>
        <span class="faint">aim {fmt(perOccasion)} g each</span>
      </div>
      <div class="row" style="gap:5px">
        {rollup.occasions.map((o) => {
          const pct = Math.min(100, (o.proteinG / perOccasion) * 100)
          const state =
            o.proteinG >= threshold ? 'in' : !o.proteinComplete ? 'unknown' : 'near'
          return (
            <div
              key={o.id}
              style="flex:1"
              title={`${o.startsAt} · ${o.proteinComplete ? '' : 'at least '}${fmt(o.proteinG, 1)} g`}
            >
              <div class="band">
                <div class="band-fill" data-state={state} style={`width:${pct}%`} />
              </div>
              <div class="faint" style="text-align:center;margin-top:3px;font-size:0.7rem">
                {o.proteinComplete ? '' : '≥'}
                {fmt(o.proteinG)}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function entryName(e: Entry): string {
  if (e.source.kind !== 'composite') return e.source.name
  return store.tombstoneById.value.has(e.source.compositeId)
    ? `${e.source.name} (deleted)`
    : e.source.name
}

function Occasions() {
  const rollup = store.rollup.value
  const entries = store.entries.value
  const [editing, setEditing] = useState<Entry | undefined>(undefined)
  const [confirmDelete, setConfirmDelete] = useState<string | undefined>(undefined)

  async function remove(e: Entry): Promise<void> {
    if (e.source.kind === 'composite') await repo.deleteCompositeLog(e.id)
    else await repo.deleteEntry(e.id)
    setConfirmDelete(undefined)
    await store.afterEdit([e.date])
  }

  if (!rollup || rollup.occasions.length === 0) {
    return (
      <Empty>
        {store.isToday.value ? 'Nothing logged yet today.' : 'Nothing logged on this day.'}
      </Empty>
    )
  }

  return (
    <div style="display:flex;flex-direction:column;gap:14px">
      {rollup.occasions.map((o) => (
        <div class="occasion" key={o.id}>
          <div class="row-between">
            <strong>{o.id.startsWith('auto-') ? o.startsAt : `${capitalise(o.id)} · ${o.startsAt}`}</strong>
            <span class="faint">
              <AggregateText agg={o.nutrients.kcal} unit="kcal" /> ·{' '}
              <AggregateText agg={o.nutrients.protein} dp={1} unit="g protein" />
            </span>
          </div>
          {o.entryIds.map((id) => {
            const e = entries.find((x) => x.id === id)
            if (!e) return null
            const isNested = e.fromCompositeEntryId !== undefined
            const partial = ESTIMATED_FIDELITIES.has(e.fidelity) || e.proxyFor !== undefined
            return (
              <div key={id}>
                <div
                  class={`entry-row${isNested ? ' nested' : ''}${partial ? ' fidelity-partial' : ''}`}
                >
                  <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0">
                    {e.source.kind === 'composite' ? (
                      <strong>{entryName(e)}</strong>
                    ) : (
                      entryName(e)
                    )}
                    {e.proxyFor && <span class="faint"> · for {e.proxyFor.note}</span>}
                    {!isNested && e.fidelity === 'ai_estimated' && (
                      <span class="source-tag">estimate</span>
                    )}
                    {isNested && e.lineSource && e.lineSource !== 'db' && (
                      <span class="source-tag">{e.lineSource}</span>
                    )}
                  </span>
                  <span class="grams">
                    {formatFood(e.grams, store.units.value.food)} ·{' '}
                    {e.nutrients.kcal === null ? '? kcal' : `${fmt(e.nutrients.kcal)} kcal`}
                  </span>
                </div>
                {!isNested && (
                  <div class="entry-actions">
                    <button class="btn btn-small btn-ghost" onClick={() => setEditing(e)}>
                      Edit
                    </button>
                    {confirmDelete === e.id ? (
                      <>
                        <button class="btn btn-small btn-ghost btn-danger" onClick={() => void remove(e)}>
                          Delete {e.source.kind === 'composite' ? 'the whole meal' : 'it'}
                        </button>
                        <button class="btn btn-small btn-ghost" onClick={() => setConfirmDelete(undefined)}>
                          Keep
                        </button>
                      </>
                    ) : (
                      <button class="btn btn-small btn-ghost" onClick={() => setConfirmDelete(e.id)}>
                        Delete
                      </button>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      ))}
      {editing && <EditEntrySheet entry={editing} onClose={() => setEditing(undefined)} />}
    </div>
  )
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/**
 * Body weight and waist. Either field takes either unit: a bare number is the
 * preferred unit and a suffix overrides it, so "92.6kg" typed where pounds
 * are preferred converts rather than fails. Storage is always kilograms and
 * centimetres.
 */
function WeightSheet(props: { onClose: () => void }) {
  const units = store.units.value
  const existing = store.rollup.value?.weightKg
  const existingWaist = store.day.value?.waistCm
  const [weight, setWeight] = useState(
    existing !== undefined ? bodyWeightInputValue(existing, units.bodyWeight) : '',
  )
  const [waist, setWaist] = useState(
    existingWaist !== undefined ? waistInputValue(existingWaist, units.waist) : '',
  )
  const kg = parseBodyWeight(weight, units.bodyWeight)
  const waistCm = waist.trim() === '' ? undefined : parseLength(waist, units.waist)
  const waistInvalid = waist.trim() !== '' && waistCm === undefined

  async function save(): Promise<void> {
    if (kg === undefined || waistInvalid) return
    const date = store.selectedDate.value
    await repo.setWeight(date, kg)
    if (waistCm !== undefined) await repo.setWaist(date, waistCm)
    await store.afterEdit([date])
    store.notify('Weight saved.')
    props.onClose()
  }

  return (
    <Sheet title="Weight" onClose={props.onClose}>
      <label>
        Weight ({BODY_WEIGHT_LABEL[units.bodyWeight]})
        <input
          type="text"
          inputMode="decimal"
          autoFocus
          value={weight}
          placeholder={units.bodyWeight === 'lb' ? '204.2' : '92.6'}
          onInput={(e) => setWeight((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save()
          }}
        />
      </label>
      {kg !== undefined && (
        <div class="faint">
          <BodyWeight kg={kg} unit={units.bodyWeight} /> — stored in kilograms.
        </div>
      )}
      {weight.trim() !== '' && kg === undefined && (
        <div class="faint">Enter a number, optionally with lb or kg.</div>
      )}
      <label>
        Waist ({WAIST_LABEL[units.waist]}, optional)
        <input
          type="text"
          inputMode="decimal"
          value={waist}
          placeholder={units.waist === 'in' ? '34' : '86'}
          onInput={(e) => setWaist((e.target as HTMLInputElement).value)}
        />
      </label>
      <div class="faint">
        The headline figure everywhere in the app is the smoothed trend, not
        this reading. A single day's weight is mostly water.
      </div>
      <button
        class="btn btn-primary btn-wide"
        disabled={kg === undefined || waistInvalid}
        onClick={() => void save()}
      >
        Save
      </button>
    </Sheet>
  )
}
