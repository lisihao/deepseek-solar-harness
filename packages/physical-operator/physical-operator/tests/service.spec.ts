import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import PhysicalOperatorRuntime, {
  PhysicalOperatorError,
  PhysicalOperatorId,
  type PhysicalOperator,
  type PhysicalOperatorAvailability,
  type PhysicalOperatorProviderRun,
  type PhysicalOperatorProviderStartRequest,
  type PhysicalOperatorResult,
  type PhysicalOperatorStartRequest,
} from '@deepseek-ai/dsh-physical-operator'

function fakeParent(): Agent {
  return { id: SessionId('parent') } as unknown as Agent
}

function request(signal = new AbortController().signal): PhysicalOperatorStartRequest {
  return {
    label: 'test run',
    prompt: [{ type: 'text', text: 'solve it' }],
    parent: fakeParent(),
    signal,
  }
}

class StubOperator implements PhysicalOperator {
  readonly descriptor
  starts = 0
  lastRequest: PhysicalOperatorProviderStartRequest | undefined
  disposed = 0

  constructor(
    id: string,
    readonly result: Promise<PhysicalOperatorResult>,
    private readonly live: PhysicalOperatorAvailability = { available: true },
    maxConcurrency = 1,
  ) {
    this.descriptor = {
      id: PhysicalOperatorId(id),
      displayName: 'Test Operator',
      description: 'Executes deterministic test work.',
      tags: ['test'],
      maxConcurrency,
    }
  }

  availability(): PhysicalOperatorAvailability {
    return this.live
  }

  async start(value: PhysicalOperatorProviderStartRequest): Promise<PhysicalOperatorProviderRun> {
    this.starts += 1
    this.lastRequest = value
    return {
      result: this.result,
      dispose: async () => { this.disposed += 1 },
    }
  }
}

async function runtime() {
  const ctx = new Context()
  await ctx.plugin(PhysicalOperatorRuntime)
  return { ctx, runtime: ctx.physicalOperators }
}

describe('PhysicalOperatorRuntime', () => {
  it('registers, discovers, starts, observes, and removes one operator', async () => {
    const { ctx, runtime: service } = await runtime()
    const operator = new StubOperator('physics.solve', Promise.resolve({
      output: [{ type: 'text', text: '42' }],
      stopReason: 'completed',
    }))
    const lifecycle: string[] = []
    ctx.on('physical-operator/start', () => { lifecycle.push('start') })
    ctx.on('physical-operator/end', () => { lifecycle.push('end') })

    const dispose = service.registerOperator(operator)
    expect(service.list()).toEqual([{
      ...operator.descriptor,
      executionModes: ['ephemeral'],
      state: 'available',
      active: 0,
    }])

    const run = await service.start('physics.solve', request())
    expect(run.operatorId).toBe('physics.solve')
    await expect(run.result).resolves.toEqual({
      output: [{ type: 'text', text: '42' }],
      stopReason: 'completed',
    })
    await run.dispose()
    expect(operator.starts).toBe(1)
    expect(operator.lastRequest).toMatchObject({
      executionId: run.id,
      mode: 'ephemeral',
    })
    expect(operator.disposed).toBe(1)
    expect(lifecycle).toEqual(['start', 'end'])
    expect(service.status('physics.solve').active).toBe(0)

    await dispose()
    expect(service.list()).toEqual([])
  })

  it('reserves capacity before async work and releases it only after settlement', async () => {
    const { runtime: service } = await runtime()
    const deferred = Promise.withResolvers<PhysicalOperatorResult>()
    const operator = new StubOperator('single-flight', deferred.promise)
    service.registerOperator(operator)

    const first = await service.start('single-flight', request())
    expect(service.status('single-flight')).toMatchObject({ state: 'busy', active: 1, maxConcurrency: 1 })
    await expect(service.start('single-flight', request())).rejects.toMatchObject({ code: 'OPERATOR_BUSY' })
    expect(operator.starts).toBe(1)

    deferred.resolve({ output: [], stopReason: 'completed' })
    await first.result
    expect(service.status('single-flight')).toMatchObject({ state: 'available', active: 0 })
  })

  it('keeps capacity across HMR removal and re-registration while an accepted run survives', async () => {
    const { runtime: service } = await runtime()
    const deferred = Promise.withResolvers<PhysicalOperatorResult>()
    const oldOperator = new StubOperator('hmr-safe', deferred.promise)
    const remove = service.registerOperator(oldOperator)
    const oldRun = await service.start('hmr-safe', request())

    await remove()
    const replacement = new StubOperator('hmr-safe', Promise.resolve({ output: [], stopReason: 'completed' }))
    service.registerOperator(replacement)
    expect(service.status('hmr-safe')).toMatchObject({ state: 'busy', active: 1 })
    await expect(service.start('hmr-safe', request())).rejects.toMatchObject({ code: 'OPERATOR_BUSY' })

    deferred.resolve({ output: [], stopReason: 'completed' })
    await oldRun.result
    expect(service.status('hmr-safe')).toMatchObject({ state: 'available', active: 0 })
    expect(replacement.starts).toBe(0)
  })

  it('reports provider availability and rejects before provider startup', async () => {
    const { runtime: service } = await runtime()
    const operator = new StubOperator(
      'offline',
      Promise.resolve({ output: [], stopReason: 'completed' }),
      { available: false, reason: 'backend missing' },
    )
    service.registerOperator(operator)
    expect(service.status('offline')).toMatchObject({
      state: 'unavailable',
      active: 0,
      unavailableReason: 'backend missing',
    })
    await expect(service.start('offline', request())).rejects.toMatchObject({ code: 'OPERATOR_UNAVAILABLE' })
    expect(operator.starts).toBe(0)
  })

  it('rejects unknown, duplicate, invalid, and pre-aborted requests with typed errors', async () => {
    const { runtime: service } = await runtime()
    await expect(service.start('missing', request())).rejects.toMatchObject({ code: 'NO_OPERATOR' })

    const operator = new StubOperator('valid-id', Promise.resolve({ output: [], stopReason: 'completed' }))
    service.registerOperator(operator)
    expect(() => service.registerOperator(operator)).toThrow(expect.objectContaining({ code: 'DUPLICATE_OPERATOR' }))

    const invalid = new StubOperator('Invalid ID', Promise.resolve({ output: [], stopReason: 'completed' }))
    expect(() => service.registerOperator(invalid)).toThrow(expect.objectContaining({ code: 'INVALID_OPERATOR' }))

    const controller = new AbortController()
    controller.abort()
    await expect(service.start('valid-id', request(controller.signal))).rejects.toMatchObject({ code: 'OPERATOR_ABORTED' })
    expect(operator.starts).toBe(0)
  })

  it('releases capacity after provider startup or result rejection and closes lifecycle as error', async () => {
    const { ctx, runtime: service } = await runtime()
    const startup: PhysicalOperator = {
      descriptor: {
        id: PhysicalOperatorId('startup-failure'),
        displayName: 'Startup Failure',
        description: 'Fails before publication.',
        tags: [],
        maxConcurrency: 1,
      },
      availability: () => ({ available: true }),
      start: async () => { throw new Error('cannot start') },
    }
    service.registerOperator(startup)
    await expect(service.start('startup-failure', request())).rejects.toThrow('cannot start')
    expect(service.status('startup-failure')).toMatchObject({ state: 'available', active: 0 })

    const resultFailure = new StubOperator('result-failure', Promise.reject(new Error('wire broke')))
    service.registerOperator(resultFailure)
    const ended = vi.fn()
    ctx.on('physical-operator/end', ended)
    const run = await service.start('result-failure', request())
    await expect(run.result).rejects.toThrow('wire broke')
    expect(ended).toHaveBeenCalledWith(expect.objectContaining({
      operatorId: 'result-failure',
      stopReason: 'error',
    }))
    expect(service.status('result-failure')).toMatchObject({ state: 'available', active: 0 })
  })

  it('uses the harness error base for stable machine-readable failures', () => {
    expect(new PhysicalOperatorError('busy', 'OPERATOR_BUSY')).toMatchObject({
      name: 'PhysicalOperatorError',
      code: 'OPERATOR_BUSY',
    })
  })

  it('normalizes legacy operators to ephemeral and rejects unsupported resident mode before startup', async () => {
    const { runtime: service } = await runtime()
    const operator = new StubOperator('legacy', Promise.resolve({ output: [], stopReason: 'completed' }))
    service.registerOperator(operator)
    expect(service.status('legacy').executionModes).toEqual(['ephemeral'])
    await expect(service.start('legacy', { ...request(), mode: 'resident' })).rejects.toMatchObject({
      code: 'OPERATOR_MODE_UNSUPPORTED',
    })
    expect(operator.starts).toBe(0)
  })
})
