/**
 * Log.
 *
 * Defaults to the ranked composite list -- the steady-state common case is
 * two taps from here. Below it: search, barcode, portion picker, and the
 * weighing flow, which is reachable in one tap and is the default action in
 * calibration. In minimal mode, the single protein-and-flag entry leads.
 *
 * When search comes up empty -- or none of the matches fit -- four routes
 * are offered, in this order, because the order is the design:
 *
 *   1. Build it from ingredients -- most missing foods are combinations of
 *      foods that are present, and a composite gives a full panel.
 *   2. Close, but not quite -- fork the nearest match and adjust it.
 *   3. Enter only what you know -- a name and whatever figures exist.
 *   4. Log a stand-in -- a similar food, marked as such, for later.
 *
 * "Create a custom food" first would put the route that demands the most at
 * the top, and the realistic outcome of that is an unlogged meal.
 */

import { useMemo, useState } from 'preact/hooks'
import * as store from '../store.ts'
import * as repo from '../../data/repositories.ts'
import { formatDisplayDate, today } from '../../domain/dates.ts'
import { AggregateText, Empty, Sheet, fmt } from '../components/common.tsx'
import { WeighFlow } from '../components/WeighFlow.tsx'
import { CompositeLogSheet } from '../components/CompositeLogSheet.tsx'
import { CompositeEditor } from '../components/CompositeEditor.tsx'
import { BarcodeSheet } from '../components/BarcodeSheet.tsx'
import { CustomFoodSheet } from '../components/CustomFoodSheet.tsx'
import { QuickLogSheet } from '../components/QuickLogSheet.tsx'
import { FoodPickerSheet } from '../components/FoodPickerSheet.tsx'
import { NeedsDetailSheet } from '../components/NeedsDetailSheet.tsx'
import { EditEntrySheet } from '../components/EditEntrySheet.tsx'
import { MinimalEntrySheet } from '../components/MinimalEntrySheet.tsx'
import type { Entry, FoodItem } from '../../domain/types.ts'

type Route =
  | { kind: 'build'; name: string }
  | { kind: 'clone-pick'; query: string }
  | { kind: 'clone'; food: FoodItem }
  | { kind: 'known'; name: string }
  | { kind: 'proxy-pick'; query: string }
  | { kind: 'proxy'; food: FoodItem; note: string }

export function Log() {
  const [weighing, setWeighing] = useState(false)
  const [logComposite, setLogComposite] = useState<string | undefined>(undefined)
  const [editing, setEditing] = useState<{ id?: string } | undefined>(undefined)
  const [showBarcode, setShowBarcode] = useState(false)
  const [showCustom, setShowCustom] = useState(false)
  const [quickFood, setQuickFood] = useState<FoodItem | undefined>(undefined)
  const [showDiary, setShowDiary] = useState(false)
  const [showNeedsDetail, setShowNeedsDetail] = useState(false)
  const [minimalEntry, setMinimalEntry] = useState(false)
  const [query, setQuery] = useState('')
  const [rejected, setRejected] = useState(false)
  const [route, setRoute] = useState<Route | undefined>(undefined)

  const ranked = store.rankedComposites.value
  const composite = store.composites.value.find((c) => c.id === logComposite)
  const editTarget = editing?.id
    ? store.composites.value.find((c) => c.id === editing.id)
    : undefined
  const minimal = (store.day.value?.precisionMode ?? store.profile.value?.precisionMode) === 'minimal'

  const results = useMemo(
    () => (query.trim().length > 0 ? store.searchIndex.value.search(query, 12) : []),
    [query, store.foodIndexVersion.value],
  )
  const searched = query.trim().length > 0
  const showRoutes = searched && (results.length === 0 || rejected)

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

      {minimal && (
        <div class="card">
          <div class="card-title">Minimal entry</div>
          <div class="faint" style="margin-bottom:10px">
            Protein grams and a saturated-fat high or low. Anything weighed
            today is still stored at full detail.
          </div>
          <button class="btn btn-primary btn-wide" onClick={() => setMinimalEntry(true)}>
            Protein and saturated fat
          </button>
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
          onInput={(e) => {
            setQuery((e.target as HTMLInputElement).value)
            setRejected(false)
          }}
        />
        {results.length > 0 && !rejected && (
          <div class="list" style="margin-top:10px">
            {results.map((r) => (
              <div key={r.food.id} class="list-item result-row">
                <button class="plain-button result-main" onClick={() => setQuickFood(r.food)}>
                  <div class="title">{r.food.name}</div>
                  <div class="meta">
                    {fmt(r.food.per100g.kcal)} kcal ·{' '}
                    {fmt(r.food.per100g.protein, 1)} g protein per 100 g
                  </div>
                </button>
                <span class="tier-tag" data-tier={r.food.tier}>
                  {r.food.tier}
                </span>
                <button
                  class="btn btn-small btn-ghost"
                  onClick={() => setRoute({ kind: 'clone', food: r.food })}
                >
                  Close, but not quite
                </button>
              </div>
            ))}
            <button class="btn btn-small btn-ghost btn-wide" onClick={() => setRejected(true)}>
              None of these fit
            </button>
          </div>
        )}

        {showRoutes && (
          <div class="routes">
            <div class="faint">
              {results.length === 0
                ? `Nothing matched "${query.trim()}". Four ways to log it anyway:`
                : 'Four ways to log it anyway:'}
            </div>
            <button
              class="route"
              onClick={() => setRoute({ kind: 'build', name: query.trim() })}
            >
              <span class="route-title">Build it from ingredients</span>
              <span class="route-sub">
                A burrito is tortilla, rice, beans, chicken and cheese. Estimate
                each part and the full panel follows.
              </span>
            </button>
            <button
              class="route"
              onClick={() => setRoute({ kind: 'clone-pick', query: query.trim() })}
            >
              <span class="route-title">Start from something close</span>
              <span class="route-sub">
                Pick the nearest food and change what is different — full-fat
                rather than low, a thicker slice.
              </span>
            </button>
            <button
              class="route"
              onClick={() => setRoute({ kind: 'known', name: query.trim() })}
            >
              <span class="route-title">Enter only what you know</span>
              <span class="route-sub">
                The menu says 640 calories and nothing else? Enter 640 and stop.
                Blanks are stored as unknown, never as zero.
              </span>
            </button>
            <button
              class="route"
              onClick={() => setRoute({ kind: 'proxy-pick', query: query.trim() })}
            >
              <span class="route-title">Log a stand-in</span>
              <span class="route-sub">
                Pick something similar and mark it as standing in. It stays
                findable, so it can be swapped when the details turn up.
              </span>
            </button>
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

      <div class="row" style="gap:8px">
        <button class="btn btn-ghost" style="flex:1" onClick={() => setShowDiary(true)}>
          Full diary for this day
        </button>
        {store.needsDetailCount.value > 0 && (
          <button class="btn btn-ghost quiet-count" onClick={() => setShowNeedsDetail(true)}>
            {store.needsDetailCount.value} need detail
          </button>
        )}
      </div>

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
      {showNeedsDetail && <NeedsDetailSheet onClose={() => setShowNeedsDetail(false)} />}
      {minimalEntry && <MinimalEntrySheet onClose={() => setMinimalEntry(false)} />}

      {route?.kind === 'build' && (
        <WeighFlow estimate={{ name: route.name }} onClose={() => setRoute(undefined)} />
      )}
      {route?.kind === 'clone-pick' && (
        <FoodPickerSheet
          title="Start from something close"
          hint="Pick the nearest match. You will change what is different next."
          initialQuery={route.query}
          onClose={() => setRoute(undefined)}
          onPick={(food) => setRoute({ kind: 'clone', food })}
        />
      )}
      {route?.kind === 'clone' && (
        <CustomFoodSheet
          cloneFrom={route.food}
          onClose={() => setRoute(undefined)}
          onSaved={(food) => {
            setRoute(undefined)
            setQuickFood(food)
          }}
        />
      )}
      {route?.kind === 'known' && (
        <CustomFoodSheet
          initialName={route.name}
          onClose={() => setRoute(undefined)}
          onSaved={(food) => {
            setRoute(undefined)
            setQuickFood(food)
          }}
        />
      )}
      {route?.kind === 'proxy-pick' && (
        <FoodPickerSheet
          title="Log a stand-in"
          hint="Pick something similar. It will be logged as an estimate and marked as standing in."
          initialQuery=""
          onClose={() => setRoute(undefined)}
          onPick={(food) => setRoute({ kind: 'proxy', food, note: route.query })}
        />
      )}
      {route?.kind === 'proxy' && (
        <QuickLogSheet
          food={route.food}
          proxyFor={route.note}
          onClose={() => setRoute(undefined)}
        />
      )}
    </div>
  )
}

function Diary(props: { onClose: () => void }) {
  const entries = store.entries.value
  const rollup = store.rollup.value
  const [editing, setEditing] = useState<Entry | undefined>(undefined)

  async function remove(e: Entry): Promise<void> {
    if (e.source.kind === 'composite') await repo.deleteCompositeLog(e.id)
    else await repo.deleteEntry(e.id)
    await store.afterEdit([e.date])
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
            <span><AggregateText agg={rollup.totals.kcal} /></span>
          </div>
          <div class="n">
            <span>Protein</span>
            <span><AggregateText agg={rollup.totals.protein} dp={1} /></span>
          </div>
          <div class="n">
            <span>Carbs</span>
            <span><AggregateText agg={rollup.totals.carbs} dp={1} /></span>
          </div>
          <div class="n">
            <span>Fat</span>
            <span><AggregateText agg={rollup.totals.fat} dp={1} /></span>
          </div>
        </div>
      )}

      <div class="list">
        {entries.length === 0 && <Empty>Nothing logged on this day.</Empty>}
        {entries
          .filter((e) => e.fromCompositeEntryId === undefined)
          .map((e) => {
            const children = entries.filter((c) => c.fromCompositeEntryId === e.id)
            const deleted =
              e.source.kind === 'composite' &&
              store.tombstoneById.value.has(e.source.compositeId)
            return (
              <div class="list-item" key={e.id} style="flex-direction:column;align-items:stretch;gap:6px">
                <div class="row-between">
                  <div style="min-width:0">
                    <div class="title">
                      {e.source.name}
                      {deleted && ' (deleted)'}
                    </div>
                    <div class="meta">
                      {e.at ?? '--:--'} · {fmt(e.grams)} g ·{' '}
                      {e.nutrients.kcal === null ? '? kcal' : `${fmt(e.nutrients.kcal)} kcal`}
                      {e.source.kind === 'composite' &&
                        ` · ${e.source.multiplier}× v${e.source.version}`}
                      {e.proxyFor && ` · stand-in for ${e.proxyFor.note}`}
                    </div>
                  </div>
                  <div class="row" style="gap:4px">
                    <button class="btn btn-small btn-ghost" onClick={() => setEditing(e)}>
                      Edit
                    </button>
                    <button
                      class="btn btn-small btn-ghost btn-danger"
                      onClick={() => void remove(e)}
                    >
                      Delete
                    </button>
                  </div>
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
      {editing && <EditEntrySheet entry={editing} onClose={() => setEditing(undefined)} />}
    </Sheet>
  )
}
