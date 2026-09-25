/** Internal typed identities for the ChatGPT Web MCP bridge. */

import type { Branded } from '@deepseek-ai/dsh-brand'

/**
 * SHA-256 identity of one accepted MCP `tools/call` wire invocation.
 *
 * It combines the full validated HTTP `x-request-id` with the JSON-RPC request id,
 * so an exact wire replay can reuse its receipt. It does not classify
 * separately received, semantically similar calls as retries.
 */
export type WebMcpCallId = Branded<'WebMcpCallId'>
