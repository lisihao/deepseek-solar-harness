/** Only external model and Resident transport boundaries are synthetic in this Loader composition. */
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { DeepSeekModelWorker } from '@deepseek-ai/dsh-model-worker-deepseek'
import type { ModelExecutionOffer } from '@deepseek-ai/dsh-model-allocation'
import { OrchestrationDaemon } from '@deepseek-ai/dsh-orchestration-local'
import type { ResidentDaemonClient } from '@deepseek-ai/dsh-resident-operator-local'
import { InnerAdapter, OuterAdapter, state } from './loader-transports.ts'

class KeylessDeepSeekWorker extends DeepSeekModelWorker {
  override offers(): Promise<ModelExecutionOffer[]> {
    return Promise.resolve([{
      offerId: 'keyless:deepseek-v4-flash', operatorId: 'deepseek-api', provider: 'deepseek-official',
      model: 'deepseek-v4-flash', displayName: 'Keyless DeepSeek fixture', source: 'metered-api', tier: 'low',
      available: true, maxConcurrency: 4, activeCount: 0, tags: ['offline-fixture'],
    }])
  }
}

class FakeResidentTransport {
  private readonly turns = new Map<string, {
    turnId: string
    sessionId: string
    commandId: string
    state: 'settled'
    result: { output: { type: 'text'; text: string }[]; stopReason: 'completed' }
  }>()

  async providers() {
    return state.driver === 'api' ? [] : [{
      operatorId: 'codex', product: 'codex', displayName: 'Fake Codex', description: 'Keyless native transport fixture',
      tags: ['analysis'], maxConcurrency: 1, injectionBoundaries: ['pre-dispatch', 'next-turn'],
      available: true, authentication: 'native-subscription', productVersion: 'fixture', protocolHash: 'fixture',
      models: [{ model: 'fixture-codex-model', displayName: 'Fake model', efforts: ['high'], defaultEffort: 'high' }],
    }]
  }

  async execute(request: Parameters<ResidentDaemonClient['execute']>[0]) {
    if (state.driver !== 'codex') throw new Error('unexpected Resident dispatch in API fixture')
    if (request.profile?.model !== 'fixture-codex-model' || request.profile.effort !== 'high') throw new Error('explicit Resident profile lost')
    state.residentMaterialized = { prompt: structuredClone(request.prompt),
      ...request.systemPrompt === undefined ? {} : { systemPrompt: request.systemPrompt } }
    const text = request.prompt.map((block) => {
      if (block === null || typeof block !== 'object' || !('type' in block) || block.type !== 'text'
        || !('text' in block) || typeof block.text !== 'string') throw new Error('expected text in fake Resident prompt')
      return block.text
    }).join('\n')
    if (!text.includes('first original part') || !text.includes('second original part')) throw new Error('Resident lost original task')
    state.residentRequests++
    const result = {
      output: [{ type: 'text' as const, text: 'RLM_FULL_ANSWER first original part; second original part; result=2' }],
      stopReason: 'completed' as const,
    }
    const turn = { turnId: 'turn:' + request.commandId, sessionId: 'fixture-codex-session', commandId: request.commandId, state: 'settled' as const, result }
    this.turns.set(turn.turnId, turn)
    return { turnId: turn.turnId, sessionId: turn.sessionId, stateRevision: 1, result: Promise.resolve(result), dispose: async () => {} }
  }

  async inspectTurn(turnId: string) {
    const turn = this.turns.get(turnId)
    if (turn === undefined) throw new Error('unknown fake Resident turn')
    return { ...turn, stateRevision: 1, updatedAt: '2026-10-17T00:00:00.000Z' }
  }

  async readEvents(_sessionId: string, afterSequence = 0) { return { events: [], nextSequence: afterSequence } }
  async list() { return [] }
  async interrupt() {}
}

export const name = 'standalone-keyless-transports'
export const inject = ['llm']

/** Start only a temporary owned daemon and expose synthetic external transports. */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const home = process.env.DSH_HOME
  if (home === undefined) throw new Error('keyless Loader fixture requires its own temporary DSH_HOME')
  ctx.effect(() => ctx.llm.registerAdapter(['standalone-fixture'], new OuterAdapter()))
  ctx.effect(() => ctx.llm.registerAdapter(['deepseek-official'], new InnerAdapter()))
  const daemon = new OrchestrationDaemon({
    root: join(home, 'orchestrations'), dshHome: home, schedulerIntervalMs: 5,
    standaloneRlmOperatorIds: ['standalone'],
    // This deliberately substitutes only the external native transport. An unexpected call fails loud.
    residentClient: new FakeResidentTransport() as unknown as ResidentDaemonClient,
    modelWorkerProviders: state.driver === 'api' ? [new KeylessDeepSeekWorker(ctx)] : [],
  })
  state.daemon = daemon
  try {
    await daemon.start()
  } catch (error) {
    await daemon.close()
    throw error
  }
  return () => daemon.close()
}
