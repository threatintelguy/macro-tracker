/**
 * Tier 2: an optional, user-configured external endpoint.
 *
 * Bring-your-own: base URL, model name, API key, speaking the
 * OpenAI-compatible chat-completions wire format. Off until configured --
 * no default endpoint, no suggested provider, no shipped key.
 *
 * What is sent, and nothing else: the fixed instruction, the meal
 * description, the names and weights of anything already weighed for this
 * meal, and the photo if one is attached. Never the profile, body weight,
 * targets, history, other entries or any identifier. Every request is
 * stateless -- no conversation, no session -- and fires only on an explicit
 * tap of Estimate.
 */

import type { ExternalEndpoint } from '../domain/types.ts'
import {
  OUTPUT_SCHEMA,
  SYSTEM_PROMPT,
  parseModelOutput,
  userPrompt,
  type EstimateRequest,
  type ModelOutput,
} from './pipeline.ts'

export class EstimateError extends Error {
  constructor(
    readonly kind: 'auth' | 'rate-limit' | 'network' | 'bad-output' | 'unavailable',
    message: string,
  ) {
    super(message)
    this.name = 'EstimateError'
  }
}

/** Accept a base like ".../v1" or the full ".../chat/completions" URL. */
export function completionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  return /\/chat\/completions$/.test(trimmed) ? trimmed : `${trimmed}/chat/completions`
}

/** Only https, so a key never crosses the network in clear. Localhost excepted. */
export function endpointProblem(e: Pick<ExternalEndpoint, 'baseUrl' | 'model'>): string | undefined {
  let url: URL
  try {
    url = new URL(completionsUrl(e.baseUrl))
  } catch {
    return 'That base URL is not a valid address.'
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    return 'The endpoint must use https.'
  }
  if (e.model.trim().length === 0) return 'Name the model to use.'
  return undefined
}

/** The exact request body. Exported so the outbound audit can inspect it. */
export function buildRequestBody(
  req: EstimateRequest,
  model: string,
  format: 'json_schema' | 'json_object',
): Record<string, unknown> {
  const text = userPrompt(req)
  const user =
    req.photo !== undefined
      ? [
          { type: 'text', text },
          { type: 'image_url', image_url: { url: req.photo } },
        ]
      : text
  return {
    model: model.trim(),
    temperature: 0.2,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: user },
    ],
    response_format:
      format === 'json_schema'
        ? { type: 'json_schema', json_schema: { name: 'meal_estimate', strict: true, schema: OUTPUT_SCHEMA } }
        : { type: 'json_object' },
  }
}

export async function estimateExternal(
  req: EstimateRequest,
  endpoint: ExternalEndpoint,
  fetchImpl: typeof fetch,
): Promise<ModelOutput> {
  const problem = endpointProblem(endpoint)
  if (problem) throw new EstimateError('unavailable', problem)

  const send = async (format: 'json_schema' | 'json_object'): Promise<Response> => {
    try {
      return await fetchImpl(completionsUrl(endpoint.baseUrl), {
        method: 'POST',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        mode: 'cors',
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${endpoint.apiKey}`,
        },
        body: JSON.stringify(buildRequestBody(req, endpoint.model, format)),
      })
    } catch {
      throw new EstimateError('network', 'Could not reach the endpoint.')
    }
  }

  let res = await send('json_schema')
  // Not every compatible server supports schema-constrained output; ask for
  // plain JSON instead, and check it against the schema here.
  if (res.status === 400 || res.status === 422) res = await send('json_object')

  if (res.status === 401 || res.status === 403) {
    throw new EstimateError('auth', 'The endpoint refused the key.')
  }
  if (res.status === 429) throw new EstimateError('rate-limit', 'The endpoint is rate limiting.')
  if (!res.ok) throw new EstimateError('network', `The endpoint answered ${res.status}.`)

  let content: unknown
  try {
    const body = (await res.json()) as { choices?: { message?: { content?: unknown } }[] }
    content = body.choices?.[0]?.message?.content
  } catch {
    throw new EstimateError('bad-output', 'The endpoint returned something that is not JSON.')
  }
  const output = parseModelOutput(content)
  if (!output) throw new EstimateError('bad-output', 'The endpoint returned no usable estimate.')
  return output
}
