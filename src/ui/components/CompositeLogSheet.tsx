/**
 * Logging a composite.
 *
 * Tap the composite, optionally set a multiplier, optionally override a
 * component, done. Two taps in the common case.
 *
 * The override is the feature that decides whether the library stays clean.
 * Swapping salmon for chicken, or skipping the seeds, is reachable in one
 * tap and must NOT create "Lincoln salad (chicken)" as a second composite --
 * that is the thing most template systems get wrong, and a year later there
 * are nine variants of one salad.
 */

import { useMemo, useState } from 'preact/hooks'
import type {
  Composite,
  CompositeInstance,
  FoodItem,
  Override,
} from '../../domain/types.ts'
import {
  componentsAtVersion,
  resolveCompositeInstance,
  type Lookups,
} from '../../domain/composites/index.ts'
import * as repo from '../../data/repositories.ts'
import * as store from '../store.ts'
import { formatTime } from '../../domain/dates.ts'
import { AggregateText, Sheet, fmt } from './common.tsx'

const MULTIPLIERS = [0.5, 1, 1.5, 2] as const

export function CompositeLogSheet(props: {
  composite: Composite
  onClose: () => void
  /**
   * Editing an already-logged instance: start from its multiplier and
   * overrides, at the version it was logged against. A multiplier-only
   * change rescales the snapshot; an override change re-resolves it.
   */
  editing?: { rootId: string; instance: CompositeInstance }
}) {
  const editing = props.editing
  const startMultiplier = editing?.instance.multiplier ?? 1
  const [multiplier, setMultiplier] = useState(startMultiplier)
  const [customMultiplier, setCustomMultiplier] = useState(
    MULTIPLIERS.includes(startMultiplier as (typeof MULTIPLIERS)[number])
      ? ''
      : String(startMultiplier),
  )
  const [overrides, setOverrides] = useState<Override[]>(editing?.instance.overrides ?? [])
  const [swapFor, setSwapFor] = useState<number | undefined>(undefined)
  const [regramFor, setRegramFor] = useState<number | undefined>(undefined)
  const [regramValue, setRegramValue] = useState('')
  const [query, setQuery] = useState('')

  const lookups: Lookups = useMemo(() => {
    const index = store.searchIndex.value
    const compMap = new Map(store.composites.value.map((c) => [c.id, c]))
    return {
      food: (id) => index.get(id),
      composite: (id) => compMap.get(id),
      tombstone: (id) => store.tombstoneById.value.get(id),
    }
  }, [store.foodIndexVersion.value, store.composites.value, store.tombstones.value])

  const version = editing?.instance.version ?? props.composite.version
  const components = componentsAtVersion(props.composite, version) ?? props.composite.components

  const instance: CompositeInstance = {
    kind: 'composite',
    compositeId: props.composite.id,
    version,
    multiplier,
    overrides,
    name: editing?.instance.name ?? props.composite.name,
  }

  const resolved = useMemo(
    () => resolveCompositeInstance(instance, lookups),
    [props.composite, multiplier, overrides, lookups],
  )

  const searchResults = useMemo(
    () => (query.trim().length > 0 ? store.searchIndex.value.search(query, 8) : []),
    [query, store.foodIndexVersion.value],
  )

  function setOverride(next: Override): void {
    setOverrides((list) => [
      ...list.filter((o) => o.componentIndex !== next.componentIndex),
      next,
    ])
  }

  function clearOverride(index: number): void {
    setOverrides((list) => list.filter((o) => o.componentIndex !== index))
  }

  function overrideFor(index: number): Override | undefined {
    return overrides.find((o) => o.componentIndex === index)
  }

  async function saveEdit(): Promise<void> {
    if (!editing) return
    const overridesChanged =
      JSON.stringify(overrides) !== JSON.stringify(editing.instance.overrides)
    let dates: string[] = []
    if (overridesChanged) {
      // What was eaten changed: re-resolve at the pinned version.
      const first =
        multiplier !== editing.instance.multiplier
          ? await repo.editCompositeMultiplier(editing.rootId, multiplier)
          : []
      const r = await repo.editCompositeOverrides(editing.rootId, overrides)
      if (r.dates.length === 0 && r.problems.length > 0) {
        store.notify(r.problems[0]!)
        return
      }
      dates = [...first, ...r.dates]
    } else if (multiplier !== editing.instance.multiplier) {
      dates = await repo.editCompositeMultiplier(editing.rootId, multiplier)
    }
    await store.afterEdit(dates)
    props.onClose()
  }

  async function log(): Promise<void> {
    if (editing) return saveEdit()
    const { problems } = await repo.logCompositeInstance({
      instance,
      date: store.selectedDate.value,
      at: formatTime(),
    })
    if (problems.length > 0) {
      store.notify(problems[0]!)
    } else {
      store.notify(`${props.composite.name} logged.`)
    }
    await store.refreshComposites()
    await store.afterEdit([store.selectedDate.value])
    props.onClose()
  }

  return (
    <Sheet title={props.composite.name} onClose={props.onClose}>
      <div class="running-total">
        <div class="n">
          <span>Grams</span>
          <span>{fmt(resolved.totalGrams)}</span>
        </div>
        <div class="n">
          <span>kcal</span>
          <span><AggregateText agg={resolved.totals.kcal} /></span>
        </div>
        <div class="n">
          <span>Protein</span>
          <span><AggregateText agg={resolved.totals.protein} dp={1} unit="g" /></span>
        </div>
        <div class="n">
          <span>Carbs</span>
          <span><AggregateText agg={resolved.totals.carbs} dp={1} unit="g" /></span>
        </div>
      </div>

      <div>
        <div class="card-title">Amount</div>
        <div class="chip-row">
          {MULTIPLIERS.map((m) => (
            <button
              key={m}
              class="chip"
              aria-pressed={multiplier === m}
              onClick={() => {
                setMultiplier(m)
                setCustomMultiplier('')
              }}
            >
              {m}×
            </button>
          ))}
          <input
            type="number"
            inputMode="decimal"
            step="0.1"
            min="0.1"
            placeholder="Other"
            value={customMultiplier}
            style="width:96px;min-height:36px"
            onInput={(e) => {
              const v = (e.target as HTMLInputElement).value
              setCustomMultiplier(v)
              const n = Number(v)
              if (Number.isFinite(n) && n > 0) setMultiplier(n)
            }}
          />
        </div>
        <div class="faint" style="margin-top:6px">
          Scales this entry only. The saved definition is untouched.
        </div>
      </div>

      <div>
        <div class="card-title">Components</div>
        <div class="list">
          {components.map((component, i) => {
            const o = overrideFor(i)
            const label =
              component.kind === 'food'
                ? component.ref.name
                : (lookups.composite(component.ref)?.name ?? 'Nested composite')
            const grams =
              component.kind === 'food'
                ? component.grams * multiplier
                : undefined

            return (
              <div key={i} class="list-item" style="flex-direction:column;align-items:stretch;gap:8px">
                <div class="row-between">
                  <div style="min-width:0">
                    <div
                      class="title"
                      style={o?.action === 'skip' ? 'text-decoration:line-through;opacity:0.55' : ''}
                    >
                      {o?.action === 'swap' ? o.ref.name : label}
                    </div>
                    <div class="meta">
                      {component.kind === 'composite'
                        ? `nested · ${component.multiplier * multiplier}×`
                        : `${fmt(
                            o?.action === 'regram'
                              ? o.grams * multiplier
                              : o?.action === 'swap' && o.grams !== undefined
                                ? o.grams * multiplier
                                : (grams ?? 0),
                          )} g`}
                      {o && ' · changed for today'}
                    </div>
                  </div>
                  {o && (
                    <button
                      class="btn btn-small btn-ghost"
                      onClick={() => clearOverride(i)}
                    >
                      Undo
                    </button>
                  )}
                </div>

                {!o && component.kind === 'food' && (
                  <div class="chip-row">
                    <button
                      class="chip"
                      onClick={() => setOverride({ componentIndex: i, action: 'skip' })}
                    >
                      Skip
                    </button>
                    <button
                      class="chip"
                      onClick={() => {
                        setSwapFor(i)
                        setQuery('')
                      }}
                    >
                      Swap
                    </button>
                    <button
                      class="chip"
                      onClick={() => {
                        setRegramFor(i)
                        setRegramValue(String(component.grams))
                      }}
                    >
                      Change grams
                    </button>
                  </div>
                )}

                {regramFor === i && (
                  <div class="row" style="gap:8px">
                    <input
                      type="number"
                      inputMode="decimal"
                      value={regramValue}
                      autoFocus
                      style="min-height:38px"
                      onInput={(e) =>
                        setRegramValue((e.target as HTMLInputElement).value)
                      }
                    />
                    <button
                      class="btn btn-small btn-primary"
                      onClick={() => {
                        const g = Number(regramValue)
                        if (Number.isFinite(g) && g > 0) {
                          setOverride({ componentIndex: i, action: 'regram', grams: g })
                        }
                        setRegramFor(undefined)
                      }}
                    >
                      Set
                    </button>
                    <button
                      class="btn btn-small btn-ghost"
                      onClick={() => setRegramFor(undefined)}
                    >
                      Cancel
                    </button>
                  </div>
                )}

                {swapFor === i && (
                  <div style="display:flex;flex-direction:column;gap:8px">
                    <input
                      type="search"
                      placeholder="Swap for…"
                      value={query}
                      autoFocus
                      style="min-height:38px"
                      onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
                    />
                    {searchResults.map((r) => (
                      <button
                        key={r.food.id}
                        class="list-item"
                        onClick={() => {
                          swapComponent(r.food, i)
                          setSwapFor(undefined)
                          setQuery('')
                        }}
                      >
                        <div style="flex:1">
                          <div class="title">{r.food.name}</div>
                          <div class="meta">
                            {fmt(r.food.per100g.kcal)} kcal / 100 g
                          </div>
                        </div>
                      </button>
                    ))}
                    <button
                      class="btn btn-small btn-ghost"
                      onClick={() => setSwapFor(undefined)}
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
        {overrides.length > 0 && (
          <div class="faint" style="margin-top:8px">
            These changes apply to this entry only. No second composite is
            created.
          </div>
        )}
      </div>

      {resolved.problems.length > 0 && (
        <div class="notice" data-tone="attention">
          {resolved.problems.map((p) => (
            <div key={p.message}>{p.message}</div>
          ))}
        </div>
      )}

      <button class="btn btn-primary btn-wide" onClick={() => void log()}>
        {editing ? 'Save changes' : `Log ${props.composite.name}`}
      </button>
    </Sheet>
  )

  function swapComponent(food: FoodItem, index: number): void {
    setOverride({
      componentIndex: index,
      action: 'swap',
      ref: { kind: 'food', foodId: food.id, name: food.name },
    })
  }
}
