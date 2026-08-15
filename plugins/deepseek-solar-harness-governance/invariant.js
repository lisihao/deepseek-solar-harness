import { applyGovernanceEvent, emptyGovernanceState, isGovernanceEvent } from './lib/state.js'

const PACKAGE_NAME = '@lisihao/dsh-code-harness-governance'

export const name = 'code-harness-governance-invariant'
export const inject = ['invariants']

function checked(state, event, fail) {
  try {
    return applyGovernanceEvent(state, event)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
    return state
  }
}

const install = Object.assign((ctx, fail) => {
  const states = new WeakMap()
  const staged = new WeakMap()

  const seed = (session) => {
    let state = emptyGovernanceState()
    for (const event of session.events) state = checked(state, event, fail)
    states.set(session, state)
    return state
  }
  const stateFor = session => states.get(session) ?? seed(session)

  for (const session of ctx.sessions.list()) seed(session)
  ctx.on('session/created', session => { seed(session) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args
    if (!isGovernanceEvent(event)) return
    staged.set(event, { session, state: checked(stateFor(session), event, fail) })
  }, { global: true })
  ctx.on('session/event', (session, event) => {
    if (!isGovernanceEvent(event)) return
    const candidate = staged.get(event)
    if (candidate === undefined || candidate.session !== session) {
      fail('governance event published without pre-commit invariant validation')
      return
    }
    staged.delete(event)
    states.set(session, candidate.state)
  }, { global: true })
}, { inject: ['sessions'] })

export const apply = ctx => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
