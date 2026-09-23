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
 *
 * Import runs forward migrations for anything at or below this, and refuses
 * anything above it rather than reading part of it.
 */
export const SCHEMA_VERSION = 2
