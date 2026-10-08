/**
 * Tier 1: the on-device model, the default.
 *
 * Llama 3.2 3B Instruct, q4f16, via WebLLM on WebGPU -- roughly 1.8 GB, about
 * 2.3 GB peak VRAM -- with Llama 3.2 1B (about 0.8 GB) as the fallback on
 * constrained devices, chosen at download time from a capability check.
 * Model selection is restricted to US-based organisations; both are Meta's.
 *
 * Downloads only on explicit consent, only over Wi-Fi where the browser can
 * tell, and is cached in the Origin Private File System. Output is
 * constrained by grammar-based sampling to the fixed JSON schema, so a
 * malformed response is impossible rather than unlikely.
 *
 * The quality gap is real: nutrition estimation is recall of specific
 * quantities, among the first capabilities to degrade as models shrink.
 * The hybrid pipeline -- the model decomposes, the library prices --
 * mitigates that without erasing it.
 *
 * WebLLM is loaded lazily, inside a worker, only when this tier is used: a
 * user who never downloads a model never loads any of it.
 */

import type { OnDeviceModelSize } from '../domain/types.ts'
import {
  OUTPUT_SCHEMA,
  SYSTEM_PROMPT,
  parseModelOutput,
  userPrompt,
  type EstimateRequest,
  type ModelOutput,
} from './pipeline.ts'
import { EstimateError } from './external.ts'

/** Model ids, as WebLLM's prebuilt catalogue names them. */
export const ON_DEVICE_MODELS: Record<
  OnDeviceModelSize,
  { id: string; idF32: string; label: string; approxGb: number }
> = {
  '3b': {
    id: 'Llama-3.2-3B-Instruct-q4f16_1-MLC',
    idF32: 'Llama-3.2-3B-Instruct-q4f32_1-MLC',
    label: 'Llama 3.2 3B Instruct',
    approxGb: 1.8,
  },
  '1b': {
    id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC',
    idF32: 'Llama-3.2-1B-Instruct-q4f32_1-MLC',
    label: 'Llama 3.2 1B Instruct',
    approxGb: 0.8,
  },
}

/**
 * Where model weights come from. Overridable at build time with
 * VITE_MODEL_BASE_URL, pointing at a host laid out like Hugging Face
 * (`<base>/<model-id>/resolve/main/<file>`) that sends CORS headers. The
 * default is the publisher's own repositories, which WebLLM's catalogue
 * already names.
 */
export function modelBaseUrl(): string | undefined {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env
  const v = env?.['VITE_MODEL_BASE_URL']?.trim()
  return v && v.length > 0 ? v.replace(/\/+$/, '') : undefined
}

export type DeviceCapability =
  | { ok: true; size: OnDeviceModelSize; f16: boolean; reason: string }
  | { ok: false; reason: string }

type GpuAdapterLike = {
  features: { has: (f: string) => boolean }
  limits: { maxStorageBufferBindingSize: number; maxBufferSize: number }
}

/**
 * Which model this device can run. The 3B model needs half-precision
 * shaders, large storage buffers and enough memory; anything less gets 1B.
 */
export async function checkDevice(nav: Navigator = navigator): Promise<DeviceCapability> {
  const gpu = (nav as Navigator & { gpu?: { requestAdapter: () => Promise<GpuAdapterLike | null> } }).gpu
  if (!gpu) return { ok: false, reason: 'This browser has no WebGPU, which the on-device model needs.' }
  let adapter: GpuAdapterLike | null = null
  try {
    adapter = await gpu.requestAdapter()
  } catch {
    adapter = null
  }
  if (!adapter) return { ok: false, reason: 'WebGPU is present but no graphics adapter is available.' }
  return pickModel({
    f16: adapter.features.has('shader-f16'),
    maxStorageBinding: adapter.limits.maxStorageBufferBindingSize,
    deviceMemoryGb: (nav as Navigator & { deviceMemory?: number }).deviceMemory,
  })
}

/** The decision itself, pure, so it can be tested without a GPU. */
export function pickModel(input: {
  f16: boolean
  maxStorageBinding: number
  deviceMemoryGb: number | undefined
}): DeviceCapability {
  const memoryOk = input.deviceMemoryGb === undefined || input.deviceMemoryGb >= 6
  const buffersOk = input.maxStorageBinding >= 1024 * 1024 * 1024
  if (input.f16 && memoryOk && buffersOk) {
    return { ok: true, size: '3b', f16: true, reason: 'This device can run the 3B model.' }
  }
  return {
    ok: true,
    size: '1b',
    f16: input.f16,
    reason: !input.f16
      ? 'No half-precision shader support, so the smaller 1B model.'
      : 'Limited graphics memory, so the smaller 1B model.',
  }
}

/**
 * Wi-Fi where the browser can say so. Android Chrome reports the connection
 * type; most others do not, and then the consent text asks instead.
 */
export function connectionForDownload(nav: Navigator = navigator): 'wifi' | 'cellular' | 'unknown' {
  const c = (nav as Navigator & { connection?: { type?: string; saveData?: boolean } }).connection
  if (!c) return 'unknown'
  if (c.saveData) return 'cellular'
  if (c.type === 'wifi' || c.type === 'ethernet') return 'wifi'
  if (c.type === 'cellular' || c.type === 'wimax' || c.type === 'bluetooth') return 'cellular'
  return 'unknown'
}

export function modelIdFor(size: OnDeviceModelSize, f16: boolean): string {
  return f16 ? ON_DEVICE_MODELS[size].id : ON_DEVICE_MODELS[size].idF32
}

// --- The engine -------------------------------------------------------------

type WebLlm = typeof import('@mlc-ai/web-llm')
type Engine = Awaited<ReturnType<WebLlm['CreateWebWorkerMLCEngine']>>

let webllm: Promise<WebLlm> | undefined
let engine: { id: string; engine: Promise<Engine> } | undefined

function lib(): Promise<WebLlm> {
  webllm ??= import('@mlc-ai/web-llm')
  return webllm
}

async function appConfig(id: string): Promise<import('@mlc-ai/web-llm').AppConfig> {
  const { prebuiltAppConfig } = await lib()
  const record = prebuiltAppConfig.model_list.find((m) => m.model_id === id)
  if (!record) throw new EstimateError('unavailable', `${id} is not in this build's model catalogue.`)
  const base = modelBaseUrl()
  return {
    cacheBackend: 'opfs',
    model_list: [base ? { ...record, model: `${base}/${id}/resolve/main/` } : record],
  }
}

/** Is the model already downloaded into this origin's storage? */
export async function isDownloaded(id: string): Promise<boolean> {
  try {
    const { hasModelInCache } = await lib()
    return await hasModelInCache(id, await appConfig(id))
  } catch {
    return false
  }
}

/**
 * Download (or load from the cache) and start the model. The first call is
 * the download; the caller has already asked for consent.
 */
export async function loadModel(
  id: string,
  onProgress?: (fraction: number, text: string) => void,
): Promise<void> {
  if (engine?.id === id) {
    await engine.engine
    return
  }
  const { CreateWebWorkerMLCEngine } = await lib()
  const worker = new Worker(new URL('./webllm.worker.ts', import.meta.url), { type: 'module' })
  const pending = CreateWebWorkerMLCEngine(worker, id, {
    appConfig: await appConfig(id),
    initProgressCallback: (r) => onProgress?.(r.progress, r.text),
  })
  engine = { id, engine: pending }
  try {
    await pending
  } catch (err) {
    engine = undefined
    worker.terminate()
    throw err
  }
}

/** Remove the model and everything cached for it. */
export async function deleteModel(id: string): Promise<void> {
  if (engine?.id === id) {
    try {
      await (await engine.engine).unload()
    } catch {
      // Already gone.
    }
    engine = undefined
  }
  const { deleteModelAllInfoInCache } = await lib()
  await deleteModelAllInfoInCache(id, await appConfig(id))
}

export async function estimateOnDevice(req: EstimateRequest, id: string): Promise<ModelOutput> {
  await loadModel(id)
  const e = await engine!.engine
  const reply = await e.chat.completions.create({
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      // No on-device vision in this phase: the description alone.
      { role: 'user', content: userPrompt({ description: req.description, pinned: req.pinned }) },
    ],
    temperature: 0.2,
    max_tokens: 1200,
    // Grammar-constrained sampling against the fixed schema.
    response_format: { type: 'json_object', schema: JSON.stringify(OUTPUT_SCHEMA) },
  })
  const output = parseModelOutput(reply.choices[0]?.message?.content ?? '')
  if (!output) throw new EstimateError('bad-output', 'The on-device model returned no usable estimate.')
  return output
}
