/**
 * Estimate a meal: a description in, a reviewable draft out.
 *
 * The description is required -- a photo alone is ambiguous about exactly
 * what matters: grilled or fried, oil or butter underneath, what the sauce
 * is. Anything already weighed is pinned and stays exact. Nothing commits
 * without review: every line shows its grams, nutrients and source, and can
 * be edited, deleted or re-matched first.
 *
 * Accepted estimates are bookkeeping, not a penalty: no warning colour, no
 * badge, no nag. They count in every trend and stay out of the expenditure
 * calculation, which needs measured intake.
 */

import { useEffect, useMemo, useState } from 'preact/hooks'
import type { FoodItem, NutrientKey } from '../../domain/types.ts'
import { aggregateNutrients } from '../../domain/nutrition/index.ts'
import { formatTime } from '../../domain/dates.ts'
import { foodInputValue, formatFood, parseFoodAmount } from '../../domain/units.ts'
import {
  buildDraft,
  makeLibraryMatcher,
  mealNameFrom,
  regramLine,
  rematchLine,
  setLineNutrient,
  type Draft,
  type DraftLine,
  type PinnedComponent,
} from '../../estimate/pipeline.ts'
import { runChain } from '../../estimate/chain.ts'
import { acceptEstimate } from '../../data/estimates.ts'
import * as repo from '../../data/repositories.ts'
import { blobToDataUrl, compressImage, pickImage } from '../../platform/image.ts'
import * as store from '../store.ts'
import { EXTERNAL_DISCLOSURE, availableTiers, type TierPlan } from '../estimateTiers.ts'
import { AggregateText, Sheet, fmt, parseOptionalNumber } from './common.tsx'
import { FoodPickerSheet } from './FoodPickerSheet.tsx'

const LINE_LABEL = { db: 'library', model: 'model', prep: 'preparation' } as const

const EDITABLE: readonly (readonly [NutrientKey, string])[] = [
  ['kcal', 'kcal'],
  ['protein', 'Protein g'],
  ['carbs', 'Carbs g'],
  ['fat', 'Fat g'],
  ['satFat', 'Sat fat g'],
  ['sodium', 'Sodium mg'],
]

export function EstimateSheet(props: {
  onClose: () => void
  /** The manual routes, offered when no model can answer. */
  onBuild: (name: string) => void
  onKnown: (name: string) => void
}) {
  const [description, setDescription] = useState('')
  const [pinned, setPinned] = useState<PinnedComponent[]>([])
  const [picking, setPicking] = useState<'pin' | { rematch: string } | undefined>(undefined)
  const [pinFood, setPinFood] = useState<FoodItem | undefined>(undefined)
  const [pinGrams, setPinGrams] = useState('')
  const [photo, setPhoto] = useState<{ blob: Blob; url: string } | undefined>(undefined)
  const [plan, setPlan] = useState<TierPlan | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [draft, setDraft] = useState<Draft | undefined>(undefined)
  const [fellBack, setFellBack] = useState(false)
  const [name, setName] = useState('')
  const [open, setOpen] = useState<string | undefined>(undefined)

  const units = store.units.value
  const externalReady = store.externalReady.value

  useEffect(() => {
    void availableTiers().then(setPlan)
  }, [store.externalEndpoint.value, store.settings.value.onDeviceModelId])

  useEffect(() => () => {
    if (photo) URL.revokeObjectURL(photo.url)
  }, [photo])

  const willSendPhoto = photo !== undefined && plan?.tiers[0]?.tier === 'external'

  async function attachPhoto(): Promise<void> {
    const file = await pickImage()
    if (!file) return
    const blob = await compressImage(file)
    setPhoto({ blob, url: URL.createObjectURL(blob) })
  }

  function addPin(): void {
    const g = parseFoodAmount(pinGrams, units.food)
    if (!pinFood || g === undefined) return
    setPinned((list) => [...list, { food: pinFood, grams: g }])
    setPinFood(undefined)
    setPinGrams('')
  }

  async function acknowledge(): Promise<void> {
    const e = store.externalEndpoint.value
    if (!e) return
    await repo.saveExternalEndpoint({ ...e, disclosureAcceptedAt: Date.now() })
    await store.refreshExternalEndpoint()
    setPlan(await availableTiers())
  }

  async function estimate(): Promise<void> {
    if (description.trim().length === 0 || !plan) return
    setBusy(true)
    setFailure(undefined)
    const request = {
      description: description.trim(),
      pinned,
      ...(willSendPhoto && photo ? { photo: await blobToDataUrl(photo.blob) } : {}),
    }
    const result = await runChain(request, plan.tiers)
    setBusy(false)
    if (!result.ok) {
      setFailure(result.message)
      return
    }
    const next = buildDraft({
      output: result.output,
      request,
      match: makeLibraryMatcher(store.searchIndex.value),
      provenance: result.provenance,
    })
    setFellBack(result.fellBackFrom !== undefined)
    setName(mealNameFrom(description))
    setDraft(next)
  }

  function updateLine(key: string, fn: (l: DraftLine) => DraftLine): void {
    setDraft((d) => (d ? { ...d, lines: d.lines.map((l) => (l.key === key ? fn(l) : l)) } : d))
  }

  async function accept(): Promise<void> {
    if (!draft || draft.lines.length === 0) return
    setBusy(true)
    const keepPhoto = photo !== undefined && store.settings.value.retainPhotos !== false
    const photoRef = keepPhoto ? await repo.putPhoto(photo!.blob) : undefined
    const date = store.selectedDate.value
    const result = await acceptEstimate({
      name,
      lines: draft.lines,
      provenance: draft.provenance,
      date,
      at: formatTime(),
      ...(photoRef ? { photoRef } : {}),
    })
    setBusy(false)
    if (result.entries.length === 0) {
      setFailure(result.problems[0] ?? 'The estimate could not be saved.')
      return
    }
    for (const f of result.foods) store.searchIndex.value.replace(f)
    await store.refreshComposites()
    await store.afterEdit([date])
    store.notify(`"${result.composite.name}" logged and saved to your meals — two taps next time.`)
    props.onClose()
  }

  const totals = useMemo(
    () => (draft ? aggregateNutrients(draft.lines.map((l) => l.nutrients)) : undefined),
    [draft],
  )

  // --- Review ---------------------------------------------------------------

  if (draft) {
    const prov = draft.provenance
    return (
      <Sheet title="Review the estimate" onClose={props.onClose}>
        <label>
          Meal name
          <input
            type="text"
            value={name}
            onInput={(e) => setName((e.target as HTMLInputElement).value)}
          />
        </label>
        <div class="faint">
          Estimated by {prov.model} {prov.tier === 'on-device' ? 'on this device' : 'at your endpoint'}
          {fellBack && ' (your endpoint did not answer, so this one did)'}. Library
          matches use database values; the rest are the model's. Check each line —
          nothing is saved until you accept.
        </div>

        {totals && (
          <div class="running-total">
            <div class="n">
              <span>kcal</span>
              <span><AggregateText agg={totals.kcal} /></span>
            </div>
            <div class="n">
              <span>Protein</span>
              <span><AggregateText agg={totals.protein} unit="g" /></span>
            </div>
            <div class="n">
              <span>Fat</span>
              <span><AggregateText agg={totals.fat} unit="g" /></span>
            </div>
            <div class="n">
              <span>Sodium</span>
              <span><AggregateText agg={totals.sodium} unit="mg" /></span>
            </div>
          </div>
        )}

        <div style="display:flex;flex-direction:column;gap:8px">
          {draft.lines.map((l) => (
            <div class="estimate-line" key={l.key} data-pinned={l.pinned ? 'true' : 'false'}>
              <div class="row-between">
                <div style="min-width:0">
                  <div class="title">
                    {l.name}
                    <span class="source-tag" data-source={l.source}>
                      {l.pinned ? 'weighed' : LINE_LABEL[l.source]}
                    </span>
                  </div>
                  <div class="meta">
                    {formatFood(l.grams, units.food)} · {fmt(l.nutrients.kcal)} kcal ·{' '}
                    {fmt(l.nutrients.protein, 1)} P · {fmt(l.nutrients.carbs, 1)} C ·{' '}
                    {fmt(l.nutrients.fat, 1)} F · {fmt(l.nutrients.sodium)} mg sodium
                  </div>
                </div>
                <button
                  class="btn btn-small btn-ghost"
                  onClick={() => setOpen(open === l.key ? undefined : l.key)}
                >
                  {open === l.key ? 'Done' : 'Edit'}
                </button>
              </div>
              {open === l.key && (
                <LineEditor
                  line={l}
                  onChange={(next) => updateLine(l.key, () => next)}
                  onRematch={() => setPicking({ rematch: l.key })}
                  onDelete={() =>
                    setDraft((d) => (d ? { ...d, lines: d.lines.filter((x) => x.key !== l.key) } : d))
                  }
                />
              )}
            </div>
          ))}
        </div>

        {failure && <div class="notice">{failure}</div>}

        <div class="row" style="gap:8px">
          <button class="btn btn-ghost" onClick={() => setDraft(undefined)}>
            Back
          </button>
          <button
            class="btn btn-primary"
            style="flex:1"
            disabled={busy || draft.lines.length === 0}
            onClick={() => void accept()}
          >
            Accept and log
          </button>
        </div>

        {typeof picking === 'object' && (
          <FoodPickerSheet
            title="Match to a library food"
            initialQuery={draft.lines.find((l) => l.key === picking.rematch)?.name.replace(/\s*\(estimate\)$/, '') ?? ''}
            onClose={() => setPicking(undefined)}
            onPick={(food) => {
              updateLine(picking.rematch, (l) => rematchLine(l, food))
              setPicking(undefined)
            }}
          />
        )}
      </Sheet>
    )
  }

  // --- Compose ----------------------------------------------------------------

  const tierLabel =
    plan === undefined
      ? 'Checking…'
      : plan.tiers.length === 0
        ? plan.needsDisclosure
          ? 'Your endpoint is set up; read what it is sent below.'
          : 'No model is set up. Settings has an on-device model and an optional endpoint.'
        : plan.tiers
            .map((t) => (t.tier === 'external' ? `${t.model} (your endpoint)` : `${t.model} (on this device)`))
            .join(', then ')

  return (
    <Sheet title="Estimate a meal" onClose={props.onClose}>
      <div class="faint">
        For food with no label, no recipe and nothing to weigh. Describe it —
        what it is, how it was cooked, roughly how much. You review every line
        before anything is saved.
      </div>

      <label>
        What was it?
        <textarea
          rows={3}
          value={description}
          placeholder="Chipotle-style burrito bowl: chicken, white rice, black beans, cheese, sour cream, salsa. Large."
          onInput={(e) => setDescription((e.target as HTMLTextAreaElement).value)}
        />
      </label>

      <div>
        <div class="card-title">Already weighed something?</div>
        {pinned.map((p, i) => (
          <div class="entry-row" key={`${p.food.id}-${i}`}>
            <span>{p.food.name}</span>
            <span class="grams">
              {formatFood(p.grams, units.food)}{' '}
              <button
                class="btn btn-small btn-ghost"
                onClick={() => setPinned((list) => list.filter((_, n) => n !== i))}
              >
                Remove
              </button>
            </span>
          </div>
        ))}
        {pinFood ? (
          <div class="row" style="gap:8px;margin-top:6px">
            <span style="flex:1;min-width:0">{pinFood.name}</span>
            <input
              type="text"
              inputMode="decimal"
              style="width:96px"
              autoFocus
              placeholder={units.food}
              value={pinGrams}
              onInput={(e) => setPinGrams((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addPin()
              }}
            />
            <button class="btn btn-small" onClick={addPin}>
              Pin
            </button>
          </div>
        ) : (
          <button class="btn btn-small btn-ghost" onClick={() => setPicking('pin')}>
            Add a weighed part
          </button>
        )}
        <div class="faint" style="margin-top:4px">
          Weighed parts stay exact; the estimate is built around them.
        </div>
      </div>

      {/* Photo capture needs the external endpoint; without one it is absent
          rather than present and failing. */}
      {externalReady && (
        <div>
          {photo ? (
            <div style="display:flex;flex-direction:column;gap:6px">
              <img class="photo-thumb" src={photo.url} alt="The meal" />
              <button class="btn btn-small btn-ghost" onClick={() => setPhoto(undefined)}>
                Remove photo
              </button>
            </div>
          ) : (
            <button class="btn btn-small btn-ghost" onClick={() => void attachPhoto()}>
              Add a photo (optional)
            </button>
          )}
        </div>
      )}

      <div class="faint">Will use: {tierLabel}</div>

      {plan?.needsDisclosure && (
        <div class="notice">
          <div style="margin-bottom:8px">{EXTERNAL_DISCLOSURE}</div>
          <button class="btn btn-small" onClick={() => void acknowledge()}>
            Understood
          </button>
        </div>
      )}
      {plan?.tiers[0]?.tier === 'external' && (
        <details class="faint">
          <summary>What is sent</summary>
          {EXTERNAL_DISCLOSURE}
          {willSendPhoto ? ' This time that includes the photo.' : ' This time there is no photo.'}
        </details>
      )}

      {failure && <div class="notice">{failure}</div>}

      {plan && plan.tiers.length === 0 ? (
        <div class="routes">
          <button class="route" onClick={() => props.onBuild(mealNameFrom(description))}>
            <span class="route-title">Build it from ingredients</span>
            <span class="route-sub">Estimate each part's grams; the panel follows.</span>
          </button>
          <button class="route" onClick={() => props.onKnown(mealNameFrom(description))}>
            <span class="route-title">Enter only what you know</span>
            <span class="route-sub">A menu's calories and nothing else is fine.</span>
          </button>
        </div>
      ) : (
        <button
          class="btn btn-primary btn-wide"
          disabled={busy || description.trim().length === 0 || !plan || plan.tiers.length === 0}
          onClick={() => void estimate()}
        >
          {busy ? 'Estimating…' : 'Estimate'}
        </button>
      )}

      {failure && plan && plan.tiers.length > 0 && (
        <div class="row" style="gap:8px">
          <button class="btn btn-small btn-ghost" onClick={() => props.onBuild(mealNameFrom(description))}>
            Build it from ingredients
          </button>
          <button class="btn btn-small btn-ghost" onClick={() => props.onKnown(mealNameFrom(description))}>
            Enter what you know
          </button>
        </div>
      )}

      {picking === 'pin' && (
        <FoodPickerSheet
          title="What did you weigh?"
          onClose={() => setPicking(undefined)}
          onPick={(food) => {
            setPinFood(food)
            setPicking(undefined)
          }}
        />
      )}
    </Sheet>
  )
}

function LineEditor(props: {
  line: DraftLine
  onChange: (l: DraftLine) => void
  onRematch: () => void
  onDelete: () => void
}) {
  const { line } = props
  const units = store.units.value
  const [amount, setAmount] = useState(foodInputValue(line.grams, units.food))

  return (
    <div style="display:flex;flex-direction:column;gap:8px">
      {!line.pinned && (
        <label>
          Amount ({units.food})
          <input
            type="text"
            inputMode="decimal"
            value={amount}
            onInput={(e) => {
              const raw = (e.target as HTMLInputElement).value
              setAmount(raw)
              const g = parseFoodAmount(raw, units.food)
              if (g !== undefined) props.onChange(regramLine(line, g))
            }}
          />
        </label>
      )}
      {line.source !== 'db' && (
        <div class="field-row">
          {EDITABLE.map(([k, label]) => (
            <label key={k}>
              {label}
              <input
                type="number"
                inputMode="decimal"
                placeholder="unknown"
                value={line.nutrients[k] === null ? '' : String(Math.round(line.nutrients[k]! * 10) / 10)}
                onChange={(e) =>
                  props.onChange(
                    setLineNutrient(line, k, parseOptionalNumber((e.target as HTMLInputElement).value)),
                  )
                }
              />
            </label>
          ))}
        </div>
      )}
      <div class="row" style="gap:8px">
        {!line.pinned && line.source !== 'prep' && (
          <button class="btn btn-small" onClick={props.onRematch}>
            {line.source === 'db' ? 'Match a different food' : 'Match to a library food'}
          </button>
        )}
        <button class="btn btn-small btn-ghost" onClick={props.onDelete}>
          Remove line
        </button>
      </div>
    </div>
  )
}
