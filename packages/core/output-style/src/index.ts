/**
 * A small, composable response-formatting policy.
 *
 * The policy is model input, not a post-processor: it gives the model a stable
 * presentation contract while preserving the original output, session log, and
 * user-requested formats.
 *
 * @module @deepseek-ai/dsh-output-style
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Cordis plugin name. */
export const name = 'output-style'

/** The ordered system-prompt section owned by this package. */
export const OUTPUT_STYLE_SECTION = 'output-style:response'

/** Render after identity/persona but before tool-specific instructions. */
export const OUTPUT_STYLE_ORDER = 25

/**
 * Stable response-formatting guidance for normal compositions.
 *
 * It deliberately describes presentation defaults rather than trying to
 * classify or rewrite a response after it has been produced. An explicit user
 * format always wins.
 */
export const OUTPUT_STYLE_GUIDANCE = `Output style:
- For analysis, plans, comparisons, implementation work, or any multi-part answer, lead with the conclusion or result. Use short descriptive headings and one blank line between sections. Use lists for parallel items, tables only for repeated comparisons, and fenced code blocks for code or structured payloads.
- Make hierarchy, ordering, and visual formatting mirror the reasoning. Keep user-facing output free of raw HTML, internal IDs, or run-on unstructured text unless the user explicitly asks for diagnostics or an exact format.
- For greetings and simple one-line questions, answer directly and briefly. Follow an explicit user-requested format over these defaults.`

/**
 * Anchored Standard's complete persona owns the entire system prompt, so it
 * cannot receive additive sections. Export the one shared composition here to
 * keep that preset's explicit identity and this policy from drifting apart.
 */
export const ANCHORED_STANDARD_PERSONA = `You are a helpful software engineer assistant.

${OUTPUT_STYLE_GUIDANCE}`

/** The prompt service this row contributes to. */
export const inject = ['systemPrompt']

/**
 * Add the policy as an unloadable section of the current prompt composition.
 * No Session message, agent-loop hook, or output transformation is installed.
 */
export function apply(ctx: Context): void {
  ctx.systemPrompt.section({
    name: OUTPUT_STYLE_SECTION,
    order: OUTPUT_STYLE_ORDER,
    text: OUTPUT_STYLE_GUIDANCE,
  })
}
