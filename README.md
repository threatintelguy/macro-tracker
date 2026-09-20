# Macro Tracker

A single-user macro tracker built to *Lincoln — Macro Tracker: Design Document*.
It logs food, computes energy and macronutrient totals, tracks body weight, and
shows how both move over time. Nothing else.

Installable PWA, Android-first, device-only storage, no account and no server.

## What is here

This is **delivery phase 1** from section 13 of the design document: a complete,
usable weighed tracker with the full composite system.

| Shipped | Notes |
| --- | --- |
| Data model and Dexie schema | Days are the spine; nothing computed is persisted except a memoised rollup |
| Curated food table (~156 foods) | Tier 1, hand-built, ranked first in search always |
| USDA subset | Tier 2 — build script written, artefact generated in CI |
| Barcode lookup | Tier 3, Open Food Facts, cached locally forever, switchable off |
| Kitchen-scale entry flow | Running total, gram field autofocus, search stays on screen |
| Full composite system | Save-from-meal, multiplier, component override, nesting, versioning, ranking |
| Weight entry and trend | EWMA α = 0.10, seeded from the first week's mean |
| Targets with provenance | Every number carries `{ value, source, rationale }` |
| Guardrail clamps | Applied last, no override path, property-tested |
| Backup and export | Encrypted `.mtb`, plain CSV, unencrypted JSON, forward migrations |
| Three-tab UI | Today, Log, Settings |

Deliberately **not** here, per the phase-1 scope:

- Observed TDEE and the three-week adjustment engine (phase 2)
- The phase state machine's dual gate and the precision-mode switcher (phase 2)
- The six analytics views and the weekly narrative (phase 3)
- Free-text estimated entry and the minimal-mode screen (phase 4)
- The on-device LLM (section 9, deferred) and the native wrapper (phase 6)

The data model, the `Fidelity` field, the `phase`/`precisionMode` fields on
`DayRecord`, the provenance shape, and `src/platform/` all exist now so those
phases land as additions rather than refactors.

Guardrail clamps arrived early. Phase 1 ships editable targets, and an editable
target without a floor under it is the one combination the design document rules
out — so `src/domain/engine/clamps.ts` is in from the start.

## Running it

```bash
npm install
npm run dev
```

```bash
npm test
```

```bash
npm run build
```

### The USDA subset (optional)

Tier 2 is a build artefact and is not committed. Download the FoodData Central
**Foundation Foods** and **SR Legacy** JSON exports from
<https://fdc.nal.usda.gov/download-datasets.html>, unzip them into one
directory, then:

```bash
npm run build:food-index -- --input ./fdc-json --out public/usda-subset.bin
```

The Branded dataset is excluded on purpose: it is label-derived rather than
lab-verified, it is most of FoodData Central's size, and it duplicates what
barcode lookup handles on demand.

Without this file the app runs on the curated table, custom foods and barcode
results. The loader treats an absent subset as an empty tier, never an error.

## Layout

```
src/
├── ui/              components, three tabs
├── domain/
│   ├── nutrition/   BMR, activity multipliers, macro maths, reference values
│   ├── engine/      target resolution, clamps, weight trend
│   ├── composites/  resolution, nesting, overrides, versioning, ranking
│   ├── phase/       calibration progress
│   └── analytics/   rollups, occasions, rolling averages
├── data/            Dexie schema, migrations, repositories
├── food/            tier resolution, registry, search index, barcode
├── platform/        Capabilities interface — the wrapper door
└── export/          encryption, CSV, backup
```

`domain/nutrition/` is person-agnostic: formulas and reference values only. The
user's profile is data in IndexedDB, not code, so a height or training change is
an edit in settings rather than a rebuild — and it is why this repo can be
public and contains no personal data.

## Testing

227 tests. The calculation engine and the clamps carry near-total coverage; the
UI gets smoke tests only, because the risk in this app is wrong numbers, not
broken buttons.

- **Clamps** — including a property sweep asserting that no input across 5,000
  random target sets and body weights produces a target below a floor, and that
  clamping is idempotent.
- **Targets** — provenance on every field, the formula → observed handover,
  carbohydrate as the remainder, and the clamps beating a user override.
- **Weight trend** — synthetic series of known ground truth: flat, a known
  linear slope, and a noisy series whose signal is buried in water movement.
- **Composites** — cycles, the depth cap, version pinning, overrides, nesting.
- **Backup** — round trips, a wrong passphrase failing rather than returning
  garbage, and a header readable without the key.
- **Lint rule** — no banned word (*streak*, *cheat*, *burn off*, *earn back*) in
  any user-facing string, and exactly one outbound host in the whole source.

## Privacy

Exactly one outbound call exists in normal operation: the barcode lookup, on an
explicit tap. It sends one product code with `credentials: 'omit'` and no
referrer, and caches the result locally forever, so a product is fetched at most
once ever. A global offline switch hard-disables it.

No analytics, no error reporting, no CDN fonts, scripts, or styles. A strict CSP
allows `self` plus the Open Food Facts hosts, so an accidental third-party
request fails loudly in development rather than silently in production.

**The honest risk:** device-only storage removes every cloud risk and introduces
one — this app holds the only copy. Browser storage is evictable and is
destroyed by "clear site data". The app requests persistent storage at install,
shows days-since-backup in settings, and escalates the prompt after 14 days.
Passphrase loss means data loss; there is no recovery mechanism, because one
would require a server.

## Deployment

GitHub Actions on push to `main`: typecheck → test → build food index → Vite
build → deploy to Pages. Set the `FDC_URL` secret to include tier 2.
