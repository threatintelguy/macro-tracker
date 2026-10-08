/**
 * Import planning: merge semantics, repair, and the dry-run preview.
 *
 * Pure. `planImport` takes what is on the device and what is in the file
 * and returns the complete database that would result, plus a preview of
 * what that means. Nothing commits without the preview being shown; the
 * caller writes a snapshot, then writes the result.
 *
 * Three modes, and the screen defaults to none of them:
 *
 *   replace    -- wipe local, restore the file. The device-migration case.
 *   fileWins   -- union; on a date collision the file's day replaces the local day.
 *   localWins  -- union; on a date collision the local day is kept.
 *
 * Conflicts resolve per day, never per entry. Merging entries within one
 * date produces duplicates far more often than the right answer, and a day
 * is the unit the user actually reasons about.
 */

import type {
  Composite,
  CompositeId,
  DayRecord,
  Entry,
  Fidelity,
  FoodItem,
  FoodRef,
  LocalDate,
  NutrientKey,
  NutrientVector,
  Phase,
  PrecisionMode,
} from '../domain/types.ts'
import { FIDELITIES, NUTRIENT_KEYS } from '../domain/types.ts'
import { isLocalDate } from '../domain/dates.ts'
import { SCHEMA_VERSION } from '../domain/schema.ts'
import {
  BackupError,
  DAY_CSV_HEADER,
  ENTRY_CSV_HEADER,
  MAX_IMPORT_BYTES,
  NUTRIENT_CSV_COLUMNS,
  type BackupPayload,
} from './backup.ts'

export type MergeMode = 'replace' | 'fileWins' | 'localWins'
export type ImportSource = 'mtb' | 'json' | 'csv-entries' | 'csv-days'

export type ImportPreview = {
  source: ImportSource
  mode: MergeMode
  /** The file's schema version; CSV carries none. */
  schemaVersion?: number
  dateRange?: { start: LocalDate; end: LocalDate }
  /** Days in the file. */
  days: number
  /** File days whose date already exists locally with different content. */
  collisions: number
  /** File days identical to what is already here, skipped. */
  duplicatesSkipped: number
  /** How many colliding days the file's version will replace. */
  daysReplaced: number
  compositesCreated: number
  customFoodsCreated: number
  /** Repairs made on the way in, in plain words. */
  repairs: string[]
  /** Replace mode: local days that will be gone. */
  localDaysRemoved: number
}

export type ImportPlan = {
  preview: ImportPreview
  result: BackupPayload
}

// --- Helpers --------------------------------------------------------------

function stable(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
      : x,
  )
}

function byDate<T extends { date: LocalDate }>(list: readonly T[]): Map<LocalDate, T[]> {
  const out = new Map<LocalDate, T[]>()
  for (const x of list) {
    const l = out.get(x.date)
    if (l) l.push(x)
    else out.set(x.date, [x])
  }
  return out
}

function datesOf(p: Pick<BackupPayload, 'days' | 'entries'>): Set<LocalDate> {
  return new Set([...p.days.map((d) => d.date), ...p.entries.map((e) => e.date)])
}

/** A day's identity for duplicate detection: its record and its entries. */
function dayFingerprint(
  day: DayRecord | undefined,
  entries: readonly Entry[] | undefined,
): string {
  const { entries: _ids, ...rest } = day ?? ({ entries: [] } as unknown as DayRecord)
  const es = [...(entries ?? [])].sort((a, b) => (a.id < b.id ? -1 : 1))
  return stable({ day: rest, entries: es })
}

/** Rebuild every day's entry list from the entries themselves. */
function reconcileDays(days: DayRecord[], entries: Entry[]): DayRecord[] {
  const grouped = byDate(entries)
  const have = new Set(days.map((d) => d.date))
  const out = days.map((d) => ({
    ...d,
    entries: (grouped.get(d.date) ?? [])
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((e) => e.id),
  }))
  // Entries whose date has no record get one, so they are reachable.
  for (const [date, list] of grouped) {
    if (have.has(date)) continue
    out.push({
      date,
      phase: 'calibration',
      precisionMode: 'weighed',
      entries: list.map((e) => e.id),
      training: [],
    })
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1))
}

// --- Repair ---------------------------------------------------------------

/**
 * Resolve and cycle-check the file's composite references on the way in.
 *
 *   - a nested component pointing at a composite that exists nowhere is
 *     dropped from the definition;
 *   - a component that would close a cycle is dropped;
 *   - an entry pinned to a composite that exists nowhere -- not in the
 *     file, not here, not as a tombstone -- is repaired to a plain food
 *     entry rather than left dangling. Its snapshot is untouched.
 */
export function repairIncoming(
  incoming: BackupPayload,
  local: BackupPayload,
): { payload: BackupPayload; repairs: string[] } {
  const repairs: string[] = []
  const known = new Map<CompositeId, Composite>()
  for (const c of local.composites) known.set(c.id, c)
  for (const c of incoming.composites) known.set(c.id, c)
  const tombstoned = new Set([
    ...local.tombstones.map((t) => t.id),
    ...incoming.tombstones.map((t) => t.id),
  ])

  // 1. Dangling nested components.
  let composites = incoming.composites.map((c) => {
    const components = c.components.filter(
      (comp) => comp.kind !== 'composite' || known.has(comp.ref),
    )
    if (components.length !== c.components.length) {
      repairs.push(
        `"${c.name}" referred to a meal that is not in the file or on this device; that component was removed.`,
      )
    }
    return components.length === c.components.length ? c : { ...c, components }
  })
  for (const c of composites) known.set(c.id, c)

  // 2. Cycles. Walk each incoming definition; drop the edge that closes one.
  composites = composites.map((c) => {
    const kept = c.components.filter((comp) => {
      if (comp.kind !== 'composite') return true
      if (reaches(comp.ref, c.id, known)) {
        repairs.push(`"${c.name}" contained itself through a nested meal; that component was removed.`)
        return false
      }
      return true
    })
    const next = kept.length === c.components.length ? c : { ...c, components: kept }
    known.set(c.id, next)
    return next
  })

  // 3. Entries pinned to a composite that exists nowhere.
  const orphanRoots = new Set<string>()
  let entries = incoming.entries.map((e) => {
    if (e.source.kind !== 'composite') return e
    const cid = e.source.compositeId
    if (known.has(cid) || tombstoned.has(cid)) return e
    orphanRoots.add(e.id)
    const ref: FoodRef = e.componentRef ?? {
      kind: 'food',
      foodId: '',
      name: `${e.source.name} — first component`,
    }
    const { componentRef: _c, ...rest } = e
    return { ...rest, source: ref }
  })
  if (orphanRoots.size > 0) {
    repairs.push(
      `${orphanRoots.size} logged meal${orphanRoots.size === 1 ? '' : 's'} pointed at a meal definition that no longer exists anywhere, and ${orphanRoots.size === 1 ? 'was' : 'were'} kept as plain food entries with ${orphanRoots.size === 1 ? 'its' : 'their'} totals unchanged.`,
    )
  }
  const ids = new Set(entries.map((e) => e.id))
  entries = entries.map((e) => {
    if (e.fromCompositeEntryId === undefined) return e
    if (orphanRoots.has(e.fromCompositeEntryId) || !ids.has(e.fromCompositeEntryId)) {
      const { fromCompositeEntryId: _f, ...rest } = e
      return rest
    }
    return e
  })

  return { payload: { ...incoming, composites, entries }, repairs }
}

function reaches(
  from: CompositeId,
  target: CompositeId,
  known: Map<CompositeId, Composite>,
): boolean {
  const seen = new Set<CompositeId>()
  const stack = [from]
  while (stack.length > 0) {
    const id = stack.pop()!
    if (id === target) return true
    if (seen.has(id)) continue
    seen.add(id)
    for (const comp of known.get(id)?.components ?? []) {
      if (comp.kind === 'composite') stack.push(comp.ref)
    }
  }
  return false
}

// --- Merge ----------------------------------------------------------------

function mergeById<T>(
  local: readonly T[],
  incoming: readonly T[],
  key: (x: T) => string,
  fileWins: boolean,
  combine?: (l: T, f: T) => T,
): { merged: T[]; created: number; duplicates: number } {
  const map = new Map<string, T>()
  for (const x of local) map.set(key(x), x)
  let created = 0
  let duplicates = 0
  for (const x of incoming) {
    const k = key(x)
    const existing = map.get(k)
    if (existing === undefined) {
      map.set(k, x)
      created++
      continue
    }
    if (stable(existing) === stable(x)) {
      duplicates++
      continue
    }
    if (combine) map.set(k, combine(existing, x))
    else if (fileWins) map.set(k, x)
  }
  return { merged: [...map.values()], created, duplicates }
}

/** Composite versions from both sides survive, so every pinned entry resolves. */
function combineComposites(fileWins: boolean) {
  return (l: Composite, f: Composite): Composite => {
    const newer = f.version > l.version ? f : l.version > f.version ? l : fileWins ? f : l
    const older = newer === f ? l : f
    const history = new Map<number, NonNullable<Composite['history']>[number]>()
    for (const h of [...(l.history ?? []), ...(f.history ?? [])]) history.set(h.version, h)
    if (older.version !== newer.version && !history.has(older.version)) {
      history.set(older.version, {
        version: older.version,
        components: older.components,
        replacedAt: older.updatedAt,
      })
    }
    history.delete(newer.version)
    const merged = [...history.values()].sort((a, b) => a.version - b.version)
    const { history: _h, ...rest } = newer
    return merged.length > 0 ? { ...rest, history: merged } : rest
  }
}

export function planImport(input: {
  local: BackupPayload
  incoming: BackupPayload
  mode: MergeMode
  source: ImportSource
}): ImportPlan {
  const { local, mode, source } = input
  // Replace wipes the device, so nothing local can satisfy a reference.
  const repaired = repairIncoming(input.incoming, mode === 'replace' ? emptyPayload() : local)
  const incoming = repaired.payload
  const fileWins = mode === 'fileWins'

  const fileDates = [...datesOf(incoming)].sort()
  const dateRange =
    fileDates.length > 0 ? { start: fileDates[0]!, end: fileDates[fileDates.length - 1]! } : undefined

  const localDays = new Map(local.days.map((d) => [d.date, d]))
  const fileDays = new Map(incoming.days.map((d) => [d.date, d]))
  const localEntries = byDate(local.entries)
  const fileEntries = byDate(incoming.entries)
  const localDates = datesOf(local)

  let collisions = 0
  let duplicatesSkipped = 0
  for (const d of fileDates) {
    if (!localDates.has(d)) continue
    if (
      dayFingerprint(localDays.get(d), localEntries.get(d)) ===
      dayFingerprint(fileDays.get(d), fileEntries.get(d))
    ) {
      duplicatesSkipped++
    } else {
      collisions++
    }
  }

  const localCustomFoods = new Set(local.foods.map((f) => f.id))
  const localComposites = new Set(local.composites.map((c) => c.id))

  const base: Omit<ImportPreview, 'daysReplaced' | 'localDaysRemoved'> = {
    source,
    mode,
    ...(source === 'mtb' || source === 'json' ? { schemaVersion: input.incoming.schemaVersion } : {}),
    ...(dateRange ? { dateRange } : {}),
    days: fileDates.length,
    collisions,
    duplicatesSkipped,
    compositesCreated: incoming.composites.filter((c) => !localComposites.has(c.id)).length,
    customFoodsCreated: incoming.foods.filter((f) => !localCustomFoods.has(f.id)).length,
    repairs: repaired.repairs,
  }

  if (mode === 'replace') {
    // The file's day records are kept exactly as written -- a restore must
    // reproduce the database -- and only a date with entries but no record
    // gains one.
    const have = new Set(incoming.days.map((d) => d.date))
    const missing = reconcileDays([], incoming.entries).filter((d) => !have.has(d.date))
    const result: BackupPayload = {
      ...incoming,
      schemaVersion: SCHEMA_VERSION,
      days: [...incoming.days, ...missing],
    }
    return {
      preview: {
        ...base,
        compositesCreated: incoming.composites.length,
        customFoodsCreated: incoming.foods.length,
        daysReplaced: 0,
        localDaysRemoved: [...localDates].filter((d) => !datesOf(incoming).has(d)).length,
      },
      result,
    }
  }

  // --- Dated records: per-day resolution.
  const replaceDates = new Set<LocalDate>()
  const addDates = new Set<LocalDate>()
  for (const d of fileDates) {
    if (!localDates.has(d)) addDates.add(d)
    else if (fileWins) {
      const same =
        dayFingerprint(localDays.get(d), localEntries.get(d)) ===
        dayFingerprint(fileDays.get(d), fileEntries.get(d))
      if (!same) replaceDates.add(d)
    }
  }
  const takeFromFile = new Set([...replaceDates, ...addDates])

  const days: DayRecord[] = [
    ...local.days.filter((d) => !replaceDates.has(d.date)),
    ...incoming.days.filter((d) => takeFromFile.has(d.date)),
  ]
  // A replaced day is replaced whole: local entries on it go too.
  const keptLocal = local.entries.filter((e) => !replaceDates.has(e.date))
  const keptIds = new Set(keptLocal.map((e) => e.id))
  const fromFile = incoming.entries.filter(
    (e) => takeFromFile.has(e.date) && !keptIds.has(e.id),
  )
  const entries = [...keptLocal, ...fromFile]

  // --- Undated records: union by identity.
  const foods = mergeById(local.foods, incoming.foods, (f) => f.id, fileWins)
  const composites = mergeById(
    local.composites,
    incoming.composites,
    (c) => c.id,
    fileWins,
    combineComposites(fileWins),
  )
  let tombstones = mergeById(local.tombstones, incoming.tombstones, (t) => t.id, fileWins).merged
  // A composite live on one side and deleted on the other: the winning side decides.
  const liveIds = new Set(composites.merged.map((c) => c.id))
  const fileTombs = new Set(incoming.tombstones.map((t) => t.id))
  const localTombs = new Set(local.tombstones.map((t) => t.id))
  const fileLive = new Set(incoming.composites.map((c) => c.id))
  const localLive = new Set(local.composites.map((c) => c.id))
  let compositeList = composites.merged
  for (const id of liveIds) {
    if (!tombstones.some((t) => t.id === id)) continue
    const deletedByWinner = fileWins
      ? fileTombs.has(id) || (!fileLive.has(id) && localTombs.has(id))
      : localTombs.has(id) || (!localLive.has(id) && fileTombs.has(id))
    if (deletedByWinner) compositeList = compositeList.filter((c) => c.id !== id)
    else tombstones = tombstones.filter((t) => t.id !== id)
  }
  const finalCompositeIds = new Set(compositeList.map((c) => c.id))

  // Usage and goals carry auto-increment ids that collide across devices,
  // so incoming rows are matched on content and re-keyed.
  const usageKey = (u: { compositeId: string; loggedAt: number }): string =>
    `${u.compositeId}@${u.loggedAt}`
  const usageSeen = new Set(local.compositeUsage.map(usageKey))
  const usage = [
    ...local.compositeUsage,
    ...incoming.compositeUsage
      .filter((u) => !usageSeen.has(usageKey(u)))
      .map(({ id: _id, ...rest }) => rest),
  ].filter((u) => finalCompositeIds.has(u.compositeId))

  const goalKey = (g: { startDate: string; createdAt: number }): string =>
    `${g.startDate}@${g.createdAt}`
  const goalSeen = new Set(local.goals.map(goalKey))
  const newGoals = incoming.goals
    .filter((g) => !goalSeen.has(goalKey(g)))
    .map(({ id: _id, ...rest }) => rest)
  let goals = [...local.goals, ...newGoals]
  // One active goal: the winning side's.
  const winnerActive = (fileWins ? incoming.goals : local.goals).find((g) => g.active)
  if (winnerActive) {
    goals = goals.map((g) =>
      g.active && goalKey(g) !== goalKey(winnerActive) ? { ...g, active: false } : g,
    )
  }

  const adjustments = mergeById(local.adjustments, incoming.adjustments, (a) => a.id, fileWins).merged
  const tdeeEstimates = mergeById(
    local.tdeeEstimates,
    incoming.tdeeEstimates,
    (t) => t.windowEnd,
    fileWins,
  ).merged
  const backupSeen = new Set(local.backups.map((b) => b.at))
  const backups = [
    ...local.backups,
    ...incoming.backups.filter((b) => !backupSeen.has(b.at)).map(({ id: _id, ...rest }) => rest),
  ]

  const profile = fileWins ? (incoming.profile ?? local.profile) : (local.profile ?? incoming.profile)
  const settings = fileWins
    ? (incoming.settings ?? local.settings)
    : (local.settings ?? incoming.settings)

  const result: BackupPayload = {
    schemaVersion: SCHEMA_VERSION,
    exportedAt: Date.now(),
    ...(profile ? { profile } : {}),
    ...(settings ? { settings } : {}),
    goals,
    days: reconcileDays(days, entries),
    entries,
    foods: foods.merged,
    composites: compositeList,
    compositeUsage: usage,
    backups,
    tombstones,
    adjustments,
    tdeeEstimates,
  }

  return {
    preview: {
      ...base,
      daysReplaced: replaceDates.size,
      localDaysRemoved: 0,
      duplicatesSkipped: duplicatesSkipped + foods.duplicates + composites.duplicates,
    },
    result,
  }
}

/**
 * CSV day rows carry day-level fields only -- weight, waist, note. Merge
 * them into existing days without touching those days' entries.
 */
export function planDayFieldsImport(input: {
  local: BackupPayload
  rows: DayCsvRow[]
  mode: Exclude<MergeMode, 'replace'>
  dayContext: (date: LocalDate) => { phase: Phase; precisionMode: PrecisionMode }
}): ImportPlan {
  const { local, rows, mode } = input
  const localDays = new Map(local.days.map((d) => [d.date, d]))
  let collisions = 0
  let duplicates = 0
  const days = new Map(localDays)

  for (const r of rows) {
    const existing = localDays.get(r.date)
    const patched = (base: DayRecord): DayRecord => {
      const { weightKg: _w, waistCm: _c, note: _n, ...rest } = base
      const w = r.weightKg ?? base.weightKg?.value
      const waist = r.waistCm ?? base.waistCm
      const note = r.note ?? base.note
      return {
        ...rest,
        ...(w !== undefined ? { weightKg: { value: w } } : {}),
        ...(waist !== undefined ? { waistCm: waist } : {}),
        ...(note !== undefined && note.length > 0 ? { note } : {}),
      }
    }
    if (existing) {
      const next = patched(existing)
      if (stable(next) === stable(existing)) {
        duplicates++
        continue
      }
      collisions++
      if (mode === 'fileWins') days.set(r.date, next)
      continue
    }
    const ctx = input.dayContext(r.date)
    days.set(
      r.date,
      patched({
        date: r.date,
        phase: r.phase ?? ctx.phase,
        precisionMode: r.precisionMode ?? ctx.precisionMode,
        entries: [],
        training: [],
      }),
    )
  }

  const dates = rows.map((r) => r.date).sort()
  return {
    preview: {
      source: 'csv-days',
      mode,
      ...(dates.length > 0 ? { dateRange: { start: dates[0]!, end: dates[dates.length - 1]! } } : {}),
      days: rows.length,
      collisions,
      duplicatesSkipped: duplicates,
      daysReplaced: mode === 'fileWins' ? collisions : 0,
      compositesCreated: 0,
      customFoodsCreated: 0,
      repairs: [],
      localDaysRemoved: 0,
    },
    result: {
      ...local,
      schemaVersion: SCHEMA_VERSION,
      days: reconcileDays([...days.values()], local.entries),
    },
  }
}

// --- CSV ------------------------------------------------------------------

/**
 * RFC 4180 parsing: quoted fields, doubled quotes, commas and newlines
 * inside quotes, CRLF or LF, and a leading byte-order mark.
 */
export function parseCsv(text: string): string[][] {
  if (text.length > MAX_IMPORT_BYTES) {
    throw new BackupError('too-large', 'That file is far larger than any export this app writes.')
  }
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"'
          i++
        } else quoted = false
      } else cell += ch
      continue
    }
    if (ch === '"' && cell.length === 0) quoted = true
    else if (ch === ',') {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += ch
  }
  if (quoted) throw new BackupError('corrupt', 'The CSV has an unclosed quote.')
  if (cell.length > 0 || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''))
}

/** Undo the export's formula defence: a leading apostrophe before = + - @. */
function uncell(s: string): string {
  return /^'[=+\-@\t\r]/.test(s) ? s.slice(1) : s
}

export type CsvKind = 'entries' | 'days'

export function detectCsvKind(header: readonly string[]): CsvKind | undefined {
  const h = new Set(header.map((c) => c.trim().toLowerCase()))
  if (h.has('source_kind') && h.has('grams') && h.has('date')) return 'entries'
  if (h.has('precision_mode') && h.has('date')) return 'days'
  return undefined
}

export type DayCsvRow = {
  date: LocalDate
  phase?: Phase
  precisionMode?: PrecisionMode
  weightKg?: number
  waistCm?: number
  note?: string
}

function columnReader(header: readonly string[], row: readonly string[]) {
  const index = new Map(header.map((h, i) => [h.trim().toLowerCase(), i]))
  return (name: string): string => uncell((row[index.get(name) ?? -1] ?? '').trim())
}

function optionalNumber(
  s: string,
  what: string,
  line: number,
  problems: string[],
  min = 0,
): number | undefined {
  if (s === '') return undefined
  const n = Number(s)
  if (!Number.isFinite(n) || n < min) {
    problems.push(`line ${line}: ${what} "${s}" is not a valid number`)
    return undefined
  }
  return n
}

export function parseDayCsv(rows: string[][]): DayCsvRow[] {
  const [header, ...body] = rows
  if (!header) return []
  const problems: string[] = []
  const out: DayCsvRow[] = []
  const seen = new Set<string>()
  body.forEach((r, i) => {
    const line = i + 2
    const col = columnReader(header, r)
    const date = col('date')
    if (!isLocalDate(date)) {
      problems.push(`line ${line}: "${date}" is not a YYYY-MM-DD date`)
      return
    }
    if (seen.has(date)) {
      problems.push(`line ${line}: ${date} appears twice`)
      return
    }
    seen.add(date)
    const phase = col('phase')
    const mode = col('precision_mode')
    const weight = optionalNumber(col('weight_kg'), 'weight', line, problems, 1e-9)
    const waist = optionalNumber(col('waist_cm'), 'waist', line, problems, 1e-9)
    const note = col('note')
    out.push({
      date,
      ...(phase === 'calibration' || phase === 'steady' || phase === 'recalibration'
        ? { phase }
        : {}),
      ...(mode === 'weighed' || mode === 'composite' || mode === 'minimal'
        ? { precisionMode: mode }
        : {}),
      ...(weight !== undefined ? { weightKg: weight } : {}),
      ...(waist !== undefined ? { waistCm: waist } : {}),
      ...(note.length > 0 ? { note } : {}),
    })
  })
  if (problems.length > 0) {
    throw new BackupError(
      'corrupt',
      `The CSV has rows that cannot be read: ${problems.slice(0, 3).join('; ')}. Nothing was imported.`,
    )
  }
  return out
}

/**
 * Entry rows become entries under foods. A name that matches a food this
 * device knows logs against it; an unrecognised name becomes a custom food
 * whose per-100 g values come from the row. Blank nutrient cells are
 * unknown, never zero. Composite rows arrive as plain entries -- CSV cannot
 * carry a composite definition, and says so before the file is chosen.
 */
export function parseEntryCsv(
  rows: string[][],
  ctx: {
    findFood: (name: string) => FoodItem | undefined
    dayContext: (date: LocalDate) => { phase: Phase; precisionMode: PrecisionMode }
    newId: (prefix: string) => string
    now?: number
  },
): BackupPayload {
  const [header, ...body] = rows
  const now = ctx.now ?? Date.now()
  const problems: string[] = []
  const entries: Entry[] = []
  const created = new Map<string, FoodItem>()
  if (!header) return emptyPayload(now)

  body.forEach((r, i) => {
    const line = i + 2
    const col = columnReader(header, r)
    const date = col('date')
    if (!isLocalDate(date)) {
      problems.push(`line ${line}: "${date}" is not a YYYY-MM-DD date`)
      return
    }
    const name = col('name')
    if (name.length === 0) {
      problems.push(`line ${line}: the name is blank`)
      return
    }
    const grams = optionalNumber(col('grams'), 'grams', line, problems)
    if (grams === undefined) {
      if (col('grams') === '') problems.push(`line ${line}: grams is blank`)
      return
    }
    const at = col('time')
    if (at !== '' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(at)) {
      problems.push(`line ${line}: time "${at}" is not HH:MM`)
      return
    }
    const fid = col('fidelity')
    const fidelity: Fidelity = (FIDELITIES as readonly string[]).includes(fid)
      ? (fid as Fidelity)
      : 'estimated'
    const nutrients = {} as NutrientVector
    for (const k of NUTRIENT_KEYS) {
      const cell = col(NUTRIENT_CSV_COLUMNS[k])
      nutrients[k] = cell === '' ? null : (optionalNumber(cell, k, line, problems) ?? null)
    }

    const key = name.toLowerCase()
    let food = ctx.findFood(name) ?? created.get(key)
    if (!food) {
      food = {
        id: ctx.newId('x'),
        name,
        tier: 'custom',
        per100g: per100gFrom(nutrients, grams),
        portions: [],
        cookState: 'n/a',
        createdAt: now,
      }
      created.set(key, food)
    }
    const occasion = col('occasion')
    const proxy = col('proxy_for')
    const note = col('note')
    entries.push({
      id: ctx.newId('e'),
      date,
      ...(at !== '' ? { at } : {}),
      ...(occasion !== '' ? { occasion } : {}),
      source: { kind: 'food', foodId: food.id, name: food.name },
      grams,
      nutrients,
      fidelity,
      ...(proxy !== '' ? { proxyFor: { note: proxy } } : {}),
      ...(note !== '' ? { note } : {}),
      createdAt: now + i,
    })
  })

  if (problems.length > 0) {
    throw new BackupError(
      'corrupt',
      `The CSV has rows that cannot be read: ${problems.slice(0, 3).join('; ')}${problems.length > 3 ? ` (and ${problems.length - 3} more)` : ''}. Nothing was imported.`,
    )
  }

  const dates = [...new Set(entries.map((e) => e.date))].sort()
  const days: DayRecord[] = dates.map((date) => ({
    date,
    ...ctx.dayContext(date),
    entries: [],
    training: [],
  }))

  return {
    ...emptyPayload(now),
    days: reconcileDays(days, entries),
    entries,
    foods: [...created.values()],
  }
}

function per100gFrom(n: NutrientVector, grams: number): NutrientVector {
  const out = {} as NutrientVector
  for (const k of NUTRIENT_KEYS as readonly NutrientKey[]) {
    const v = n[k]
    out[k] = v === null || !(grams > 0) ? null : (v * 100) / grams
  }
  return out
}

export function emptyPayload(now = Date.now()): BackupPayload {
  return {
    schemaVersion: SCHEMA_VERSION,
    exportedAt: now,
    goals: [],
    days: [],
    entries: [],
    foods: [],
    composites: [],
    compositeUsage: [],
    backups: [],
    tombstones: [],
    adjustments: [],
    tdeeEstimates: [],
  }
}

/** The CSV headers this app writes, for the "what CSV can do" explanation. */
export const CSV_HEADERS = { days: DAY_CSV_HEADER, entries: ENTRY_CSV_HEADER }
