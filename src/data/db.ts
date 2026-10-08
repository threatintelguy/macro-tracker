/**
 * Dexie schema and migrations.
 *
 * Monotonic versioned migrations. Every export embeds `schemaVersion` and
 * import runs forward migrations against older files -- the app holds the
 * only copy of multi-year data, so an import path that cannot read last
 * year's backup is a data-loss bug in waiting.
 */

import Dexie, { type Table } from 'dexie'
import type {
  AdjustmentEvent,
  BackupMeta,
  Composite,
  CompositeTombstone,
  CompositeUsage,
  DayRecord,
  Entry,
  ExternalEndpoint,
  FoodItem,
  Goal,
  LookupRecord,
  Photo,
  Profile,
  Settings,
  Snapshot,
  TdeeEstimate,
} from '../domain/types.ts'
import { foodOrigin } from '../food/search.ts'
import { DEFAULT_UNIT_PREFS } from '../domain/units.ts'
import {
  DEFAULT_SECONDARY_TARGETS,
  MACRO_BANDS,
} from '../domain/nutrition/index.ts'
import { DEFAULT_OCCASION_WINDOW_MINUTES } from '../domain/analytics/index.ts'
import { DEFAULT_PRESET } from '../domain/engine/targets.ts'

export { SCHEMA_VERSION } from '../domain/schema.ts'

export class MacroDb extends Dexie {
  days!: Table<DayRecord, string>
  entries!: Table<Entry, string>
  foods!: Table<FoodItem, string>
  composites!: Table<Composite, string>
  compositeUsage!: Table<CompositeUsage, number>
  goals!: Table<Goal, number>
  profile!: Table<Profile, string>
  settings!: Table<Settings, string>
  backups!: Table<BackupMeta, number>
  tombstones!: Table<CompositeTombstone, string>
  adjustments!: Table<AdjustmentEvent, string>
  tdeeEstimates!: Table<TdeeEstimate, string>
  snapshots!: Table<Snapshot, number>
  photos!: Table<Photo, string>
  lookups!: Table<LookupRecord, string>
  secrets!: Table<ExternalEndpoint, string>

  constructor(name = 'macro-tracker') {
    super(name)

    this.version(1).stores({
      days: 'date, phase, precisionMode',
      entries: 'id, date, [date+at], occasion, fromCompositeEntryId',
      foods: 'id, name, tier, barcode, *aliases',
      composites: 'id, name, updatedAt, retired',
      compositeUsage: '++id, compositeId, loggedAt',
      goals: '++id, active, startDate',
      profile: 'id',
      settings: 'id',
      backups: '++id, at',
    })

    // Additive only. Nullable nutrients need no index or row change, so
    // there is no upgrade function: every existing row is already valid.
    this.version(2).stores({
      tombstones: 'id',
      adjustments: 'id, date, at',
      tdeeEstimates: 'windowEnd',
      snapshots: '++id, at',
    })

    // Addendum 2. Migration E: foods gain `origin`, which drives ranking and
    // the library badge; existing custom foods and cached barcode rows are
    // otherwise untouched. Migration F's entry fields (`estimateSource`,
    // `lineSource`, `photoRef`) are optional and need no rewrite. New
    // tables: plate photos, the record of network lookups already made, and
    // the external endpoint -- kept apart so a key never travels in a backup.
    this.version(3)
      .stores({
        foods: 'id, name, tier, barcode, *aliases, origin',
        photos: 'id',
        lookups: 'key',
        secrets: 'id',
      })
      .upgrade(async (tx) => {
        await tx
          .table<FoodItem, string>('foods')
          .toCollection()
          .modify((f) => {
            if (!f.origin) f.origin = foodOrigin(f)
          })
      })
  }
}

export const db = new MacroDb()

export function defaultSettings(): Settings {
  return {
    id: 'settings',
    preset: DEFAULT_PRESET,
    overrides: [],
    secondary: { ...DEFAULT_SECONDARY_TARGETS },
    // Mid-band defaults; both are editable in settings.
    proteinGPerKg: 2.0,
    fatGPerKg: MACRO_BANDS.fat.min,
    occasionWindowMinutes: DEFAULT_OCCASION_WINDOW_MINUTES,
    barcodeLookupEnabled: true,
    units: { ...DEFAULT_UNIT_PREFS },
    floatingAdd: true,
    onlineSearchEnabled: true,
    retainPhotos: true,
  }
}
