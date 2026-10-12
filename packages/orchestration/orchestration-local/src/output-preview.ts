/** The bounded, user-facing text a node's result event carries, projected from the operator's output blocks. */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/** Longest preview kept in an event; the complete output stays in the retained evidence. */
export const MAX_OPERATOR_OUTPUT_PREVIEW = 8_000

/**
 * Project the operator's user-facing result without copying unbounded output into the event index. Text blocks are written
 * as they are and other visible blocks as JSON; reasoning blocks are the operator's working notes, not part of the result,
 * so they are left out of the preview and stay only in the retained evidence.
 * @param output - the operator's output blocks.
 * @returns the preview, cut at {@link MAX_OPERATOR_OUTPUT_PREVIEW} characters, and whether it was cut.
 */
export function operatorOutputPreview(output: readonly ContentBlock[]): { outputPreview: string; outputTruncated: boolean } {
  const text = output.filter(block => block.type !== 'reasoning').map((block) => {
    if (block.type === 'text') return block.text
    return JSON.stringify(block)
  }).join('\n')
  return {
    outputPreview: text.slice(0, MAX_OPERATOR_OUTPUT_PREVIEW),
    outputTruncated: text.length > MAX_OPERATOR_OUTPUT_PREVIEW,
  }
}
