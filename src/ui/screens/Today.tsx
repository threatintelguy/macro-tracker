/**
 * Today.
 *
 * Priority order, following the guidance:
 *   1. Protein — today against target, plus the 7-day average. Largest.
 *   2. Calories — today against target, plus the 7-day average.
 *   3. Weight trend — the trend value, not today's reading.
 *   4. Carbs and fat — compact, secondary.
 *   5. Fibre and saturated fat — 7-day averages against their bands.
 *
 * In calibration, items 1–5 are replaced by a completion meter showing both
 * days elapsed and composite-library coverage, plus the weighed diary.
 */

import { useState } from 'preact/hooks'
import type { TargetKey } from '../../domain/types.ts'
import * as store from '../store.ts'
import * as repo from '../../data/repositories.ts'
import {
  CEILING_TARGETS,
  TARGET_UNITS,
} from '../../domain/engine/targets.ts'
import {
  occasionsClearingProtein,
  fidelityLabel,
} from '../../domain/analytics/index.ts'
import { perOccasionProteinTarget } from '../../domain/nutrition/index.ts'
import { formatDisplayDate, today } from '../../domain/dates.ts'
import { Band, Empty, Meter, ProvenanceSheet, Sheet, fmt } from '../components/common.tsx'
import { TrendSparkline, WeightChart, type Horizon } from '../components/WeightChart.tsx'
import { WeighFlow } from '../components/WeighFlow.tsx'
import { CompositeLogSheet } from '../components/CompositeLogSheet.tsx'

export function Today() {
  const [explain, setExplain] = useState<TargetKey | undefined>(undefined)
  const [showWeight, setShowWeight] = useState(false)
  const [horizon, setHorizon] = useState<Horizon>(90)
  const [weighing, setWeighing] = useState(false)
  const [logComposite, setLogComposite] = useState<string | undefined>(undefined)

  const rollup = store.rollup.value
  const resolved = store.targets.value
  const seven = store.sevenDay.value
  const progress = store.progress.value
  const date = store.selectedDate.value
  const inCalibration = store.profile.value?.phase !== 'steady'

  const totals = rollup?.totals
  const composite = store.composites.value.find((c) => c.id === logComposite)

  function value(key: TargetKey): number {
    if (!totals) return 0
    return key === 'kcal' ? totals.kcal : totals[key as keyof typeof totals]
  }

  return (
    <div class="screen">
      <div class="screen-head">
        <h1>{formatDisplayDate(date)}</h1>
        {date !== today() && (
          <button
            class="btn btn-small btn-ghost"
            onClick={() => {
              store.selectedDate.value = today()
              void store.refreshDay()
            }}
          >
            Back to today
          </button>
        )}
      </div>

      {!resolved && (
        <div class="notice">
          Enter your weight to set targets. Everything downstream uses the
          weight trend, so the first reading is where the app starts.
        </div>
      )}

      {inCalibration && progress && (
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
                {fmt(value('protein'))}
                <span style="font-size:1.2rem;color:var(--text-dim)">
                  {' '}
                  / {fmt(resolved.targets.protein.value)} g
                </span>
              </span>
              {seven && (
                <span class="sub">
                  7-day average {fmt(seven.protein)} g over {seven.days} days
                </span>
              )}
            </button>
          </div>
          <div style="margin-top:10px">
            <Band
              value={value('protein')}
              target={resolved.targets.protein.value}
            />
          </div>

          {rollup && rollup.occasions.length > 0 && store.currentWeightKg.value !== undefined && (
            <ProteinDistribution />
          )}
        </div>
      )}

      {/* 2. Calories. */}
      {resolved && (
        <div class="card">
          <button class="stat-hero explainable" onClick={() => setExplain('kcal')}>
            <span class="label">Calories</span>
            <span class="value" style="font-size:2rem">
              {fmt(value('kcal'))}
              <span style="font-size:1.05rem;color:var(--text-dim)">
                {' '}
                / {fmt(resolved.targets.kcal.value)}
              </span>
            </span>
            {seven && (
              <span class="sub">7-day average {fmt(seven.kcal)} kcal</span>
            )}
          </button>
          <div style="margin-top:10px">
            <Band value={value('kcal')} target={resolved.targets.kcal.value} />
          </div>
        </div>
      )}

      {/* 3. Weight trend — the trend value, never today's reading. */}
      <div class="card">
        <div class="row-between">
          <div class="stat">
            <span class="label">Weight trend</span>
            <span class="value">
              {store.currentWeightKg.value !== undefined
                ? `${fmt(store.currentWeightKg.value, 2)} kg`
                : '—'}
            </span>
            <span class="sub">
              {rollup?.weightKg !== undefined
                ? `today's reading ${fmt(rollup.weightKg, 1)} kg`
                : 'no reading today'}
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
      {resolved && (
        <div class="grid-2">
          {(['carbs', 'fat'] as const).map((key) => (
            <div class="card" key={key}>
              <button class="stat explainable" onClick={() => setExplain(key)}>
                <span class="label">{key === 'carbs' ? 'Carbs' : 'Fat'}</span>
                <span class="value">
                  {fmt(value(key))}
                  <span style="font-size:0.85rem;color:var(--text-dim)">
                    {' '}
                    / {fmt(resolved.targets[key].value)} g
                  </span>
                </span>
              </button>
              <div style="margin-top:8px">
                <Band value={value(key)} target={resolved.targets[key].value} />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 5. Fibre and saturated fat — 7-day averages against their bands. */}
      {resolved && seven && (
        <div class="card">
          <div class="card-title">7-day averages</div>
          <div class="grid-2">
            {(['fibre', 'satFat'] as const).map((key) => (
              <div key={key}>
                <button class="stat explainable" onClick={() => setExplain(key)}>
                  <span class="label">
                    {key === 'fibre' ? 'Fibre' : 'Saturated fat'}
                  </span>
                  <span class="value" style="font-size:1.1rem">
                    {fmt(key === 'fibre' ? seven.fibre : seven.satFat, 1)}
                    <span style="font-size:0.8rem;color:var(--text-dim)">
                      {' '}
                      / {fmt(resolved.targets[key].value)} {TARGET_UNITS[key]}
                    </span>
                  </span>
                </button>
                <div style="margin-top:6px">
                  <Band
                    value={key === 'fibre' ? seven.fibre : seven.satFat}
                    target={resolved.targets[key].value}
                    isCeiling={CEILING_TARGETS.has(key)}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Today's occasions, with their protein totals. */}
      <div class="card">
        <div class="row-between" style="margin-bottom:8px">
          <div class="card-title" style="margin:0">
            Today's occasions
          </div>
          <span class="faint">
            {rollup ? fidelityLabel(lowestFidelity(rollup.fidelities)) : ''}
          </span>
        </div>
        <Occasions />
      </div>

      {/* Composites ranked most likely for the current hour. */}
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

      <button class="btn btn-primary btn-wide" onClick={() => setWeighing(true)}>
        Weigh and log
      </button>

      {explain && resolved && (
        <ProvenanceSheet
          targetKey={explain}
          target={resolved.targets[explain]}
          todayValue={value(explain)}
          {...(seven && (explain === 'protein' || explain === 'kcal' || explain === 'carbs' || explain === 'fat' || explain === 'fibre' || explain === 'satFat')
            ? { sevenDayValue: seven[explain as keyof typeof seven] as number }
            : {})}
          onClose={() => setExplain(undefined)}
        />
      )}

      {showWeight && <WeightSheet onClose={() => setShowWeight(false)} />}
      {weighing && <WeighFlow onClose={() => setWeighing(false)} />}
      {composite && (
        <CompositeLogSheet
          composite={composite}
          onClose={() => setLogComposite(undefined)}
        />
      )}
    </div>
  )
}

function lowestFidelity(
  fidelities: readonly ('weighed' | 'portioned' | 'estimated' | 'flagged')[],
): 'weighed' | 'portioned' | 'estimated' | 'flagged' {
  const order = ['weighed', 'portioned', 'estimated', 'flagged'] as const
  let worst = 0
  for (const f of fidelities) worst = Math.max(worst, order.indexOf(f))
  return order[worst] ?? 'weighed'
}

function ProteinDistribution() {
  const rollup = store.rollup.value
  const weightKg = store.currentWeightKg.value
  const resolved = store.targets.value
  if (!rollup || weightKg === undefined || !resolved) return null

  const { clearing, total, threshold } = occasionsClearingProtein(rollup, weightKg)
  const perOccasion = perOccasionProteinTarget(resolved.targets.protein.value)

  return (
    <div style="margin-top:12px">
      <div class="row-between" style="margin-bottom:6px">
        <span class="faint">
          {clearing} of {total} occasions past {fmt(threshold)} g
        </span>
        <span class="faint">aim {fmt(perOccasion)} g each</span>
      </div>
      <div class="row" style="gap:5px">
        {rollup.occasions.map((o) => {
          const pct = Math.min(100, (o.proteinG / perOccasion) * 100)
          return (
            <div
              key={o.id}
              style="flex:1"
              title={`${o.startsAt} · ${fmt(o.proteinG, 1)} g`}
            >
              <div class="band">
                <div
                  class="band-fill"
                  data-state={o.proteinG >= threshold ? 'in' : 'near'}
                  style={`width:${pct}%`}
                />
              </div>
              <div class="faint" style="text-align:center;margin-top:3px;font-size:0.7rem">
                {fmt(o.proteinG)}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Occasions() {
  const rollup = store.rollup.value
  const entries = store.entries.value

  if (!rollup || rollup.occasions.length === 0) {
    return <Empty>Nothing logged yet today.</Empty>
  }

  return (
    <div style="display:flex;flex-direction:column;gap:14px">
      {rollup.occasions.map((o) => (
        <div class="occasion" key={o.id}>
          <div class="row-between">
            <strong>{o.startsAt}</strong>
            <span class="faint">
              {fmt(o.nutrients.kcal)} kcal · {fmt(o.proteinG, 1)} g protein
            </span>
          </div>
          {o.entryIds.map((id) => {
            const e = entries.find((x) => x.id === id)
            if (!e) return null
            const isNested = e.fromCompositeEntryId !== undefined
            return (
              <div
                class={`entry-row${isNested ? ' nested' : ''}${e.fidelity === 'estimated' || e.fidelity === 'flagged' ? ' fidelity-partial' : ''}`}
                key={id}
              >
                <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                  {e.source.kind === 'composite' ? (
                    <strong>{e.source.name}</strong>
                  ) : (
                    e.source.name
                  )}
                </span>
                <span class="grams">
                  {fmt(e.grams)} g · {fmt(e.nutrients.kcal)} kcal
                </span>
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}

function WeightSheet(props: { onClose: () => void }) {
  const existing = store.rollup.value?.weightKg
  const [kg, setKg] = useState(existing !== undefined ? String(existing) : '')

  async function save(): Promise<void> {
    const v = Number(kg)
    if (!Number.isFinite(v) || v <= 0) return
    await repo.setWeight(store.selectedDate.value, v)
    await store.refreshDay()
    await store.refreshHistory()
    store.notify('Weight saved.')
    props.onClose()
  }

  return (
    <Sheet title="Weight" onClose={props.onClose}>
      <label>
        Kilograms
        <input
          type="number"
          inputMode="decimal"
          step="0.1"
          autoFocus
          value={kg}
          onInput={(e) => setKg((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save()
          }}
        />
      </label>
      <div class="faint">
        The headline figure everywhere in the app is the smoothed trend, not
        this reading. A single day's weight is mostly water.
      </div>
      <button class="btn btn-primary btn-wide" onClick={() => void save()}>
        Save
      </button>
    </Sheet>
  )
}
