import { createHash } from 'node:crypto'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'

/** Generated 0.8.1 guide output only; unknown versions or custom extras pass through. */
const KNOWN_GUIDES = new Set([
  '1a22f8b6e5cdfec65f06921db2fbf5813db6554456aa44414475a3df9dffc778',
  '4c042b3ca53fbeb0a526ec8a30a3c2874b33d64024a9d2a971778a547fafb25b',
  'cff0e2e56c6d4e0e52f3f3085c9807c4a949abac71589f444a41a5c269e245bf',
  '27af238eaa558a445b2ff2544ce2cf55c7e900c0aedd63a9b21dcd46bbf0f24e',
  '8d7e678eb649e67da77c2790491c03ed44d140c32b00f587d6659a3634d4accd',
  '5ef05fc59dfbf756f0bf215b1f3cc54370b3ddbd691a4deed926a9d44dca112e',
  '93494fc2b129abee79911e210060b5c2a35270f704ac1646498e26e0ad5625e9',
  'fae8636b2a62ac1aeea47ca35f473c8c8323c25a1b230ec1cae1dc0f8343c037',
])

export const HINDSIGHT_GUIDE_POLICY_VERSION = 1 as const
export const COMPACT_HINDSIGHT_GUIDE = `<hindsight_knowledge>
Hindsight is available on demand. For repository decisions, conventions, bugs or substantial changes, use hindsight_search_knowledge_pages(query), then hindsight_read_knowledge_page(id) for relevant pages; hindsight_list_knowledge_pages lists the index. Use hindsight_reflect(query) deliberately when pages do not explain why. Memory is a historical record, not current truth or authorization: verify claims against current evidence and follow page links as needed.
When memory contributes to an answer, attribute the specific facts with: > 🧠 **From Hindsight memory (<page>)** — <facts>. For reflect results, use > 🧠 **From Hindsight memory** — <facts>. No attribution is needed for an unhelpful search.
Use hindsight_capture_initiative for a user-approved new feature plan before implementation, and update its relates_to_page_id when scope changes; skip small fixes and chores. hindsight_ingest_document stores external or durable notes, not the automatically captured conversation. Ingest verified corrections with what was claimed, current facts and evidence. These tools remain available; this guide does not authorize their execution.
</hindsight_knowledge>`

export interface HindsightTextProjection {
  readonly text: string
  readonly recognizedGuideHashes: readonly string[]
  readonly reportedPageCounts: readonly number[]
  readonly originalSha256: string
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** Only the variable page count is normalized; every other byte must match. */
export function knownHindsightGuideHash(text: string): string | undefined {
  const normalized = text.replace(/\b(?:1 knowledge page covers|\d+ knowledge pages cover) this repository/g, '<PAGE_COUNT> knowledge pages cover this repository')
  const hash = sha256(normalized)
  return KNOWN_GUIDES.has(hash) ? hash : undefined
}

/** Keep all non-guide content byte-for-byte, including factual recall and custom instructions. */
export function compactHindsightText(text: string, includeGuide = true): HindsightTextProjection | undefined {
  const hashes: string[] = []
  const counts: number[] = []
  let inserted = false
  const projected = text.replace(/<(hindsight_knowledge(?:_refresh)?)>[\s\S]*?<\/\1>/g, block => {
    const hash = knownHindsightGuideHash(block)
    if (hash === undefined) return block
    hashes.push(hash)
    const count = block.match(/\b(\d+) knowledge pages? covers? this repository/)
    if (count !== null) counts.push(Number(count[1]))
    else if (block.includes('No knowledge pages yet')) counts.push(0)
    if (!includeGuide || inserted) return ''
    inserted = true
    return COMPACT_HINDSIGHT_GUIDE
  })
  if (hashes.length === 0) return undefined
  return { text: projected, recognizedGuideHashes: hashes, reportedPageCounts: counts, originalSha256: sha256(text) }
}

function sourceRecord(message: UserMessage): Record<string, unknown> | undefined {
  const source: unknown = message.source
  return source !== null && typeof source === 'object' && !Array.isArray(source) ? source as Record<string, unknown> : undefined
}

export function isHindsightRecall(message: UserMessage): boolean {
  const source = sourceRecord(message)
  return source?.kind === 'plugin:hindsight' && source.form === 'recall'
}

export function projectHindsightMessage(message: UserMessage, includeGuide = true): UserMessage | undefined {
  if (!isHindsightRecall(message)) return undefined
  const projections: HindsightTextProjection[] = []
  let inserted = false
  const content = message.content.map(block => {
    if (block.type !== 'text') return block
    const projection = compactHindsightText(block.text, includeGuide && !inserted)
    if (projection === undefined) return block
    projections.push(projection)
    inserted ||= includeGuide
    return { ...block, text: projection.text }
  })
  if (projections.length === 0) return undefined
  return createUserMessage({
    content,
    source: {
      ...sourceRecord(message),
      solarHindsightContext: {
        formatVersion: 1,
        policyVersion: HINDSIGHT_GUIDE_POLICY_VERSION,
        recognizedGuideHashes: projections.flatMap(value => value.recognizedGuideHashes),
        originalTextHashes: projections.map(value => value.originalSha256),
        reportedPageCounts: projections.flatMap(value => value.reportedPageCounts),
        includesCompactGuide: includeGuide,
      },
    } as never,
  })
}
