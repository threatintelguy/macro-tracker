/**
 * The needs-detail list.
 *
 * Everything logged with unknown values or as a stand-in. When the package,
 * receipt or menu is to hand, it is a thirty-second fix and the affected
 * days recalculate.
 *
 * A convenience, never a nag: no badge escalation, no notification, no
 * warning colour. An item that sits here for a year is a legitimate
 * outcome -- the day it belongs to is still logged, which was the point.
 *
 * It also offers to re-resolve a line of an accepted estimate whose numbers
 * came from the model, once the library has that food. Optional and never
 * automatic: silently changing a past day would break the rule that history
 * stays as logged.
 */

import { useEffect, useState } from 'preact/hooks'
import type { Entry, FoodItem, NutrientKey } from '../../domain/types.ts'
import { NUTRIENT_KEYS } from '../../domain/types.ts'
import { nutrientLabel, nutrientUnit } from '../../domain/nutrition/index.ts'
import { formatDisplayDate } from '../../domain/dates.ts'
import * as repo from '../../data/repositories.ts'
import * as store from '../store.ts'
import { Empty, Sheet, fmt, parseOptionalNumber } from './common.tsx'
import { FoodPickerSheet } from './FoodPickerSheet.tsx'

export function NeedsDetailSheet(props: { onClose: () => void }) {
  const [items, setItems] = useState<Entry[] | undefined>(undefined)
  const [lines, setLines] = useState<{ entry: Entry; food: FoodItem }[]>([])
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const [open, setOpen] = useState<string | undefined>(undefined)

  async function load(): Promise<void> {
    setItems(await repo.needsDetailEntries())
    setLines(await store.reresolvable())
  }

  async function useLibrary(entry: Entry, food: FoodItem): Promise<void> {
    const dates = await repo.reresolveEstimatedLine(entry.id, food)
    await store.afterEdit(dates)
    store.notify(`${formatDisplayDate(entry.date)} now uses ${food.name}.`)
    await load()
  }

  const offered = lines.filter((l) => !dismissed.has(l.entry.id))

  useEffect(() => {
    void load()
  }, [])

  return (
    <Sheet title="Needs detail" onClose={props.onClose}>
      <div class="faint">
        Entries logged with values you did not have at the time, or as a
        stand-in. Fill them in if the details turn up; leaving them is fine.
      </div>
      {items === undefined && <div class="faint">Loading…</div>}
      {items !== undefined && items.length === 0 && offered.length === 0 && (
        <Empty>Nothing waiting for detail.</Empty>
      )}
      {offered.length > 0 && (
        <div>
          <div class="card-title">Now in your library</div>
          <div class="faint" style="margin-bottom:8px">
            These parts of estimated meals were priced by the model. Your
            library has them now; use its values if they fit. The amount stays
            as estimated.
          </div>
          <div class="list">
            {offered.map(({ entry, food }) => (
              <div key={entry.id} class="list-item" style="flex-direction:column;align-items:stretch;gap:6px">
                <div>
                  <div class="title">{store.estimateLineName(entry)}</div>
                  <div class="meta">
                    {formatDisplayDate(entry.date)} · {fmt(entry.grams)} g ·{' '}
                    {fmt(entry.nutrients.kcal)} kcal now, {fmt((food.per100g.kcal ?? 0) * entry.grams / 100)} kcal
                    from {food.name}
                  </div>
                </div>
                <div class="row" style="gap:8px">
                  <button class="btn btn-small" onClick={() => void useLibrary(entry, food)}>
                    Use library values
                  </button>
                  <button
                    class="btn btn-small btn-ghost"
                    onClick={() => setDismissed((d) => new Set(d).add(entry.id))}
                  >
                    Not this
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      <div class="list">
        {items?.map((e) => (
          <NeedsDetailItem
            key={e.id}
            entry={e}
            open={open === e.id}
            onToggle={() => setOpen(open === e.id ? undefined : e.id)}
            onResolved={async () => {
              setOpen(undefined)
              await load()
            }}
          />
        ))}
      </div>
    </Sheet>
  )
}

function missing(e: Entry): NutrientKey[] {
  return NUTRIENT_KEYS.filter((k) => e.nutrients[k] === null)
}

function NeedsDetailItem(props: {
  entry: Entry
  open: boolean
  onToggle: () => void
  onResolved: () => Promise<void>
}) {
  const e = props.entry
  const gaps = missing(e)
  const [values, setValues] = useState<Record<string, string>>({})
  const [updateFood, setUpdateFood] = useState(true)
  const [picking, setPicking] = useState(false)

  async function saveValues(): Promise<void> {
    const parsed: Partial<Record<NutrientKey, number>> = {}
    for (const k of gaps) {
      const v = parseOptionalNumber(values[k])
      if (v !== null) parsed[k] = v
    }
    const dates = await repo.resolveEntryDetail(e.id, parsed, { updateFood })
    await store.afterEdit(dates)
    await props.onResolved()
  }

  async function keepStandIn(): Promise<void> {
    const dates = await repo.clearProxy(e.id)
    await store.afterEdit(dates)
    await props.onResolved()
  }

  return (
    <div class="list-item" style="flex-direction:column;align-items:stretch;gap:8px">
      <button class="row-between plain-button" onClick={props.onToggle}>
        <div style="min-width:0;text-align:left">
          <div class="title">{e.source.name}</div>
          <div class="meta">
            {formatDisplayDate(e.date)} · {fmt(e.grams)} g
            {e.proxyFor && ` · stand-in for ${e.proxyFor.note}`}
          </div>
          {gaps.length > 0 && (
            <div class="meta">
              Missing: {gaps.map((k) => nutrientLabel(k).toLowerCase()).join(', ')}
            </div>
          )}
        </div>
        <span class="faint">{props.open ? 'Close' : 'Fill in'}</span>
      </button>

      {props.open && (
        <div style="display:flex;flex-direction:column;gap:8px">
          {gaps.length > 0 && (
            <>
              <div class="faint">For the {fmt(e.grams)} g logged, as eaten.</div>
              <div class="field-row">
                {gaps.map((k) => (
                  <label key={k}>
                    {nutrientLabel(k)} ({nutrientUnit(k)})
                    <input
                      type="number"
                      inputMode="decimal"
                      placeholder="unknown"
                      value={values[k] ?? ''}
                      onInput={(ev) =>
                        setValues((v) => ({
                          ...v,
                          [k]: (ev.target as HTMLInputElement).value,
                        }))
                      }
                    />
                  </label>
                ))}
              </div>
              {e.source.kind === 'food' && (
                <label class="toggle">
                  <span>Also fill in the food, and its other entries</span>
                  <input
                    type="checkbox"
                    checked={updateFood}
                    onChange={(ev) => setUpdateFood((ev.target as HTMLInputElement).checked)}
                  />
                </label>
              )}
              <button class="btn btn-primary btn-wide" onClick={() => void saveValues()}>
                Save what you know
              </button>
            </>
          )}
          {e.proxyFor && e.source.kind === 'food' && (
            <div class="row" style="gap:8px">
              <button class="btn btn-small" onClick={() => setPicking(true)}>
                Swap for the real food
              </button>
              <button class="btn btn-small btn-ghost" onClick={() => void keepStandIn()}>
                Keep the stand-in
              </button>
            </div>
          )}
        </div>
      )}

      {picking && (
        <FoodPickerSheet
          title={`What was "${e.proxyFor?.note ?? e.source.name}"?`}
          initialQuery={e.proxyFor?.note ?? ''}
          onClose={() => setPicking(false)}
          onPick={async (food) => {
            setPicking(false)
            const dates = await repo.editEntryFood(e.id, food)
            await store.afterEdit(dates)
            await props.onResolved()
          }}
        />
      )}
    </div>
  )
}
