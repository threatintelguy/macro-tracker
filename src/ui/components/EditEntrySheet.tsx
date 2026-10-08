/**
 * Edit a logged entry.
 *
 * Delete-and-relog throws away the timestamp, the occasion and any override
 * record, then makes the user redo the search. This keeps all of that.
 *
 *   amount    -- rescales the snapshot; never re-resolves against the food table
 *   food      -- re-resolves from scratch, fresh snapshot
 *   time      -- may cross an occasion boundary; the day re-buckets
 *   occasion, fidelity
 *
 * For a composite: multiplier and component overrides (through the composite
 * sheet), and "explode into components" for the rare meal that diverged too
 * far to express as overrides.
 *
 * Edits are silent. No history, no badge.
 */

import { useEffect, useState } from 'preact/hooks'
import type { Entry, Fidelity, FoodItem } from '../../domain/types.ts'
import { FIDELITIES } from '../../domain/types.ts'
import { NAMED_OCCASIONS, fidelityLabel } from '../../domain/analytics/index.ts'
import { nutrientsForGrams, scaleNutrients } from '../../domain/nutrition/index.ts'
import * as repo from '../../data/repositories.ts'
import * as store from '../store.ts'
import { Sheet, fmt } from './common.tsx'
import { FoodPickerSheet } from './FoodPickerSheet.tsx'
import { CompositeLogSheet } from './CompositeLogSheet.tsx'
import { foodInputValue, parseFoodAmount } from '../../domain/units.ts'

const OCCASION_LABELS: Record<(typeof NAMED_OCCASIONS)[number], string> = {
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  dinner: 'Dinner',
  snack: 'Snack',
}

export function EditEntrySheet(props: { entry: Entry; onClose: () => void }) {
  const e = props.entry
  const isComposite = e.source.kind === 'composite'
  const units = store.units.value
  const [grams, setGrams] = useState(foodInputValue(e.grams, units.food))
  const [food, setFood] = useState<FoodItem | undefined>(undefined)
  const [at, setAt] = useState(e.at ?? '')
  const [occasion, setOccasion] = useState(e.occasion ?? '')
  const [fidelity, setFidelity] = useState<Fidelity>(e.fidelity)
  const [picking, setPicking] = useState(false)
  const [editingComposite, setEditingComposite] = useState(false)
  const [confirmExplode, setConfirmExplode] = useState(false)

  const composite =
    e.source.kind === 'composite'
      ? store.composites.value.find((c) => c.id === (e.source as { compositeId: string }).compositeId)
      : undefined
  const deleted =
    e.source.kind === 'composite' && store.tombstoneById.value.has(e.source.compositeId)

  // Grams or ounces; a suffix overrides the preference. Stored as grams.
  const parsedGrams = parseFoodAmount(grams, units.food)
  const g = parsedGrams ?? e.grams
  const gramsValid = parsedGrams !== undefined
  // What the entry will read after saving, for the preview line.
  const preview = food
    ? nutrientsForGrams(food.per100g, gramsValid ? g : e.grams)
    : gramsValid && e.grams > 0
      ? scaleNutrients(e.nutrients, g / e.grams)
      : e.nutrients

  async function save(): Promise<void> {
    const dates: string[] = []
    if (!isComposite) {
      if (food) {
        dates.push(...(await repo.editEntryFood(e.id, food, gramsValid ? g : e.grams)))
      } else if (gramsValid && Math.abs(g - e.grams) > 1e-9) {
        dates.push(...(await repo.editEntryAmount(e.id, g)))
      }
    }
    const timeValid = at === '' || /^([01]\d|2[0-3]):[0-5]\d$/.test(at)
    if (
      timeValid &&
      (at !== (e.at ?? '') || occasion !== (e.occasion ?? '') || fidelity !== e.fidelity)
    ) {
      dates.push(
        ...(await repo.editEntryMeta(e.id, {
          at: at === '' ? null : at,
          occasion: occasion === '' ? null : occasion,
          fidelity,
        })),
      )
    }
    await store.afterEdit(dates)
    props.onClose()
  }

  async function explode(): Promise<void> {
    const dates = await repo.explodeCompositeLog(e.id)
    await store.afterEdit(dates)
    props.onClose()
  }

  if (editingComposite && composite && e.source.kind === 'composite') {
    return (
      <CompositeLogSheet
        composite={composite}
        editing={{ rootId: e.id, instance: e.source }}
        onClose={props.onClose}
      />
    )
  }

  return (
    <Sheet title={`Edit ${e.source.name}${deleted ? ' (deleted)' : ''}`} onClose={props.onClose}>
      {isComposite ? (
        <div class="card" style="display:flex;flex-direction:column;gap:8px">
          <div class="faint">
            {e.source.kind === 'composite' &&
              `${e.source.multiplier}× · version ${e.source.version}${e.source.overrides.length > 0 ? ` · ${e.source.overrides.length} change${e.source.overrides.length === 1 ? '' : 's'} for this entry` : ''}`}
          </div>
          {composite ? (
            <button class="btn btn-wide" onClick={() => setEditingComposite(true)}>
              Change amount or components
            </button>
          ) : (
            <div class="faint">
              The meal definition was deleted, so its components cannot be
              changed here. The logged totals are kept as they were.
            </div>
          )}
          {!confirmExplode ? (
            <button class="btn btn-wide btn-ghost" onClick={() => setConfirmExplode(true)}>
              Explode into components
            </button>
          ) : (
            <div class="notice">
              <div style="margin-bottom:8px">
                The meal becomes loose entries, each keeping its logged amount
                and nutrients. The saved meal itself is not changed.
              </div>
              <div class="row" style="gap:8px">
                <button class="btn btn-small btn-primary" onClick={() => void explode()}>
                  Explode
                </button>
                <button class="btn btn-small btn-ghost" onClick={() => setConfirmExplode(false)}>
                  Keep it together
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <>
          <div class="row-between">
            <div style="min-width:0">
              <div class="card-title" style="margin:0">
                Food
              </div>
              <div>{food ? food.name : e.source.name}</div>
              {e.proxyFor && !food && (
                <div class="faint">stand-in for {e.proxyFor.note}</div>
              )}
            </div>
            <button class="btn btn-small" onClick={() => setPicking(true)}>
              Change food
            </button>
          </div>
          <label>
            Amount ({units.food})
            <input
              type="text"
              inputMode="decimal"
              value={grams}
              onInput={(ev) => setGrams((ev.target as HTMLInputElement).value)}
            />
          </label>
          <div class="faint">
            {food
              ? 'A different food takes a fresh set of values from the food table.'
              : 'A new amount scales the values logged for this entry. It does not look the food up again.'}
          </div>
        </>
      )}

      {e.estimateSource && (
        <div class="faint">
          Estimated by {e.estimateSource.model}{' '}
          {e.estimateSource.tier === 'on-device' ? 'on this device' : 'at your endpoint'} on{' '}
          {new Date(e.estimateSource.at).toLocaleDateString()}.
        </div>
      )}
      {e.photoRef && <EntryPhoto id={e.photoRef} onDeleted={props.onClose} />}

      <div class="field-row">
        <label>
          Time
          <input
            type="time"
            value={at}
            onInput={(ev) => setAt((ev.target as HTMLInputElement).value)}
          />
        </label>
        <label>
          Occasion
          <select
            value={occasion}
            onChange={(ev) => setOccasion((ev.target as HTMLSelectElement).value)}
          >
            <option value="">Group by time</option>
            {NAMED_OCCASIONS.map((o) => (
              <option key={o} value={o}>
                {OCCASION_LABELS[o]}
              </option>
            ))}
            {occasion !== '' && !(NAMED_OCCASIONS as readonly string[]).includes(occasion) && (
              <option value={occasion}>{occasion}</option>
            )}
          </select>
        </label>
      </div>

      <div>
        <div class="card-title">How it was measured</div>
        <div class="chip-row">
          {/* A model estimate is recorded by the estimate flow, with its
              provenance; it is never something to pick by hand. */}
          {FIDELITIES.filter((f) => f !== 'ai_estimated' || e.fidelity === 'ai_estimated').map((f) => (
            <button
              key={f}
              class="chip"
              aria-pressed={fidelity === f}
              onClick={() => setFidelity(f)}
            >
              {fidelityLabel(f)}
            </button>
          ))}
        </div>
      </div>

      {!isComposite && (
        <div class="faint">
          {fmt(preview.kcal)} kcal · {fmt(preview.protein, 1)} g protein ·{' '}
          {fmt(preview.carbs, 1)} g carbs · {fmt(preview.fat, 1)} g fat
        </div>
      )}

      <button class="btn btn-primary btn-wide" onClick={() => void save()}>
        Save
      </button>

      {picking && (
        <FoodPickerSheet
          title="Change food"
          initialQuery={e.proxyFor?.note ?? ''}
          onClose={() => setPicking(false)}
          onPick={(f) => {
            setFood(f)
            setPicking(false)
          }}
        />
      )}
    </Sheet>
  )
}

/** A plate photo attached to an entry: kept for correcting the estimate, deletable. */
function EntryPhoto(props: { id: string; onDeleted: () => void }) {
  const [url, setUrl] = useState<string | undefined>(undefined)
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    let objectUrl: string | undefined
    void repo.getPhoto(props.id).then((blob) => {
      if (!blob) {
        setMissing(true)
        return
      }
      objectUrl = URL.createObjectURL(blob)
      setUrl(objectUrl)
    })
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [props.id])

  if (missing) return null
  return (
    <div style="display:flex;flex-direction:column;gap:6px">
      {url && <img class="photo-thumb" src={url} alt="The meal as photographed" />}
      <button
        class="btn btn-small btn-ghost"
        onClick={() =>
          void repo.deletePhoto(props.id).then(async () => {
            store.notify('Photo deleted.')
            await store.refreshDay()
            props.onDeleted()
          })
        }
      >
        Delete photo
      </button>
    </div>
  )
}
