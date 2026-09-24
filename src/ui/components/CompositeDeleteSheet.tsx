/**
 * Delete, or delete-and-purge, a composite.
 *
 * Retire is the right default and stays as it is. Delete is for a mistake
 * -- a duplicate, a typo'd name, a test entry from setup -- and leaves a
 * tombstone so past days keep their totals and show the name as deleted.
 *
 * Delete-and-purge is a separate, harder action: it removes every entry
 * derived from the composite and changes those days' totals. It is the only
 * operation in the app that alters historical totals, so it asks for typed
 * confirmation, takes a snapshot first, and states how many days change.
 *
 * Both are blocked, naming the parents, while another meal nests this one.
 * Confirmations state real counts; a generic "are you sure" gets dismissed
 * unread.
 */

import { useEffect, useState } from 'preact/hooks'
import type { Composite } from '../../domain/types.ts'
import * as repo from '../../data/repositories.ts'
import { takeSnapshot } from '../../data/transfer.ts'
import * as store from '../store.ts'
import { Sheet } from './common.tsx'

const PURGE_WORD = 'PURGE'

export function CompositeDeleteSheet(props: { composite: Composite; onClose: () => void }) {
  const c = props.composite
  const [radius, setRadius] = useState<repo.CompositeBlastRadius | undefined>()
  const [purging, setPurging] = useState(false)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void repo.compositeBlastRadius(c.id).then(setRadius)
  }, [c.id])

  async function remove(): Promise<void> {
    setBusy(true)
    try {
      await repo.deleteComposite(c.id)
      await store.refreshComposites()
      store.notify(`"${c.name}" deleted. Past days keep their totals.`)
      props.onClose()
    } catch (e) {
      store.notify(e instanceof Error ? e.message : 'Could not delete.')
    } finally {
      setBusy(false)
    }
  }

  async function purge(): Promise<void> {
    if (typed.trim() !== PURGE_WORD) return
    setBusy(true)
    try {
      await takeSnapshot('purge')
      const dates = await repo.purgeComposite(c.id)
      await store.refreshComposites()
      await store.afterEdit(dates)
      store.notify(
        `"${c.name}" and its entries are gone. ${dates.length} day${dates.length === 1 ? '' : 's'} recalculated; the previous state is saved in Settings.`,
      )
      props.onClose()
    } catch (e) {
      store.notify(e instanceof Error ? e.message : 'Could not purge.')
    } finally {
      setBusy(false)
    }
  }

  if (!radius) {
    return (
      <Sheet title={`Delete ${c.name}`} onClose={props.onClose}>
        <div class="faint">Counting where it is used…</div>
      </Sheet>
    )
  }

  if (radius.parents.length > 0) {
    return (
      <Sheet title={`Delete ${c.name}`} onClose={props.onClose}>
        <div class="notice">
          This meal is used inside{' '}
          {radius.parents.map((p, i) => (
            <span key={p.id}>
              {i > 0 && (i === radius.parents.length - 1 ? ' and ' : ', ')}
              <strong>{p.name}</strong>
            </span>
          ))}
          . Remove it from {radius.parents.length === 1 ? 'that meal' : 'those meals'}{' '}
          first — deleting here would break {radius.parents.length === 1 ? 'it' : 'them'}.
        </div>
      </Sheet>
    )
  }

  const usedText =
    radius.entries === 0
      ? 'Never logged, so nothing in your history refers to it.'
      : `Used in ${radius.entries} entr${radius.entries === 1 ? 'y' : 'ies'} across ${radius.days} day${radius.days === 1 ? '' : 's'}.`

  return (
    <Sheet title={`Delete ${c.name}`} onClose={props.onClose}>
      {!purging ? (
        <>
          <div>
            {usedText}
            {radius.entries > 0 &&
              ` Those days keep their totals and will show the name as deleted.`}
          </div>
          <div class="faint">
            If you still eat this now and then, Retire hides it from the list and
            can be undone. Delete cannot.
          </div>
          <button class="btn btn-wide btn-danger" disabled={busy} onClick={() => void remove()}>
            Delete {c.name}
          </button>
          {radius.entries > 0 && (
            <button class="btn btn-wide btn-ghost" onClick={() => setPurging(true)}>
              Delete it and its entries…
            </button>
          )}
        </>
      ) : (
        <>
          <div class="notice">
            This removes {c.name} and all {radius.entries} entr
            {radius.entries === 1 ? 'y' : 'ies'} logged from it.{' '}
            <strong>
              The totals of {radius.days} day{radius.days === 1 ? '' : 's'} will change.
            </strong>{' '}
            It is meant for a test meal logged against days that never happened.
          </div>
          <div class="faint">
            A copy of everything as it is now is saved first, and can be put back
            from Settings.
          </div>
          <label>
            Type {PURGE_WORD} to remove the meal and its entries
            <input
              type="text"
              autoComplete="off"
              value={typed}
              onInput={(e) => setTyped((e.target as HTMLInputElement).value)}
            />
          </label>
          <button
            class="btn btn-wide btn-danger"
            disabled={busy || typed.trim() !== PURGE_WORD}
            onClick={() => void purge()}
          >
            Remove meal and {radius.entries} entr{radius.entries === 1 ? 'y' : 'ies'}
          </button>
          <button class="btn btn-wide btn-ghost" onClick={() => setPurging(false)}>
            Back
          </button>
        </>
      )}
    </Sheet>
  )
}
