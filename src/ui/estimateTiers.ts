/**
 * Which model tiers are usable right now, in fallback order.
 *
 *   external (configured + online + enabled + disclosure acknowledged)
 *     -> on-device (downloaded + WebGPU available)
 *       -> manual entry (always; not a tier, the absence of one)
 */

import type { Tier } from '../estimate/chain.ts'
import { estimateExternal } from '../estimate/external.ts'
import { estimateOnDevice, isDownloaded } from '../estimate/onDevice.ts'
import * as store from './store.ts'

export type TierPlan = {
  tiers: Tier[]
  /** The external endpoint is set up but its disclosure has not been acknowledged. */
  needsDisclosure: boolean
}

export async function availableTiers(): Promise<TierPlan> {
  const tiers: Tier[] = []
  let needsDisclosure = false

  const endpoint = store.externalEndpoint.value
  if (endpoint && store.externalReady.value) {
    if (endpoint.disclosureAcceptedAt === undefined) {
      needsDisclosure = true
    } else {
      tiers.push({
        tier: 'external',
        model: endpoint.model.trim(),
        run: (req) => estimateExternal(req, endpoint, globalThis.fetch.bind(globalThis)),
      })
    }
  }

  const id = store.settings.value.onDeviceModelId
  const hasGpu = typeof navigator !== 'undefined' && 'gpu' in navigator
  if (id && hasGpu && (await isDownloaded(id))) {
    tiers.push({ tier: 'on-device', model: id, run: (req) => estimateOnDevice(req, id) })
  }

  return { tiers, needsDisclosure }
}

/** The plain statement of what an external request carries. */
export const EXTERNAL_DISCLOSURE = [
  'What is sent to your endpoint when you tap Estimate, and nothing else:',
  'a fixed instruction, the meal description you typed, the names and weights of anything you weighed for this meal, and the photo if you attached one.',
  'Never your profile, body weight, targets, history, other entries or any identifier. Each request stands alone: no conversation, no session.',
].join(' ')
