/**
 * The fallback chain.
 *
 *   external (configured + online + enabled)
 *     -> on-device (downloaded + WebGPU available)
 *       -> manual entry (always)
 *
 * Every step is optional except the last. A user who declines both models
 * still has a working tracker -- the four manual routes need no model, and
 * that must stay true. External failures fall back silently: the draft says
 * which tier produced it, as provenance, not as a warning.
 */

import type { EstimateSource, EstimateTier } from '../domain/types.ts'
import type { EstimateRequest, ModelOutput } from './pipeline.ts'

export type Tier = {
  tier: EstimateTier
  model: string
  /** Throws on failure; the chain moves to the next tier. */
  run: (req: EstimateRequest) => Promise<ModelOutput>
}

export type ChainResult =
  | { ok: true; output: ModelOutput; provenance: EstimateSource; fellBackFrom?: EstimateTier }
  | { ok: false; reason: 'no-model' | 'all-failed'; message: string }

/**
 * Run the first tier that answers. The photo goes only to the external
 * tier: the on-device tier has no vision, and receives the description
 * alone.
 */
export async function runChain(
  req: EstimateRequest,
  tiers: readonly Tier[],
  now: () => Date = () => new Date(),
): Promise<ChainResult> {
  if (tiers.length === 0) {
    return {
      ok: false,
      reason: 'no-model',
      message:
        'No model is set up. Build it from ingredients or enter what you know instead — neither needs a model.',
    }
  }
  let failedFrom: EstimateTier | undefined
  for (const t of tiers) {
    try {
      const input: EstimateRequest =
        t.tier === 'external' ? req : { description: req.description, pinned: req.pinned }
      const output = await t.run(input)
      return {
        ok: true,
        output,
        provenance: { tier: t.tier, model: t.model, at: now().toISOString() },
        ...(failedFrom ? { fellBackFrom: failedFrom } : {}),
      }
    } catch {
      failedFrom ??= t.tier
    }
  }
  return {
    ok: false,
    reason: 'all-failed',
    message:
      'The estimate did not come back. Build it from ingredients or enter what you know instead.',
  }
}
