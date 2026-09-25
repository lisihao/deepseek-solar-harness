/**
 * Prompt rendering, disposal, and progress helpers shared by the ephemeral
 * ChatGPT Web Provider and its coordinated Resident sessions.
 *
 * @module @deepseek-ai/dsh-physical-operator-chatgpt-web/run-support
 */

import {
  PhysicalOperatorError,
  type PhysicalOperatorProgressEvent,
  type PhysicalOperatorProgressPage,
  type PhysicalOperatorProviderStartRequest,
  type PhysicalOperatorResult,
} from '@deepseek-ai/dsh-physical-operator'

/**
 * Render a start request as the single readable text prompt typed into ChatGPT Web.
 * A context envelope renders as plain sections (system text, each named
 * context, then the task) rather than a JSON document, so the website model
 * reads the task as the request.
 *
 * @param request - Provider start request; a context envelope takes precedence over prompt blocks.
 * @returns the rendered envelope, or the joined text blocks prefixed by a non-empty system prompt.
 * @throws PhysicalOperatorError `INVALID_RESULT` for a non-text block or an empty task.
 */
export function textPromptForRequest(request: PhysicalOperatorProviderStartRequest): string {
  const envelope = request.contextEnvelope
  const text: string[] = []
  for (const block of envelope?.task ?? request.prompt) {
    if (block.type !== 'text') {
      throw new PhysicalOperatorError('ChatGPT Web accepts text prompt blocks only', 'INVALID_RESULT')
    }
    text.push(block.text)
  }
  const task = text.join('\n')
  if (task.trim().length === 0) {
    throw new PhysicalOperatorError('ChatGPT Web prompt must not be empty', 'INVALID_RESULT')
  }
  const sections = envelope === undefined
    ? request.systemPrompt === undefined || request.systemPrompt.length === 0 ? [] : [request.systemPrompt]
    : [
      ...envelope.systemText.length === 0 ? [] : [envelope.systemText],
      ...envelope.contexts.map(context => `## ${context.name}\n\n${context.text}`),
    ]
  return [...sections, task].join('\n\n---\n\n')
}

/**
 * Wait until a run's result settles without observing its outcome.
 *
 * @param result - The run result whose holder still receives any terminal failure.
 * @returns a promise that resolves once `result` has settled.
 */
export async function settleForDisposal(result: Promise<PhysicalOperatorResult>): Promise<void> {
  try {
    await result
  } catch {
    // Disposal only establishes quiescence. The holder still receives the
    // original terminal failure from `result`.
  }
}

/** Content-free progress retained only for the run holder's bounded reader. */
export class ProgressLog {
  private sequence = 0
  private readonly events: PhysicalOperatorProgressEvent[] = []

  /** @param commandId - Command identity stamped on every appended event. */
  constructor(private readonly commandId: string) {}

  /**
   * Append one frozen progress event with the next sequence number.
   *
   * @param type - Progress event type.
   * @param data - Content-free event fields; `commandId` is added.
   */
  append(type: string, data: Readonly<Record<string, unknown>>): void {
    this.sequence += 1
    this.events.push(Object.freeze({
      sequence: this.sequence,
      type,
      time: new Date().toISOString(),
      data: Object.freeze({ ...data, commandId: this.commandId }),
    }))
  }

  /**
   * Read events after a sequence number.
   *
   * @param afterSequence - Exclusive lower sequence bound.
   * @param limit - Maximum number of events; negative values read none.
   * @param signal - Aborts the read before it starts.
   * @returns the page of events and the sequence to resume after.
   */
  read(afterSequence: number, limit: number, signal?: AbortSignal): Promise<PhysicalOperatorProgressPage> {
    if (signal?.aborted) {
      return Promise.reject(new PhysicalOperatorError('ChatGPT Web progress read was aborted', 'OPERATOR_ABORTED'))
    }
    const events = this.events.filter(event => event.sequence > afterSequence).slice(0, Math.max(0, limit))
    return Promise.resolve({ events, nextSequence: events.at(-1)?.sequence ?? afterSequence })
  }
}
