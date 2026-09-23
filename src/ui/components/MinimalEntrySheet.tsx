/**
 * Minimal entry: protein grams and a saturated-fat high/low flag, and
 * nothing else. It exists to keep the series continuous on days when the
 * alternative is nothing at all.
 */

import { useState } from 'preact/hooks'
import * as repo from '../../data/repositories.ts'
import * as store from '../store.ts'
import { Sheet } from './common.tsx'

export function MinimalEntrySheet(props: { onClose: () => void }) {
  const day = store.day.value
  const [protein, setProtein] = useState(
    day?.proteinOverride !== undefined ? String(day.proteinOverride) : '',
  )
  const [flag, setFlag] = useState<'low' | 'high' | undefined>(day?.satFatFlag)

  const p = Number(protein)
  const valid = protein.trim() === '' || (Number.isFinite(p) && p >= 0)

  async function save(): Promise<void> {
    if (!valid) return
    const date = store.selectedDate.value
    await repo.setMinimalDay(date, {
      ...(protein.trim() !== '' ? { proteinG: p } : {}),
      ...(flag ? { satFatFlag: flag } : {}),
    })
    await store.afterEdit([date])
    props.onClose()
  }

  return (
    <Sheet title="Protein and saturated fat" onClose={props.onClose}>
      <label>
        Protein today (g)
        <input
          type="number"
          inputMode="decimal"
          autoFocus
          value={protein}
          onInput={(e) => setProtein((e.target as HTMLInputElement).value)}
        />
      </label>
      <div>
        <div class="card-title">Saturated fat</div>
        <div class="chip-row">
          {(['low', 'high'] as const).map((f) => (
            <button key={f} class="chip" aria-pressed={flag === f} onClick={() => setFlag(f)}>
              {f === 'low' ? 'Low' : 'High'}
            </button>
          ))}
        </div>
      </div>
      <button class="btn btn-primary btn-wide" disabled={!valid} onClick={() => void save()}>
        Save
      </button>
    </Sheet>
  )
}
