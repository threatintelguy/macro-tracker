/**
 * Log.
 *
 * Defaults to the ranked composite list -- the steady-state common case is
 * two taps from here. Below it: search, barcode, portion picker, and the
 * weighing flow, which is reachable in one tap and is the default action in
 * calibration.
 *
 * The full diary is accessible but is not the landing view.
 */

import { useMemo, useState } from 'preact/hooks'
import * as store from '../store.ts'
import * as repo from '../../data/repositories.ts'
import { formatDisplayDate, today } from '../../domain/dates.ts'
import { Empty, Sheet, fmt } from '../components/common.tsx'
import { WeighFlow } from '../components/WeighFlow.tsx'
import { CompositeLogSheet } from '../components/CompositeLogSheet.tsx'
import { CompositeEditor } from '../components/CompositeEditor.tsx'
import { BarcodeSheet } from '../components/BarcodeSheet.tsx'
import { CustomFoodSheet } from '../components/CustomFoodSheet.tsx'
import { QuickLogSheet } from '../components/QuickLogSheet.tsx'
import type { FoodItem } from '../../domain/types.ts'

export function Log() {
  const [weighing, setWeighing] = useState(false)
  const [logComposite, setLogComposite] = useState<string | undefined>(undefined)
  const [editing, setEditing] = useState<{ id?: string } | undefined>(undefined)
  const [showBarcode, setShowBarcode] = useState(false)
  const [showCustom, setShowCustom] = useState(false)
  const [quickFood, setQuickFood] = useState<FoodItem | undefined>(undefined)
  const [showDiary, setShowDiary] = useState(false)
  const [query, setQuery] = useState('')

  const ranked = store.rankedComposites.value
  const composite = store.composites.value.find((c) => c.id === logComposite)
  const editTarget = editing?.id
    ? store.composites.value.find((c) => c.id === editing.id)
    : undefined

  const results = useMemo(
    () => (query.trim().length > 0 ? store.searchIndex.value.search(query, 12) : []),
    [query, store.foodIndexVersion.value],
  )

  return (
    <div class="screen">
      <div class="screen-head">
        <h1>Log</h1>
        <span class="faint">{formatDisplayDate(store.selectedDate.value)}</span>
      </div>

      {store.selectedDate.value !== today() && (
        <div class="notice">
          Logging to {formatDisplayDate(store.selectedDate.value)}. Any day is
          editable at any time.
        </div>
      )}

      <div class="card">
        <div class="card-title">Your meals</div>
        <div class="list">
          {ranked.map((r) => (
            <button
              key={r.composite.id}
              class="list-item"
              onClick={() => setLogComposite(r.composite.id)}
            >
              <div style="flex:1;min-width:0">
                <div class="title">{r.composite.name}</div>
                <div class="meta">
                  {r.composite.components.length} components
                  {r.usageCount > 0
                    ? ` · logged ${r.usageCount}×`
                    : ' · not yet logged'}
                  {r.hourMatches > 0 && ' · usual about now'}
                </div>
              </div>
              <span class="faint">Log</span>
            </button>
          ))}
          {ranked.length === 0 && (
            <Empty>
              Nothing here yet. Weigh a meal and tick "save this meal as a
              composite" — the library builds itself from what you actually eat.
            </Empty>
          )}
        </div>
        <button
          class="btn btn-small btn-ghost btn-wide"
          style="margin-top:10px"
          onClick={() => setEditing({})}
        >
          Build a composite by hand
        </button>
      </div>

      <button class="btn btn-primary btn-wide" onClick={() => setWeighing(true)}>
        Weigh and log
      </button>

      <div class="card">
        <div class="card-title">Search a single food</div>
        <input
          type="search"
          placeholder="Search foods"
          value={query}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
        />
        {results.length > 0 && (
          <div class="list" style="margin-top:10px">
            {results.map((r) => (
              <button
                key={r.food.id}
                class="list-item"
                onClick={() => setQuickFood(r.food)}
              >
                <div style="flex:1;min-width:0">
                  <div class="title">{r.food.name}</div>
                  <div class="meta">
                    {fmt(r.food.per100g.kcal)} kcal ·{' '}
                    {fmt(r.food.per100g.protein, 1)} g protein per 100 g
                  </div>
                </div>
                <span class="tier-tag" data-tier={r.food.tier}>
                  {r.food.tier}
                </span>
              </button>
            ))}
          </div>
        )}
        <div class="row" style="gap:8px;margin-top:10px">
          <button class="btn btn-small" onClick={() => setShowBarcode(true)}>
            Barcode
          </button>
          <button class="btn btn-small btn-ghost" onClick={() => setShowCustom(true)}>
            New food
          </button>
        </div>
      </div>

      <button class="btn btn-wide btn-ghost" onClick={() => setShowDiary(true)}>
        Full diary for this day
      </button>

      {weighing && <WeighFlow onClose={() => setWeighing(false)} />}
      {composite && (
        <CompositeLogSheet
          composite={composite}
          onClose={() => setLogComposite(undefined)}
        />
      )}
      {editing && (
        <CompositeEditor
          {...(editTarget ? { composite: editTarget } : {})}
          onClose={() => setEditing(undefined)}
        />
      )}
      {showBarcode && (
        <BarcodeSheet
          onClose={() => setShowBarcode(false)}
          onResolved={(food) => {
            setShowBarcode(false)
            setQuickFood(food)
          }}
        />
      )}
      {showCustom && (
        <CustomFoodSheet
          onClose={() => setShowCustom(false)}
          onSaved={(food) => {
            setShowCustom(false)
            setQuickFood(food)
          }}
        />
      )}
      {quickFood && (
        <QuickLogSheet food={quickFood} onClose={() => setQuickFood(undefined)} />
      )}
      {showDiary && <Diary onClose={() => setShowDiary(false)} />}
    </div>
  )
}

function Diary(props: { onClose: () => void }) {
  const entries = store.entries.value
  const rollup = store.rollup.value

  async function remove(id: string, isComposite: boolean): Promise<void> {
    if (isComposite) await repo.deleteCompositeLog(id)
    else await repo.deleteEntry(id)
    await store.refreshDay()
    await store.refreshHistory()
  }

  return (
    <Sheet
      title={`Diary — ${formatDisplayDate(store.selectedDate.value)}`}
      onClose={props.onClose}
    >
      {rollup && (
        <div class="running-total">
          <div class="n">
            <span>kcal</span>
            <span>{fmt(rollup.totals.kcal)}</span>
          </div>
          <div class="n">
            <span>Protein</span>
            <span>{fmt(rollup.totals.protein, 1)}</span>
          </div>
          <div class="n">
            <span>Carbs</span>
            <span>{fmt(rollup.totals.carbs, 1)}</span>
          </div>
          <div class="n">
            <span>Fat</span>
            <span>{fmt(rollup.totals.fat, 1)}</span>
          </div>
        </div>
      )}

      <div class="list">
        {entries.length === 0 && <Empty>Nothing logged on this day.</Empty>}
        {entries
          .filter((e) => e.fromCompositeEntryId === undefined)
          .map((e) => {
            const children = entries.filter((c) => c.fromCompositeEntryId === e.id)
            return (
              <div class="list-item" key={e.id} style="flex-direction:column;align-items:stretch;gap:6px">
                <div class="row-between">
                  <div style="min-width:0">
                    <div class="title">{e.source.name}</div>
                    <div class="meta">
                      {e.at ?? '--:--'} · {fmt(e.grams)} g ·{' '}
                      {fmt(e.nutrients.kcal)} kcal
                      {e.source.kind === 'composite' &&
                        ` · ${e.source.multiplier}× v${e.source.version}`}
                    </div>
                  </div>
                  <button
                    class="btn btn-small btn-ghost btn-danger"
                    onClick={() =>
                      void remove(e.id, e.source.kind === 'composite')
                    }
                  >
                    Delete
                  </button>
                </div>
                {children.map((c) => (
                  <div class="entry-row nested" key={c.id}>
                    <span>{c.source.name}</span>
                    <span class="grams">
                      {fmt(c.grams)} g · {fmt(c.nutrients.kcal)} kcal
                    </span>
                  </div>
                ))}
              </div>
            )
          })}
      </div>
    </Sheet>
  )
}
