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
import {
  DEFAULT_SECONDARY_TARGETS,
  MACRO_BANDS,
} from '../domain/nutrition/index.ts'
import { DEFAULT_OCCASION_WINDOW_MINUTES } from '../domain/analytics/index.ts'
import { DEFAULT_PRESET } from '../domain/engine/targets.ts'

export const SCHEMA_VERSION = 1

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
  }
}
