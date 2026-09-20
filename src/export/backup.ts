/**
 * Export, encryption, and import.
 *
 * Backup is not a feature here. It is the thing that makes device-only
 * storage survivable: this app holds the only copy, browser storage is
 * evictable, and years of history can vanish to a mis-tap in Android
 * settings.
 *
 * Format: a single `.mtb` file -- JSON, gzipped, then AES-GCM encrypted with
 * a key derived from a passphrase via PBKDF2. The header carries
 * schemaVersion, timestamp, and record counts IN CLEAR so a file can be
 * identified without decrypting it.
 *
 * Passphrase loss means data loss. There is no recovery mechanism, because
 * a recovery mechanism would require a server.
 */

import type {
  BackupMeta,
  Composite,
  CompositeUsage,
  DayRecord,
  Entry,
  FoodItem,
  Goal,
  Profile,
  Settings,
} from '../domain/types.ts'

export const MTB_MAGIC = 'MTB1'
export const PBKDF2_ITERATIONS = 310_000

export type BackupPayload = {
  schemaVersion: number
  exportedAt: number
  profile?: Profile
  settings?: Settings
  goals: Goal[]
  days: DayRecord[]
  entries: Entry[]
  /** Custom and barcode foods only. Curated and USDA rows ship with the app. */
  foods: FoodItem[]
  composites: Composite[]
  compositeUsage: CompositeUsage[]
  backups: BackupMeta[]
}

export type BackupHeader = {
  magic: string
  schemaVersion: number
  exportedAt: number
  encrypted: boolean
  recordCounts: Record<string, number>
  app: string
}

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

  const header: BackupHeader = {
    magic: MTB_MAGIC,
    schemaVersion: input.payload.schemaVersion,
    exportedAt: input.payload.exportedAt,
    encrypted,
    recordCounts: countRecords(input.payload),
    app: 'macro-tracker',
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

  const salt = c.getRandomValues(new Uint8Array(16))
  const iv = c.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(input.passphrase!, salt, c)
  const cipher = await c.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    compressed as BufferSource,
  )

  parts.push(blobPart(salt), blobPart(iv), cipher)
  return new Blob(parts, { type: 'application/octet-stream' })
}

/** Read the clear header without decrypting, so a file can be identified. */
export function readHeader(buffer: ArrayBuffer): BackupHeader {
  const bytes = new Uint8Array(buffer)
  const magic = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!)
  if (magic !== MTB_MAGIC) {
    throw new Error('This is not a Macro Tracker backup file.')
  }
  const headerLength = new DataView(buffer).getUint32(4, true)
  const json = new TextDecoder().decode(bytes.subarray(8, 8 + headerLength))
  return JSON.parse(json) as BackupHeader
}

export async function readBackup(input: {
  buffer: ArrayBuffer
  passphrase?: string
  crypto?: Crypto
}): Promise<BackupPayload> {
  const c = input.crypto ?? globalThis.crypto
  const header = readHeader(input.buffer)
  const bytes = new Uint8Array(input.buffer)
  const headerLength = new DataView(input.buffer).getUint32(4, true)
  let cursor = 8 + headerLength

  let body: Uint8Array
  if (header.encrypted) {
    if (!input.passphrase) {
      throw new Error('This backup is encrypted. Enter its passphrase to restore it.')
    }
    const salt = bytes.subarray(cursor, cursor + 16)
    cursor += 16
    const iv = bytes.subarray(cursor, cursor + 12)
    cursor += 12
    const cipher = bytes.subarray(cursor)
    const key = await deriveKey(input.passphrase, salt, c)
    try {
      const plain = await c.subtle.decrypt(
        { name: 'AES-GCM', iv: iv as BufferSource },
        key,
        cipher as BufferSource,
      )
      body = new Uint8Array(plain)
    } catch {
      throw new Error(
        'That passphrase did not decrypt the file. There is no recovery mechanism — a wrong passphrase means the file cannot be read.',
      )
    }
  } else {
    body = bytes.subarray(cursor)
  }

  const json = looksGzipped(body) ? await gunzip(body) : body
  const payload = JSON.parse(new TextDecoder().decode(json)) as BackupPayload
  return migratePayload(payload)
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
  }
}

// --- Plain formats --------------------------------------------------------

/**
 * Data lock-in would be indefensible in a single-user app the user built
 * themselves, so plain CSV and unencrypted JSON are always available.
 */
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

  const header = [
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
    'note',
  ]

  const rows = [...input.days]
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map((d) => {
      const entries = byDate.get(d.date) ?? []
      const sum = (k: keyof Entry['nutrients']): number =>
        entries.reduce((acc, e) => acc + e.nutrients[k], 0)
      return [
        d.date,
        d.phase,
        d.precisionMode,
        d.weightKg?.value ?? '',
        d.waistCm ?? '',
        round(sum('kcal')),
        round(sum('protein')),
        round(sum('carbs')),
        round(sum('fat')),
        round(sum('satFat')),
        round(sum('fibre')),
        round(sum('sodium')),
        round(sum('addedSugar')),
        round(sum('alcohol')),
        entries.length,
        lowestFidelity(entries),
        d.note ?? '',
      ]
    })

  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n')
}

export function entriesToCsv(entries: Entry[]): string {
  const header = [
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
    'note',
  ]
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
      round(e.nutrients.kcal),
      round(e.nutrients.protein),
      round(e.nutrients.carbs),
      round(e.nutrients.fat),
      round(e.nutrients.satFat),
      round(e.nutrients.fibre),
      round(e.nutrients.sodium),
      round(e.nutrients.addedSugar),
      round(e.nutrients.alcohol),
      e.note ?? '',
    ])
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n')
}

function lowestFidelity(entries: Entry[]): string {
  if (entries.length === 0) return ''
  const order = ['weighed', 'portioned', 'estimated', 'flagged']
  let worst = 0
  for (const e of entries) worst = Math.max(worst, order.indexOf(e.fidelity))
  return order[worst] ?? ''
}

function round(n: number): number {
  return Math.round(n * 10) / 10
}

function csvCell(v: string | number): string {
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function backupFilename(at: number, encrypted: boolean): string {
  const d = new Date(at)
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return `macro-tracker-${stamp}${encrypted ? '' : '-plain'}.mtb`
}

/** Days since the last backup. Drives the health indicator in settings. */
export function daysSinceBackup(lastAt: number | undefined, now = Date.now()): number | undefined {
  if (lastAt === undefined) return undefined
  return Math.floor((now - lastAt) / 86_400_000)
}

export const BACKUP_PROMPT_ESCALATION_DAYS = 14
