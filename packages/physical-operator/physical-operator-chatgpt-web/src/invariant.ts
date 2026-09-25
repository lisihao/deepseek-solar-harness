/** Durable receipt invariants for the ChatGPT web physical operator. */

/* jscpd:ignore-start -- session receipt invariants share the dispatch staging pattern */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from './web-session.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-physical-operator-chatgpt-web'

/** Cordis companion plugin name. */
export const name = 'physical-operator-chatgpt-web-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

interface ReceiptIdentity {
  readonly commandId: string
  readonly parentId: string
  readonly laneId: string
  readonly laneKey: string
}

interface IntentReceipt {
  readonly identity: ReceiptIdentity
  readonly workspaceName: string
  readonly connectorName: string
}

interface AcceptedReceipt {
  readonly identity: ReceiptIdentity
  readonly workspaceName: string
  readonly connectorName: string
  readonly conversationId: string
  readonly conversationUrl: string
  readonly userMessageId: string
}

interface ReceiptState {
  readonly identities: Map<string, ReceiptIdentity>
  readonly intents: Map<string, IntentReceipt>
  readonly accepted: Map<string, AcceptedReceipt>
  readonly completed: Set<string>
}

interface StagedState {
  readonly session: Session
  readonly state: ReceiptState
}

function emptyState(): ReceiptState {
  return {
    identities: new Map(),
    intents: new Map(),
    accepted: new Map(),
    completed: new Set(),
  }
}

function copyState(state: ReceiptState): ReceiptState {
  return {
    identities: new Map(state.identities),
    intents: new Map(state.intents),
    accepted: new Map(state.accepted),
    completed: new Set(state.completed),
  }
}

function nonEmpty(value: unknown, field: string, fail: InvariantFailure): string {
  if (typeof value !== 'string' || value.length === 0) fail(`ChatGPT Web receipt ${field} must be a non-empty string`)
  return value
}

function identityOf(
  data: { readonly commandId: unknown; readonly parentId: unknown; readonly laneId: unknown; readonly laneKey: unknown },
  fail: InvariantFailure,
): ReceiptIdentity {
  return {
    commandId: nonEmpty(data.commandId, 'commandId', fail),
    parentId: nonEmpty(data.parentId, 'parentId', fail),
    laneId: nonEmpty(data.laneId, 'laneId', fail),
    laneKey: nonEmpty(data.laneKey, 'laneKey', fail),
  }
}

function sameIdentity(left: ReceiptIdentity, right: ReceiptIdentity): boolean {
  return left.commandId === right.commandId
    && left.parentId === right.parentId
    && left.laneId === right.laneId
    && left.laneKey === right.laneKey
}

function bindIdentity(state: ReceiptState, identity: ReceiptIdentity, fail: InvariantFailure): void {
  const existing = state.identities.get(identity.commandId)
  if (existing !== undefined && !sameIdentity(existing, identity)) {
    fail(`ChatGPT Web command ${JSON.stringify(identity.commandId)} changes resident lane identity`)
  }
  state.identities.set(identity.commandId, identity)
}

function requirePriorIntent(
  state: ReceiptState,
  identity: ReceiptIdentity,
  type: string,
  fail: InvariantFailure,
): IntentReceipt {
  const intent = state.intents.get(identity.commandId)
  if (intent === undefined) {
    fail(`ChatGPT Web ${type} ${JSON.stringify(identity.commandId)} has no prior intent receipt`)
  }
  if (!sameIdentity(intent.identity, identity)) {
    fail(`ChatGPT Web ${type} ${JSON.stringify(identity.commandId)} changes resident lane identity`)
  }
  return intent
}

function validateEvent(state: ReceiptState, event: SessionEvent, fail: InvariantFailure): ReceiptState {
  const next = copyState(state)
  switch (event.type) {
    case 'chatgpt-web/intent': {
      const identity = identityOf(event.data, fail)
      bindIdentity(next, identity, fail)
      if (next.intents.has(identity.commandId)) {
        fail(`ChatGPT Web intent repeats command ${JSON.stringify(identity.commandId)}`)
      }
      const workspaceName = nonEmpty(event.data.workspaceName, 'workspaceName', fail)
      const connectorName = nonEmpty(event.data.connectorName, 'connectorName', fail)
      next.intents.set(identity.commandId, { identity, workspaceName, connectorName })
      return next
    }
    case 'chatgpt-web/accepted': {
      const identity = identityOf(event.data, fail)
      bindIdentity(next, identity, fail)
      const intent = requirePriorIntent(next, identity, 'accepted receipt', fail)
      const workspaceName = nonEmpty(event.data.workspaceName, 'workspaceName', fail)
      const connectorName = nonEmpty(event.data.connectorName, 'connectorName', fail)
      if (workspaceName !== intent.workspaceName || connectorName !== intent.connectorName) {
        fail(`ChatGPT Web accepted receipt ${JSON.stringify(identity.commandId)} diverges from its intent`)
      }
      if (next.accepted.has(identity.commandId)) {
        fail(`ChatGPT Web accepted receipt repeats command ${JSON.stringify(identity.commandId)}`)
      }
      next.accepted.set(identity.commandId, {
        identity,
        workspaceName,
        connectorName,
        conversationId: nonEmpty(event.data.conversationId, 'conversationId', fail),
        conversationUrl: nonEmpty(event.data.conversationUrl, 'conversationUrl', fail),
        userMessageId: nonEmpty(event.data.userMessageId, 'userMessageId', fail),
      })
      return next
    }
    case 'chatgpt-web/completed': {
      const identity = identityOf(event.data, fail)
      bindIdentity(next, identity, fail)
      const accepted = next.accepted.get(identity.commandId)
      if (accepted === undefined) {
        fail(`ChatGPT Web completed receipt ${JSON.stringify(identity.commandId)} has no prior accepted native turn`)
      }
      if (!sameIdentity(accepted.identity, identity)) {
        fail(`ChatGPT Web completed receipt ${JSON.stringify(identity.commandId)} changes resident lane identity`)
      }
      if (next.completed.has(identity.commandId)) {
        fail(`ChatGPT Web completed receipt repeats command ${JSON.stringify(identity.commandId)}`)
      }
      const conversationId = nonEmpty(event.data.conversationId, 'conversationId', fail)
      const conversationUrl = nonEmpty(event.data.conversationUrl, 'conversationUrl', fail)
      const userMessageId = nonEmpty(event.data.userMessageId, 'userMessageId', fail)
      if (conversationId !== accepted.conversationId
        || conversationUrl !== accepted.conversationUrl
        || userMessageId !== accepted.userMessageId) {
        fail(`ChatGPT Web completed receipt ${JSON.stringify(identity.commandId)} diverges from its accepted native turn`)
      }
      nonEmpty(event.data.assistantMessageId, 'assistantMessageId', fail)
      next.completed.add(identity.commandId)
      return next
    }
    case 'chatgpt-web/submission-pending':
    case 'chatgpt-web/rejected':
    case 'chatgpt-web/terminal': {
      const identity = identityOf(event.data, fail)
      bindIdentity(next, identity, fail)
      requirePriorIntent(next, identity, event.type, fail)
      return next
    }
    default:
      return state
  }
}

/** Install durable intent/accepted/completed receipt relationship checks. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const states = new WeakMap<Session, ReceiptState>()
  const staged = new WeakMap<SessionEvent, StagedState>()

  const seed = (session: Session): ReceiptState => {
    let state = emptyState()
    states.set(session, state)
    for (const event of session.events) state = validateEvent(state, event, fail)
    states.set(session, state)
    return state
  }
  const stateFor = (session: Session): ReceiptState => states.get(session) ?? seed(session)

  for (const session of ctx.sessions.list()) seed(session)
  ctx.on('session/created', (session) => { seed(session) }, { global: true })
  ctx.on('session/event', (session, event) => {
    const pending = staged.get(event)
    if (pending === undefined || pending.session !== session) return fail('ChatGPT Web session receipt event was not staged before publication')
    staged.delete(event)
    states.set(session, pending.state)
  }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    staged.set(event, { session, state: validateEvent(stateFor(session), event, fail) })
  }, { global: true })
}, { inject: ['sessions'] })

/** Register the package-owned invariant contribution. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
