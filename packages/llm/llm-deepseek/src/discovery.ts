/**
 * Read the configured DeepSeek endpoint's model directory without creating a
 * chat completion. The adapter owns the cached directory; this helper only
 * validates one `GET /models` response and returns its usable exact ids.
 *
 * @module dsh-llm-deepseek/discovery
 */

import { attributionHeaders, LlmError } from '@deepseek-ai/dsh-llm'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'

interface ListingEntry {
  readonly id?: unknown
}

const DISCOVERY_TIMEOUT_CODE = 'LLM_DISCOVERY_TIMEOUT'

/** Join a configured endpoint prefix to its model-listing path. */
function listingUrl(baseURL: string): string {
  return `${baseURL.replace(/\/+$/, '')}/models`
}

/** Return the provider's error message when its response exposes one. */
function providerMessage(body: unknown, status: number): string {
  if (typeof body === 'object' && body !== null) {
    const error = (body as { readonly error?: unknown }).error
    if (typeof error === 'object' && error !== null) {
      const message = (error as { readonly message?: unknown }).message
      if (typeof message === 'string' && message.length > 0) return message
    }
  }
  return `DeepSeek model directory request failed with HTTP ${status}`
}

/** Validate an OpenAI-compatible `GET /models` reply and retain first-seen ids. */
function listingIds(body: unknown): string[] {
  if (typeof body !== 'object' || body === null) {
    throw new LlmError('DeepSeek model directory did not return a JSON object', 'DISCOVERY_FAILED')
  }
  const data = (body as { readonly data?: unknown }).data
  if (!Array.isArray(data)) {
    throw new LlmError('DeepSeek model directory has no "data" array', 'DISCOVERY_FAILED')
  }
  const ids: string[] = []
  const seen = new Set<string>()
  for (const raw of data) {
    if (typeof raw !== 'object' || raw === null) continue
    const id = (raw as ListingEntry).id
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}

/**
 * Read model ids from one configured DeepSeek endpoint.
 * @param options - resolved endpoint, credential, and existing request identity.
 * @returns de-duplicated model ids in endpoint order.
 * @throws LlmError when the endpoint is unreachable, rejects the listing, or sends invalid JSON.
 */
export async function discoverDeepSeekModels(options: {
  readonly baseURL: string
  readonly apiKey: string
  readonly userId: string
  /** Maximum duration for the directory request and JSON body read. */
  readonly timeoutMs: number
}): Promise<readonly string[]> {
  using d = deadline(undefined, options.timeoutMs, DISCOVERY_TIMEOUT_CODE)
  let response: Response
  try {
    response = await fetch(listingUrl(options.baseURL), {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${options.apiKey}`,
        ...attributionHeaders(),
        'x-deepseek-harness-user-id': options.userId,
      },
      signal: d.signal,
    })
  } catch (error: unknown) {
    const timeout = timeoutOf(d.signal, DISCOVERY_TIMEOUT_CODE)
    if (timeout !== undefined) {
      throw new LlmError(
        `DeepSeek model directory request timed out after ${timeout.timeoutMs}ms`,
        'TIMEOUT',
        { cause: error },
      )
    }
    throw new LlmError('DeepSeek model directory request failed', 'TRANSPORT', { cause: error })
  }

  let body: unknown
  try {
    body = await response.json()
  } catch (error: unknown) {
    const timeout = timeoutOf(d.signal, DISCOVERY_TIMEOUT_CODE)
    if (timeout !== undefined) {
      throw new LlmError(
        `DeepSeek model directory request timed out after ${timeout.timeoutMs}ms`,
        'TIMEOUT',
        { cause: error },
      )
    }
    throw new LlmError(
      response.ok
        ? 'DeepSeek model directory did not return valid JSON'
        : `DeepSeek model directory request failed with HTTP ${response.status}`,
      'DISCOVERY_FAILED',
      { status: response.status, cause: error },
    )
  }
  if (!response.ok) {
    throw new LlmError(providerMessage(body, response.status), 'DISCOVERY_FAILED', { status: response.status })
  }
  return listingIds(body)
}
