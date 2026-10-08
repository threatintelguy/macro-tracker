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
| Backup, export and import | Encrypted `.mtb`, plain JSON and CSV out; all three back in, with a dry-run preview, explicit merge mode and an undo snapshot |
| Four-tab UI | Today, Log, Trends, Settings |

### Addendum 1

| Change | Notes |
| --- | --- |
| Foods not in the database | Four routes in order: build from ingredients, clone a near match, enter only what you know, log a stand-in. Unknown nutrients are `null`, never 0; totals report floors with coverage |
| Needs-detail list | Unknowns and stand-ins, fixable later; no badge, no notification, no warning colour |
| Import | `.mtb` and `.json` restore everything; CSV imports rows only and says so first |
| Editing and past days | Edit beside Delete; amount rescales the snapshot, food re-resolves; arrows, swipe and a picker move the diary by day |
| Composite delete | Tombstones keep past days rendering; delete-and-purge is separate, typed-confirmed and snapshotted |
| Daily notes | On every day; marked on the charts; searchable from Trends |
| Phase 2 engine | Observed TDEE (21-day window), the three-week adjustment rule with suppressors and an append-only audit log, the calibration gate, and the precision-mode switcher with a minimal-mode layout |

### Addendum 2

| Change | Notes |
| --- | --- |
| Food library | Bundled core: full Foundation and SR Legacy plus a curated slice of USDA Branded, built in CI. **Search online** (Open Food Facts and FoodData Central) on an explicit tap after local results; every accepted result is written locally for good. Ranking: curated, previously logged, local, generic, branded; branded never outranks a generic food for a query that names no brand; near-duplicates collapse with alternatives under a disclosure |
| Barcodes | Local table, then the bundled index's GTINs, then the record of past lookups — including misses — before the network. The same code is looked up at most once, ever |
| Hybrid AI estimation | A description (plus optional photo and pinned weighed parts) becomes a draft: the model proposes components, the library prices them, the preparation allowance is its own line. Mandatory line-by-line review; accepting saves a reusable composite. `ai_estimated` fidelity, with tier and model recorded; included in trends, excluded from observed TDEE |
| Model hosting | On-device Llama 3.2 3B (1B on constrained devices) via WebLLM on WebGPU, downloaded on consent, cached in OPFS, grammar-constrained JSON. Optional bring-your-own OpenAI-compatible endpoint, off until configured. Fallback: external → on-device → manual |
| Label OCR | Tesseract.js, bundled and offline. Every parsed value is confirmed before saving; partial reads land in "enter only what you know" |
| Plate photos | Only with an external endpoint; compressed to ~1024 px, kept on the entry, deletable singly or all at once |
| Units | Per domain — body weight lb/kg, food g/oz, height ft·in/cm, waist in/cm. Display and input only; storage stays metric. Body weight always shows both units. Any weight field takes either unit by suffix |
| Today | Today's figures primary, the 7-day average a quiet second line. The add control sits between calibration and protein, with a floating button that persists while scrolling |

Schema version 3. An Addendum 1 export still imports.

Still **not** here:

- The rest of the six analytics views (the protein heatmap, weekly comparison) and the weekly narrative (phase 3)
- Automatic calibration extensions and the recalibration proposals; the gate is reported and the user moves phase
- On-device vision, and the native wrapper (phase 6)

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

### The bundled food index (optional)

A build artefact, not committed. Download the FoodData Central
**Foundation Foods** and **SR Legacy** JSON exports, and optionally
**Branded Foods**, from <https://fdc.nal.usda.gov/download-datasets.html>,
unzip them, then:

```bash
npm run build:food-index -- --input ./fdc-generic --branded ./fdc-branded --out public/usda-subset.bin
```

The generic datasets go in whole. The Branded export is several gigabytes and
is streamed; only a slice is kept (`--branded-max`, default 45,000): current
US products with a full macro panel, one per GTIN, ranked by how common the
product type and the brand are — selected by frequency, not completeness.
Unreported nutrients stay unknown in the index, never zero.

Without this file the app runs on the curated table, custom foods and cached
lookups. The loader treats an absent index as an empty tier, never an error.

### The on-device model

Nothing to build. WebLLM downloads the weights on the user's consent from the
publisher's repositories named in its own catalogue (Hugging Face `mlc-ai`,
model libraries from `mlc-ai/binary-mlc-llm-libs`) and caches them in OPFS.
To serve them from somewhere else, set `VITE_MODEL_BASE_URL` at build time to
a host laid out like Hugging Face (`<base>/<model-id>/resolve/main/<file>`)
that sends CORS headers. GitHub Release assets do not work for this: they
send no CORS headers, so a browser cannot fetch them.

## Layout

```
src/
├── ui/              components, three tabs
├── domain/
│   ├── nutrition/   BMR, activity multipliers, macro maths, reference values
│   ├── engine/      target resolution, clamps, weight trend, observed TDEE, adjustment rule
│   ├── composites/  resolution, nesting, overrides, versioning, ranking
│   ├── phase/       calibration progress
│   └── analytics/   rollups, occasions, rolling averages
├── data/            Dexie schema, migrations, repositories
├── food/            registry, search and ranking, bundled index, barcode, online search, label OCR
├── estimate/        hybrid estimation pipeline, on-device and external tiers, fallback chain
├── platform/        Capabilities interface — the wrapper door
└── export/          encryption, CSV, backup, import validation and merge planning
```

`domain/nutrition/` is person-agnostic: formulas and reference values only. The
user's profile is data in IndexedDB, not code, so a height or training change is
an edit in settings rather than a rebuild — and it is why this repo can be
public and contains no personal data.

## Testing

312 tests. The calculation engine and the clamps carry near-total coverage; the
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
- **Backup and import** — export, wipe, import and compare for `.mtb` and
  `.json`; a version 1 file still importing; a wrong passphrase told apart
  from a damaged file; malformed files rejected whole; merge modes, repairs
  and CSV formula defusing.
- **Unknown is not zero** — a property sweep asserting no day ever reports a
  total below the sum of its known entries, and floors reported with coverage.
- **Engine** — observed TDEE against synthetic series of known ground truth,
  the adjustment rule and its suppressors, and edits that append notes to
  past decisions rather than rewriting them.
- **Lint rule** — no banned word (*streak*, *cheat*, *burn off*, *earn back*) in
  any user-facing string; exactly the known outbound hosts in the source; and
  `fetch` called only from the audited modules.
- **Addendum 2** — units parsing and dual display; generic-over-branded
  ranking at several thousand foods; duplicate collapse; the v2 index format
  and the streaming reader; one network request per barcode, ever; the
  estimate pipeline (library over model, pins never overwritten, the
  preparation allowance always separate, model output bounded); the exact
  outbound request body; the fallback chain; estimated days kept out of a
  mixed TDEE window; label parsing; the v3 migration and a round trip
  carrying the new fidelity and source fields.

## Privacy

Every outbound call is on an explicit tap, sends `credentials: 'omit'` and no
referrer, and is hard-disabled by the offline switch:

- **Barcode lookup** — one product code, to Open Food Facts, only when neither
  local storage, the bundled index nor a past lookup can answer.
- **Search online** — the query string alone, to Open Food Facts and USDA
  FoodData Central (with api.data.gov's shared `DEMO_KEY`), only after local
  search. Accepted results are kept locally.
- **The on-device model download** — once, on consent.
- **The optional external endpoint** — the fixed instruction, the meal
  description, any pinned weights and the photo if attached. Never the
  profile, weight, targets, history, other entries or an identifier. The key
  lives in IndexedDB (not a hardware keystore) and never goes in a backup.

No analytics, no error reporting, no CDN fonts, scripts, or styles. Because the
external endpoint is whatever URL the user configures, the CSP's `connect-src`
allows https; the host allowlist lives in `tests/lint.test.ts` instead, which
fails the build on any new host or any `fetch` outside the audited modules.

**The honest risk:** device-only storage removes every cloud risk and introduces
one — this app holds the only copy. Browser storage is evictable and is
destroyed by "clear site data". The app requests persistent storage at install,
shows days-since-backup in settings, and escalates the prompt after 14 days.
Passphrase loss means data loss; there is no recovery mechanism, because one
would require a server.

## Deployment

GitHub Actions on push to `main`: typecheck → test → build food index → Vite
build → deploy to Pages. Set the `FDC_URL` secret to include tier 2.
