/**
 * Pick one food from search. Used to change an entry's food, to choose the
 * near match to clone, and to choose a stand-in.
 */

import { useMemo, useState } from 'preact/hooks'
import type { FoodItem } from '../../domain/types.ts'
import * as store from '../store.ts'
import { Sheet } from './common.tsx'
import { OnlineSearch, ResultRow } from './FoodSearch.tsx'

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
          <ResultRow key={r.food.id} result={r} onPick={props.onPick} />
        ))}
      </div>
      <OnlineSearch query={query} onAccepted={props.onPick} />
    </Sheet>
  )
}
