import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import type { ProcessRunner } from '../src/process.ts'
import { createRunner } from '../src/runner.ts'

afterEach(() => vi.unstubAllEnvs())

describe('Mnemon config and resolution', () => {
  it('materializes conservative defaults', () => {
    expect(resolveConfig({})).toMatchObject({
      storageScope: 'global',
      timeoutMs: 10_000,
      defaultRecallLimit: 10,
      recallQuality: {
        policy: 'strict-v1',
        lowScoreThreshold: 0.25,
        highScoreThreshold: 0.6,
        candidateMultiplier: 3,
        maxMediumResults: 4,
        maxUnknownResults: 2,
      },
      routingGuidance: true,
      displayMode: 'sidebar',
      lifecycleEnabled: true,
      recallMode: 'guided',
      writebackMode: 'guided',
      idleReviewMs: 30_000,
      tabEnabled: true,
      writeEnabled: true,
      remoteAccess: 'read-only',
      conversationInteraction: { turnBar: true, saveAction: true },
      persistenceStrategy: {
        mode: 'manual',
        providerId: 'mnemon-native',
        prompt: '',
        rules: {
          allowedProviderIds: ['mnemon-native'],
          dataBoundary: 'allow-remote',
          requiredCapabilities: [],
          preference: 'balanced',
        },
        providerConnections: {},
      },
      taskAgentModel: { mode: 'inherit' },
    })
  })

  it('validates configurable recall quality policy thresholds and expansion', () => {
    expect(resolveConfig({
      recallQuality: { policy: 'team-v2', lowScoreThreshold: 0.2, highScoreThreshold: 0.7, candidateMultiplier: 2, maxMediumResults: 5, maxUnknownResults: 1 },
    }).recallQuality).toEqual({ policy: 'team-v2', lowScoreThreshold: 0.2, highScoreThreshold: 0.7, candidateMultiplier: 2, maxMediumResults: 5, maxUnknownResults: 1 })
    expect(() => resolveConfig({ recallQuality: { lowScoreThreshold: 0.7, highScoreThreshold: 0.6 } })).toThrow('less than')
    expect(() => resolveConfig({ recallQuality: { candidateMultiplier: 1.5 } })).toThrow('integer')
    expect(() => resolveConfig({ recallQuality: { policy: '../unsafe' } })).toThrow('policy id')
    expect(() => resolveConfig({ recallQuality: { maxMediumResults: 51 } })).toThrow('max medium')
    expect(() => resolveConfig({ recallQuality: { maxUnknownResults: -1 } })).toThrow('max unknown')
  })

  it('inherits the DSH new-session model by default and validates fixed task routes', () => {
    expect(resolveConfig({}).taskAgentModel).toEqual({ mode: 'inherit' })
    expect(resolveConfig({
      taskAgentModel: { mode: 'fixed', provider: ' deepseek ', model: ' deepseek-chat ' },
    }).taskAgentModel).toEqual({ mode: 'fixed', provider: 'deepseek', model: 'deepseek-chat' })
    expect(() => resolveConfig({ taskAgentModel: { mode: 'fixed', provider: 'deepseek' } }))
      .toThrow('provider and model')
  })

  it('resolves a bounded automatic persistence strategy without changing its provider connections', () => {
    expect(resolveConfig({
      persistenceStrategy: {
        mode: 'automatic',
        prompt: 'Prefer shared project memory.',
        rules: {
          allowedProviderIds: ['mnemon-native', 'openviking', 'openviking'],
          dataBoundary: 'allow-remote',
          requiredCapabilities: ['graph'],
          preference: 'shared-first',
        },
        providerConnections: { openviking: { targetUri: 'viking://resources/team' } },
      },
    }).persistenceStrategy).toEqual({
      mode: 'automatic',
      providerId: 'mnemon-native',
      prompt: 'Prefer shared project memory.',
      rules: {
        allowedProviderIds: ['mnemon-native', 'openviking'],
        dataBoundary: 'allow-remote',
        requiredCapabilities: ['graph'],
        preference: 'shared-first',
      },
      providerConnections: { openviking: { targetUri: 'viking://resources/team' } },
    })
  })

  it('migrates the settings schema empty candidate list to the conservative manual default', () => {
    expect(resolveConfig({ persistenceStrategy: { mode: 'manual', rules: { allowedProviderIds: [] } } }).persistenceStrategy.rules.allowedProviderIds)
      .toEqual(['mnemon-native'])
    expect(() => resolveConfig({ persistenceStrategy: { mode: 'automatic', rules: { allowedProviderIds: [] } } }))
      .toThrow('at least one allowed provider')
  })

  it('requires an explicit trusted-host grant for remote management', () => {
    expect(resolveConfig({ remoteAccess: 'trusted-host' }).remoteAccess).toBe('trusted-host')
  })

  it('keeps explicit conversation-surface opt-outs', () => {
    expect(resolveConfig({ conversationInteraction: { turnBar: false, saveAction: false } }).conversationInteraction)
      .toMatchObject({ turnBar: false, saveAction: false })
  })

  it('supports sidebar and buildin display modes with sidebar as the default', () => {
    expect(resolveConfig({}).displayMode).toBe('sidebar')
    expect(resolveConfig({ displayMode: 'buildin' }).displayMode).toBe('buildin')
  })

  it('resolves the one storage-scope setting and preserves legacy dataDir as custom', () => {
    expect(resolveConfig({ storageScope: 'workspace' })).toMatchObject({ storageScope: 'workspace' })
    expect(resolveConfig({ dataDir: '/memory/custom' })).toMatchObject({
      storageScope: 'custom', dataDir: '/memory/custom',
    })
    expect(() => resolveConfig({ storageScope: 'custom' })).toThrow('custom dataDir')
    expect(() => resolveConfig({ storageScope: 'custom', dataDir: 'relative/memory' })).toThrow('absolute')
  })

  it('migrates the selected root from the former named-Pack settings', () => {
    expect(resolveConfig({
      storageScope: 'custom',
      customPackId: 'research',
      customPacks: [
        { id: 'project', name: 'Project', dataDir: '/memory/project' },
        { id: 'research', name: 'Research', dataDir: '~/memory/research' },
      ],
    })).toMatchObject({
      storageScope: 'custom',
      dataDir: '~/memory/research',
    })
  })

  it('rejects duplicate, missing, and unsafe custom Pack definitions', () => {
    expect(() => resolveConfig({ customPacks: [{ id: 'same', name: 'One', dataDir: '/one' }, { id: 'same', name: 'Two', dataDir: '/two' }] })).toThrow('duplicate')
    expect(() => resolveConfig({ storageScope: 'custom', customPackId: 'missing', customPacks: [{ id: 'other', name: 'Other', dataDir: '/other' }] })).toThrow('unknown custom Pack')
    expect(() => resolveConfig({ customPacks: [{ id: '../bad', name: 'Bad', dataDir: '/bad' }] })).toThrow('id')
  })

  it('rejects unsafe store names', () => {
    expect(() => resolveConfig({ store: '../other' })).toThrow('store')
  })

  it('preserves Mnemon environment and active-store semantics when config is omitted', () => {
    vi.stubEnv('MNEMON_DATA_DIR', '/memory-root')
    vi.stubEnv('MNEMON_STORE', 'shared')
    const process: ProcessRunner = async () => ({ stdout: '{}', stderr: '', exitCode: 0 })
    const runner = createRunner(resolveConfig({ cliPath: '/fake/mnemon' }), process)
    expect(runner.effectiveDataDir()).toBe('/memory-root')
    expect(runner.effectiveStore()).toBe('shared')
  })

  it('serializes CLI processes so concurrent WebUI reads cannot race Mnemon migrations', async () => {
    let active = 0
    let maximumActive = 0
    const process = vi.fn<ProcessRunner>(async () => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await Promise.resolve()
      active -= 1
      return { stdout: '{}', stderr: '', exitCode: 0 }
    })
    const runner = createRunner(resolveConfig({ cliPath: '/fake/mnemon' }), process)

    await Promise.all([
      runner.runText(['status']),
      runner.runText(['viz', '--format', 'html', '--output', '-']),
      runner.runText(['--version'], { globalFlags: false }),
    ])

    expect(process).toHaveBeenCalledTimes(3)
    expect(maximumActive).toBe(1)
  })

  it('continues the CLI queue after one command fails', async () => {
    const process = vi.fn<ProcessRunner>()
      .mockResolvedValueOnce({ stdout: '', stderr: 'locked', exitCode: 1 })
      .mockResolvedValueOnce({ stdout: 'recovered', stderr: '', exitCode: 0 })
    const runner = createRunner(resolveConfig({ cliPath: '/fake/mnemon' }), process)

    await expect(runner.runText(['status'])).rejects.toThrow('locked')
    await expect(runner.runText(['--version'], { globalFlags: false })).resolves.toBe('recovered')
  })

  it('keeps a related CLI batch contiguous in the shared process queue', async () => {
    const events: string[] = []
    const process = vi.fn<ProcessRunner>(async (_command, args) => {
      events.push(String(args.at(-1)))
      await Promise.resolve()
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const runner = createRunner(resolveConfig({ cliPath: '/fake/mnemon' }), process)

    const batch = runner.runTextBatch([{ args: ['first'] }, { args: ['second'] }])
    const queued = runner.runText(['third'])
    await Promise.all([batch, queued])

    expect(events).toEqual(['first', 'second', 'third'])
  })

  it('points launch failures at the environment variable and actual settings namespace', async () => {
    const process = vi.fn<ProcessRunner>().mockRejectedValue(new Error('spawn mnemon ENOENT'))
    const runner = createRunner(resolveConfig({ cliPath: '/missing/mnemon' }), process)

    await expect(runner.runText(['status'])).rejects.toThrow('MNEMON_CLI_PATH or mnemon.cliPath')
  })

  it('holds the CLI queue across one exclusive Pack operation', async () => {
    const events: string[] = []
    const process = vi.fn<ProcessRunner>(async (_command, args) => {
      events.push(`cli:${args.at(-1)}:start`)
      await Promise.resolve()
      events.push(`cli:${args.at(-1)}:end`)
      return { stdout: '{}', stderr: '', exitCode: 0 }
    })
    const runner = createRunner(resolveConfig({ cliPath: '/fake/mnemon' }), process)

    const first = runner.runText(['first'])
    const exclusive = runner.withExclusive(async () => {
      events.push('pack:start')
      await Promise.resolve()
      events.push('pack:end')
    })
    const second = runner.runText(['second'])
    await Promise.all([first, exclusive, second])

    expect(events).toEqual(['cli:first:start', 'cli:first:end', 'pack:start', 'pack:end', 'cli:second:start', 'cli:second:end'])
  })
})
