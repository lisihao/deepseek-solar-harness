/** Deterministic resident Service Provider for the public Loader composition. */

import type { Context } from '@deepseek-ai/cordis'
import ResidentOperatorService, {
  ResidentOperatorSessionId,
  ResidentOperatorTurnId,
  type ResidentEventPage,
  type ResidentEventReadRequest,
  type ResidentExecuteRequest,
  type ResidentIndeterminateResolutionRequest,
  type ResidentInterruptRequest,
  type ResidentProviderStatus,
  type ResidentResetRequest,
  type ResidentSessionSnapshot,
  type ResidentTurn,
} from '@deepseek-ai/dsh-resident-operator'

const sessionId = ResidentOperatorSessionId('resident:loader-session')

class FixtureResidentOperatorService extends ResidentOperatorService {
  private revision = 0

  providers(): Promise<ResidentProviderStatus[]> {
    return Promise.resolve([{
      operatorId: 'scripted-resident',
      product: 'codex',
      available: true,
      authentication: 'native-subscription',
      productVersion: 'fixture',
      protocolHash: 'fixture',
    }])
  }

  execute(request: ResidentExecuteRequest): Promise<ResidentTurn> {
    this.revision += 1
    const turn = this.revision
    const text = request.prompt
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    return Promise.resolve({
      sessionId,
      turnId: ResidentOperatorTurnId(`resident:loader-turn-${turn}`),
      stateRevision: turn,
      result: Promise.resolve({
        output: [{ type: 'text', text: `resident turn ${turn}: ${text}` }],
        stopReason: 'completed',
      }),
      dispose: () => Promise.resolve(),
    })
  }

  list(): Promise<ResidentSessionSnapshot[]> { return Promise.resolve([]) }
  inspect(_sessionId: string): Promise<ResidentSessionSnapshot> { return Promise.reject(new Error('not used')) }
  readEvents(_request: ResidentEventReadRequest): Promise<ResidentEventPage> { return Promise.resolve({ events: [], nextSequence: 0 }) }
  interrupt(_request: ResidentInterruptRequest): Promise<void> { return Promise.resolve() }
  reset(_request: ResidentResetRequest): Promise<ResidentSessionSnapshot> { return Promise.reject(new Error('not used')) }
  resolveIndeterminate(_request: ResidentIndeterminateResolutionRequest): Promise<void> { return Promise.resolve() }
}

export const name = 'resident-loader-fixture'

/** Mount the deterministic provider behind the real Resident Service Definition. */
export function apply(ctx: Context): void {
  new FixtureResidentOperatorService(ctx)
}
