/**
 * Agent-owned coordination controls for a ChatGPT Web turn.
 *
 * The `web_session` tool is intentionally small. It does not execute browser
 * work and it does not grant access to the DSH tool bridge; the callback
 * supplied by the configured Web provider is the authority that decides which
 * exact model call may use it. The existing MCP bridge remains the path for
 * real DSH tool execution and logging.
 *
 * @module @deepseek-ai/dsh-physical-operator-chatgpt-web/coordination-tools
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type ContentBlock, type MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Stable source identity for a queued Web continuation. */
export const WEB_HANDOFF_PLUGIN = 'chatgpt-web-handoff'

/** Model-facing name of the coordination tool. */
export const WEB_SESSION_TOOL_NAME = 'web_session'

/** Prompt section name registered by {@link registerWebCoordinationTools}. */
export const WEB_COORDINATION_PROMPT_SECTION = 'tool:web-session'

/** Instruction returned after a checkpoint or handoff. */
export const WEB_SESSION_YIELD_INSTRUCTION =
  'Finish the current Web response so the DSH loop can deliver queued input.'

/** Instruction returned by a checkpoint when no queued input is waiting. */
export const WEB_SESSION_CONTINUE_INSTRUCTION =
  'Continue the current task; no queued input is waiting. Task completion still requires its acceptance evidence.'

/** Directive attached to an admitted handoff message. */
export const WEB_HANDOFF_RESUME_DIRECTIVE =
  'Resume this work in a fresh Web lane from the handoff summary above.'

/** Inputs supplied by the provider that owns one exact coordinating Web call. */
export interface WebCoordinationToolOptions {
  /**
   * Return true only for the exact live Agent and (when supplied) native tool
   * call that owns the coordinating Web turn.
   */
  readonly isCoordinating: (agent: Agent, callId?: string) => boolean
  /** Maximum UTF-8 byte size of the complete handoff message, wrapper included. */
  readonly maxHandoffBytes: number
}

/** The canonical `checkpoint` result returned to the Web model. */
export interface WebCheckpointResult {
  readonly action: 'checkpoint'
  readonly pendingSteering: number
  readonly pendingFollowups: number
  readonly shouldYield: boolean
  readonly instruction: string
}

/** The canonical `handoff` result returned to the Web model. */
export interface WebHandoffResult {
  readonly action: 'handoff'
  readonly messageId: string
  readonly instruction: string
}

/** The canonical output union of the `web_session` tool. */
export type WebSessionResult = WebCheckpointResult | WebHandoffResult

/** The admitted handoff message projection used to start a fresh browser lane. */
export interface WebHandoffMessage {
  readonly id: MessageId
  readonly content: readonly ContentBlock[]
}

const HANDOFF_OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', const: 'checkpoint', required: true },
        pendingSteering: { type: 'integer', required: true },
        pendingFollowups: { type: 'integer', required: true },
        shouldYield: { type: 'boolean', required: true },
        instruction: { type: 'string', required: true },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', const: 'handoff', required: true },
        messageId: { type: 'string', required: true },
        instruction: { type: 'string', required: true },
      },
    },
  ],
} as const

const WEB_COORDINATION_PROMPT =
  'Use the genuine MCP `dsh_tools` and `dsh_execute` capabilities when they are exposed in this Web lane. '
  + 'Call `web_session` with `checkpoint` before major Web work and again before ending the Web response. '
  + 'A tool result is evidence about one operation; it is not proof that the whole goal is complete. '
  + 'When queued DSH input or a continuation is pending, finish the current Web response so the DSH loop can deliver it. '
  + 'Use `handoff` only with a concise summary when work must continue in a fresh Web lane.'

function isHandoffMessage(message: UserMessage): boolean {
  return message.source.kind === 'plugin' && message.source.plugin === WEB_HANDOFF_PLUGIN
}

function hasQueuedHandoff(agent: Agent): boolean {
  return agent.inbox.nextStep.some(isHandoffMessage) || agent.inbox.nextTurn.some(isHandoffMessage)
}

function hasQueuedUserInput(agent: Agent): boolean {
  return agent.inbox.nextStep.some(message => message.source.kind === 'user')
    || agent.inbox.nextTurn.some(message => message.source.kind === 'user')
}

function requireCoordinator(
  exec: { readonly agent?: Agent; readonly callId: unknown },
  options: WebCoordinationToolOptions,
): Agent {
  const agent = exec.agent
  if (agent === undefined) {
    throw new Error('web_session requires a calling Agent')
  }
  if (!options.isCoordinating(agent, String(exec.callId))) {
    throw new Error('web_session is available only to the coordinating ChatGPT Web call')
  }
  return agent
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function handoffText(summary: string): string {
  return `${summary.trim()}\n\n${WEB_HANDOFF_RESUME_DIRECTIVE}`
}

function requireHandoffSummary(summary: string | undefined, maxBytes: number): string {
  if (summary === undefined || summary.trim().length === 0) {
    throw new Error('web_session handoff requires a non-blank summary')
  }
  const text = handoffText(summary)
  if (utf8Bytes(text) > maxBytes) {
    throw new Error(`web_session handoff summary exceeds the ${String(maxBytes)}-byte UTF-8 limit including its wrapper`)
  }
  return text
}

function checkpointResult(agent: Agent): WebCheckpointResult {
  const pendingSteering = agent.inbox.nextStep.length
  const pendingFollowups = agent.inbox.nextTurn.length
  return {
    action: 'checkpoint',
    pendingSteering,
    pendingFollowups,
    shouldYield: pendingSteering > 0 || pendingFollowups > 0,
    instruction: pendingSteering > 0 || pendingFollowups > 0
      ? WEB_SESSION_YIELD_INSTRUCTION
      : WEB_SESSION_CONTINUE_INSTRUCTION,
  }
}

/**
 * Register the scoped coordination tool and prompt guidance.
 *
 * The caller owns the returned disposer. Plugin composition should return it
 * from `ctx.effect(() => registerWebCoordinationTools(...))` so unloading the
 * provider removes both the tool and its prompt section.
 * @param ctx - context carrying the DSH tool and system-prompt services.
 * @param options - exact-call authority predicate and handoff byte limit.
 * @returns a single-use disposer for both registrations.
 */
export function registerWebCoordinationTools(
  ctx: Context,
  options: WebCoordinationToolOptions,
): () => void {
  if (!Number.isSafeInteger(options.maxHandoffBytes) || options.maxHandoffBytes < 1) {
    throw new Error('web_session maxHandoffBytes must be a positive safe integer')
  }

  const disposePrompt = ctx.systemPrompt.section({
    name: WEB_COORDINATION_PROMPT_SECTION,
    order: 116,
    text: WEB_COORDINATION_PROMPT,
  })

  const disposeTool = ctx.tools.register(defineTool({
    name: WEB_SESSION_TOOL_NAME,
    description:
      'Coordinate one authenticated ChatGPT Web response with the DSH loop. '
      + 'Use checkpoint to observe queued DSH input and handoff to queue a bounded continuation summary.',
    parameters: {
      action: {
        type: 'string',
        enum: ['checkpoint', 'handoff'],
        required: true,
        description: 'Checkpoint the current Web response or queue a continuation handoff.',
      },
      summary: {
        type: 'string',
        description: 'Required for handoff: concise work state and next steps for a fresh Web lane.',
      },
    },
    output: {
      schema: HANDOFF_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    presentCall: args => ({
      card: 'generic',
      title: `Web session ${args.action}`,
      kind: 'execute',
      rawInput: args,
    }),
    execute(args, exec): Promise<WebSessionResult> {
      const agent = requireCoordinator(exec, options)
      if (args.action === 'checkpoint') return Promise.resolve(checkpointResult(agent))

      const text = requireHandoffSummary(args.summary, options.maxHandoffBytes)
      if (hasQueuedHandoff(agent)) {
        throw new Error('web_session handoff is already queued for this Agent')
      }
      if (hasQueuedUserInput(agent)) {
        throw new Error('web_session handoff cannot queue while user input is already pending')
      }
      const message = createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: WEB_HANDOFF_PLUGIN },
      })
      agent.inject(message)
      return Promise.resolve({
        action: 'handoff',
        messageId: message.id,
        instruction: WEB_SESSION_YIELD_INSTRUCTION,
      })
    },
  }))

  const disposeFilter = ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    if (context.agent !== undefined && options.isCoordinating(context.agent)) return assembled
    return {
      ...assembled,
      sections: assembled.sections.filter(section => section.name !== WEB_COORDINATION_PROMPT_SECTION),
      tools: assembled.tools.filter(tool => tool.name !== WEB_SESSION_TOOL_NAME),
    }
  }, { prepend: true })

  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    disposeFilter()
    disposeTool()
    disposePrompt()
  }
}

/**
 * Find the latest admitted Web handoff in a Session event log.
 *
 * Injection itself only writes an inbox splice. The handoff becomes admitted
 * when the loop consumes it and appends a `user/message`; therefore this fold
 * deliberately reads only logged user-message events and never the live inbox.
 * @param events - ordered Session events.
 * @returns the latest admitted handoff identity and content, or `undefined`.
 */
export function latestWebHandoffMessage(events: readonly SessionEvent[]): WebHandoffMessage | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'user/message' || !isHandoffMessage(event.data)) continue
    return { id: event.data.id, content: event.data.content }
  }
  return undefined
}
