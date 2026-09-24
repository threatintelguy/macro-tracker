/**
 * Composite definition editor.
 *
 * Editing a definition bumps its version and leaves every prior instance
 * pinned to the old one -- past entries stay as logged. Nesting is allowed;
 * a cycle is refused at input rather than caught at resolution.
 */

import { useMemo, useState } from 'preact/hooks'
import type { Component, Composite } from '../../domain/types.ts'
import {
  MAX_COMPOSITE_DEPTH,
  compositeDepth,
  editDefinition,
  resolveComposite,
  wouldCycle,
  type Lookups,
} from '../../domain/composites/index.ts'
import * as repo from '../../data/repositories.ts'
import * as store from '../store.ts'
import { AggregateText, Sheet, fmt } from './common.tsx'

export function CompositeEditor(props: {
  composite?: Composite
  onClose: () => void
}) {
  const existing = props.composite
  const [name, setName] = useState(existing?.name ?? '')
  const [components, setComponents] = useState<Component[]>(
    existing ? [...existing.components] : [],
  )
  const [query, setQuery] = useState('')
  const [adding, setAdding] = useState<'food' | 'composite' | undefined>(undefined)
  const [problem, setProblem] = useState<string | undefined>(undefined)

  const lookups: Lookups = useMemo(() => {
    const index = store.searchIndex.value
    const compMap = new Map(store.composites.value.map((c) => [c.id, c]))
    return { food: (id) => index.get(id), composite: (id) => compMap.get(id) }
  }, [store.foodIndexVersion.value, store.composites.value])

  const draft: Composite = {
    id: existing?.id ?? 'draft',
    name: name || 'Untitled',
    version: existing?.version ?? 1,
    components,
    createdAt: existing?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  }

  const preview = useMemo(
    () =>
      resolveComposite(draft, {
        ...lookups,
        composite: (id) => (id === draft.id ? draft : lookups.composite(id)),
      }),
    [components, lookups, name],
  )

  const foodResults = useMemo(
    () => (adding === 'food' ? store.searchIndex.value.search(query, 10) : []),
    [adding, query, store.foodIndexVersion.value],
  )

  const compositeOptions = useMemo(
    () =>
      adding === 'composite'
        ? store.composites.value.filter(
            (c) =>
              !c.retired &&
              c.id !== existing?.id &&
              (query.trim().length === 0 ||
                c.name.toLowerCase().includes(query.trim().toLowerCase())),
          )
        : [],
    [adding, query, store.composites.value, existing],
  )

  function addComposite(child: Composite): void {
    if (existing && wouldCycle(existing.id, child.id, lookups.composite)) {
      setProblem(
        `"${child.name}" already contains this meal. Adding it would make each contain the other.`,
      )
      return
    }
    const depth = compositeDepth(child, lookups.composite)
    if (depth + 1 > MAX_COMPOSITE_DEPTH) {
      setProblem(
        `That would nest more than ${MAX_COMPOSITE_DEPTH} levels deep, which is not resolved.`,
      )
      return
    }
    setProblem(undefined)
    setComponents((list) => [...list, { kind: 'composite', ref: child.id, multiplier: 1 }])
    setAdding(undefined)
    setQuery('')
  }

  async function save(): Promise<void> {
    if (name.trim().length === 0 || components.length === 0) return
    const now = Date.now()

    if (existing) {
      // A definition edit bumps the version; past instances stay as logged.
      const changed =
        JSON.stringify(existing.components) !== JSON.stringify(components)
      const next = changed
        ? { ...editDefinition(existing, components, now), name: name.trim() }
        : { ...existing, name: name.trim(), updatedAt: now }
      await repo.putComposite(next)
      store.notify(
        changed
          ? `Updated to version ${next.version}. Entries already logged keep the definition they were logged with.`
          : 'Renamed.',
      )
    } else {
      await repo.putComposite({
        id: repo.newId('c'),
        name: name.trim(),
        version: 1,
        components,
        createdAt: now,
        updatedAt: now,
      })
      store.notify(`"${name.trim()}" added to your library.`)
    }

    await store.refreshComposites()
    props.onClose()
  }

  return (
    <Sheet
      title={existing ? `Edit ${existing.name}` : 'New composite'}
      onClose={props.onClose}
    >
      <label>
        Name
        <input
          type="text"
          value={name}
          placeholder="Lincoln salad"
          onInput={(e) => setName((e.target as HTMLInputElement).value)}
        />
      </label>

      {existing && (
        <div class="faint">
          Version {existing.version}. Saving a change to the components creates
          version {existing.version + 1}; anything already logged stays exactly
          as it was logged.
        </div>
      )}

      <div class="running-total">
        <div class="n">
          <span>Grams</span>
          <span>{fmt(preview.totalGrams)}</span>
        </div>
        <div class="n">
          <span>kcal</span>
          <span><AggregateText agg={preview.totals.kcal} /></span>
        </div>
        <div class="n">
          <span>Protein</span>
          <span><AggregateText agg={preview.totals.protein} dp={1} unit="g" /></span>
        </div>
        <div class="n">
          <span>Fat</span>
          <span><AggregateText agg={preview.totals.fat} dp={1} unit="g" /></span>
        </div>
      </div>

      <div class="list">
        {components.map((c, i) => (
          <div class="list-item" key={i}>
            <div style="flex:1;min-width:0">
              <div class="title">
                {c.kind === 'food'
                  ? c.ref.name
                  : (lookups.composite(c.ref)?.name ?? 'Missing composite')}
              </div>
              <div class="meta">{c.kind === 'composite' ? 'nested' : 'food'}</div>
            </div>
            <input
              type="number"
              inputMode="decimal"
              step={c.kind === 'food' ? '1' : '0.1'}
              value={String(c.kind === 'food' ? c.grams : c.multiplier)}
              style="width:88px;min-height:36px"
              onInput={(e) => {
                const v = Number((e.target as HTMLInputElement).value)
                if (!Number.isFinite(v)) return
                setComponents((list) =>
                  list.map((x, n) =>
                    n !== i
                      ? x
                      : x.kind === 'food'
                        ? { ...x, grams: v }
                        : { ...x, multiplier: v },
                  ),
                )
              }}
            />
            <span class="faint">{c.kind === 'food' ? 'g' : '×'}</span>
            <button
              class="btn btn-small btn-ghost"
              onClick={() => setComponents((list) => list.filter((_, n) => n !== i))}
            >
              Remove
            </button>
          </div>
        ))}
        {components.length === 0 && (
          <div class="empty">Add the components, weighed in grams.</div>
        )}
      </div>

      {problem && (
        <div class="notice" data-tone="attention">
          {problem}
        </div>
      )}

      {adding === undefined ? (
        <div class="row" style="gap:8px">
          <button class="btn btn-small" onClick={() => setAdding('food')}>
            Add food
          </button>
          <button class="btn btn-small btn-ghost" onClick={() => setAdding('composite')}>
            Add a saved meal
          </button>
        </div>
      ) : (
        <div style="display:flex;flex-direction:column;gap:8px">
          <input
            type="search"
            autoFocus
            placeholder={adding === 'food' ? 'Search foods' : 'Search your library'}
            value={query}
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          />
          <div class="list">
            {adding === 'food' &&
              foodResults.map((r) => (
                <button
                  key={r.food.id}
                  class="list-item"
                  onClick={() => {
                    setComponents((list) => [
                      ...list,
                      {
                        kind: 'food',
                        ref: { kind: 'food', foodId: r.food.id, name: r.food.name },
                        grams: 100,
                      },
                    ])
                    setAdding(undefined)
                    setQuery('')
                  }}
                >
                  <div style="flex:1">
                    <div class="title">{r.food.name}</div>
                    <div class="meta">{fmt(r.food.per100g.kcal)} kcal / 100 g</div>
                  </div>
                  <span class="tier-tag" data-tier={r.food.tier}>
                    {r.food.tier}
                  </span>
                </button>
              ))}
            {adding === 'composite' &&
              compositeOptions.map((c) => (
                <button key={c.id} class="list-item" onClick={() => addComposite(c)}>
                  <div style="flex:1">
                    <div class="title">{c.name}</div>
                    <div class="meta">{c.components.length} components</div>
                  </div>
                </button>
              ))}
            {adding === 'composite' && compositeOptions.length === 0 && (
              <div class="empty">Nothing else in the library to nest.</div>
            )}
          </div>
          <button class="btn btn-small btn-ghost" onClick={() => setAdding(undefined)}>
            Cancel
          </button>
        </div>
      )}

      <button
        class="btn btn-primary btn-wide"
        disabled={name.trim().length === 0 || components.length === 0}
        onClick={() => void save()}
      >
        {existing ? 'Save changes' : 'Add to library'}
      </button>
    </Sheet>
  )
}
