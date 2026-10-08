/**
 * The data schema version, embedded in every export.
 *
 * v1 -- phase 1.
 * v2 -- Addendum 1. Nutrient fields widen to number | null (no row is
 *       rewritten: existing values stay as they were); custom foods gain
 *       `derivedFrom` and entries `proxyFor` and `componentRef`, all
 *       optional. New tables for composite tombstones, the adjustment audit
 *       log, stored TDEE estimates, and pre-import / pre-purge snapshots.
 *       Both changes are additive and neither touches an existing row.
 * v3 -- Addendum 2. Migration E: foods gain `origin` (curated, usda-generic,
 *       usda-branded, barcode, online, custom), filled from the tier for
 *       older rows, and a new `online` tier. Migration F: the `ai_estimated`
 *       fidelity; entries gain optional `estimateSource`, `lineSource` and
 *       `photoRef`; foods `estimate`; composites `estimateSource`; settings
 *       gain unit preferences and the estimate options. Photos, the record
 *       of lookups and the external endpoint are device-only and are not
 *       part of an export.
 *
 * Import runs forward migrations for anything at or below this, and refuses
 * anything above it rather than reading part of it.
 */
export const SCHEMA_VERSION = 3
