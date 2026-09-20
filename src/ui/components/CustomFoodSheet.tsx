/**
 * Manual food entry and recipes.
 *
 * Always available, and the fallback when barcode misses. A recipe takes an
 * ingredient list plus a total yield weight and produces a per-100 g vector,
 * so a batch of chilli logs like any other food.
 */

import { useMemo, useState } from 'preact/hooks'
import type { FoodItem, NutrientVector } from '../../domain/types.ts'
import { ZERO_NUTRIENTS } from '../../domain/types.ts'
import {
  makeNutrients,
  nutrientsForGrams,
  scaleNutrients,
  sumNutrients,
} from '../../domain/nutrition/index.ts'
import * as repo from '../../data/repositories.ts'
import * as store from '../store.ts'
import { Sheet, fmt } from './common.tsx'

type Mode = 'label' | 'recipe'

type Ingredient = { food: FoodItem; grams: number }

export function CustomFoodSheet(props: {
  onClose: () => void
  onSaved: (food: FoodItem) => void
}) {
  const [mode, setMode] = useState<Mode>('label')
  const [name, setName] = useState('')
  const [basis, setBasis] = useState('100')
  const [fields, setFields] = useState<Record<string, string>>({})
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

  function num(key: string): number {
    const v = Number(fields[key])
    return Number.isFinite(v) ? v : 0
  }

  function per100gFromLabel(): NutrientVector {
    const b = Number(basis)
    if (!Number.isFinite(b) || b <= 0) return { ...ZERO_NUTRIENTS }
    const factor = 100 / b
    return scaleNutrients(
      makeNutrients({
        kcal: num('kcal'),
        protein: num('protein'),
        carbs: num('carbs'),
        fat: num('fat'),
        satFat: num('satFat'),
        fibre: num('fibre'),
        sodium: num('sodium'),
        addedSugar: num('addedSugar'),
        alcohol: num('alcohol'),
      }),
      factor,
    )
  }

  function per100gFromRecipe(): NutrientVector {
    const y = Number(yieldGrams)
    if (!Number.isFinite(y) || y <= 0) return { ...ZERO_NUTRIENTS }
    // Recipe scaling is arithmetic on the yield.
    return scaleNutrients(recipeTotals, 100 / y)
  }

  const preview = mode === 'label' ? per100gFromLabel() : per100gFromRecipe()
  const canSave =
    name.trim().length > 0 &&
    (mode === 'label'
      ? Number(basis) > 0
      : ingredients.length > 0 && Number(yieldGrams) > 0)

  async function save(): Promise<void> {
    const food: FoodItem = {
      id: repo.newId('x'),
      name: name.trim(),
      tier: 'custom',
      per100g: preview,
      portions:
        mode === 'label' && Number(basis) > 0 && Number(basis) !== 100
          ? [{ label: `1 serving (${fmt(Number(basis))} g)`, grams: Number(basis) }]
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
    }
    await repo.putFood(food)
    await store.loadFoodIndex()
    store.notify(`"${food.name}" saved to your foods.`)
    props.onSaved(food)
  }

  return (
    <Sheet title="New food" onClose={props.onClose}>
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
            Values below are per this many grams
            <input
              type="number"
              inputMode="decimal"
              value={basis}
              onInput={(e) => setBasis((e.target as HTMLInputElement).value)}
            />
          </label>
          <div class="field-row">
            {(
              [
                ['kcal', 'Calories'],
                ['protein', 'Protein (g)'],
                ['carbs', 'Carbs (g)'],
                ['fat', 'Fat (g)'],
                ['satFat', 'Saturated fat (g)'],
                ['fibre', 'Fibre (g)'],
                ['sodium', 'Sodium (mg)'],
                ['addedSugar', 'Added sugar (g)'],
              ] as const
            ).map(([key, label]) => (
              <label key={key}>
                {label}
                <input
                  type="number"
                  inputMode="decimal"
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
