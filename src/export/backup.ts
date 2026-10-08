/**
 * Export, encryption, and import.
 *
 * Backup is not a feature here. It is the thing that makes device-only
 * storage survivable: this app holds the only copy, browser storage is
 * evictable, and years of history can vanish to a mis-tap in Android
 * settings. And a backup that cannot be restored is not a backup.
 *
 * Formats:
 *
 *   .mtb  -- JSON, gzipped, then AES-GCM encrypted with a key derived from a
 *            passphrase via PBKDF2. The header carries schemaVersion,
 *            timestamp and record counts IN CLEAR so a file can be
 *            identified without decrypting it. Complete round trip.
 *   .json -- the same payload, plain. Complete round trip.
 *   .csv  -- a flat table. Lossy: it cannot carry composite definitions,
 *            overrides, provenance or the audit log. Never a restore path.
 *
 * Passphrase loss means data loss. There is no recovery mechanism, because
 * a recovery mechanism would require a server.
 */

import type {
  AdjustmentEvent,
  BackupMeta,
  Composite,
  CompositeTombstone,
  CompositeUsage,
  DayRecord,
  Entry,
  FoodItem,
  Goal,
  NutrientKey,
  Profile,
  Settings,
  TdeeEstimate,
} from '../domain/types.ts'
import { NUTRIENT_KEYS } from '../domain/types.ts'
import { SCHEMA_VERSION } from '../domain/schema.ts'
import { aggregateNutrients } from '../domain/nutrition/index.ts'
import { lowestFidelity } from '../domain/analytics/index.ts'
import { validatePayload } from './validate.ts'
import { foodOrigin } from '../food/search.ts'

export const MTB_MAGIC = 'MTB1'
export const PBKDF2_ITERATIONS = 310_000
/** The plain JSON format's marker, so a random JSON file is not mistaken for one. */
export const JSON_FORMAT = 'macro-tracker-backup'
/** A generous ceiling on an import. Years of data is a few megabytes. */
export const MAX_IMPORT_BYTES = 64 * 1024 * 1024

export type BackupPayload = {
  schemaVersion: number
  exportedAt: number
  profile?: Profile
  settings?: Settings
  goals: Goal[]
  days: DayRecord[]
  entries: Entry[]
  /** Foods stored on this device: custom, barcode and accepted online results. */
  foods: FoodItem[]
  composites: Composite[]
  compositeUsage: CompositeUsage[]
  backups: BackupMeta[]
  /** v2 onward. */
  tombstones: CompositeTombstone[]
  adjustments: AdjustmentEvent[]
  tdeeEstimates: TdeeEstimate[]
}

export type BackupHeader = {
  magic: string
  schemaVersion: number
  exportedAt: number
  encrypted: boolean
  recordCounts: Record<string, number>
  app: string
  /**
   * Encrypted files from v2: a known constant encrypted under the same key
   * with its own IV. It lets a failed decryption say "wrong passphrase"
   * rather than "wrong passphrase or damaged file".
   */
  keyCheck?: { iv: string; data: string }
}

/**
 * Why a file could not be read. The UI words each differently: a wrong
 * passphrase and a damaged file call for different next steps.
 */
export type BackupErrorKind =
  | 'not-backup'
  | 'newer-schema'
  | 'needs-passphrase'
  | 'wrong-passphrase'
  | 'wrong-passphrase-or-corrupt'
  | 'corrupt'
  | 'too-large'

export class BackupError extends Error {
  constructor(
    readonly kind: BackupErrorKind,
    message: string,
  ) {
    super(message)
    this.name = 'BackupError'
  }
}

const KEY_CHECK_PLAINTEXT = 'macro-tracker key check v1'

// --- Compression ----------------------------------------------------------

/**
 * Uint8Array is a valid BlobPart at runtime; the DOM lib types it against a
 * non-shared ArrayBuffer, which a generic Uint8Array does not satisfy.
 */
function blobPart(bytes: Uint8Array): BlobPart {
  return bytes as unknown as BlobPart
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === 'undefined') return bytes
  const stream = new Blob([blobPart(bytes)])
    .stream()
    .pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') return bytes
  const stream = new Blob([blobPart(bytes)])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** gzip members start with 1f 8b. Lets import read uncompressed files too. */
function looksGzipped(bytes: Uint8Array): boolean {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b
}

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

// --- Crypto ---------------------------------------------------------------

async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  crypto: Crypto,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

// --- File assembly --------------------------------------------------------

/**
 * File layout:
 *
 *   'MTB1'            4 bytes
 *   headerLength      u32 little endian
 *   header            UTF-8 JSON, in clear
 *   salt              16 bytes  (encrypted files only)
 *   iv                12 bytes  (encrypted files only)
 *   body              gzipped JSON, AES-GCM encrypted when encrypted
 */
export async function writeBackup(input: {
  payload: BackupPayload
  passphrase?: string
  crypto?: Crypto
}): Promise<Blob> {
  const c = input.crypto ?? globalThis.crypto
  const encrypted = input.passphrase !== undefined && input.passphrase.length > 0

  const json = new TextEncoder().encode(JSON.stringify(input.payload))
  const compressed = await gzip(json)

  let salt: Uint8Array | undefined
  let iv: Uint8Array | undefined
  let key: CryptoKey | undefined
  let keyCheck: BackupHeader['keyCheck']
  if (encrypted) {
    salt = c.getRandomValues(new Uint8Array(16))
    iv = c.getRandomValues(new Uint8Array(12))
    key = await deriveKey(input.passphrase!, salt, c)
    // A separate IV: reusing the body's IV under the same key would break
    // AES-GCM's confidentiality guarantee.
    const checkIv = c.getRandomValues(new Uint8Array(12))
    const check = await c.subtle.encrypt(
      { name: 'AES-GCM', iv: checkIv as BufferSource },
      key,
      new TextEncoder().encode(KEY_CHECK_PLAINTEXT) as BufferSource,
    )
    keyCheck = { iv: toBase64(checkIv), data: toBase64(new Uint8Array(check)) }
  }

  const header: BackupHeader = {
    magic: MTB_MAGIC,
    schemaVersion: input.payload.schemaVersion,
    exportedAt: input.payload.exportedAt,
    encrypted,
    recordCounts: countRecords(input.payload),
    app: 'macro-tracker',
    ...(keyCheck ? { keyCheck } : {}),
  }
  const headerBytes = new TextEncoder().encode(JSON.stringify(header))

  const parts: BlobPart[] = []
  const prefix = new Uint8Array(8)
  for (let i = 0; i < 4; i++) prefix[i] = MTB_MAGIC.charCodeAt(i)
  new DataView(prefix.buffer).setUint32(4, headerBytes.length, true)
  parts.push(blobPart(prefix), blobPart(headerBytes))

  if (!encrypted) {
    parts.push(blobPart(compressed))
    return new Blob(parts, { type: 'application/octet-stream' })
  }

  const cipher = await c.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key!,
    compressed as BufferSource,
  )

  parts.push(blobPart(salt!), blobPart(iv!), cipher)
  return new Blob(parts, { type: 'application/octet-stream' })
}

/** Is this buffer an .mtb file? Checked before anything else is parsed. */
export function isMtb(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 8) return false
  const b = new Uint8Array(buffer, 0, 4)
  return String.fromCharCode(b[0]!, b[1]!, b[2]!, b[3]!) === MTB_MAGIC
}

/** Read the clear header without decrypting, so a file can be identified. */
export function readHeader(buffer: ArrayBuffer): BackupHeader {
  if (!isMtb(buffer)) {
    throw new BackupError('not-backup', 'This is not a Macro Tracker backup file.')
  }
  const bytes = new Uint8Array(buffer)
  const headerLength = new DataView(buffer).getUint32(4, true)
  if (8 + headerLength > bytes.length) {
    throw new BackupError('corrupt', 'The backup file is damaged: its header is cut short.')
  }
  let header: unknown
  try {
    header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + headerLength)))
  } catch {
    throw new BackupError('corrupt', 'The backup file is damaged: its header cannot be read.')
  }
  if (
    typeof header !== 'object' ||
    header === null ||
    typeof (header as BackupHeader).schemaVersion !== 'number' ||
    typeof (header as BackupHeader).encrypted !== 'boolean'
  ) {
    throw new BackupError('corrupt', 'The backup file is damaged: its header is malformed.')
  }
  return header as BackupHeader
}

/** Refuse a file from a newer build before reading any of it. */
export function assertReadableVersion(schemaVersion: number): void {
  if (!Number.isInteger(schemaVersion) || schemaVersion < 0) {
    throw new BackupError('corrupt', 'The file does not say which version wrote it.')
  }
  if (schemaVersion > SCHEMA_VERSION) {
    throw new BackupError(
      'newer-schema',
      `This file came from a newer build of the app (data version ${schemaVersion}; this build reads up to ${SCHEMA_VERSION}). Update the app, then import it. Nothing was read.`,
    )
  }
}

export async function readBackup(input: {
  buffer: ArrayBuffer
  passphrase?: string
  crypto?: Crypto
}): Promise<BackupPayload> {
  if (input.buffer.byteLength > MAX_IMPORT_BYTES) {
    throw new BackupError('too-large', 'That file is far larger than any backup this app writes.')
  }
  const c = input.crypto ?? globalThis.crypto
  const header = readHeader(input.buffer)
  assertReadableVersion(header.schemaVersion)

  const bytes = new Uint8Array(input.buffer)
  const headerLength = new DataView(input.buffer).getUint32(4, true)
  let cursor = 8 + headerLength

  let body: Uint8Array
  if (header.encrypted) {
    if (!input.passphrase) {
      throw new BackupError(
        'needs-passphrase',
        'This backup is encrypted. Enter its passphrase to restore it.',
      )
    }
    if (bytes.length < cursor + 28) {
      throw new BackupError('corrupt', 'The backup file is damaged: it is cut short.')
    }
    const salt = bytes.subarray(cursor, cursor + 16)
    cursor += 16
    const iv = bytes.subarray(cursor, cursor + 12)
    cursor += 12
    const cipher = bytes.subarray(cursor)
    const key = await deriveKey(input.passphrase, salt, c)

    // The key check separates the two failures AES-GCM alone cannot tell
    // apart: a wrong key and a damaged ciphertext both fail authentication.
    let keyVerified = false
    if (header.keyCheck) {
      try {
        const plain = await c.subtle.decrypt(
          { name: 'AES-GCM', iv: fromBase64(header.keyCheck.iv) as BufferSource },
          key,
          fromBase64(header.keyCheck.data) as BufferSource,
        )
        keyVerified = new TextDecoder().decode(plain) === KEY_CHECK_PLAINTEXT
      } catch {
        keyVerified = false
      }
      if (!keyVerified) {
        throw new BackupError(
          'wrong-passphrase',
          'That passphrase is not the one this backup was written with. There is no recovery mechanism — try it again carefully, including capitals and spaces.',
        )
      }
    }

    try {
      const plain = await c.subtle.decrypt(
        { name: 'AES-GCM', iv: iv as BufferSource },
        key,
        cipher as BufferSource,
      )
      body = new Uint8Array(plain)
    } catch {
      if (keyVerified) {
        throw new BackupError(
          'corrupt',
          'The passphrase is right, but the file is damaged and cannot be decrypted. Try another copy of the backup.',
        )
      }
      throw new BackupError(
        'wrong-passphrase-or-corrupt',
        'That passphrase did not decrypt the file. Either the passphrase is wrong or the file is damaged — this older file format cannot tell which.',
      )
    }
  } else {
    body = bytes.subarray(cursor)
  }

  let raw: unknown
  try {
    const json = looksGzipped(body) ? await gunzip(body) : body
    raw = JSON.parse(new TextDecoder().decode(json))
  } catch {
    throw new BackupError('corrupt', 'The backup file is damaged: its contents cannot be read.')
  }
  return parsePayload(raw)
}

/**
 * Validate and migrate a decoded payload. Structural validation happens in
 * full before anything is written: a malformed file is rejected whole,
 * never half imported.
 */
export function parsePayload(raw: unknown): BackupPayload {
  if (typeof raw !== 'object' || raw === null) {
    throw new BackupError('corrupt', 'The file does not contain a backup.')
  }
  const version = (raw as { schemaVersion?: unknown }).schemaVersion
  assertReadableVersion(typeof version === 'number' ? version : -1)
  const validated = validatePayload(raw)
  if (!validated.ok) {
    throw new BackupError(
      'corrupt',
      `The file is not a valid backup: ${validated.problems.slice(0, 3).join('; ')}${validated.problems.length > 3 ? ` (and ${validated.problems.length - 3} more)` : ''}. Nothing was imported.`,
    )
  }
  return migratePayload(validated.payload)
}

/**
 * Forward migrations for older files.
 *
 * The app holds the only copy of multi-year data, so an import path that
 * cannot read last year's backup is a data-loss bug in waiting. Each schema
 * bump adds a step here; none may be removed.
 */
export function migratePayload(payload: BackupPayload): BackupPayload {
  let p = payload
  if (p.schemaVersion < 1) {
    p = { ...p, schemaVersion: 1 }
  }
  if (p.schemaVersion < 2) {
    // v2: nullable nutrients (existing numbers stay as they are) and three
    // new collections, empty in any v1 file.
    p = {
      ...p,
      schemaVersion: 2,
      tombstones: p.tombstones ?? [],
      adjustments: p.adjustments ?? [],
      tdeeEstimates: p.tdeeEstimates ?? [],
    }
  }
  if (p.schemaVersion < 3) {
    // v3: foods gain an origin, derived from the tier. Every other v3 field
    // is optional, so nothing else in an older file needs touching.
    p = {
      ...p,
      schemaVersion: 3,
      foods: p.foods.map((f) => (f.origin ? f : { ...f, origin: foodOrigin(f) })),
    }
  }
  return p
}

export function countRecords(p: BackupPayload): Record<string, number> {
  return {
    days: p.days.length,
    entries: p.entries.length,
    foods: p.foods.length,
    composites: p.composites.length,
    usage: p.compositeUsage.length,
    goals: p.goals.length,
    // Absent from a version 1 payload.
    tombstones: p.tombstones?.length ?? 0,
    adjustments: p.adjustments?.length ?? 0,
  }
}

// --- Plain JSON -----------------------------------------------------------

export function payloadToJson(payload: BackupPayload): string {
  return JSON.stringify({ format: JSON_FORMAT, ...payload }, null, 1)
}

export function readJsonBackup(text: string): BackupPayload {
  if (text.length > MAX_IMPORT_BYTES) {
    throw new BackupError('too-large', 'That file is far larger than any backup this app writes.')
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new BackupError('corrupt', 'That file is not valid JSON.')
  }
  if (
    typeof raw !== 'object' ||
    raw === null ||
    (raw as { format?: unknown }).format !== JSON_FORMAT
  ) {
    throw new BackupError('not-backup', 'That JSON file is not a Macro Tracker backup.')
  }
  return parsePayload(raw)
}

// --- CSV ------------------------------------------------------------------

/**
 * Data lock-in would be indefensible in a single-user app the user built
 * themselves, so plain CSV is always available. It is lossy by nature and
 * the UI says so; notes are one of the few things it carries intact.
 */
export const DAY_CSV_HEADER = [
  'date',
  'phase',
  'precision_mode',
  'weight_kg',
  'waist_cm',
  'kcal',
  'protein_g',
  'carbs_g',
  'fat_g',
  'sat_fat_g',
  'fibre_g',
  'sodium_mg',
  'added_sugar_g',
  'alcohol_g',
  'entry_count',
  'lowest_fidelity',
  'incomplete',
  'note',
] as const

export const ENTRY_CSV_HEADER = [
  'date',
  'time',
  'occasion',
  'source_kind',
  'name',
  'grams',
  'fidelity',
  'kcal',
  'protein_g',
  'carbs_g',
  'fat_g',
  'sat_fat_g',
  'fibre_g',
  'sodium_mg',
  'added_sugar_g',
  'alcohol_g',
  'proxy_for',
  'note',
] as const

/** CSV column for each nutrient, in NUTRIENT_KEYS order. */
export const NUTRIENT_CSV_COLUMNS: Record<NutrientKey, string> = {
  kcal: 'kcal',
  protein: 'protein_g',
  carbs: 'carbs_g',
  fat: 'fat_g',
  satFat: 'sat_fat_g',
  fibre: 'fibre_g',
  sodium: 'sodium_mg',
  addedSugar: 'added_sugar_g',
  alcohol: 'alcohol_g',
}

export function daysToCsv(input: {
  days: DayRecord[]
  entries: Entry[]
}): string {
  const byDate = new Map<string, Entry[]>()
  for (const e of input.entries) {
    const list = byDate.get(e.date)
    if (list) list.push(e)
    else byDate.set(e.date, [e])
  }

  const rows = [...input.days]
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map((d) => {
      const entries = byDate.get(d.date) ?? []
      const totals = aggregateNutrients(entries.map((e) => e.nutrients))
      // A total with unknown contributions is written as its known floor and
      // listed in `incomplete`, so a spreadsheet cannot mistake it for whole.
      const incomplete = NUTRIENT_KEYS.filter((k) => !totals[k].complete)
      return [
        d.date,
        d.phase,
        d.precisionMode,
        d.weightKg?.value ?? '',
        d.waistCm ?? '',
        ...NUTRIENT_KEYS.map((k) =>
          entries.length === 0 || totals[k].knownEntries === 0 ? '' : round(totals[k].value),
        ),
        entries.length,
        lowestFidelityOf(entries),
        incomplete.join(' '),
        d.note ?? '',
      ]
    })

  return [[...DAY_CSV_HEADER], ...rows].map((r) => r.map(csvCell).join(',')).join('\n')
}

export function entriesToCsv(entries: Entry[]): string {
  const rows = [...entries]
    .sort((a, b) =>
      a.date === b.date
        ? (a.at ?? '').localeCompare(b.at ?? '')
        : a.date < b.date
          ? -1
          : 1,
    )
    .map((e) => [
      e.date,
      e.at ?? '',
      e.occasion ?? '',
      e.source.kind,
      e.source.name,
      round(e.grams),
      e.fidelity,
      // Unknown is written blank, never 0, and reads back as unknown.
      ...NUTRIENT_KEYS.map((k) => {
        const v = e.nutrients[k]
        return v === null ? '' : round(v)
      }),
      e.proxyFor?.note ?? '',
      e.note ?? '',
    ])
  return [[...ENTRY_CSV_HEADER], ...rows].map((r) => r.map(csvCell).join(',')).join('\n')
}

function lowestFidelityOf(entries: Entry[]): string {
  if (entries.length === 0) return ''
  return lowestFidelity(entries.map((e) => e.fidelity))
}

function round(n: number): number {
  return Math.round(n * 10) / 10
}

/**
 * Quote a cell, and defuse spreadsheet formulas. A food name from a barcode
 * lookup is third-party text; a cell starting `=`, `+`, `-` or `@` would be
 * executed by a spreadsheet opening the file. Prefixing an apostrophe is
 * the standard defence, and import strips it again.
 */
export function csvCell(v: string | number): string {
  let s = String(v)
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function backupFilename(at: number, encrypted: boolean): string {
  const d = new Date(at)
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return `macro-tracker-${stamp}${encrypted ? '' : '-plain'}.mtb`
}

export function jsonFilename(at: number): string {
  return backupFilename(at, false).replace(/-plain\.mtb$/, '.json')
}

/** Days since the last backup. Drives the health indicator in settings. */
export function daysSinceBackup(lastAt: number | undefined, now = Date.now()): number | undefined {
  if (lastAt === undefined) return undefined
  return Math.floor((now - lastAt) / 86_400_000)
}

export const BACKUP_PROMPT_ESCALATION_DAYS = 14
