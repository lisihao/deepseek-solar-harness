/**
 * Anchored Standard's exact complete persona.
 *
 * Complete personas intentionally replace all global prompt sections. Import
 * the shared output-style composition instead of adding a synthetic user
 * message or trying to bypass the SystemPrompt registry.
 */

import {
  ANCHORED_STANDARD_PERSONA,
} from '@deepseek-ai/dsh-output-style'
import {
  PERSONA_ORDER,
  PERSONA_SECTION,
} from '@deepseek-ai/dsh-system-prompt'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'anchored-output-style-persona'

/** The complete persona only requires the existing prompt registry. */
export const inject = ['systemPrompt']

/**
 * Install Anchored Standard's one complete system-prompt section.
 * Runtime context remains suppressed exactly as it was under dsh-persona.
 */
export function apply(ctx) {
  ctx.systemPrompt.section({
    name: PERSONA_SECTION,
    order: PERSONA_ORDER,
    text: ANCHORED_STANDARD_PERSONA,
    complete: true,
  })
  ctx.systemPrompt.suppressRuntimeContext()
}
