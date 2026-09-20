/**
 * Log a single food.
 *
 * Grams entry is `weighed`. Choosing a listed serving is `portioned` --
 * fidelity is recorded per entry, so a portion picked for convenience is
 * never later mistaken for a weighed figure.
 */

import { useState } from 'preact/hooks'
import type { Fidelity, FoodItem } from '../../domain/types.ts'
import { nutrientsForGrams } from '../../domain/nutrition/index.ts'
import * as repo from '../../data/repositories.ts'
import * as store from '../store.ts'
import { formatTime } from '../../domain/dates.ts'
import { Sheet, fmt } from './common.tsx'

export function QuickLogSheet(props: { food: FoodItem; onClose: () => void }) {
  const [grams, setGrams] = useState('100')
  const [fidelity, setFidelity] = useState<Fidelity>('weighed')

  const g = Number(grams)
  const valid = Number.isFinite(g) && g > 0
  const nutrients = valid
    ? nutrientsForGrams(props.food.per100g, g)
    : props.food.per100g

  async function log(): Promise<void> {
    if (!valid) return
    await repo.addEntry({
      date: store.selectedDate.value,
      at: formatTime(),
      source: { kind: 'food', foodId: props.food.id, name: props.food.name },
      grams: g,
      nutrients,
      fidelity,
    })
    await store.refreshDay()
    await store.refreshHistory()
    store.notify(`${props.food.name} logged.`)
    props.onClose()
  }

  return (
    <Sheet title={props.food.name} onClose={props.onClose}>
      <div class="faint">
        per 100 g: {fmt(props.food.per100g.kcal)} kcal ·{' '}
        {fmt(props.food.per100g.protein, 1)} P · {fmt(props.food.per100g.carbs, 1)} C
        · {fmt(props.food.per100g.fat, 1)} F
      </div>

      <label>
        Grams
        <input
          type="number"
          inputMode="decimal"
          autoFocus
          value={grams}
          onInput={(e) => {
            setGrams((e.target as HTMLInputElement).value)
            setFidelity('weighed')
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void log()
          }}
        />
      </label>

      {props.food.portions.length > 0 && (
        <div>
          <div class="card-title">Listed servings</div>
          <div class="chip-row">
            {props.food.portions.map((p) => (
              <button
                key={p.label}
                class="chip"
                aria-pressed={fidelity === 'portioned' && Number(grams) === p.grams}
                onClick={() => {
                  setGrams(String(p.grams))
                  setFidelity('portioned')
                }}
              >
                {p.label} · {fmt(p.grams)} g
              </button>
            ))}
          </div>
        </div>
      )}

      {props.food.pairedWith && (
        <div class="notice">
          This food has a {props.food.cookState === 'raw' ? 'cooked' : 'raw'}{' '}
          counterpart. Weighing at the wrong stage is a common accuracy trap —
          search for it if that is what you weighed.
        </div>
      )}

      <div class="running-total">
        <div class="n">
          <span>kcal</span>
          <span>{fmt(nutrients.kcal)}</span>
        </div>
        <div class="n">
          <span>Protein</span>
          <span>{fmt(nutrients.protein, 1)}</span>
        </div>
        <div class="n">
          <span>Carbs</span>
          <span>{fmt(nutrients.carbs, 1)}</span>
        </div>
        <div class="n">
          <span>Fat</span>
          <span>{fmt(nutrients.fat, 1)}</span>
        </div>
      </div>

      <button class="btn btn-primary btn-wide" disabled={!valid} onClick={() => void log()}>
        Log {fmt(g)} g
      </button>
    </Sheet>
  )
}
