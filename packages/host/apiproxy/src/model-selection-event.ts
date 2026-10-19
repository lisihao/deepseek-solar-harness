/** Durable explicit per-Session model choices, independent of global defaults and model requests. */
import type { ModelSelection } from './api/sessions.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm/brand'
import { z } from 'zod'
import { modelSelectionSchema } from './api/sessions.schema.ts'

const savedSelection = z.object({ version: z.literal(1), selected: modelSelectionSchema, ordinary: modelSelectionSchema.nullable() })

type SavedModelSelection = Omit<ModelSelection, 'reasoningEffort'> & { reasoningEffort?: ReasoningEffortId }

/**
 * Restore the last explicit Session choice after validating its durable JSON.
 * @param events - Original Session log.
 * @returns Last explicit choice after durable JSON validation, or no record.
 */
export function readSavedModelSelection(events: readonly SessionEvent[]): {
  version: 1
  selected: SavedModelSelection
  ordinary: SavedModelSelection | null
} | undefined {
  const event = events.findLast(e => e.type === 'session/model-selection')
  if (event === undefined) return undefined
  const saved = savedSelection.parse(event.data)
  const copy = (selection: z.output<typeof modelSelectionSchema>) => ({
    provider: selection.provider, model: selection.model,
    ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(selection.reasoningEffort) }),
  })
  if (saved.ordinary?.provider === 'dsh-physical-operator'
    && (saved.ordinary.model === 'chatgpt-web' || saved.ordinary.model.startsWith('chatgpt-web:'))) {
    throw new Error('Saved ordinary selection cannot use ChatGPT Web')
  }
  return { version: saved.version, selected: copy(saved.selected), ordinary: saved.ordinary === null ? null : copy(saved.ordinary) }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Explicit user route choice; never a request receipt or model-visible prompt input. */
    'session/model-selection': { version: 1; selected: ModelSelection; ordinary: ModelSelection | null }
  }
}
