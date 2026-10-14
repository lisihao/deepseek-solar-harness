// One closed turn answered through a native Resident route, for browser checks of how a native reply is attributed.
// The reply is logged under the operator name with no model; the model and effort live on the turn's dispatch, as the
// native route writes them.
import type { PhysicalOperatorExecutionPreference } from '@deepseek-ai/dsh-physical-operator'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
// Carries the physical-operator/dispatch and session/title event declarations into this builder.
import type {} from '@deepseek-ai/dsh-tool-physical-operator'
import type {} from '@deepseek-ai/dsh-session-title'

/** The provider name the native route logs its replies under. */
const NATIVE_ROUTE_PROVIDER = 'dsh-physical-operator'

/** Facts of one native turn. */
export interface NativeReplyFixtureOptions {
  /** Operator that served the turn, which is also the logged reply's model. */
  readonly operatorId: string
  /** Native model and effort the dispatch carried. */
  readonly profile: PhysicalOperatorExecutionPreference
  /** Searchable title projected into the sidebar. */
  readonly title: string
  /** Marker painted in the user message, for search. */
  readonly userMarker: string
  /** Text of the native reply. */
  readonly reply: string
}

/**
 * Build the JSONL of one closed native turn.
 * @param options - Operator, native profile, and visible text.
 * @returns Seed fixture text with `{{sessionId}}` and `{{cwd}}` placeholders.
 */
export function createNativeReplyFixture(options: NativeReplyFixtureOptions): string {
  const session = Session.create(SessionId('native-reply-template'))
  session.append('turn/start', { turn: 1 })
  const user = createUserMessage({ content: [{ type: 'text', text: options.userMarker }], source: { kind: 'user' } })
  const userEvent = session.append('user/message', user, { surfaceOp: 'append' })
  session.append('session/title', { title: options.title, messageSeqs: [userEvent.seq], source: { kind: 'fallback' } })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('request/header', {
    header: { config: { provider: NATIVE_ROUTE_PROVIDER, model: options.operatorId }, system: 'Native reply fixture.' },
    reason: 'initial',
  })
  session.append('physical-operator/dispatch', {
    commandId: 'resident-native-reply-fixture',
    operatorId: options.operatorId,
    promptMessageId: String(user.id),
    requestedByMessageId: String(user.id),
    turn: 1,
    step: 1,
    recovered: false,
    executionMode: 'resident',
    residentProfile: options.profile,
  }, { ignorable: true })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text: options.reply }],
      source: { provider: NATIVE_ROUTE_PROVIDER, model: options.operatorId },
    }),
    usage: { inputTokens: 100, outputTokens: 20 },
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return [
    JSON.stringify({
      type: 'session',
      version: SESSION_FORMAT_VERSION,
      id: '{{sessionId}}',
      createdAt: Date.now() - 60_000,
      cwd: '{{cwd}}',
      delegationDepth: 0,
    }),
    ...session.events.map(event => JSON.stringify(event)),
    '',
  ].join('\n')
}
