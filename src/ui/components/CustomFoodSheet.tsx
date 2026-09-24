/**
 * Manual food entry and recipes.
 *
 * Always available, and the fallback when barcode misses. A recipe takes an
 * ingredient list plus a total yield weight and produces a per-100 g vector,
 * so a batch of chilli logs like any other food.
 *
 * The form requires nothing but a name. If a menu board says 640 calories
 * and nothing else, the user enters 640 and stops: every blank is stored as
 * unknown, never as zero, and the entry lands in the needs-detail list for
 * whenever -- if ever -- the rest turns up.
 *
 * Cloning ("close, but not quite") starts from a near match: the user edits
 * what they know, and provenance records the origin and which fields moved.
 */

import { useMemo, useState } from 'preact/hooks'
import type { FoodItem, NutrientKey, NutrientVector } from '../../domain/types.ts'
import { NUTRIENT_KEYS } from '../../domain/types.ts'
import {
  nutrientsForGrams,
  scaleNutrients,
  sumNutrients,
} from '../../domain/nutrition/index.ts'
import { adjustedFields } from '../../domain/editing.ts'
import { unknownNutrients } from '../../domain/composites/index.ts'
import * as repo from '../../data/repositories.ts'
import * as store from '../store.ts'
import { Sheet, fmt, parseOptionalNumber } from './common.tsx'

type Mode = 'label' | 'recipe'

type Ingredient = { food: FoodItem; grams: number }

const LABEL_FIELDS: readonly (readonly [NutrientKey, string])[] = [
  ['kcal', 'Calories'],
  ['protein', 'Protein (g)'],
  ['carbs', 'Carbs (g)'],
  ['fat', 'Fat (g)'],
  ['satFat', 'Saturated fat (g)'],
  ['fibre', 'Fibre (g)'],
  ['sodium', 'Sodium (mg)'],
  ['addedSugar', 'Added sugar (g)'],
  ['alcohol', 'Alcohol (g)'],
]

function fieldsFrom(v: NutrientVector): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of NUTRIENT_KEYS) {
    const x = v[k]
    out[k] = x === null ? '' : String(Math.round(x * 100) / 100)
  }
  return out
}

function enteredVector(fields: Record<string, string>): NutrientVector {
  const out = {} as NutrientVector
  // Blank is unknown. Never zero.
  for (const k of NUTRIENT_KEYS) out[k] = parseOptionalNumber(fields[k])
  return out
}

export function CustomFoodSheet(props: {
  onClose: () => void
  onSaved: (food: FoodItem) => void
  /** Prefill the name, e.g. from a search that found nothing. */
  initialName?: string
  /** "Close, but not quite": fork this food and adjust it. */
  cloneFrom?: FoodItem
}) {
  const origin = props.cloneFrom
  const [mode, setMode] = useState<Mode>('label')
  const [name, setName] = useState(
    origin ? `${origin.name} (adjusted)` : (props.initialName ?? ''),
  )
  const [basis, setBasis] = useState('100')
  // Labels do not list alcohol for foods without it -- a product containing
  // alcohol must declare it -- so it starts at 0 and can be cleared.
  const [fields, setFields] = useState<Record<string, string>>(
    origin ? fieldsFrom(origin.per100g) : { alcohol: '0' },
  )
  const [ingredients, setIngredients] = useState<Ingredient[]>([])
  const [yieldGrams, setYieldGrams] = useState('')
  const [query, setQuery] = useState('')

  const results = useMemo(
    () => (query.trim().length > 0 ? store.searchIndex.value.search(query, 8) : []),
    [query, store.foodIndexVersion.value],
  )

  const recipeTotals = useMemo(
    () =>
      sumNutrients(
        ingredients.map((i) => nutrientsForGrams(i.food.per100g, i.grams)),
      ),
    [ingredients],
  )

  function per100gFromLabel(): NutrientVector {
    const b = Number(basis)
    // An unreadable basis is treated as 100 g rather than blocking the save.
    const factor = Number.isFinite(b) && b > 0 ? 100 / b : 1
    return scaleNutrients(enteredVector(fields), factor)
  }

  function per100gFromRecipe(): NutrientVector {
    const y = Number(yieldGrams)
    if (!Number.isFinite(y) || y <= 0) return unknownNutrients()
    // Recipe scaling is arithmetic on the yield. An ingredient with an
    // unknown field makes the recipe's field unknown, not the sum of the rest.
    return scaleNutrients(recipeTotals, 100 / y)
  }

  const preview = mode === 'label' ? per100gFromLabel() : per100gFromRecipe()
  // Name is the only thing required.
  const canSave =
    name.trim().length > 0 &&
    (mode === 'label' || (ingredients.length > 0 && Number(yieldGrams) > 0))

  async function save(): Promise<void> {
    if (!canSave) return
    const b = Number(basis)
    const food: FoodItem = {
      id: repo.newId('x'),
      name: name.trim(),
      tier: 'custom',
      per100g: preview,
      portions:
        mode === 'label' && b > 0 && b !== 100
          ? [{ label: `1 serving (${fmt(b)} g)`, grams: b }]
          : [],
      cookState: 'n/a',
      createdAt: Date.now(),
      ...(mode === 'recipe'
        ? {
            recipe: {
              ingredients: ingredients.map((i) => ({
                ref: { kind: 'food' as const, foodId: i.food.id, name: i.food.name },
                grams: i.grams,
              })),
              yieldGrams: Number(yieldGrams),
            },
          }
        : {}),
      ...(origin
        ? {
            derivedFrom: {
              ref: { kind: 'food' as const, foodId: origin.id, name: origin.name },
              adjustedFields: adjustedFields(origin.per100g, preview),
            },
          }
        : {}),
    }
    await repo.putFood(food)
    await store.loadFoodIndex()
    store.notify(`"${food.name}" saved to your foods.`)
    props.onSaved(food)
  }

  return (
    <Sheet title={origin ? 'Close, but not quite' : 'New food'} onClose={props.onClose}>
      {origin ? (
        <div class="faint">
          Starting from {origin.name}, per 100 g. Change what you know is
          different — the new food remembers where it came from.
        </div>
      ) : (
        <div class="faint">
          Only the name is needed. Leave anything you do not know blank: a
          blank is stored as unknown, never as zero, and can be filled in later.
        </div>
      )}

      {!origin && (
        <div class="chip-row">
          <button
            class="chip"
            aria-pressed={mode === 'label'}
            onClick={() => setMode('label')}
          >
            From a label
          </button>
          <button
            class="chip"
            aria-pressed={mode === 'recipe'}
            onClick={() => setMode('recipe')}
          >
            Recipe
          </button>
        </div>
      )}

      <label>
        Name
        <input
          type="text"
          value={name}
          placeholder={mode === 'recipe' ? 'Batch chilli' : 'Own-brand oat bar'}
          onInput={(e) => setName((e.target as HTMLInputElement).value)}
        />
      </label>

      {mode === 'label' ? (
        <>
          <label>
            The values below are for this many grams
            <input
              type="number"
              inputMode="decimal"
              value={basis}
              onInput={(e) => setBasis((e.target as HTMLInputElement).value)}
            />
          </label>
          {!origin && (
            <div class="faint">
              A whole menu item or serving? Put its weight here — a guess is
              fine — and enter the values for the whole thing.
            </div>
          )}
          <div class="field-row">
            {LABEL_FIELDS.map(([key, label]) => (
              <label key={key}>
                {label}
                <input
                  type="number"
                  inputMode="decimal"
                  placeholder="unknown"
                  value={fields[key] ?? ''}
                  onInput={(e) =>
                    setFields((f) => ({
                      ...f,
                      [key]: (e.target as HTMLInputElement).value,
                    }))
                  }
                />
              </label>
            ))}
          </div>
        </>
      ) : (
        <>
          <input
            type="search"
            placeholder="Add an ingredient"
            value={query}
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          />
          {results.length > 0 && (
            <div class="list">
              {results.map((r) => (
                <button
                  key={r.food.id}
                  class="list-item"
                  onClick={() => {
                    setIngredients((list) => [...list, { food: r.food, grams: 100 }])
                    setQuery('')
                  }}
                >
                  <div style="flex:1">
                    <div class="title">{r.food.name}</div>
                    <div class="meta">{fmt(r.food.per100g.kcal)} kcal / 100 g</div>
                  </div>
                </button>
              ))}
            </div>
          )}

          <div class="list">
            {ingredients.map((ing, i) => (
              <div class="list-item" key={`${ing.food.id}-${i}`}>
                <div style="flex:1;min-width:0">
                  <div class="title">{ing.food.name}</div>
                </div>
                <input
                  type="number"
                  inputMode="decimal"
                  value={String(ing.grams)}
                  style="width:92px;min-height:36px"
                  onInput={(e) => {
                    const g = Number((e.target as HTMLInputElement).value)
                    setIngredients((list) =>
                      list.map((x, n) =>
                        n === i ? { ...x, grams: Number.isFinite(g) ? g : 0 } : x,
                      ),
                    )
                  }}
                />
                <span class="faint">g</span>
                <button
                  class="btn btn-small btn-ghost"
                  onClick={() =>
                    setIngredients((list) => list.filter((_, n) => n !== i))
                  }
                >
                  Remove
                </button>
              </div>
            ))}
          </div>

          <label>
            Total cooked yield, in grams
            <input
              type="number"
              inputMode="decimal"
              value={yieldGrams}
              placeholder={String(Math.round(ingredients.reduce((a, i) => a + i.grams, 0)))}
              onInput={(e) => setYieldGrams((e.target as HTMLInputElement).value)}
            />
          </label>
          <div class="faint">
            Weigh the finished batch. The difference from the raw ingredient
            weight is water, and it is what makes the per-100 g figure right.
          </div>
        </>
      )}

      <div class="card">
        <div class="card-title">Per 100 g</div>
        <div class="faint">
          {fmt(preview.kcal)} kcal · {fmt(preview.protein, 1)} P ·{' '}
          {fmt(preview.carbs, 1)} C · {fmt(preview.fat, 1)} F ·{' '}
          {fmt(preview.satFat, 1)} sat · {fmt(preview.fibre, 1)} fibre
        </div>
        {NUTRIENT_KEYS.some((k) => preview[k] === null) && (
          <div class="faint" style="margin-top:4px">
            — means unknown. It will be counted as unknown, not as zero.
          </div>
        )}
      </div>

      <button
        class="btn btn-primary btn-wide"
        disabled={!canSave}
        onClick={() => void save()}
      >
        Save food
      </button>
    </Sheet>
  )
}
