import { Script } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import BrowserRuntime, {
  BrowserError,
  BrowserProviderId,
  BrowserWorkspaceId,
  type BrowserCapabilityV1,
  type BrowserJsonValue,
  type BrowserProvider,
  type BrowserRunProgramResultV1,
  type BrowserRunProgramV1,
} from '@deepseek-ai/dsh-browser'
import PhysicalOperatorRuntime from '@deepseek-ai/dsh-physical-operator'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as adapter from '../src/index.ts'

const CAPABILITIES: readonly BrowserCapabilityV1[] = [
  'authenticated-profile-reuse',
  'named-workspace',
  'page-evaluate',
]

function fakeParent(): Agent {
  return { id: SessionId('chatgpt-web-parent') } as unknown as Agent
}

function resultFor(value: BrowserJsonValue): BrowserRunProgramResultV1 {
  return {
    version: 1,
    workspace: {
      id: BrowserWorkspaceId('chatgpt-web-fixture'),
      name: 'fixture-chatgpt-web',
      lifecycle: 'active',
      control: 'agent',
    },
    output: { kind: 'json', value },
  }
}

class StubBrowserProvider implements BrowserProvider {
  readonly descriptor: BrowserProvider['descriptor']
  readonly programs: BrowserRunProgramV1[] = []
  readonly signals: (AbortSignal | undefined)[] = []

  constructor(
    private readonly execute: (
      program: BrowserRunProgramV1,
      signal?: AbortSignal,
    ) => Promise<BrowserRunProgramResultV1> = async () => resultFor({
      status: 'completed', response: 'fixture response', truncated: false,
    }),
    capabilities: readonly BrowserCapabilityV1[] = CAPABILITIES,
  ) {
    this.descriptor = {
      id: BrowserProviderId('fixture-browser'),
      layers: ['browser-js-v1'],
      capabilities,
    }
  }

  available(): boolean {
    return true
  }

  async runProgram(program: BrowserRunProgramV1, signal?: AbortSignal): Promise<BrowserRunProgramResultV1> {
    this.programs.push(program)
    this.signals.push(signal)
    return this.execute(program, signal)
  }
}

async function setup(provider = new StubBrowserProvider()) {
  const ctx = new Context()
  await ctx.plugin(BrowserRuntime)
  await ctx.plugin(PhysicalOperatorRuntime)
  ctx.browser.registerProvider(provider)
  const plugin = await ctx.plugin(adapter, {
    workspaceName: 'fixture-chatgpt-web',
    generationTimeoutMs: 1_000,
    pollIntervalMs: 10,
    outputMaxBytes: 2_048,
  })
  return { ctx, plugin, provider }
}

function request(signal = new AbortController().signal) {
  return {
    label: 'fixture ChatGPT task',
    prompt: [{ type: 'text' as const, text: 'private task body' }],
    systemPrompt: 'system instructions',
    parent: fakeParent(),
    signal,
  }
}

function serializedProgramRequest(program: BrowserRunProgramV1): Record<string, unknown> {
  const match = /^const request = (.*);$/m.exec(program.source)
  if (match?.[1] === undefined) throw new Error('fixture did not find serialized browser program request')
  return JSON.parse(match[1]) as Record<string, unknown>
}

describe('ChatGPT Web physical operator', () => {
  it('registers an ephemeral, single-flight browser operator and submits the merged text prompt', async () => {
    const { ctx, plugin, provider } = await setup()
    expect(ctx.physicalOperators.status('chatgpt-web')).toMatchObject({
      id: 'chatgpt-web',
      displayName: 'ChatGPT Web',
      maxConcurrency: 1,
      executionModes: ['ephemeral'],
      state: 'available',
    })

    const run = await ctx.physicalOperators.start('chatgpt-web', request())
    await expect(run.result).resolves.toEqual({
      output: [{ type: 'text', text: 'fixture response' }],
      stopReason: 'completed',
    })
    expect(provider.programs).toHaveLength(1)
    const program = provider.programs[0]!
    expect(program.workspace).toEqual({
      kind: 'named', name: 'fixture-chatgpt-web', createIfMissing: true,
    })
    expect(program.requiredCapabilities).toEqual(CAPABILITIES)
    expect(serializedProgramRequest(program)).toMatchObject({
      prompt: 'system instructions\n\n---\n\nprivate task body',
      workspaceName: 'fixture-chatgpt-web',
      url: 'https://chatgpt.com/',
    })
    expect(program.source).not.toMatch(/fetch\s*\(|api\.openai\.com|puppeteer|localhost:9222/i)

    const progress = await run.readEvents?.(0, 20)
    expect(progress?.events.map(event => event.type)).toEqual([
      'chatgpt-web.connecting',
      'chatgpt-web.submitting',
      'chatgpt-web.waiting',
      'chatgpt-web.completed',
    ])
    expect(JSON.stringify(progress)).not.toContain('private task body')
    expect(JSON.stringify(progress)).not.toContain('fixture response')

    await plugin.dispose()
    expect(ctx.physicalOperators.list()).toEqual([])
    await ctx.fiber.dispose()
  })

  it('builds a browser program in the required order: open, inspect, submit, then wait for a fresh response', () => {
    const program = adapter.buildChatGptWebProgram({
      url: 'https://chatgpt.com/',
      workspaceName: 'fixture-chatgpt-web',
      prompt: 'question',
      model: 'GPT-5',
      generationTimeoutMs: 1_000,
      pollIntervalMs: 1,
      outputMaxBytes: 2_048,
    })
    const open = program.source.indexOf("id: 'chatgpt-open'")
    const inspect = program.source.indexOf('const inspect =')
    const select = program.source.indexOf('const selection =')
    const fill = program.source.indexOf("id: 'chatgpt-fill'")
    const send = program.source.indexOf("id: 'chatgpt-send'")
    const responsePoll = program.source.indexOf('const initialCount =')
    expect(open).toBeGreaterThan(-1)
    expect(inspect).toBeGreaterThan(open)
    expect(select).toBeGreaterThan(inspect)
    expect(fill).toBeGreaterThan(select)
    expect(send).toBeGreaterThan(fill)
    expect(responsePoll).toBeGreaterThan(send)
    expect(program.source).toContain("return { status: 'auth-required' }")
    expect(program.source).toContain("return { status: 'model-selection-unavailable' }")
    expect(program.source).toContain("return { status: 'generation-timeout' }")
    expect(program.source).not.toContain("kind: 'close-page'")
  })

  it('emits browser evaluator functions as executable JavaScript rather than TypeScript source', () => {
    const program = adapter.buildChatGptWebProgram({
      url: 'https://chatgpt.com/',
      workspaceName: 'fixture-chatgpt-web',
      prompt: 'question',
      model: 'GPT-5',
      generationTimeoutMs: 1_000,
      pollIntervalMs: 1,
      outputMaxBytes: 2_048,
    })
    const encodedEvaluators = [
      ...program.source.matchAll(/browser\.evaluate\(page, ("(?:\\.|[^"\\])*")/g),
    ].map(match => match[1])
    expect(encodedEvaluators).toHaveLength(4)
    for (const encoded of encodedEvaluators) {
      const evaluator = JSON.parse(encoded!) as string
      expect(() => new Script(`(${evaluator})`)).not.toThrow()
    }
  })

  it('fails loud instead of silently falling back when an explicit model cannot be verified', async () => {
    const provider = new StubBrowserProvider(async () => resultFor({ status: 'model-selection-unavailable' }))
    const { ctx, plugin } = await setup(provider)
    const run = await ctx.physicalOperators.start('chatgpt-web', {
      ...request(),
      residentProfile: { model: 'GPT-5' },
    })
    await expect(run.result).rejects.toMatchObject({ code: 'MODEL_SELECTION_UNAVAILABLE' })
    expect(provider.programs).toHaveLength(1)
    expect(serializedProgramRequest(provider.programs[0]!)).toMatchObject({ model: 'GPT-5' })

    await plugin.dispose()
    await ctx.fiber.dispose()
  })

  it('does not request a model control unless the caller explicitly selects one', async () => {
    const { ctx, plugin, provider } = await setup()
    const run = await ctx.physicalOperators.start('chatgpt-web', request())
    await run.result
    expect(serializedProgramRequest(provider.programs[0]!)).not.toHaveProperty('model')

    await plugin.dispose()
    await ctx.fiber.dispose()
  })

  it('returns an aborted terminal result and never closes the browser when its caller aborts', async () => {
    const provider = new StubBrowserProvider(async (_program, signal) => {
      return new Promise<BrowserRunProgramResultV1>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(new BrowserError('fixture browser was cancelled', 'BROWSER_ABORTED'))
        }, { once: true })
      })
    })
    const { ctx, plugin } = await setup(provider)
    const controller = new AbortController()
    const run = await ctx.physicalOperators.start('chatgpt-web', request(controller.signal))
    controller.abort(new Error('caller cancelled'))

    await expect(run.result).resolves.toEqual({ output: [], stopReason: 'aborted' })
    expect(provider.signals[0]?.aborted).toBe(true)
    const events = await run.readEvents?.(0, 20)
    expect(events?.events.at(-1)).toMatchObject({ type: 'chatgpt-web.aborted', data: { phase: 'aborted' } })

    await run.dispose()
    await plugin.dispose()
    await ctx.fiber.dispose()
  })

  it('admits only one active ChatGPT turn at a time', async () => {
    const deferred = Promise.withResolvers<BrowserRunProgramResultV1>()
    const provider = new StubBrowserProvider(async () => deferred.promise)
    const { ctx, plugin } = await setup(provider)
    const first = await ctx.physicalOperators.start('chatgpt-web', request())
    expect(ctx.physicalOperators.status('chatgpt-web')).toMatchObject({ state: 'busy', active: 1 })
    await expect(ctx.physicalOperators.start('chatgpt-web', request())).rejects.toMatchObject({ code: 'OPERATOR_BUSY' })

    deferred.resolve(resultFor({ status: 'completed', response: 'done', truncated: false }))
    await expect(first.result).resolves.toMatchObject({ stopReason: 'completed' })
    expect(ctx.physicalOperators.status('chatgpt-web')).toMatchObject({ state: 'available', active: 0 })

    await plugin.dispose()
    await ctx.fiber.dispose()
  })

  it('rejects an unavailable browser seam and invalid direct settings before it registers an operator', async () => {
    const unavailable = new StubBrowserProvider(undefined, ['page-evaluate'])
    const { ctx, plugin } = await setup(unavailable)
    const status = ctx.physicalOperators.status('chatgpt-web')
    expect(status.state).toBe('unavailable')
    expect(status.unavailableReason).toContain('authenticated-profile-reuse')
    await expect(ctx.physicalOperators.start('chatgpt-web', request())).rejects.toMatchObject({ code: 'OPERATOR_UNAVAILABLE' })
    await plugin.dispose()

    expect(() => { adapter.apply(ctx, { url: 'http://chatgpt.com/' }) }).toThrow('https://chatgpt.com/')
    expect(() => { adapter.apply(ctx, { url: 'https://chatgpt.com/other' }) }).toThrow('exactly')
    expect(ctx.physicalOperators.list()).toEqual([])
    await ctx.fiber.dispose()
  })

  it('rejects non-text input, unsupported resident mode, and unverified effort control before browser dispatch', async () => {
    const { ctx, plugin, provider } = await setup()
    await expect(ctx.physicalOperators.start('chatgpt-web', {
      ...request(),
      prompt: [{ type: 'image', image_url: 'data:image/png;base64,AA==' }],
    } as never)).rejects.toMatchObject({ code: 'INVALID_RESULT' })
    await expect(ctx.physicalOperators.start('chatgpt-web', {
      ...request(), mode: 'resident',
    })).rejects.toMatchObject({ code: 'OPERATOR_MODE_UNSUPPORTED' })
    await expect(ctx.physicalOperators.start('chatgpt-web', {
      ...request(), residentProfile: { effort: 'high' },
    })).rejects.toMatchObject({ code: 'OPERATOR_OPTION_UNSUPPORTED' })
    expect(provider.programs).toEqual([])

    await plugin.dispose()
    await ctx.fiber.dispose()
  })
})
