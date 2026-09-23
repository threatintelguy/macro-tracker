/**
 * The day's note.
 *
 * Context about the day or the food, in plain text. Collapsed to a single
 * line until tapped; autosaves on blur; no save button and no character
 * limit worth enforcing. Identical on today and on any past day -- a note
 * written three weeks later is no different from one written that evening.
 *
 * Notes are inert. Nothing parses them, nothing extracts structure from
 * them. They are for reading, and for the markers on the charts.
 */

import { useEffect, useRef, useState } from 'preact/hooks'
import * as repo from '../../data/repositories.ts'
import * as store from '../store.ts'

export function DayNote() {
  const date = store.selectedDate.value
  const saved = store.day.value?.note ?? ''
  const [open, setOpen] = useState(false)
  const [text, setText] = useState(saved)
  const ref = useRef<HTMLTextAreaElement>(null)

  // Another day, or a reload: show what is stored.
  useEffect(() => {
    setText(saved)
    setOpen(false)
  }, [date, saved])

  useEffect(() => {
    if (open) ref.current?.focus()
  }, [open])

  async function persist(): Promise<void> {
    if (text === saved) {
      setOpen(false)
      return
    }
    await repo.saveDayNote(date, text)
    await store.afterEdit([date])
    setOpen(false)
  }

  if (!open) {
    return (
      <button class="note-collapsed" onClick={() => setOpen(true)}>
        {saved.trim().length > 0 ? (
          <span class="note-text-one-line">{saved}</span>
        ) : (
          <span class="faint">Add a note about this day</span>
        )}
      </button>
    )
  }

  return (
    <textarea
      ref={ref}
      class="note-input"
      rows={4}
      value={text}
      placeholder="Back from Chicago, ate out four nights."
      aria-label="Note for this day"
      onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
      onBlur={() => void persist()}
    />
  )
}
