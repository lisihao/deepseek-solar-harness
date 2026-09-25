import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import BrowserRuntime, {
  BrowserError,
  BrowserOperationId,
  BrowserPageKey,
  BrowserProviderId,
  BrowserWorkspaceId,
  type BrowserProvider,
  type BrowserRunPlanV1,
  type BrowserRunProgramV1,
  type BrowserRunProgramResultV1,
  type BrowserRunResultV1,
} from '@deepseek-ai/dsh-browser'

const plan: BrowserRunPlanV1 = {
  version: 1,
  workspace: { kind: 'current' },
  requiredCapabilities: [],
  operations: [{
    kind: 'navigate',
    id: BrowserOperationId('navigate-main'),
    page: BrowserPageKey('main'),
    url: 'https://example.com',
    waitUntil: 'load',
  }],
}

const result: BrowserRunResultV1 = {
  version: 1,
  workspace: {
    id: BrowserWorkspaceId('workspace-1'),
    lifecycle: 'active',
    control: 'agent',
  },
  operations: [{
    kind: 'page',
    id: BrowserOperationId('navigate-main'),
    operation: 'navigate',
    page: {
      page: BrowserPageKey('main'),
      url: 'https://example.com',
      title: 'Example Domain',
    },
  }],
}

const program: BrowserRunProgramV1 = {
  version: 1,
  language: 'browser-js-v1',
  workspace: { kind: 'current' },
  source: 'const title = await browser.evaluate("main", "() => document.title"); return title',
  requiredCapabilities: ['page-evaluate'],
  output: { kind: 'text', maxCharacters: 8 },
}

const programResult: BrowserRunProgramResultV1 = {
  version: 1,
  workspace: result.workspace,
  output: { kind: 'text', value: 'Example Domain', truncated: false },
}

function makeProvider(
  id: string,
  available: boolean,
  runPlan: NonNullable<BrowserProvider['runPlan']> = () => Promise.resolve(result),
): BrowserProvider {
  return {
    descriptor: {
      id: BrowserProviderId(id),
      layers: ['portable-plan-v1'],
      capabilities: ['semantic-snapshot'],
    },
    available: () => available,
    runPlan,
  }
}

function makeProgramProvider(
  id: string,
  runProgram: NonNullable<BrowserProvider['runProgram']> = () => Promise.resolve(programResult),
  capabilities: BrowserProvider['descriptor']['capabilities'] = ['page-evaluate'],
): BrowserProvider {
  return {
    descriptor: {
      id: BrowserProviderId(id),
      layers: ['browser-js-v1'],
      capabilities,
    },
    available: () => true,
    runProgram,
  }
}

async function mountBrowser(
  config: ConstructorParameters<typeof BrowserRuntime>[1] = {},
): Promise<{ ctx: Context; browser: BrowserRuntime }> {
  const ctx = new Context()
  await ctx.plugin(BrowserRuntime, config)
  return { ctx, browser: ctx.browser }
}

describe('BrowserRuntime Provider registry', () => {
  it('registers and disposes one Provider', async () => {
    const { browser } = await mountBrowser()
    const dispose = browser.registerProvider(makeProvider('primary', true))

    await expect(browser.runPlan(plan)).resolves.toBe(result)
    dispose()

    await expect(browser.runPlan(plan)).rejects.toThrow(expect.objectContaining({ code: 'BROWSER_UNAVAILABLE' }))
  })

  it('rejects duplicate Provider ids', async () => {
    const { browser } = await mountBrowser()
    browser.registerProvider(makeProvider('primary', true))

    expect(() => browser.registerProvider(makeProvider('primary', true)))
      .toThrow(expect.objectContaining({ code: 'BROWSER_DUPLICATE_PROVIDER' }))
  })

  it('disposes a registration with its contributing fiber', async () => {
    const { ctx, browser } = await mountBrowser()
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.browser.registerProvider(makeProvider('primary', true))
    }, { inject: ['browser'] }))

    await expect(browser.runPlan(plan)).resolves.toBe(result)
    await fiber.dispose()

    await expect(browser.runPlan(plan)).rejects.toThrow(expect.objectContaining({ code: 'BROWSER_UNAVAILABLE' }))
  })
})

describe('BrowserRuntime execution-time selection', () => {
  it('fails when no Provider is usable', async () => {
    const { browser } = await mountBrowser()
    browser.registerProvider(makeProvider('primary', false))

    await expect(browser.runPlan(plan)).rejects.toThrow(expect.objectContaining({ code: 'BROWSER_UNAVAILABLE' }))
  })

  it('fails when the configured Provider is missing', async () => {
    const { browser } = await mountBrowser({ provider: 'primary' })
    browser.registerProvider(makeProvider('other', true))

    await expect(browser.runPlan(plan)).rejects.toThrow(expect.objectContaining({ code: 'BROWSER_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('fails when the configured Provider is unavailable', async () => {
    const { browser } = await mountBrowser({ provider: 'primary' })
    browser.registerProvider(makeProvider('primary', false))

    await expect(browser.runPlan(plan)).rejects.toThrow(expect.objectContaining({ code: 'BROWSER_PROVIDER_CONFIGURED_UNAVAILABLE' }))
  })

  it('does not use registration order to choose between usable Providers', async () => {
    const { browser } = await mountBrowser()
    browser.registerProvider(makeProvider('primary', true))
    browser.registerProvider(makeProvider('other', true))

    await expect(browser.runPlan(plan)).rejects.toThrow(expect.objectContaining({ code: 'BROWSER_PROVIDER_AMBIGUOUS' }))
  })

  it('auto-selects the sole usable Provider', async () => {
    const { browser } = await mountBrowser()
    browser.registerProvider(makeProvider('unavailable', false))
    browser.registerProvider(makeProvider('primary', true))

    await expect(browser.runPlan(plan)).resolves.toBe(result)
    expect(browser.capabilities('portable-plan-v1')).toEqual(['semantic-snapshot'])
  })

  it('checks plan capabilities before the first operation', async () => {
    const { browser } = await mountBrowser()
    const runPlan = vi.fn<NonNullable<BrowserProvider['runPlan']>>().mockResolvedValue(result)
    browser.registerProvider(makeProvider('primary', true, runPlan))
    const screenshotPlan: BrowserRunPlanV1 = {
      ...plan,
      requiredCapabilities: ['screenshot'],
    }

    await expect(browser.runPlan(screenshotPlan)).rejects.toThrow(
      expect.objectContaining({ code: 'BROWSER_CAPABILITY_UNAVAILABLE' }),
    )
    expect(runPlan).not.toHaveBeenCalled()
  })

  it('uses the configured Provider without exposing it in the result', async () => {
    const { browser } = await mountBrowser({ provider: 'other' })
    const selectedResult = { ...result, operations: [] }
    browser.registerProvider(makeProvider('primary', true))
    browser.registerProvider(makeProvider('other', true, () => Promise.resolve(selectedResult)))

    await expect(browser.runPlan(plan)).resolves.toBe(selectedResult)
  })
})

describe('BrowserRuntime Provider boundary', () => {
  it('forwards the exact portable plan and AbortSignal', async () => {
    const { browser } = await mountBrowser()
    const run = vi.fn<NonNullable<BrowserProvider['runPlan']>>().mockResolvedValue(result)
    browser.registerProvider(makeProvider('primary', true, run))
    const controller = new AbortController()

    await expect(browser.runPlan(plan, controller.signal)).resolves.toBe(result)
    expect(run).toHaveBeenCalledExactlyOnceWith(plan, controller.signal)
  })

  it('rejects an already-aborted run without calling the Provider', async () => {
    const { browser } = await mountBrowser()
    const run = vi.fn<NonNullable<BrowserProvider['runPlan']>>().mockResolvedValue(result)
    browser.registerProvider(makeProvider('primary', true, run))
    const controller = new AbortController()
    controller.abort('cancelled')

    await expect(browser.runPlan(plan, controller.signal)).rejects.toThrow(
      expect.objectContaining({ code: 'BROWSER_ABORTED', cause: 'cancelled' }),
    )
    expect(run).not.toHaveBeenCalled()
  })

  it('preserves portable BrowserError failures from a Provider', async () => {
    const { browser } = await mountBrowser()
    const providerError = new BrowserError('page was replaced', 'BROWSER_PAGE_STALE', {
      operationId: BrowserOperationId('navigate-main'),
    })
    browser.registerProvider(makeProvider('primary', true, () => Promise.reject(providerError)))

    await expect(browser.runPlan(plan)).rejects.toBe(providerError)
    expect(providerError.operationId).toBe(BrowserOperationId('navigate-main'))
  })

  it.each([
    'BROWSER_USER_CONTROL',
    'BROWSER_WORKSPACE_INACTIVE',
  ] as const)('fails loudly without retrying or taking control for %s', async (code) => {
    const { browser } = await mountBrowser()
    const providerError = new BrowserError('execution requires caller recovery', code)
    const run = vi.fn<NonNullable<BrowserProvider['runPlan']>>().mockRejectedValue(providerError)
    browser.registerProvider(makeProvider('primary', true, run))

    await expect(browser.runPlan(plan)).rejects.toBe(providerError)
    expect(run).toHaveBeenCalledOnce()
  })

  it('normalizes arbitrary Provider failures and retains the cause', async () => {
    const { browser } = await mountBrowser()
    const cause = new Error('native transport closed')
    const run = vi.fn<NonNullable<BrowserProvider['runPlan']>>().mockRejectedValue(cause)
    browser.registerProvider(makeProvider('primary', true, run))

    await expect(browser.runPlan(plan)).rejects.toThrow(expect.objectContaining({
      code: 'BROWSER_PROVIDER_FAILED',
      cause,
    }))
    expect(run).toHaveBeenCalledOnce()
  })

  it('classifies a Provider failure after cancellation as aborted', async () => {
    const { browser } = await mountBrowser()
    const controller = new AbortController()
    browser.registerProvider(makeProvider('primary', true, () => {
      controller.abort()
      return Promise.reject(new Error('transport interrupted'))
    }))

    await expect(browser.runPlan(plan, controller.signal)).rejects.toThrow(
      expect.objectContaining({ code: 'BROWSER_ABORTED' }),
    )
  })
})

describe('BrowserRuntime programmable layer', () => {
  it('requires an explicitly declared browser-js-v1 layer', async () => {
    const { browser } = await mountBrowser()
    browser.registerProvider(makeProvider('plan-only', true))

    await expect(browser.runProgram(program)).rejects.toThrow(
      expect.objectContaining({ code: 'BROWSER_EXECUTION_LAYER_UNAVAILABLE' }),
    )
  })

  it('rejects a configured Provider that does not declare browser-js-v1', async () => {
    const { browser } = await mountBrowser({ provider: 'plan-only' })
    browser.registerProvider(makeProvider('plan-only', true))

    await expect(browser.runProgram(program)).rejects.toThrow(
      expect.objectContaining({ code: 'BROWSER_EXECUTION_LAYER_UNAVAILABLE' }),
    )
  })

  it('enforces required capabilities before running source', async () => {
    const { browser } = await mountBrowser()
    const runProgram = vi.fn<NonNullable<BrowserProvider['runProgram']>>().mockResolvedValue(programResult)
    browser.registerProvider(makeProgramProvider('program', runProgram, []))

    await expect(browser.runProgram(program)).rejects.toThrow(
      expect.objectContaining({ code: 'BROWSER_CAPABILITY_UNAVAILABLE' }),
    )
    expect(runProgram).not.toHaveBeenCalled()
  })

  it('passes one source execution unchanged and enforces its text bound', async () => {
    const { browser } = await mountBrowser()
    const runProgram = vi.fn<NonNullable<BrowserProvider['runProgram']>>().mockResolvedValue(programResult)
    browser.registerProvider(makeProvider('plan-only', true))
    browser.registerProvider(makeProgramProvider('program', runProgram))
    const controller = new AbortController()

    await expect(browser.runProgram(program, controller.signal)).resolves.toMatchObject({
      output: { kind: 'text', value: 'Example ', truncated: true },
    })
    expect(runProgram).toHaveBeenCalledExactlyOnceWith(program, controller.signal)
    expect(browser.capabilities('browser-js-v1')).toContain('page-evaluate')
  })

  it('preserves text output already within its contract', async () => {
    const { browser } = await mountBrowser()
    const bounded = { ...programResult, output: { kind: 'text' as const, value: 'Example', truncated: false } }
    browser.registerProvider(makeProgramProvider('program', () => Promise.resolve(bounded)))

    await expect(browser.runProgram(program)).resolves.toBe(bounded)
  })

  it('bounds text without splitting a grapheme cluster', async () => {
    const { browser } = await mountBrowser()
    const unicodeProgram: BrowserRunProgramV1 = {
      ...program,
      output: { kind: 'text', maxCharacters: 1 },
    }
    const unicodeResult: BrowserRunProgramResultV1 = {
      ...programResult,
      output: { kind: 'text', value: '👨‍👩‍👧‍👦x', truncated: false },
    }
    browser.registerProvider(makeProgramProvider('program', () => Promise.resolve(unicodeResult)))

    await expect(browser.runProgram(unicodeProgram)).resolves.toMatchObject({
      output: { kind: 'text', value: '👨‍👩‍👧‍👦', truncated: true },
    })
  })

  it('accepts bounded JSON output and rejects oversized JSON output', async () => {
    const jsonProgram: BrowserRunProgramV1 = {
      ...program,
      requiredCapabilities: [],
      output: { kind: 'json', maxBytes: 16 },
    }
    const bounded: BrowserRunProgramResultV1 = {
      ...programResult,
      output: { kind: 'json', value: { ok: true } },
    }
    const a = await mountBrowser()
    a.browser.registerProvider(makeProgramProvider('program', () => Promise.resolve(bounded)))
    await expect(a.browser.runProgram(jsonProgram)).resolves.toBe(bounded)

    const oversized: BrowserRunProgramResultV1 = {
      ...programResult,
      output: { kind: 'json', value: { text: 'larger than the declared bound' } },
    }
    const b = await mountBrowser()
    b.browser.registerProvider(makeProgramProvider('program', () => Promise.resolve(oversized)))
    await expect(b.browser.runProgram(jsonProgram)).rejects.toThrow(
      expect.objectContaining({ code: 'BROWSER_OUTPUT_LIMIT' }),
    )
  })

  it('accepts no output and rejects a result that violates the output kind', async () => {
    const noneProgram: BrowserRunProgramV1 = {
      ...program,
      requiredCapabilities: [],
      output: { kind: 'none' },
    }
    const none: BrowserRunProgramResultV1 = { ...programResult, output: { kind: 'none' } }
    const a = await mountBrowser()
    a.browser.registerProvider(makeProgramProvider('program', () => Promise.resolve(none)))
    await expect(a.browser.runProgram(noneProgram)).resolves.toBe(none)

    const b = await mountBrowser()
    b.browser.registerProvider(makeProgramProvider('program'))
    await expect(b.browser.runProgram(noneProgram)).rejects.toThrow(
      expect.objectContaining({ code: 'BROWSER_PROTOCOL' }),
    )
  })

  it('fails loudly when a declared layer has no implementation', async () => {
    const planBrowser = await mountBrowser()
    planBrowser.browser.registerProvider({
      descriptor: {
        id: BrowserProviderId('broken-plan'),
        layers: ['portable-plan-v1'],
        capabilities: [],
      },
      available: () => true,
    })
    await expect(planBrowser.browser.runPlan(plan)).rejects.toThrow(
      expect.objectContaining({ code: 'BROWSER_PROTOCOL' }),
    )

    const programBrowser = await mountBrowser()
    programBrowser.browser.registerProvider({
      descriptor: {
        id: BrowserProviderId('broken-program'),
        layers: ['browser-js-v1'],
        capabilities: ['page-evaluate'],
      },
      available: () => true,
    })
    await expect(programBrowser.browser.runProgram(program)).rejects.toThrow(
      expect.objectContaining({ code: 'BROWSER_PROTOCOL' }),
    )
  })
})

describe('BrowserError', () => {
  it('carries a closed portable code', () => {
    const error = new BrowserError('timed out', 'BROWSER_TIMEOUT')
    expect(error.name).toBe('BrowserError')
    expect(error.code).toBe('BROWSER_TIMEOUT')
    expect(error.operationId).toBeUndefined()
  })
})
