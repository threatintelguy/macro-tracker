/**
 * Search results, shared by every place that searches foods.
 *
 * Each row carries its origin badge; near-duplicates collapsed by ranking
 * stay reachable under a disclosure. Below local results sits the explicit
 * "Search online" action -- never automatic, only after local search, and
 * disabled by offline mode. Online results are set apart and labelled as not
 * yet on this device; accepting one writes it into the local library
 * permanently, where local search finds it from then on.
 */

import type { ComponentChildren } from 'preact'
import { useState } from 'preact/hooks'
import type { FoodItem, FoodOrigin } from '../../domain/types.ts'
import type { SearchResult } from '../../food/search.ts'
import { foodOrigin } from '../../food/search.ts'
import { searchOnline } from '../../food/online.ts'
import * as store from '../store.ts'
import { fmt } from './common.tsx'

export const ORIGIN_LABEL: Record<FoodOrigin, string> = {
  curated: 'curated',
  'usda-generic': 'usda',
  'usda-branded': 'branded',
  barcode: 'scanned',
  online: 'saved online',
  custom: 'yours',
}

export function OriginTag(props: { food: FoodItem }) {
  const origin = foodOrigin(props.food)
  return (
    <span class="tier-tag" data-tier={props.food.tier} data-origin={origin}>
      {props.food.estimate ? 'estimate' : ORIGIN_LABEL[origin]}
    </span>
  )
}

export function foodMeta(food: FoodItem): string {
  return `${food.brand ? `${food.brand} · ` : ''}${fmt(food.per100g.kcal)} kcal · ${fmt(food.per100g.protein, 1)} g protein per 100 g`
}

/** One result: the food, its badge, and any collapsed near-duplicates. */
export function ResultRow(props: {
  result: SearchResult
  onPick: (food: FoodItem) => void
  actions?: ComponentChildren
}) {
  const { result } = props
  return (
    <div class="list-item result-row" style="flex-wrap:wrap">
      <button class="plain-button result-main" onClick={() => props.onPick(result.food)}>
        <div class="title">{result.food.name}</div>
        <div class="meta">{foodMeta(result.food)}</div>
      </button>
      <OriginTag food={result.food} />
      {props.actions}
      {result.alternatives.length > 0 && (
        <details class="alternatives" style="flex-basis:100%">
          <summary>
            {result.alternatives.length} similar{' '}
            {result.alternatives.length === 1 ? 'entry' : 'entries'}
          </summary>
          <div class="list" style="margin-top:6px">
            {result.alternatives.map((alt) => (
              <button key={alt.id} class="list-item" onClick={() => props.onPick(alt)}>
                <div style="flex:1;min-width:0">
                  <div class="title">{alt.name}</div>
                  <div class="meta">{foodMeta(alt)}</div>
                </div>
                <OriginTag food={alt} />
              </button>
            ))}
          </div>
        </details>
      )}
    </div>
  )
}

/**
 * The explicit online search. Renders nothing for an empty query. The
 * request fires only on the tap, sends only the query, and is refused
 * outright in offline mode.
 */
export function OnlineSearch(props: { query: string; onAccepted: (food: FoodItem) => void }) {
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'busy' }
    | { kind: 'done'; query: string; foods: FoodItem[]; partial: boolean }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' })
  const q = props.query.trim()
  if (q.length === 0) return null

  const allowed = store.onlineSearchAllowed.value
  const stale = state.kind === 'done' && state.query !== q

  async function run(): Promise<void> {
    setState({ kind: 'busy' })
    const r = await searchOnline(q, {
      fetch: globalThis.fetch.bind(globalThis),
      enabled: store.onlineSearchAllowed.value,
    })
    if (!r.ok) {
      setState({ kind: 'error', message: r.message })
      return
    }
    // Anything already on this device is a local result, not an online one.
    const index = store.searchIndex.value
    const fresh = r.foods.filter((f) => !index.get(f.id) && !(f.barcode && index.barcode(f.barcode)))
    setState({ kind: 'done', query: q, foods: fresh, partial: r.partial })
  }

  async function accept(food: FoodItem): Promise<void> {
    await store.saveLocalFood({ ...food, createdAt: Date.now() })
    store.notify(`"${food.name}" saved to your foods — found locally from now on.`)
    props.onAccepted(food)
  }

  if (!allowed) {
    return (
      <div class="faint" style="margin-top:8px">
        {store.offline.value
          ? 'Offline mode is on, so online search is off.'
          : 'Online search is switched off in settings.'}
      </div>
    )
  }

  return (
    <div class="online-results">
      {(state.kind === 'idle' || stale || state.kind === 'error') && (
        <button class="btn btn-small btn-ghost btn-wide" onClick={() => void run()}>
          Search online for “{q}”
        </button>
      )}
      {state.kind === 'busy' && <div class="faint">Searching Open Food Facts and USDA…</div>}
      {state.kind === 'error' && <div class="faint">{state.message}</div>}
      {state.kind === 'done' && !stale && (
        <>
          <div class="card-title" style="margin:0">
            Online — not on this device yet
          </div>
          {state.foods.length === 0 && (
            <div class="faint">Nothing new online for that.</div>
          )}
          {state.partial && (
            <div class="faint">One of the two databases did not answer; these are from the other.</div>
          )}
          <div class="list">
            {state.foods.map((f) => (
              <div key={f.id} class="list-item result-row">
                <div class="result-main">
                  <div class="title">{f.name}</div>
                  <div class="meta">{foodMeta(f)}</div>
                </div>
                <button class="btn btn-small" onClick={() => void accept(f)}>
                  Add
                </button>
              </div>
            ))}
          </div>
          <div class="faint">
            Sent: the words “{q}”, nothing else. Whatever you add is kept on
            this device for good.
          </div>
        </>
      )}
    </div>
  )
}
