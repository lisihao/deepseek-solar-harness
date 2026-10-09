/** What the scheduling model reads of the candidates the Host offers, bounded to the dispatch input limit. */
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { KennelCollaborationCandidate } from '@deepseek-ai/dsh-orchestration'
import type { KennelDispatchCandidate } from './dispatcher.ts'

/** Longest text of one collaboration detail the model reads; the full text stays in the logged candidate. */
const MAX_DETAIL_CHARS = 200

function clip(value: unknown): unknown {
  if (typeof value === 'string') return value.length <= MAX_DETAIL_CHARS ? value : `${value.slice(0, MAX_DETAIL_CHARS - 1)}…`
  if (Array.isArray(value)) return value.map(clip)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clip(entry)]))
  }
  return value
}

function viewOf(candidate: KennelDispatchCandidate): KennelDispatchCandidate {
  if (candidate.kind !== 'collaboration') return candidate
  const details = clip(candidate.details) as KennelCollaborationCandidate['details']
  return { ...candidate, details }
}

/**
 * Build the scheduling request from the candidates a message can choose. Collaboration details are shortened for the model,
 * so earlier review comments identify a candidate without filling the input. When the request still exceeds the limit, the
 * oldest collaboration candidates are left out, so history never blocks a message; work and existing-run candidates are never
 * left out.
 * @param candidates - Host-qualified candidates, collaborations in the order the Session started them.
 * @param request - the user's message text.
 * @param system - selection prompt.
 * @param maxBytes - UTF-8 byte limit of the whole request.
 * @returns the candidates the model is shown and its request (system prompt and the one user message), or undefined when
 * the request exceeds the limit with only work and existing-run candidates.
 */
export function fitCandidates(
  candidates: readonly KennelDispatchCandidate[], request: string, system: string, maxBytes: number,
): { candidates: KennelDispatchCandidate[]; options: { system: string; messages: UserMessage[] } } | undefined {
  const shown = [...candidates]
  for (;;) {
    const text = JSON.stringify({ request, candidates: shown.map(viewOf) })
    const options = {
      system,
      messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })],
    }
    if (Buffer.byteLength(JSON.stringify(options)) <= maxBytes) return { candidates: shown, options }
    const oldest = shown.findIndex(candidate => candidate.kind === 'collaboration')
    if (oldest < 0) return undefined
    shown.splice(oldest, 1)
  }
}
