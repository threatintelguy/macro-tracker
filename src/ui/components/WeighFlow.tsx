/**
 * The kitchen-scale workflow.
 *
 *   1. Tare, place food, read grams
 *   2. Search or scan -> food resolves
 *   3. Type grams -> entry lands
 *   4. Repeat for the next component, staying on the same screen
 *
 * The requirements that follow: the gram field takes focus automatically
 * with a numeric keypad; the food search stays on screen between components
 * so a four-ingredient meal is one screen and not four round trips; the
 * running total is visible; and "save this meal as a composite" is offered
 * at the end of every multi-component entry -- which is how the library
 * builds itself rather than requiring setup work up front.
 */

import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { Fidelity, FoodItem, NutrientVector } from '../../domain/types.ts'
import {
  nutrientsForGrams,
  sumNutrients,
} from '../../domain/nutrition/index.ts'
import { ZERO_NUTRIENTS } from '../../domain/types.ts'
import * as store from '../store.ts'
import * as repo from '../../data/repositories.ts'
import { formatTime } from '../../domain/dates.ts'
import { Sheet, fmt } from './common.tsx'
import { BarcodeSheet } from './BarcodeSheet.tsx'
import { CustomFoodSheet } from './CustomFoodSheet.tsx'

export type DraftComponent = {
  food: FoodItem
  grams: number
  fidelity: Fidelity
  nutrients: NutrientVector
}

export function WeighFlow(props: { onClose: () => void; onSaved?: () => void }) {
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<FoodItem | undefined>(undefined)
  const [grams, setGrams] = useState('')
  const [fidelity, setFidelity] = useState<Fidelity>('weighed')
  const [draft, setDraft] = useState<DraftComponent[]>([])
  const [showBarcode, setShowBarcode] = useState(false)
  const [showCustom, setShowCustom] = useState(false)
  const [saveAsComposite, setSaveAsComposite] = useState(false)
  const [compositeName, setCompositeName] = useState('')

  const gramsRef = useRef<HTMLInputElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const results = useMemo(
    () => store.searchIndex.value.search(query, 14),
    [query, store.foodIndexVersion.value],
  )

  // The gram field takes focus the moment a food resolves.
  useEffect(() => {
    if (picked) gramsRef.current?.focus()
  }, [picked])

  const totals = useMemo(
    () => sumNutrients(draft.map((d) => d.nutrients)),
    [draft],
  )
  const totalGrams = draft.reduce((a, d) => a + d.grams, 0)

  const pendingNutrients =
    picked && Number(grams) > 0
      ? nutrientsForGrams(picked.per100g, Number(grams))
      : ZERO_NUTRIENTS

  function addComponent(): void {
    const g = Number(grams)
    if (!picked || !Number.isFinite(g) || g <= 0) return
    setDraft((d) => [
      ...d,
      {
        food: picked,
        grams: g,
        fidelity,
        nutrients: nutrientsForGrams(picked.per100g, g),
      },
    ])
    // Stay on the same screen and reset for the next component.
    setPicked(undefined)
    setGrams('')
    setFidelity('weighed')
    setQuery('')
    searchRef.current?.focus()
  }

  function usePortion(portionGrams: number): void {
    setGrams(String(portionGrams))
    setFidelity('portioned')
  }

  async function commit(): Promise<void> {
    if (draft.length === 0) return
    const at = formatTime()
    const date = store.selectedDate.value

    await repo.addEntries(
      draft.map((d) => ({
        date,
        at,
        source: { kind: 'food' as const, foodId: d.food.id, name: d.food.name },
        grams: d.grams,
        nutrients: d.nutrients,
        fidelity: d.fidelity,
      })),
    )

    if (saveAsComposite && compositeName.trim().length > 0) {
      const now = Date.now()
      await repo.putComposite({
        id: repo.newId('c'),
        name: compositeName.trim(),
        version: 1,
        components: draft.map((d) => ({
          kind: 'food' as const,
          ref: { kind: 'food' as const, foodId: d.food.id, name: d.food.name },
          grams: d.grams,
        })),
        createdAt: now,
        updatedAt: now,
      })
      await store.refreshComposites()
      store.notify(
        `Saved "${compositeName.trim()}" to your library — one tap next time.`,
      )
    } else {
      store.notify(
        draft.length === 1 ? 'Entry logged.' : `${draft.length} items logged.`,
      )
    }

    await store.refreshDay()
    await store.refreshHistory()
    props.onSaved?.()
    props.onClose()
  }

  return (
    <Sheet title="Weigh and log" onClose={props.onClose}>
      {draft.length > 0 && (
        <div class="running-total">
          <div class="n">
            <span>Items</span>
            <span>{draft.length}</span>
          </div>
          <div class="n">
            <span>Grams</span>
            <span>{fmt(totalGrams)}</span>
          </div>
          <div class="n">
            <span>kcal</span>
            <span>{fmt(totals.kcal)}</span>
          </div>
          <div class="n">
            <span>Protein</span>
            <span>{fmt(totals.protein)} g</span>
          </div>
        </div>
      )}

      {draft.length > 0 && (
        <div class="list">
          {draft.map((d, i) => (
            <div class="list-item" key={`${d.food.id}-${i}`}>
              <div style="flex:1;min-width:0">
                <div class="title" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                  {d.food.name}
                </div>
                <div class="meta">
                  {fmt(d.grams)} g · {fmt(d.nutrients.kcal)} kcal ·{' '}
                  {fmt(d.nutrients.protein, 1)} g protein
                </div>
              </div>
              <button
                class="btn btn-small btn-ghost"
                aria-label={`Remove ${d.food.name}`}
                onClick={() => setDraft((list) => list.filter((_, n) => n !== i))}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}

      {picked ? (
        <div class="card" style="display:flex;flex-direction:column;gap:10px">
          <div class="row-between">
            <div>
              <div class="title">{picked.name}</div>
              <div class="faint">
                per 100 g: {fmt(picked.per100g.kcal)} kcal ·{' '}
                {fmt(picked.per100g.protein, 1)} P · {fmt(picked.per100g.carbs, 1)} C ·{' '}
                {fmt(picked.per100g.fat, 1)} F
              </div>
            </div>
            <button
              class="btn btn-small btn-ghost"
              onClick={() => {
                setPicked(undefined)
                setGrams('')
              }}
            >
              Change
            </button>
          </div>

          <label>
            Grams
            <input
              ref={gramsRef}
              type="number"
              inputMode="decimal"
              min="0"
              step="1"
              value={grams}
              placeholder="0"
              onInput={(e) => {
                setGrams((e.target as HTMLInputElement).value)
                setFidelity('weighed')
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addComponent()
              }}
            />
          </label>

          {picked.portions.length > 0 && (
            <div class="chip-row">
              {picked.portions.map((p) => (
                <button
                  key={p.label}
                  class="chip"
                  onClick={() => usePortion(p.grams)}
                >
                  {p.label} · {fmt(p.grams)} g
                </button>
              ))}
            </div>
          )}

          {Number(grams) > 0 && (
            <div class="faint">
              {fmt(pendingNutrients.kcal)} kcal · {fmt(pendingNutrients.protein, 1)} g
              protein · {fmt(pendingNutrients.carbs, 1)} g carbs ·{' '}
              {fmt(pendingNutrients.fat, 1)} g fat
              {fidelity === 'portioned' && ' · listed serving'}
            </div>
          )}

          <button
            class="btn btn-primary btn-wide"
            disabled={!(Number(grams) > 0)}
            onClick={addComponent}
          >
            Add to meal
          </button>
        </div>
      ) : (
        <>
          <input
            ref={searchRef}
            type="search"
            placeholder="Search foods"
            value={query}
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
            autoFocus
          />
          <div class="row" style="gap:8px">
            <button class="btn btn-small" onClick={() => setShowBarcode(true)}>
              Scan barcode
            </button>
            <button class="btn btn-small btn-ghost" onClick={() => setShowCustom(true)}>
              New food
            </button>
          </div>
          <div class="list">
            {results.length === 0 && (
              <div class="empty">
                Nothing matched. Add it as a new food and it will be there next
                time.
              </div>
            )}
            {results.map((r) => (
              <button
                key={r.food.id}
                class="list-item"
                onClick={() => setPicked(r.food)}
              >
                <div style="flex:1;min-width:0">
                  <div class="title">{r.food.name}</div>
                  <div class="meta">
                    {fmt(r.food.per100g.kcal)} kcal ·{' '}
                    {fmt(r.food.per100g.protein, 1)} g protein per 100 g
                    {r.food.cookState !== 'n/a' && ` · ${r.food.cookState}`}
                  </div>
                </div>
                <span class="tier-tag" data-tier={r.food.tier}>
                  {r.food.tier}
                </span>
              </button>
            ))}
          </div>
        </>
      )}

      {draft.length > 1 && (
        <div class="card">
          <label class="toggle">
            <span>Save this meal as a composite</span>
            <input
              type="checkbox"
              checked={saveAsComposite}
              onChange={(e) =>
                setSaveAsComposite((e.target as HTMLInputElement).checked)
              }
            />
          </label>
          {saveAsComposite && (
            <>
              <input
                type="text"
                placeholder="Name it — e.g. Lincoln salad"
                value={compositeName}
                style="margin-top:8px"
                onInput={(e) =>
                  setCompositeName((e.target as HTMLInputElement).value)
                }
              />
              <div class="faint" style="margin-top:6px">
                Every meal weighed properly now becomes a one-tap entry later.
                This is what the weighing is buying.
              </div>
            </>
          )}
        </div>
      )}

      <button
        class="btn btn-primary btn-wide"
        disabled={draft.length === 0}
        onClick={() => void commit()}
      >
        {draft.length === 0
          ? 'Add something first'
          : `Log ${draft.length} item${draft.length === 1 ? '' : 's'}`}
      </button>

      {showBarcode && (
        <BarcodeSheet
          onClose={() => setShowBarcode(false)}
          onResolved={(food) => {
            setPicked(food)
            setShowBarcode(false)
          }}
        />
      )}

      {showCustom && (
        <CustomFoodSheet
          onClose={() => setShowCustom(false)}
          onSaved={(food) => {
            setPicked(food)
            setShowCustom(false)
          }}
        />
      )}
    </Sheet>
  )
}
