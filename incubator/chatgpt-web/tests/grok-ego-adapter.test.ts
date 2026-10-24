import { describe, expect, it, vi } from 'vitest'

import {
  GrokEgoAdapter,
  GrokEgoAdapterError,
  GROK_EGO_FRAME_MARKER,
  isGrokUrl,
  type GrokEgoProcessRunner,
} from '../src/grok-ego-adapter.js'
import { EgoProcessError, type EgoProcessRequest, type EgoProcessResult } from '../src/process-contract.js'
import type { GrokPageObservation, GrokResource } from '../src/grok-contract.js'

const options = {
  executable: '/usr/local/bin/ego-browser',
  cwd: '/tmp/dsh-grok-web',
  commandTimeoutMs: 1_000,
  stdoutMaxBytes: 32 * 1024,
} as const

const resource: GrokResource = {
  provider: 'grok',
  spaceId: 17,
  pageLabel: 'p1',
  conversationUrl: 'https://grok.com/',
}

function observation(overrides: Partial<GrokPageObservation> = {}): GrokPageObservation {
  return {
    url: resource.conversationUrl,
    authenticated: true,
    loginRequired: false,
    challenge: false,
    busy: false,
    composerCount: 1,
    composerText: 'Fixture prompt',
    submitCount: 1,
    submitEnabled: true,
    modelLabel: 'Expert',
    messages: [],
    errors: [],
    ...overrides,
  }
}

function success(value: unknown, stderr = ''): EgoProcessResult {
  return {
    stdout: `${GROK_EGO_FRAME_MARKER}${JSON.stringify({ ok: true, value })}\n`,
    stderr,
    exitCode: 0,
    executionStopped: true,
  }
}

function failure(code: string, message: string): EgoProcessResult {
  return {
    stdout: `${GROK_EGO_FRAME_MARKER}${JSON.stringify({ ok: false, error: { code, message } })}\n`,
    stderr: '',
    exitCode: 0,
    executionStopped: true,
  }
}

function queueRunner(...results: Array<EgoProcessResult | Error>): { readonly run: GrokEgoProcessRunner; readonly calls: ReturnType<typeof vi.fn> } {
  const calls = vi.fn(async (): Promise<EgoProcessResult> => {
    const next = results.shift()
    if (next === undefined) throw new Error('unexpected fake Ego call')
    if (next instanceof Error) throw next
    return next
  })
  return { run: calls as unknown as GrokEgoProcessRunner, calls }
}

function sourceAt(calls: ReturnType<typeof vi.fn>, index: number): string {
  const request = calls.mock.calls[index]?.[0] as EgoProcessRequest | undefined
  expect(request).toBeDefined()
  return request!.source
}

describe('GrokEgoAdapter', () => {
  it('accepts the host maximum output budget plus frame overhead', () => {
    expect(() => GrokEgoAdapter.create({ ...options, stdoutMaxBytes: 8 * 1024 * 1024 + 512 * 1024 })).not.toThrow()
    expect(() => GrokEgoAdapter.create({ ...options, stdoutMaxBytes: 8 * 1024 * 1024 + 512 * 1024 + 1 })).toThrow()
  })

  it('uses one named TaskSpace and only the original page through the bounded public Ego seam', async () => {
    const completed = observation({
      url: 'https://grok.com/c/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa?rid=22222222-2222-4222-8222-222222222222',
      composerText: '',
      submitEnabled: false,
      messages: [{
        id: 'response-22222222-2222-4222-8222-222222222222',
        role: 'assistant',
        text: 'Visible fixture answer',
        hasCopyControl: true,
        hasArtifacts: false,
      }],
    })
    const fixture = queueRunner(
      success({ resource }),
      success(observation()),
      success({ submitted: true }),
      success(completed),
      success({ finished: true }),
    )
    const adapter = GrokEgoAdapter.create(options, fixture.run)

    const allocated = await adapter.allocate({ id: 'fixture-run', sessionId: 'fixture-session' })
    await adapter.prepare(allocated, { prompt: 'Fixture prompt', modelLabel: 'Expert' })
    await adapter.submit(allocated)
    await expect(adapter.observe(allocated)).resolves.toEqual(completed)
    await adapter.finish(allocated)

    expect(fixture.calls).toHaveBeenCalledTimes(5)
    const allocateSource = sourceAt(fixture.calls, 0)
    const prepareSource = sourceAt(fixture.calls, 1)
    const submitSource = sourceAt(fixture.calls, 2)
    const observeSource = sourceAt(fixture.calls, 3)
    const finishSource = sourceAt(fixture.calls, 4)

    expect(allocateSource).toContain('taskSpace(__input.taskName)')
    expect(allocateSource).toContain('GROK_TASKSPACE_NOT_FRESH')
    expect(allocateSource).not.toContain('.newPage(')
    expect(prepareSource).toContain('await __page.fill(__composer, __input.request.prompt)')
    expect(prepareSource).not.toContain('submit Grok prompt')
    expect(prepareSource).toContain('aria-checked')
    expect(prepareSource).toContain('data-state')
    expect(prepareSource).toContain('需要 SuperGrok Heavy')
    expect(submitSource.match(/__page\.click\(/g)).toHaveLength(1)
    expect(submitSource).toContain('submit Grok prompt')
    expect(observeSource).not.toContain('.fill(')
    expect(observeSource).not.toContain('.click(')
    expect(observeSource).not.toContain('.goto(')
    expect(observeSource).not.toContain('.newPage(')
    expect(observeSource).not.toContain('.finish(')
    expect(finishSource).toContain('await __task.finish({ keep: [] })')
  })

  it('rejects genuine whitespace edits rather than relaxing exact draft comparison', async () => {
    for (const changed of ['Fixture prompt ', 'Fixture\nprompt', 'Fixture  prompt']) {
      const fixture = queueRunner(success({ resource }), success(observation({ composerText: changed })))
      const adapter = GrokEgoAdapter.create(options, fixture.run)
      const allocated = await adapter.allocate({ id: 'literal-draft', sessionId: 'fixture-session' })
      await expect(adapter.prepare(allocated, { prompt: 'Fixture prompt', modelLabel: 'Expert' }))
        .rejects.toMatchObject({ code: 'GROK_PROMPT_READBACK_MISMATCH' })
      expect(fixture.calls).toHaveBeenCalledTimes(2)
    }
  })

  it('records the submit attempt before the process call and never retries an uncertain send', async () => {
    const timeout = new EgoProcessError('EGO_TIMEOUT', 'untrusted stderr', false, true, 'secret')
    const fixture = queueRunner(success({ resource }), success(observation()), timeout)
    const adapter = GrokEgoAdapter.create(options, fixture.run)
    const allocated = await adapter.allocate({ id: 'one-send', sessionId: 'fixture-session' })
    await adapter.prepare(allocated, { prompt: 'Fixture prompt', modelLabel: 'Expert' })

    const thrown = await adapter.submit(allocated).catch((error: unknown) => error)
    expect(thrown).toMatchObject({ code: 'GROK_EGO_TIMEOUT', message: 'Ego browser command failed', mayHaveLateEffects: true })
    expect((thrown as Error).message).not.toContain('secret')
    await expect(adapter.submit(allocated)).rejects.toMatchObject({ code: 'GROK_SUBMISSION_ALREADY_ATTEMPTED' })
    expect(fixture.calls).toHaveBeenCalledTimes(3)
  })

  it('fails closed on model drift, login, challenge, malformed frames, and unexpected transport output', async () => {
    const modelDrift = queueRunner(success({ resource }), success(observation({ modelLabel: 'Fast' })))
    const driftAdapter = GrokEgoAdapter.create(options, modelDrift.run)
    const driftResource = await driftAdapter.allocate({ id: 'model-drift', sessionId: 'fixture-session' })
    await expect(driftAdapter.prepare(driftResource, { prompt: 'Fixture prompt', modelLabel: 'Expert' }))
      .rejects.toMatchObject({ code: 'GROK_MODEL_MISMATCH' })

    const login = queueRunner(success({ resource }), success(observation({ authenticated: false, loginRequired: true })))
    const loginAdapter = GrokEgoAdapter.create(options, login.run)
    const loginResource = await loginAdapter.allocate({ id: 'login', sessionId: 'fixture-session' })
    await expect(loginAdapter.prepare(loginResource, { prompt: 'Fixture prompt' })).rejects.toMatchObject({ code: 'GROK_LOGIN_REQUIRED' })

    const challenge = queueRunner(success({ resource }), success(observation({ challenge: true })))
    const challengeAdapter = GrokEgoAdapter.create(options, challenge.run)
    const challengeResource = await challengeAdapter.allocate({ id: 'challenge', sessionId: 'fixture-session' })
    await expect(challengeAdapter.prepare(challengeResource, { prompt: 'Fixture prompt' })).rejects.toMatchObject({ code: 'GROK_CHALLENGE_REQUIRED' })

    const malformed = queueRunner({ stdout: 'not a frame\n', stderr: '', exitCode: 0, executionStopped: true })
    await expect(GrokEgoAdapter.create(options, malformed.run).allocate({ id: 'bad-frame', sessionId: 'fixture-session' }))
      .rejects.toMatchObject({ code: 'GROK_EGO_FRAME' })

    const noisy = queueRunner(success({ resource }, 'unexpected transport output\n'))
    await expect(GrokEgoAdapter.create(options, noisy.run).allocate({ id: 'noisy', sessionId: 'fixture-session' }))
      .rejects.toMatchObject({ code: 'GROK_EGO_FRAME' })
  })

  it('keeps Heavy conditional on the observed per-option subscription restriction and validates API boundaries', async () => {
    const fixture = queueRunner(success({ resource }), success(observation({ modelLabel: 'Heavy' })))
    const adapter = GrokEgoAdapter.create(options, fixture.run)
    const allocated = await adapter.allocate({ id: 'heavy', sessionId: 'fixture-session' })
    await expect(adapter.prepare(allocated, { prompt: 'Fixture prompt', modelLabel: 'Heavy' })).resolves.toMatchObject({ modelLabel: 'Heavy' })

    await expect(adapter.prepare(allocated, { prompt: 'Fixture prompt', modelLabel: 'Unknown' as never }))
      .rejects.toMatchObject({ code: 'GROK_MODEL_UNSUPPORTED' })
    await expect(adapter.observe({ ...resource, conversationUrl: 'https://grok.com.evil/c/fixture' })).rejects.toMatchObject({ code: 'GROK_RESOURCE_INVALID' })
    expect(isGrokUrl('https://grok.com/')).toBe(true)
    expect(isGrokUrl('https://grok.com/c/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa?rid=22222222-2222-4222-8222-222222222222')).toBe(true)
    expect(isGrokUrl('https://grok.com/c/not-a-uuid')).toBe(false)
    expect(isGrokUrl('https://grok.com/c/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa?rid=not-a-uuid')).toBe(false)
  })

  it('does not conflate a caller finish with automatic completion and rejects duplicate finishes', async () => {
    const fixture = queueRunner(success({ finished: true }))
    const adapter = GrokEgoAdapter.create(options, fixture.run)

    await adapter.finish(resource)
    await expect(adapter.finish(resource)).rejects.toBeInstanceOf(GrokEgoAdapterError)
    expect(fixture.calls).toHaveBeenCalledTimes(1)
  })

  it('surfaces an explicit script refusal without leaking untrusted process output', async () => {
    const fixture = queueRunner(failure('GROK_MODEL_SELECTION_UNAVAILABLE', 'Requested exact Grok model is subscription-restricted'))
    const adapter = GrokEgoAdapter.create(options, fixture.run)

    await expect(adapter.allocate({ id: 'script-error', sessionId: 'fixture-session' }))
      .rejects.toMatchObject({ code: 'GROK_MODEL_SELECTION_UNAVAILABLE', message: 'Requested exact Grok model is subscription-restricted' })
  })
})
