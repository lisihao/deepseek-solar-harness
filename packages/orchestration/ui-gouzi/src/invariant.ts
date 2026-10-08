/** Package-owned relations between kennel input, selection, submission, and receipts. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { KennelDispatchCandidate } from './dispatcher.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-ui-gouzi'

/** Cordis companion plugin name. */
export const name = 'ui-gouzi-invariant'
/** Service required to register the package contribution. */
export const inject = ['invariants']

/** Resolve the selection from the same session's committed request and decision. */
function selectedCandidate(session: Session, messageId: string, seq: number, fail: InvariantFailure): KennelDispatchCandidate {
  const request = session.events.findLast(event => event.seq < seq
    && event.type === 'kennel/dispatch-request' && event.data.messageId === messageId)
  if (request?.type !== 'kennel/dispatch-request') fail(`dispatch for ${messageId} has no prior request`)
  const decision = session.events.findLast(event => event.seq < seq
    && event.type === 'kennel/dispatch-decision' && event.data.messageId === messageId)
  if (decision?.type !== 'kennel/dispatch-decision' || decision.seq <= request.seq) {
    fail(`dispatch for ${messageId} has no decision after its request`)
  }
  const candidate = request.data.candidates.find(candidate => candidate.id === decision.data.candidateId)
  if (candidate === undefined) fail(`dispatch for ${messageId} has no selected request candidate`)
  return candidate
}

/** Validate relations before append commits; ordinary event observers cannot veto a committed record. */
const install: InvariantInstaller = (ctx, fail) => {
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    switch (event.type) {
      case 'kennel/dispatch-request': {
        const user = session.events.findLast(previous => previous.seq < event.seq
          && previous.type === 'user/message' && String(previous.data.id) === event.data.messageId)
        if (user?.type !== 'user/message' || user.data.source.kind !== 'user') {
          fail(`dispatch request for ${event.data.messageId} has no prior user message`)
        }
        break
      }
      case 'kennel/dispatch-submission': {
        if (selectedCandidate(session, event.data.messageId, event.seq, fail).kind !== 'work') {
          fail(`dispatch submission for ${event.data.messageId} does not select work`)
        }
        break
      }
      case 'kennel/dispatch-admitted': {
        if (!session.events.some(previous => previous.seq < event.seq
          && previous.type === 'kennel/dispatch-submission' && previous.data.messageId === event.data.messageId)) {
          fail(`dispatch admission for ${event.data.messageId} has no prior submission`)
        }
        break
      }
      case 'kennel/dispatch-control': {
        const selected = selectedCandidate(session, event.data.messageId, event.seq, fail)
        if (selected.kind !== 'control' || selected.id !== event.data.candidate.id
          || selected.runId !== String(event.data.result.runId)) {
          fail(`dispatch control for ${event.data.messageId} does not match its selected task`)
        }
        break
      }
      default:
        // Other merge-extensible session event relations belong to their owners.
        break
    }
  }, { global: true })
}

/**
 * Register the kennel dispatch invariant companion.
 * @param ctx - context carrying the invariant service.
 * @returns the contribution's disposer after installation succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
