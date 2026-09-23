/**
 * Pick one food from search. Used to change an entry's food, to choose the
 * near match to clone, and to choose a stand-in.
 */

import { useMemo, useState } from 'preact/hooks'
import type { FoodItem } from '../../domain/types.ts'
import * as store from '../store.ts'
import { Sheet, fmt } from './common.tsx'

export function FoodPickerSheet(props: {
  title: string
  hint?: string
  initialQuery?: string
  onPick: (food: FoodItem) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState(props.initialQuery ?? '')
  const results = useMemo(
    () => store.searchIndex.value.search(query, 14),
    [query, store.foodIndexVersion.value],
  )

  return (
    <Sheet title={props.title} onClose={props.onClose}>
      {props.hint && <div class="faint">{props.hint}</div>}
      <input
        type="search"
        placeholder="Search foods"
        value={query}
        autoFocus
        onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
      />
      <div class="list">
        {results.length === 0 && <div class="empty">Nothing matched.</div>}
        {results.map((r) => (
          <button key={r.food.id} class="list-item" onClick={() => props.onPick(r.food)}>
            <div style="flex:1;min-width:0">
              <div class="title">{r.food.name}</div>
              <div class="meta">
                {fmt(r.food.per100g.kcal)} kcal · {fmt(r.food.per100g.protein, 1)} g
                protein per 100 g
              </div>
            </div>
            <span class="tier-tag" data-tier={r.food.tier}>
              {r.food.tier}
            </span>
          </button>
        ))}
      </div>
    </Sheet>
  )
}
