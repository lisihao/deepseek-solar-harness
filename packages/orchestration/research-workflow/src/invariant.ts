/** Package-owned checks for research events' original-run and action associations. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import './events.ts'

/** Companion plugin name. */
export const name = 'research-workflow-invariant'
/** Required registry. */
export const inject = ['invariants']

const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    if (event.type === 'research/workflow') {
      const { runId, sessionId, definition } = event.data
      if (session.id !== sessionId || definition.runId !== runId || definition.input.sessionId !== sessionId) {
        fail('research workflow definition conflicts with its original Session or run')
      }
    }
    if (event.type === 'research/workflow-update') {
      const { runId, sessionId, ownerId, state } = event.data, definition = state.definition
      const expectedInput = state.stages.filter(s => s.kind !== 'gemini-research-start')
        .every(s => s.deliveryVerified && !s.blockers.includes('original-input-unlinked'))
      const expectedReady = state.stages.every(s => s.blockers.length === 0)
      const expectedState = state.finalStatus.state === 'needs-input' ? 'needs-input'
        : expectedReady && state.finalStatus.state === 'verified-and-synthesized' ? 'verified-and-synthesized' : 'partial'
      if (session.id !== sessionId || state.ownerId !== ownerId || state.run.runId !== runId
        || definition.runId !== runId || definition.input.sessionId !== sessionId || state.finalStatus.basis.runId !== runId
        || state.stages.length !== definition.input.stages.length || state.stages.some((s, i) => {
        const original = definition.input.stages[i], request = s.action?.request
        return original?.kind !== s.kind || request !== undefined && (request.runId !== runId
          || request.actionId !== original.actionId || request.stepId !== original.stepId
          || request.preparedPromptId !== original.preparedPromptId)
      }) || state.outputs.some(o => o.artifact.runId !== runId || !state.stages.some(s =>
        s.action?.request.actionId === o.artifact.actionId && s.action.inputSha256 === o.artifact.requestSha256))
        || state.previews.some(p => p.input.workflowId !== definition.input.workflowId || p.input.request.runId !== runId)
        || state.fullInputVerified !== expectedInput || state.readyForVerification !== expectedReady || state.state !== expectedState) {
        fail('research workflow projection conflicts with its original owner, Session, stages or computed state')
      }
    }
    if (event.type === 'research/input' && event.data.runId !== event.data.request.runId) {
      fail('research input belongs to another run')
    }
    if (event.type !== 'research/action') return
    const { runId, snapshot, qualification, observations, deliveries } = event.data
    const actionId = snapshot.request.actionId
    if (snapshot.request.runId !== runId
      || qualification !== null && (qualification.runId !== runId || qualification.actionId !== actionId
        || qualification.requestSha256 !== snapshot.inputSha256)
      || observations.some(x => x.runId !== runId || x.actionId !== actionId)
      || deliveries.some(x => x.runId !== runId || x.actionId !== actionId || x.requestSha256 !== snapshot.inputSha256)) {
      fail('research action projection conflicts with its original run or action')
    }
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * @param ctx - Context with the invariant registry.
 * @returns Owned companion registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-research-workflow', install))
