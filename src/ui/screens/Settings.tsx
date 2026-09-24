/**
 * Settings.
 *
 * Profile · goal and rate · targets with provenance, each editable and
 * resettable · phase and precision mode · composite library management ·
 * custom foods · export and import, as a matched pair · the needs-detail
 * list · offline mode · theme.
 *
 * The goal screen refuses an unsafe rate or target at input rather than
 * accepting it and clamping later, so the app never displays a number it
 * will not honour.
 */

import { useEffect, useMemo, useState } from 'preact/hooks'
import type {
  ActivityLevel,
  Composite,
  PresetName,
  TargetKey,
} from '../../domain/types.ts'
import * as store from '../store.ts'
import * as repo from '../../data/repositories.ts'
import { db, SCHEMA_VERSION } from '../../data/db.ts'
import {
  ACTIVITY_LABELS,
  ACTIVITY_MULTIPLIERS,
  bmi,
  waistToHeight,
} from '../../domain/nutrition/index.ts'
import {
  CEILING_TARGETS,
  PRESETS,
  TARGET_LABELS,
  TARGET_UNITS,
  sourceLabel,
} from '../../domain/engine/targets.ts'
import { CLAMPS, validateGoal } from '../../domain/engine/clamps.ts'
import { capabilities, type StorageEstimate } from '../../platform/index.ts'
import {
  BACKUP_PROMPT_ESCALATION_DAYS,
  backupFilename,
  daysSinceBackup,
  daysToCsv,
  entriesToCsv,
  jsonFilename,
  payloadToJson,
  writeBackup,
} from '../../export/backup.ts'
import { collectPayload, restoreSnapshot } from '../../data/transfer.ts'
import * as engine from '../../data/engine.ts'
import { Empty, Sheet, fmt } from '../components/common.tsx'
import { CompositeEditor } from '../components/CompositeEditor.tsx'
import { CompositeDeleteSheet } from '../components/CompositeDeleteSheet.tsx'
import { ImportSheet } from '../components/ImportSheet.tsx'
import { NeedsDetailSheet } from '../components/NeedsDetailSheet.tsx'
import { today } from '../../domain/dates.ts'
import {
  GATE_MAX_TDEE_SE,
  GATE_MIN_LOGGED_PCT,
  GATE_MIN_WEIGHT_ENTRIES,
  PRECISION_MODE_INFO,
  graduationGate,
  phaseLabel,
  precisionModeLabel,
} from '../../domain/phase/index.ts'
import type { PrecisionMode } from '../../domain/types.ts'

export function Settings() {
  const [editTarget, setEditTarget] = useState<TargetKey | undefined>(undefined)
  const [editComposite, setEditComposite] = useState<Composite | undefined>(undefined)
  const [newComposite, setNewComposite] = useState(false)
  const [showBackup, setShowBackup] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [showNeedsDetail, setShowNeedsDetail] = useState(false)
  const [deleting, setDeleting] = useState<Composite | undefined>(undefined)
  const [showGoal, setShowGoal] = useState(false)
  const [storage, setStorage] = useState<StorageEstimate | undefined>(undefined)

  const profile = store.profile.value
  const settings = store.settings.value
  const resolved = store.targets.value
  const lastBackup = profile?.lastBackupAt
  const sinceBackup = daysSinceBackup(lastBackup)

  useEffect(() => {
    void capabilities.storageEstimate().then(setStorage)
  }, [])

  if (!profile) return <div class="screen">Loading…</div>

  async function patchProfile(patch: Partial<typeof profile>): Promise<void> {
    const next = { ...profile!, ...patch }
    await repo.saveProfile(next)
    store.profile.value = next
  }

  async function patchSettings(patch: Partial<typeof settings>): Promise<void> {
    const next = { ...settings, ...patch }
    await repo.saveSettings(next)
    store.settings.value = next
  }

  return (
    <div class="screen">
      <div class="screen-head">
        <h1>Settings</h1>
      </div>

      {/* Backup health — always visible, because this app holds the only copy. */}
      <div
        class="notice"
        data-tone={
          sinceBackup === undefined || sinceBackup >= BACKUP_PROMPT_ESCALATION_DAYS
            ? 'attention'
            : undefined
        }
      >
        <div class="row-between">
          <span>
            {sinceBackup === undefined
              ? 'No backup yet. This app holds the only copy of your data.'
              : sinceBackup === 0
                ? 'Backed up today.'
                : `Last backup ${sinceBackup} day${sinceBackup === 1 ? '' : 's'} ago.`}
          </span>
          <button class="btn btn-small" onClick={() => setShowBackup(true)}>
            Back up
          </button>
        </div>
      </div>

      {/* Export and import, as a matched pair. */}
      <div class="card">
        <div class="card-title">Your data</div>
        <div class="grid-2">
          <button class="btn" onClick={() => setShowBackup(true)}>
            Export
          </button>
          <button class="btn" onClick={() => setShowImport(true)}>
            Import
          </button>
        </div>
        <Snapshots />
        <button
          class="btn btn-small btn-ghost btn-wide"
          style="margin-top:10px"
          onClick={() => setShowNeedsDetail(true)}
        >
          Needs detail
          {store.needsDetailCount.value > 0 && ` · ${store.needsDetailCount.value}`}
        </button>
      </div>

      <PhaseAndMode />

      {/* Targets with provenance. */}
      <div class="card">
        <div class="card-title">Targets</div>
        <div class="chip-row" style="margin-bottom:10px">
          {(['fatLoss', 'maintenance', 'leanGain', 'custom'] as PresetName[]).map(
            (p) => (
              <button
                key={p}
                class="chip"
                aria-pressed={settings.preset === p}
                onClick={() => void patchSettings({ preset: p })}
              >
                {p === 'custom' ? 'Custom' : PRESETS[p].label}
              </button>
            ),
          )}
        </div>
        {settings.preset !== 'custom' && (
          <div class="faint" style="margin-bottom:10px">
            {PRESETS[settings.preset].description}
          </div>
        )}

        {resolved ? (
          <div class="list">
            {(Object.keys(TARGET_LABELS) as TargetKey[]).map((key) => {
              const t = resolved.targets[key]
              return (
                <button
                  key={key}
                  class="list-item"
                  onClick={() => setEditTarget(key)}
                >
                  <div style="flex:1;min-width:0">
                    <div class="title">{TARGET_LABELS[key]}</div>
                    <div class="meta">
                      {sourceLabel(t.source)}
                      {CEILING_TARGETS.has(key) && ' · ceiling'}
                      {t.clampedFrom !== undefined &&
                        t.source !== 'clamped' &&
                        ' · at a floor'}
                    </div>
                  </div>
                  <strong style="font-variant-numeric:tabular-nums">
                    {fmt(t.value)} {TARGET_UNITS[key]}
                  </strong>
                </button>
              )
            })}
          </div>
        ) : (
          <Empty>Enter a weight to compute targets.</Empty>
        )}

        {resolved && (
          <div class="faint" style="margin-top:10px">
            Maintenance {fmt(resolved.maintenanceKcal)} kcal, from{' '}
            {resolved.maintenanceSource === 'observed'
              ? 'your measured expenditure'
              : `the formula (BMR ${fmt(resolved.bmr)})`}
            . Tap any target to see where it came from and to change it.
          </div>
        )}
      </div>

      {/* Goal. */}
      <div class="card">
        <div class="row-between">
          <div>
            <div class="card-title" style="margin:0">
              Goal
            </div>
            <div style="margin-top:4px">
              {store.goal.value
                ? `${store.goal.value.direction} · ${fmt(Math.abs(store.goal.value.targetRateKgPerWeek), 2)} kg/week`
                : 'Not set'}
            </div>
          </div>
          <button class="btn btn-small" onClick={() => setShowGoal(true)}>
            {store.goal.value ? 'Change' : 'Set'}
          </button>
        </div>
      </div>

      {/* Profile. */}
      <div class="card">
        <div class="card-title">Profile</div>
        <div class="field-row">
          <label>
            Height (cm)
            <input
              type="number"
              inputMode="decimal"
              value={String(profile.heightCm)}
              onChange={(e) => {
                const v = Number((e.target as HTMLInputElement).value)
                if (v > 0) void patchProfile({ heightCm: v })
              }}
            />
          </label>
          <label>
            Birth year
            <input
              type="number"
              inputMode="numeric"
              value={String(profile.birthYear)}
              onChange={(e) => {
                const v = Number((e.target as HTMLInputElement).value)
                if (v > 1900) void patchProfile({ birthYear: v })
              }}
            />
          </label>
        </div>
        <label style="margin-top:10px">
          Activity
          <select
            value={profile.activityLevel}
            onChange={(e) =>
              void patchProfile({
                activityLevel: (e.target as HTMLSelectElement).value as ActivityLevel,
              })
            }
          >
            {(Object.keys(ACTIVITY_MULTIPLIERS) as ActivityLevel[]).map((a) => (
              <option key={a} value={a}>
                {ACTIVITY_LABELS[a]}
              </option>
            ))}
          </select>
        </label>

        {store.currentWeightKg.value !== undefined && (
          <div class="faint" style="margin-top:10px">
            BMI {fmt(bmi(store.currentWeightKg.value, profile.heightCm), 1)} — a weak
            signal for an active person of this height. Waist circumference, and
            waist-to-height under 0.5, are the better references
            {store.day.value?.waistCm !== undefined &&
              ` — currently ${fmt(waistToHeight(store.day.value.waistCm, profile.heightCm), 2)}`}
            .
          </div>
        )}
      </div>

      {/* Composite library management. */}
      <div class="card">
        <div class="row-between" style="margin-bottom:8px">
          <div class="card-title" style="margin:0">
            Composite library
          </div>
          <button class="btn btn-small btn-ghost" onClick={() => setNewComposite(true)}>
            New
          </button>
        </div>
        <CompositeLibrary onEdit={setEditComposite} onDelete={setDeleting} />
      </div>

      {/* Privacy and network. */}
      <div class="card">
        <div class="card-title">Privacy</div>
        <label class="toggle" style="margin-bottom:10px">
          <span>Barcode lookup</span>
          <input
            type="checkbox"
            checked={settings.barcodeLookupEnabled}
            onChange={(e) =>
              void patchSettings({
                barcodeLookupEnabled: (e.target as HTMLInputElement).checked,
              })
            }
          />
        </label>
        <label class="toggle">
          <span>Offline mode — no network requests at all</span>
          <input
            type="checkbox"
            checked={profile.offlineMode}
            onChange={(e) =>
              void patchProfile({
                offlineMode: (e.target as HTMLInputElement).checked,
              })
            }
          />
        </label>
        <p class="faint" style="margin:10px 0 0">
          Exactly one outbound call exists in this app: the barcode lookup, on
          an explicit tap. It sends one product code with no identifier, no
          session and no cookie, and caches the result locally forever. There is
          no analytics, no error reporting, and no third-party script or font.
          With lookup off, this app makes no network requests after the page
          loads.
        </p>
      </div>

      {/* Storage durability. */}
      <div class="card">
        <div class="card-title">Storage</div>
        <div class="row-between">
          <span class="muted">Persistent storage</span>
          <span>
            {storage?.persisted === true
              ? 'Granted'
              : storage?.persisted === false
                ? 'Not granted'
                : '—'}
          </span>
        </div>
        {storage?.usageBytes !== undefined && (
          <div class="row-between" style="margin-top:6px">
            <span class="muted">Used</span>
            <span>
              {(storage.usageBytes / 1024 / 1024).toFixed(1)} MB
              {storage.quotaBytes !== undefined &&
                ` of ${(storage.quotaBytes / 1024 / 1024 / 1024).toFixed(1)} GB`}
            </span>
          </div>
        )}
        {storage?.persisted === false && (
          <button
            class="btn btn-small btn-wide"
            style="margin-top:10px"
            onClick={() =>
              void capabilities.requestPersistentStorage().then(async (ok) => {
                setStorage(await capabilities.storageEstimate())
                store.notify(
                  ok
                    ? 'Persistent storage granted.'
                    : 'The browser declined. Back up regularly — browser storage can be evicted.',
                )
              })
            }
          >
            Request persistent storage
          </button>
        )}
      </div>

      {/* Appearance. */}
      <div class="card">
        <div class="card-title">Appearance</div>
        <div class="chip-row">
          {(['dark', 'light'] as const).map((t) => (
            <button
              key={t}
              class="chip"
              aria-pressed={profile.theme === t}
              onClick={() => {
                void patchProfile({ theme: t })
                document.documentElement.dataset['theme'] = t
              }}
            >
              {t === 'dark' ? 'Dark' : 'Light'}
            </button>
          ))}
        </div>
      </div>

      <div class="faint" style="text-align:center;padding:8px 0 4px">
        Schema v{SCHEMA_VERSION} · every number here is an estimate from
        population equations applied to one person.
      </div>

      {editTarget && resolved && (
        <TargetEditor
          targetKey={editTarget}
          onClose={() => setEditTarget(undefined)}
        />
      )}
      {showGoal && <GoalSheet onClose={() => setShowGoal(false)} />}
      {showBackup && <BackupSheet onClose={() => setShowBackup(false)} />}
      {showImport && <ImportSheet onClose={() => setShowImport(false)} />}
      {showNeedsDetail && <NeedsDetailSheet onClose={() => setShowNeedsDetail(false)} />}
      {deleting && (
        <CompositeDeleteSheet composite={deleting} onClose={() => setDeleting(undefined)} />
      )}
      {(editComposite || newComposite) && (
        <CompositeEditor
          {...(editComposite ? { composite: editComposite } : {})}
          onClose={() => {
            setEditComposite(undefined)
            setNewComposite(false)
          }}
        />
      )}
    </div>
  )
}

type LibrarySort = 'mostUsed' | 'leastUsed' | 'recent' | 'longAgo'

const SORT_LABELS: Record<LibrarySort, string> = {
  mostUsed: 'Most used',
  leastUsed: 'Least used',
  recent: 'Used recently',
  longAgo: 'Not used lately',
}

/**
 * Composites auto-save from every multi-component meal, so the library
 * accumulates one-offs. Usage count and last-used date, sortable both ways,
 * make cleanup obvious without the app prompting anything. A meal used once,
 * months ago, is the candidate; nothing is ever acted on automatically.
 */
function CompositeLibrary(props: {
  onEdit: (c: Composite) => void
  onDelete: (c: Composite) => void
}) {
  const composites = store.composites.value
  const usage = store.usage.value
  const [sort, setSort] = useState<LibrarySort>('mostUsed')

  const rows = useMemo(() => {
    const list = composites.map((c) => {
      const uses = usage.filter((u) => u.compositeId === c.id)
      return {
        composite: c,
        count: uses.length,
        lastUsedAt:
          uses.length > 0 ? Math.max(...uses.map((u) => u.loggedAt)) : undefined,
      }
    })
    const last = (r: (typeof list)[number]): number => r.lastUsedAt ?? r.composite.createdAt
    switch (sort) {
      case 'mostUsed':
        return list.sort((a, b) => b.count - a.count || last(b) - last(a))
      case 'leastUsed':
        return list.sort((a, b) => a.count - b.count || last(a) - last(b))
      case 'recent':
        return list.sort((a, b) => last(b) - last(a))
      case 'longAgo':
        return list.sort((a, b) => last(a) - last(b))
    }
  }, [composites, usage, sort])

  async function toggleRetired(c: Composite): Promise<void> {
    await repo.putComposite({ ...c, retired: !c.retired })
    await store.refreshComposites()
  }

  if (rows.length === 0) {
    return <Empty>The library builds itself as you weigh meals.</Empty>
  }

  return (
    <>
      <div class="chip-row" style="margin-bottom:8px">
        {(Object.keys(SORT_LABELS) as LibrarySort[]).map((k) => (
          <button key={k} class="chip" aria-pressed={sort === k} onClick={() => setSort(k)}>
            {SORT_LABELS[k]}
          </button>
        ))}
      </div>
      <div class="list">
        {rows.map((r) => (
          <div
            class="list-item"
            key={r.composite.id}
            style={`flex-wrap:wrap;${r.composite.retired ? 'opacity:0.55' : ''}`}
          >
            <div style="flex:1;min-width:0">
              <div class="title">{r.composite.name}</div>
              <div class="meta">
                v{r.composite.version} · {r.composite.components.length} components ·{' '}
                {r.count === 0 ? 'never logged' : `logged ${r.count}×`}
                {r.lastUsedAt !== undefined &&
                  ` · last ${new Date(r.lastUsedAt).toLocaleDateString()}`}
                {r.composite.retired && ' · retired'}
              </div>
            </div>
            <div class="row" style="gap:4px">
              <button
                class="btn btn-small btn-ghost"
                onClick={() => props.onEdit(r.composite)}
              >
                Edit
              </button>
              <button
                class="btn btn-small btn-ghost"
                onClick={() => void toggleRetired(r.composite)}
              >
                {r.composite.retired ? 'Restore' : 'Retire'}
              </button>
              <button
                class="btn btn-small btn-ghost"
                onClick={() => props.onDelete(r.composite)}
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
  )
}

/**
 * The copies written before each import and purge. One tap puts the
 * database back exactly as it was.
 */
function Snapshots() {
  const [list, setList] = useState<{ id?: number; at: number; reason: string }[]>([])
  const [confirm, setConfirm] = useState<number | undefined>(undefined)

  async function load(): Promise<void> {
    setList(await repo.listSnapshots())
  }
  useEffect(() => {
    void load()
  }, [store.recentRollups.value])

  async function restore(id: number): Promise<void> {
    await restoreSnapshot(id)
    await store.loadFoodIndex()
    await store.refreshAll()
    await engine.runDailyEngine()
    await store.refreshHistory()
    setConfirm(undefined)
    store.notify('Put back as it was.')
    await load()
  }

  const latest = list[0]
  if (!latest || latest.id === undefined) return null
  const id = latest.id
  const when = new Date(latest.at).toLocaleString()
  return (
    <div style="margin-top:10px">
      {confirm === id ? (
        <div class="notice">
          <div style="margin-bottom:8px">
            Put everything back as it was before the {latest.reason} on {when}?
            Anything logged since then is replaced.
          </div>
          <div class="row" style="gap:8px">
            <button class="btn btn-small btn-primary" onClick={() => void restore(id)}>
              Put it back
            </button>
            <button class="btn btn-small btn-ghost" onClick={() => setConfirm(undefined)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button class="btn btn-small btn-ghost btn-wide" onClick={() => setConfirm(id)}>
          Undo the last {latest.reason} ({when})
        </button>
      )}
    </div>
  )
}

/**
 * Phase and precision mode.
 *
 * The mode switcher is a first-class control. Switching states plainly what
 * changes and what each mode can feed; switching down is a legitimate
 * choice, so there is no "are you sure".
 *
 * Leaving calibration is dual-gated: the date must pass AND the data must
 * suffice. The app reports the gate; the user confirms.
 */
function PhaseAndMode() {
  const profile = store.profile.value
  const progress = store.progress.value
  const latest = store.latestTdee.value
  if (!profile) return null

  const gate =
    progress && profile.phase !== 'steady'
      ? graduationGate({
          progress,
          ...(latest && latest.sufficient ? { tdeeSe: latest.standardError } : {}),
        })
      : undefined

  async function setMode(mode: PrecisionMode): Promise<void> {
    const next = { ...profile!, precisionMode: mode }
    await repo.saveProfile(next)
    store.profile.value = next
    // The mode is recorded on the day: today switches, the past does not.
    const t = today()
    const day = await repo.getDay(t)
    if (day) await repo.saveDay({ ...day, precisionMode: mode })
    await store.afterEdit([t])
  }

  async function setPhase(phase: 'steady' | 'recalibration'): Promise<void> {
    const t = today()
    const next = {
      ...profile!,
      phase,
      phaseStartDate: t,
      // Recalibration is weighed; steady restores the chosen mode.
      precisionMode: phase === 'recalibration' ? ('weighed' as const) : profile!.precisionMode,
    }
    delete (next as { phaseEndDate?: string }).phaseEndDate
    await repo.saveProfile(next)
    store.profile.value = next
    const day = await repo.getDay(t)
    if (day) await repo.saveDay({ ...day, phase, precisionMode: next.precisionMode })
    await store.afterEdit([t])
    store.notify(`${phaseLabel(phase)} from today.`)
  }

  return (
    <div class="card">
      <div class="card-title">Phase and precision</div>
      <div class="row-between">
        <span>{phaseLabel(profile.phase)}</span>
        {profile.phase === 'steady' ? (
          <button class="btn btn-small btn-ghost" onClick={() => void setPhase('recalibration')}>
            Start recalibration
          </button>
        ) : (
          <button
            class="btn btn-small"
            disabled={!gate?.passes}
            onClick={() => void setPhase('steady')}
          >
            Move to steady state
          </button>
        )}
      </div>
      {gate && (
        <div class="faint" style="margin-top:6px">
          {gate.dateReached ? 'End date reached' : `Ends ${progress?.endDate ?? ''}`} ·{' '}
          {Math.round(gate.loggedPct)}% of days logged (needs {GATE_MIN_LOGGED_PCT}%) ·{' '}
          {gate.weightEntries} weight readings (needs {GATE_MIN_WEIGHT_ENTRIES}) ·{' '}
          {gate.tdeeSe !== undefined
            ? `expenditure known to ±${Math.round(gate.tdeeSe)} kcal (needs ±${GATE_MAX_TDEE_SE})`
            : 'expenditure not measurable yet'}
        </div>
      )}

      <div class="card-title" style="margin-top:14px">
        Precision mode
      </div>
      <div class="chip-row">
        {(['weighed', 'composite', 'minimal'] as const).map((m) => (
          <button
            key={m}
            class="chip"
            aria-pressed={profile.precisionMode === m}
            onClick={() => void setMode(m)}
          >
            {precisionModeLabel(m)}
          </button>
        ))}
      </div>
      <div class="faint" style="margin-top:8px">
        {PRECISION_MODE_INFO[profile.precisionMode].logs}{' '}
        {PRECISION_MODE_INFO[profile.precisionMode].effort}.{' '}
        {PRECISION_MODE_INFO[profile.precisionMode].feeds}
      </div>
    </div>
  )
}

function TargetEditor(props: { targetKey: TargetKey; onClose: () => void }) {
  const resolved = store.targets.value!
  const key = props.targetKey
  const target = resolved.targets[key]
  const settings = store.settings.value
  const [value, setValue] = useState(String(Math.round(target.value)))
  const [note, setNote] = useState('')

  async function save(): Promise<void> {
    const v = Number(value)
    if (!Number.isFinite(v) || v < 0) return
    const overrides = [
      ...settings.overrides.filter((o) => o.key !== key),
      { key, value: v, setAt: Date.now(), ...(note.trim() ? { note: note.trim() } : {}) },
    ]
    const next = { ...settings, overrides, preset: 'custom' as PresetName }
    await repo.saveSettings(next)
    store.settings.value = next
    store.notify(`${TARGET_LABELS[key]} set to ${fmt(v)} ${TARGET_UNITS[key]}.`)
    props.onClose()
  }

  async function reset(): Promise<void> {
    const next = {
      ...settings,
      overrides: settings.overrides.filter((o) => o.key !== key),
    }
    await repo.saveSettings(next)
    store.settings.value = next
    store.notify(`${TARGET_LABELS[key]} reset to its computed value.`)
    props.onClose()
  }

  return (
    <Sheet title={TARGET_LABELS[key]} onClose={props.onClose}>
      <div class="row" style="gap:8px">
        <span class="tier-tag">{sourceLabel(target.source)}</span>
        {target.updatedAt !== undefined && (
          <span class="faint">
            changed {new Date(target.updatedAt).toLocaleDateString()}
          </span>
        )}
      </div>
      <p class="muted" style="margin:0;font-size:0.92rem">
        {target.rationale}
      </p>

      {target.clampedFrom !== undefined && (
        <div class="notice" data-tone="attention">
          A floor was reached: the layers below produced{' '}
          {fmt(target.clampedFrom)} {TARGET_UNITS[key]}. Guardrail floors have no
          override, in either direction.
        </div>
      )}

      <label>
        Target ({TARGET_UNITS[key]})
        <input
          type="number"
          inputMode="decimal"
          value={value}
          autoFocus
          onInput={(e) => setValue((e.target as HTMLInputElement).value)}
        />
      </label>
      <label>
        Why (optional)
        <input
          type="text"
          value={note}
          placeholder="Training block, medical guidance…"
          onInput={(e) => setNote((e.target as HTMLInputElement).value)}
        />
      </label>

      <div class="faint">
        Edits are recorded with a timestamp and can be reset at any time. The
        guardrail floors still apply afterwards — calories below{' '}
        {CLAMPS.minKcal}, protein below {CLAMPS.minProteinGPerKg} g/kg and fat
        below {CLAMPS.minFatGPerKg} g/kg are raised back, and the app will say
        so.
      </div>

      <div class="row" style="gap:8px">
        <button class="btn btn-primary" style="flex:1" onClick={() => void save()}>
          Save
        </button>
        {target.source === 'user' && (
          <button class="btn btn-ghost" onClick={() => void reset()}>
            Reset
          </button>
        )}
      </div>
    </Sheet>
  )
}

function GoalSheet(props: { onClose: () => void }) {
  const existing = store.goal.value
  const profile = store.profile.value!
  const weightKg = store.currentWeightKg.value ?? existing?.anchorWeightKg ?? 0
  const resolved = store.targets.value

  const [direction, setDirection] = useState<'loss' | 'maintain' | 'gain'>(
    existing?.direction ?? 'loss',
  )
  const [rate, setRate] = useState(
    String(Math.abs(existing?.targetRateKgPerWeek ?? 0.35)),
  )
  const [targetWeight, setTargetWeight] = useState(
    existing?.targetWeightKg !== undefined ? String(existing.targetWeightKg) : '',
  )

  const signedRate =
    direction === 'maintain' ? 0 : direction === 'loss' ? -Number(rate) : Number(rate)

  const validation = validateGoal({
    direction,
    rateKgPerWeek: signedRate,
    currentWeightKg: weightKg,
    heightCm: profile.heightCm,
    ...(targetWeight.trim() !== '' ? { targetWeightKg: Number(targetWeight) } : {}),
    ...(resolved
      ? {
          plannedKcal: resolved.targets.kcal.value,
          maintenanceKcal: resolved.maintenanceKcal,
        }
      : {}),
  })

  async function save(): Promise<void> {
    if (!validation.ok) return
    await repo.setActiveGoal({
      direction,
      targetRateKgPerWeek: signedRate,
      startDate: today(),
      anchorWeightKg: weightKg,
      ...(targetWeight.trim() !== ''
        ? { targetWeightKg: Number(targetWeight) }
        : {}),
      active: true,
      createdAt: Date.now(),
    })
    store.goal.value = await repo.getActiveGoal()
    store.notify('Goal set.')
    props.onClose()
  }

  return (
    <Sheet title="Goal" onClose={props.onClose}>
      <div class="chip-row">
        {(['loss', 'maintain', 'gain'] as const).map((d) => (
          <button
            key={d}
            class="chip"
            aria-pressed={direction === d}
            onClick={() => setDirection(d)}
          >
            {d === 'loss' ? 'Fat loss' : d === 'gain' ? 'Lean gain' : 'Maintain'}
          </button>
        ))}
      </div>

      {direction !== 'maintain' && (
        <label>
          Rate (kg per week)
          <input
            type="number"
            inputMode="decimal"
            step="0.05"
            value={rate}
            onInput={(e) => setRate((e.target as HTMLInputElement).value)}
          />
        </label>
      )}

      <label>
        Target weight (kg, optional)
        <input
          type="number"
          inputMode="decimal"
          step="0.5"
          value={targetWeight}
          onInput={(e) => setTargetWeight((e.target as HTMLInputElement).value)}
        />
      </label>

      {!validation.ok && (
        <div class="notice" data-tone="attention">
          {validation.problems.map((p) => (
            <div key={p} style="margin-bottom:4px">
              {p}
            </div>
          ))}
        </div>
      )}

      <div class="faint">
        Loss is limited to {CLAMPS.maxLossRatePctPerWeek}% of body weight per
        week and gain to {CLAMPS.maxGainRateLbPerWeek} lb per week. These are
        refused here rather than accepted and quietly adjusted later.
      </div>

      <button
        class="btn btn-primary btn-wide"
        disabled={!validation.ok}
        onClick={() => void save()}
      >
        Save goal
      </button>
    </Sheet>
  )
}

function BackupSheet(props: { onClose: () => void }) {
  const [passphrase, setPassphrase] = useState('')
  const [confirmPlain, setConfirmPlain] = useState(false)
  const [busy, setBusy] = useState(false)

  async function afterExport(encrypted: boolean): Promise<void> {
    await repo.recordBackup({
      recordCounts: await repo.recordCounts(),
      encrypted,
      schemaVersion: SCHEMA_VERSION,
    })
    store.profile.value = await repo.getProfile()
  }

  async function exportBackup(encrypted: boolean): Promise<void> {
    setBusy(true)
    try {
      const payload = await collectPayload()
      const blob = await writeBackup({
        payload,
        ...(encrypted ? { passphrase } : {}),
      })
      await capabilities.saveFile(backupFilename(payload.exportedAt, encrypted), blob)
      await afterExport(encrypted)
      store.notify('Backup written to your downloads.')
      props.onClose()
    } finally {
      setBusy(false)
    }
  }

  async function exportJson(): Promise<void> {
    setBusy(true)
    try {
      const payload = await collectPayload()
      await capabilities.saveFile(
        jsonFilename(payload.exportedAt),
        new Blob([payloadToJson(payload)], { type: 'application/json' }),
      )
      await afterExport(false)
      store.notify('JSON written to your downloads.')
      props.onClose()
    } finally {
      setBusy(false)
    }
  }

  async function exportCsv(): Promise<void> {
    const [days, entries] = await Promise.all([
      db.days.toArray(),
      db.entries.toArray(),
    ])
    await capabilities.saveFile(
      `macro-tracker-days-${today()}.csv`,
      new Blob([daysToCsv({ days, entries })], { type: 'text/csv' }),
    )
    await capabilities.saveFile(
      `macro-tracker-entries-${today()}.csv`,
      new Blob([entriesToCsv(entries)], { type: 'text/csv' }),
    )
    store.notify('CSV written to your downloads.')
  }

  return (
    <Sheet title="Export" onClose={props.onClose}>
      <div class="notice">
        This app holds the only copy of your data. Browser storage is evictable
        and is destroyed by "clear site data". A backup is what makes that
        survivable — and Import, beside Export in Settings, is how it comes back.
      </div>

      <label>
        Passphrase
        <input
          type="password"
          value={passphrase}
          placeholder="Encrypts the backup file"
          onInput={(e) => setPassphrase((e.target as HTMLInputElement).value)}
        />
      </label>
      <div class="faint">
        Encryption is the default because the file lands in a Downloads folder
        that may sync to a cloud drive automatically.{' '}
        <strong>Passphrase loss means data loss.</strong> There is no recovery
        mechanism, because a recovery mechanism would require a server.
      </div>

      <button
        class="btn btn-primary btn-wide"
        disabled={busy || passphrase.length === 0}
        onClick={() => void exportBackup(true)}
      >
        Export encrypted backup (.mtb)
      </button>

      <div class="divider" />

      <label class="toggle">
        <span>Export without encryption</span>
        <input
          type="checkbox"
          checked={confirmPlain}
          onChange={(e) => setConfirmPlain((e.target as HTMLInputElement).checked)}
        />
      </label>
      {confirmPlain && (
        <>
          <button
            class="btn btn-wide btn-ghost"
            disabled={busy}
            onClick={() => void exportBackup(false)}
          >
            Unencrypted backup (.mtb) — not recommended
          </button>
          <button class="btn btn-wide btn-ghost" disabled={busy} onClick={() => void exportJson()}>
            Plain JSON (.json) — for inspection or other tools
          </button>
        </>
      )}

      <button class="btn btn-wide btn-ghost" onClick={() => void exportCsv()}>
        Export plain CSV
      </button>
      <div class="faint">
        CSV is a flat table: it cannot carry saved meals, their versions or the
        adjustment history, so it is not a backup. Notes travel intact.
      </div>
    </Sheet>
  )
}
