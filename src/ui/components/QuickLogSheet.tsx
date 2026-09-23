/**
 * Log a single food.
 *
 * Grams entry is `weighed`. Choosing a listed serving is `portioned` --
 * fidelity is recorded per entry, so a portion picked for convenience is
 * never later mistaken for a weighed figure.
 *
 * As a stand-in (`proxyFor`), the food stands in for something that is not
 * in the database. It logs at estimated fidelity, keeps a note of what it
 * stood in for, and waits in the needs-detail queue until -- if ever -- the
 * real thing is known.
 */

import { useState } from 'preact/hooks'
import type { Fidelity, FoodItem } from '../../domain/types.ts'
import { nutrientsForGrams } from '../../domain/nutrition/index.ts'
import * as repo from '../../data/repositories.ts'
import * as store from '../store.ts'
import { formatTime } from '../../domain/dates.ts'
import { Sheet, fmt } from './common.tsx'

export function QuickLogSheet(props: {
  food: FoodItem
  onClose: () => void
  /** Log as a stand-in for something else; the text is what it stood in for. */
  proxyFor?: string
}) {
  const isProxy = props.proxyFor !== undefined
  // A custom food saved from a serving starts at that serving.
  const firstPortion = props.food.tier === 'custom' ? props.food.portions[0] : undefined
  const [grams, setGrams] = useState(String(firstPortion?.grams ?? 100))
  const [fidelity, setFidelity] = useState<Fidelity>(isProxy ? 'estimated' : 'weighed')
  const [proxyNote, setProxyNote] = useState(props.proxyFor ?? '')

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
      fidelity: isProxy ? 'estimated' : fidelity,
      ...(isProxy
        ? { proxyFor: { note: proxyNote.trim() || 'something not in the database' } }
        : {}),
    })
    await store.afterEdit([store.selectedDate.value])
    store.notify(
      isProxy
        ? `Logged ${props.food.name} as a stand-in. It is in the needs-detail list if the real figures turn up.`
        : `${props.food.name} logged.`,
    )
    props.onClose()
  }

  return (
    <Sheet title={isProxy ? `Stand-in: ${props.food.name}` : props.food.name} onClose={props.onClose}>
      <div class="faint">
        per 100 g: {fmt(props.food.per100g.kcal)} kcal ·{' '}
        {fmt(props.food.per100g.protein, 1)} P · {fmt(props.food.per100g.carbs, 1)} C
        · {fmt(props.food.per100g.fat, 1)} F
      </div>

      {isProxy && (
        <label>
          What it stands in for
          <input
            type="text"
            value={proxyNote}
            placeholder="Street tacos from the market stall"
            onInput={(e) => setProxyNote((e.target as HTMLInputElement).value)}
          />
        </label>
      )}

      <label>
        Grams{isProxy ? ' (a guess is fine)' : ''}
        <input
          type="number"
          inputMode="decimal"
          autoFocus
          value={grams}
          onInput={(e) => {
            setGrams((e.target as HTMLInputElement).value)
            if (!isProxy) setFidelity('weighed')
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
                  if (!isProxy) setFidelity('portioned')
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

      {isProxy && (
        <div class="faint">
          Logged as an estimate. It counts toward the day, stays out of the
          expenditure calculation, and can be swapped for the real thing later.
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
