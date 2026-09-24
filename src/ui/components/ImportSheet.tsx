/**
 * Import: the other half of export.
 *
 * On a device-only app a new phone is a total loss of history without this.
 * .mtb and .json restore everything; CSV is a convenience for bulk entry and
 * the screen says so BEFORE a file is chosen, so nobody migrates by CSV and
 * believes they are whole.
 *
 * The merge mode is an explicit choice with no default. Nothing commits
 * without a dry-run preview, and a snapshot is written first so a bad
 * import is one undo away.
 */

import { useState } from 'preact/hooks'
import { capabilities } from '../../platform/index.ts'
import { formatDisplayDate } from '../../domain/dates.ts'
import {
  commitImport,
  identifyFile,
  parseImport,
  planForImport,
  type ParsedImport,
  type PendingFile,
} from '../../data/transfer.ts'
import { BackupError, MAX_IMPORT_BYTES } from '../../export/backup.ts'
import type { ImportPlan, MergeMode } from '../../export/importPlan.ts'
import * as engine from '../../data/engine.ts'
import * as store from '../store.ts'
import { Sheet } from './common.tsx'

const REPLACE_WORD = 'REPLACE'

function describeError(e: unknown): string {
  if (e instanceof BackupError) return e.message
  if (e instanceof Error) return `Could not read that file: ${e.message}`
  return 'Could not read that file.'
}

export function ImportSheet(props: { onClose: () => void }) {
  const [file, setFile] = useState<{ name: string; pending: PendingFile } | undefined>()
  const [passphrase, setPassphrase] = useState('')
  const [parsed, setParsed] = useState<ParsedImport | undefined>()
  const [mode, setMode] = useState<MergeMode | undefined>()
  const [plan, setPlan] = useState<ImportPlan | undefined>()
  const [typed, setTyped] = useState('')
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)

  const isCsv = parsed?.kind === 'csv-entries' || parsed?.kind === 'csv-days'
  const needsPassphrase =
    file?.pending.kind === 'mtb' && file.pending.header.encrypted && !parsed

  function reset(): void {
    setFile(undefined)
    setParsed(undefined)
    setMode(undefined)
    setPlan(undefined)
    setTyped('')
    setError(undefined)
    setPassphrase('')
  }

  async function choose(): Promise<void> {
    reset()
    const f = await capabilities.openFile('.mtb,.json,.csv,application/json,text/csv,application/octet-stream')
    if (!f) return
    // Refuse an outsized file before reading it into memory.
    if (f.size > MAX_IMPORT_BYTES) {
      setError('That file is far larger than any export this app writes.')
      return
    }
    try {
      const pending = identifyFile(f.name, await f.arrayBuffer())
      setFile({ name: f.name, pending })
      // Unencrypted files decode straight away; encrypted ones wait for the passphrase.
      if (!(pending.kind === 'mtb' && pending.header.encrypted)) {
        setParsed(await parseImport(pending))
      }
    } catch (e) {
      setError(describeError(e))
    }
  }

  async function unlock(): Promise<void> {
    if (!file) return
    setBusy(true)
    setError(undefined)
    try {
      setParsed(await parseImport(file.pending, passphrase))
    } catch (e) {
      setError(describeError(e))
    } finally {
      setBusy(false)
    }
  }

  async function chooseMode(next: MergeMode): Promise<void> {
    if (!parsed) return
    setMode(next)
    setPlan(undefined)
    setTyped('')
    setError(undefined)
    try {
      setPlan(await planForImport(parsed, next))
    } catch (e) {
      setError(describeError(e))
    }
  }

  async function commit(): Promise<void> {
    if (!plan || !mode) return
    if (mode === 'replace' && typed.trim() !== REPLACE_WORD) return
    setBusy(true)
    try {
      await commitImport(plan)
      await store.loadFoodIndex()
      await store.refreshAll()
      await engine.runDailyEngine()
      await store.refreshHistory()
      store.notify(
        `Imported ${plan.preview.days} day${plan.preview.days === 1 ? '' : 's'}. The previous state is saved — Settings can put it back.`,
      )
      props.onClose()
    } catch (e) {
      setError(describeError(e))
    } finally {
      setBusy(false)
    }
  }

  const p = plan?.preview

  return (
    <Sheet title="Import" onClose={props.onClose}>
      <div class="notice">
        <strong>.mtb</strong> and <strong>.json</strong> files from this app
        restore everything: days, entries, meals and their versions, custom
        foods, targets, goals and the adjustment history.
        <div style="margin-top:6px">
          <strong>CSV brings in day and entry rows only.</strong> It creates a
          custom food for any name it does not recognise, and it does not
          restore saved meals, targets or history. Use it for data put together
          elsewhere — not to move to a new phone.
        </div>
      </div>

      <button class="btn btn-wide" disabled={busy} onClick={() => void choose()}>
        {file ? 'Choose a different file' : 'Choose a file'}
      </button>

      {file && (
        <div class="faint">
          {file.name}
          {file.pending.kind === 'mtb' &&
            ` · exported ${new Date(file.pending.header.exportedAt).toLocaleDateString()} · ${file.pending.header.encrypted ? 'encrypted' : 'not encrypted'}`}
        </div>
      )}

      {needsPassphrase && (
        <>
          <label>
            Its passphrase
            <input
              type="password"
              value={passphrase}
              autoFocus
              onInput={(e) => setPassphrase((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void unlock()
              }}
            />
          </label>
          <button
            class="btn btn-primary btn-wide"
            disabled={busy || passphrase.length === 0}
            onClick={() => void unlock()}
          >
            Unlock
          </button>
        </>
      )}

      {error && (
        <div class="notice" data-tone="attention" role="alert">
          {error}
        </div>
      )}

      {parsed && (
        <div>
          <div class="card-title">How should it combine with what is here?</div>
          <div class="mode-list" role="radiogroup" aria-label="Import mode">
            {!isCsv && (
              <button
                class="mode-option"
                role="radio"
                aria-checked={mode === 'replace'}
                onClick={() => void chooseMode('replace')}
              >
                <span class="route-title">Replace everything</span>
                <span class="route-sub">
                  Wipe this device and restore the file. For moving to a new phone.
                </span>
              </button>
            )}
            <button
              class="mode-option"
              role="radio"
              aria-checked={mode === 'fileWins'}
              onClick={() => void chooseMode('fileWins')}
            >
              <span class="route-title">Merge — the file wins</span>
              <span class="route-sub">
                Keep both. Where a date is in both, the file's day replaces this
                device's day.
              </span>
            </button>
            <button
              class="mode-option"
              role="radio"
              aria-checked={mode === 'localWins'}
              onClick={() => void chooseMode('localWins')}
            >
              <span class="route-title">Merge — this device wins</span>
              <span class="route-sub">
                Keep both. Where a date is in both, this device's day is kept.
              </span>
            </button>
          </div>
          <div class="faint" style="margin-top:6px">
            Days are the unit: a date in both is resolved as a whole day, never
            entry by entry.
          </div>
        </div>
      )}

      {p && mode && (
        <div class="card preview">
          <div class="card-title">Before anything changes</div>
          <dl class="preview-list">
            <dt>In the file</dt>
            <dd>
              {p.days} day{p.days === 1 ? '' : 's'}
              {p.dateRange &&
                `, ${formatDisplayDate(p.dateRange.start)} to ${formatDisplayDate(p.dateRange.end)}`}
            </dd>
            {mode !== 'replace' && (
              <>
                <dt>Already here</dt>
                <dd>
                  {p.collisions} date{p.collisions === 1 ? '' : 's'} differ
                  {mode === 'fileWins'
                    ? ` — ${p.daysReplaced} will be replaced by the file's`
                    : ' — this device keeps its own'}
                </dd>
                <dt>Skipped as duplicates</dt>
                <dd>{p.duplicatesSkipped}</dd>
              </>
            )}
            {mode === 'replace' && (
              <>
                <dt>On this device now</dt>
                <dd>
                  Everything is replaced
                  {p.localDaysRemoved > 0 &&
                    `; ${p.localDaysRemoved} day${p.localDaysRemoved === 1 ? '' : 's'} not in the file will be gone`}
                </dd>
              </>
            )}
            <dt>Meals to be created</dt>
            <dd>{p.compositesCreated}</dd>
            <dt>Custom foods to be created</dt>
            <dd>{p.customFoodsCreated}</dd>
            <dt>File version</dt>
            <dd>{p.schemaVersion !== undefined ? `data version ${p.schemaVersion}` : 'CSV (no version)'}</dd>
          </dl>
          {p.repairs.length > 0 && (
            <div class="notice" style="margin-top:8px">
              {p.repairs.map((r) => (
                <div key={r}>{r}</div>
              ))}
            </div>
          )}
          <div class="faint" style="margin-top:8px">
            A copy of everything as it is now is saved first, so this can be
            undone from Settings.
          </div>
        </div>
      )}

      {plan && mode === 'replace' && (
        <label>
          Type {REPLACE_WORD} to wipe this device and restore the file
          <input
            type="text"
            autoComplete="off"
            value={typed}
            onInput={(e) => setTyped((e.target as HTMLInputElement).value)}
          />
        </label>
      )}

      {plan && mode && (
        <button
          class="btn btn-primary btn-wide"
          disabled={busy || (mode === 'replace' && typed.trim() !== REPLACE_WORD)}
          onClick={() => void commit()}
        >
          {mode === 'replace' ? 'Replace everything' : 'Import'}
        </button>
      )}
    </Sheet>
  )
}
