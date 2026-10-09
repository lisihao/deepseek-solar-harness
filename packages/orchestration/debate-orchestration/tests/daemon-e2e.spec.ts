import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import {
  DEFAULT_DEBATE_CONVERGENCE,
  DEFAULT_DEBATE_PERSONAS,
  DEFAULT_DEBATE_ROUNDS,
  defaultDebateBudget,
  type DebatePolicyV1,
} from '@deepseek-ai/dsh-debate'
import { LocalDebateProvider } from '@deepseek-ai/dsh-debate-local'
import { GouziAuthorityEpoch, GouziHostId, GouziId, GouziOwnerId } from '@deepseek-ai/dsh-orchestration'
import {
  OrchestrationDaemon,
  OrchestrationDaemonClient,
  OrchestrationStore,
} from '@deepseek-ai/dsh-orchestration-local'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DebateTaskGraphRoundExecutor } from '../src/index.ts'

interface ScriptedResidentRequest {
  readonly commandId: string
  readonly operatorId: string
  readonly profile?: { readonly model: string }
  readonly prompt?: readonly { readonly type: string; readonly text?: string }[]
  readonly nativeToolPolicy?: 'inherit' | 'disabled'
}

type ScriptedResult = {
  readonly output: readonly { readonly type: 'text'; readonly text: string }[]
  readonly stopReason: 'completed'
  readonly usage: {
    readonly inputTokens: number
    readonly outputTokens: number
    readonly cacheReadInputTokens: number
    readonly costUsd: number
  }
}

function turnBody(slotId: string): string {
  return JSON.stringify({
    confidence: 0.9,
    outputPreview: `settled ${slotId}`,
    claims: [{
      version: 1,
      claimId: 'claim:decision',
      statement: 'The reversible option is preferred.',
      status: 'supported',
      severity: 'medium',
      confidence: 0.9,
      supportingSlotIds: [slotId],
      opposingSlotIds: [],
      evidenceRefs: [{ version: 1, ref: `fixture:${slotId}`, kind: 'artifact' }],
    }],
    dissent: [],
    unresolved: [],
    evidenceRefs: [{ version: 1, ref: `fixture:${slotId}`, kind: 'artifact' }],
  })
}

/** Keyless deterministic Resident fixture exercising the real daemon and Scheduler. */
class ScriptedKeylessResident {
  readonly requests: ScriptedResidentRequest[] = []
  peakParticipants = 0
  judgeStartedAfterParticipants = false
  judgeReceivedParticipantEvidence = false
  private activeParticipants = 0
  private readonly participantSettledByRound = new Map<number, number>()
  private readonly turns = new Map<string, ScriptedResult>()

  async providers() {
    return [{
      operatorId: 'codex',
      product: 'codex',
      displayName: 'Codex fixture',
      description: 'Offline native-subscription fixture.',
      tags: ['coding'],
      maxConcurrency: 4,
      injectionBoundaries: ['pre-dispatch', 'next-turn'] as const,
      available: true,
      authentication: 'native-subscription',
      productVersion: 'fixture',
      protocolHash: 'fixture',
      models: [
        { model: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna', efforts: ['medium'], defaultEffort: 'medium' },
        { model: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', efforts: ['high'], defaultEffort: 'high' },
      ],
    }, {
      operatorId: 'claude-code',
      product: 'claude-code',
      displayName: 'Claude Code fixture',
      description: 'Offline native-subscription fixture.',
      tags: ['analysis'],
      maxConcurrency: 4,
      injectionBoundaries: ['pre-dispatch', 'next-turn'] as const,
      available: true,
      authentication: 'native-subscription',
      productVersion: 'fixture',
      protocolHash: 'fixture',
      models: [{ model: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6', efforts: [] }],
      quotaPools: [{
        poolId: 'claude-fixture',
        displayName: 'Claude fixture quota',
        models: ['claude-sonnet-4-6'],
        meter: 'native-subscription' as const,
        primary: { usedPercent: 10 },
        observedAt: '2026-08-29T00:00:00.000Z',
      }],
    }]
  }

  async execute(request: ScriptedResidentRequest) {
    this.requests.push(request)
    const identity = /:debate-r(\d+)-([^:]+):1$/u.exec(request.commandId)
    const roundText = identity?.[1]
    const slotId = identity?.[2]
    if (roundText === undefined || slotId === undefined) throw new Error(`fixture could not identify Debate slot from ${request.commandId}`)
    const round = Number(roundText)
    const turnId = `turn:${request.commandId}`
    const sessionId = `session:${request.operatorId}`
    const resultValue: ScriptedResult = {
      output: [{ type: 'text', text: turnBody(slotId) }],
      stopReason: 'completed',
      usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 2, costUsd: 0.01 },
    }
    const participant = slotId !== 'decision-judge'
    let result: Promise<ScriptedResult>
    if (participant) {
      this.activeParticipants += 1
      this.peakParticipants = Math.max(this.peakParticipants, this.activeParticipants)
      result = new Promise(resolve => setTimeout(() => {
        this.activeParticipants -= 1
        this.participantSettledByRound.set(round, (this.participantSettledByRound.get(round) ?? 0) + 1)
        this.turns.set(turnId, resultValue)
        resolve(resultValue)
      }, 40))
    } else {
      const prompt = request.prompt?.map(block => block.text ?? '').join('\n') ?? ''
      this.judgeStartedAfterParticipants = this.participantSettledByRound.get(round) === 2
      this.judgeReceivedParticipantEvidence = prompt.includes('Upstream Evidence contents:')
        && prompt.includes('settled constructive-proposer')
        && prompt.includes('settled skeptical-falsifier')
      this.turns.set(turnId, resultValue)
      result = Promise.resolve(resultValue)
    }
    return { turnId, sessionId, stateRevision: 1, result, dispose: async () => {} }
  }

  async inspectTurn(turnId: string) {
    const result = this.turns.get(turnId)
    return result === undefined
      ? { turnId, sessionId: 'session:fixture', commandId: 'fixture', state: 'running', stateRevision: 1, updatedAt: new Date().toISOString() }
      : { turnId, sessionId: 'session:fixture', commandId: 'fixture', state: 'settled', stateRevision: 2, updatedAt: new Date().toISOString(), result }
  }

  async readEvents(_sessionId: string, afterSequence = 0) {
    return { events: [], nextSequence: afterSequence }
  }

  async interrupt() {}
}

function policy(): DebatePolicyV1 {
  const persona = (title: string, mandate: string, stance: string) => ({
    title,
    mandate,
    stance,
    instructions: ['Return calibrated claims with Evidence references.'],
  })
  return {
    version: 1,
    mode: 'auto',
    roster: [{
      version: 1,
      role: 'constructive-proposer',
      kind: 'participant',
      operatorId: 'codex',
      model: 'gpt-5.6-luna',
      tier: 'low',
      source: 'native-subscription',
      persona: persona('Proposer', 'Build the strongest reversible proposal.', 'constructive'),
    }, {
      version: 1,
      role: 'skeptical-falsifier',
      kind: 'participant',
      operatorId: 'claude-code',
      model: 'claude-sonnet-4-6',
      tier: 'medium',
      source: 'native-subscription',
      persona: persona('Falsifier', 'Find the strongest counterexample.', 'skeptical'),
    }, {
      version: 1,
      role: 'decision-judge',
      kind: 'judge',
      operatorId: 'codex',
      model: 'gpt-5.6-sol',
      tier: 'high',
      source: 'native-subscription',
      persona: persona('Judge', 'Synthesize only after participant Evidence.', 'evidence-first'),
    }],
    budget: {
      version: 1,
      maxRounds: 1,
      maxTurnsPerAgent: 1,
      maxAgentsPerRound: 3,
      maxInputTokens: 80_000,
      maxOutputTokens: 40_000,
      maxTotalTokens: 120_000,
      maxCostUsd: 1,
    },
    rounds: {
      version: 1,
      firstRound: 'blind-independent',
      followUp: 'claim-ledger',
      escalation: 'high-severity-unresolved',
    },
    convergence: {
      version: 1,
      scoreThreshold: 0.8,
      minSettledAgents: 2,
      maxUnresolvedHighSeverity: 0,
      requireEvidenceForCritical: true,
      earlyStop: true,
    },
    preserveDissent: true,
  }
}

describe('Debate real TaskGraph binding', () => {
  const cleanup: Array<() => Promise<void>> = []
  afterEach(async () => {
    vi.unstubAllGlobals()
    for (const action of cleanup.splice(0).reverse()) await action()
  })

  it('completes one Debate through the real daemon with parallel participants and an Evidence-fenced judge', async () => {
    // Keep the Unix socket path below the macOS sockaddr_un length limit.
    const temporaryRoot = process.platform === 'win32' ? tmpdir() : '/tmp'
    const home = await mkdtemp(join(temporaryRoot, 'dsh-debate-e2e-'))
    const orchestrationRoot = join(home, 'orchestrations')
    const workspace = join(home, 'workspace')
    await mkdir(workspace)
    const resident = new ScriptedKeylessResident()
    const daemon = new OrchestrationDaemon({
      root: orchestrationRoot,
      dshHome: home,
      residentClient: resident as never,
      modelWorkerProviders: [],
      schedulerIntervalMs: 5,
    })
    await daemon.start()
    cleanup.push(async () => rm(home, { recursive: true, force: true }))
    cleanup.push(async () => daemon.close())
    const client = new OrchestrationDaemonClient({
      root: orchestrationRoot,
      dshHome: home,
      autoStart: false,
      connectTimeoutMs: 2_000,
    })
    const context = new Context()
    cleanup.push(async () => context.root.fiber.dispose())
    const debate = new LocalDebateProvider(context, {
      root: join(home, 'debates'),
      executor: new DebateTaskGraphRoundExecutor(client, { pollIntervalMs: 5, timeoutMs: 5_000 }),
      idFactory: () => 'debate-e2e',
    })

    const completed = await debate.start({
      version: 1,
      commandId: 'debate-e2e:start',
      workspace,
      prompt: 'Choose the strongest supported reversible option.',
      objective: 'Reach a bounded evidence-based decision.',
      policy: policy(),
      sourceRefs: [{ version: 1, ref: 'fixture:brief', kind: 'artifact' }],
      sourceSessionId: 'session:debate-e2e',
    })

    const debateEvents = await debate.readEvents({ runId: completed.runId, limit: 100 })
    const orchestrationRuns = await client.list()
    expect(completed.state, JSON.stringify({ completed, debateEvents, orchestrationRuns, requests: resident.requests }, null, 2)).toBe('completed')
    expect(resident.requests.every(request => request.nativeToolPolicy === 'disabled')).toBe(true)
    expect(completed.rounds).toHaveLength(1)
    expect(resident.peakParticipants).toBe(2)
    expect(resident.judgeStartedAfterParticipants).toBe(true)
    expect(resident.judgeReceivedParticipantEvidence).toBe(true)
    expect(resident.requests.map(request => [request.operatorId, request.profile?.model])).toEqual([
      ['codex', 'gpt-5.6-luna'],
      ['claude-code', 'claude-sonnet-4-6'],
      ['codex', 'gpt-5.6-sol'],
    ])
    expect(completed.cost).toMatchObject({
      usageStatus: 'known',
      costStatus: 'known',
      inputTokens: 30,
      outputTokens: 15,
      costUsd: 0.03,
      unknownUsageTurns: 0,
      unknownCostTurns: 0,
    })
    const extended = await debate.control({
      version: 1,
      commandId: 'debate-e2e:continue',
      runId: completed.runId,
      expectedRevision: completed.revision,
      action: 'continue',
      reason: '继续讨论 2 轮',
    })
    expect(extended).toMatchObject({
      state: 'completed',
      currentRound: 3,
      continuation: {
        grants: [{ firstRound: 2, lastRound: 3 }],
        effectiveBudget: { maxRounds: 3, maxCostUsd: 1 },
      },
    })
    const physicalRounds = resident.requests.map(request => /:debate-r(\d+)-/u.exec(request.commandId)?.[1])
    expect(physicalRounds).toEqual(['1', '1', '1', '2', '2', '2', '3', '3', '3'])
    const continuedEvents = await debate.readEvents({ runId: extended.runId, limit: 100 })
    expect(continuedEvents.events.filter(event => event.type === 'debate.round.started').map(event => event.round))
      .toEqual([1, 2, 3])
  }, process.platform === 'win32' ? 30_000 : 15_000)

  it('runs a Debate whose roles are Gouzi members, one member per role, bound by a recipient set', async () => {
    const temporaryRoot = process.platform === 'win32' ? tmpdir() : '/tmp'
    const home = await mkdtemp(join(temporaryRoot, 'dsh-debate-gouzi-'))
    const orchestrationRoot = join(home, 'orchestrations')
    const workspace = join(home, 'workspace')
    await mkdir(workspace)
    const scopes = [workspace, await realpath(workspace)]
    const ports: Record<string, number> = { alpha: 13311, beta: 13312, gamma: 13313 }
    const registry = new OrchestrationStore(orchestrationRoot)
    registry.gouzi.pairHost({ hostId: GouziHostId('host-1'), label: 'Host', authorityEpoch: GouziAuthorityEpoch('epoch-1'), credentialRef: 'HOST_TOKEN' })
    for (const [id, port] of Object.entries(ports)) {
      registry.gouzi.create({ gouziId: GouziId(id), ownerId: GouziOwnerId('owner'), hostId: GouziHostId('host-1'), name: id, avatarId: 'shiba', role: 'development', grantDeadlineMs: 60_000 })
      registry.gouzi.setMembership(GouziId(id), 'enabled')
      registry.gouzi.setEndpoint(GouziId(id), `http://127.0.0.1:${String(port)}`)
    }
    registry.close()

    const executed: {
      member: string
      slotId: string
      model: string | undefined
      grantedTo: string | undefined
      judgeSawEvidence: boolean
    }[] = []
    const results = new Map<string, unknown>()
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
      if (typeof init?.body !== 'string') throw new Error('expected JSON body')
      const call = JSON.parse(init.body) as { rpcId: string; method: string; payload: Record<string, unknown> }
      const member = Object.entries(ports).find(([, port]) => String(input).includes(`:${String(port)}/`))?.[0]
      if (member === undefined) throw new Error(`unexpected endpoint ${String(input)}`)
      let value: unknown
      switch (call.method) {
        case 'operator.providers':
          value = [{
            operatorId: 'codex', product: 'codex', displayName: 'Native', description: 'Native', tags: ['coding'], maxConcurrency: 4,
            gouziWorkspace: { gouziId: member, generation: 1, projectId: 'a'.repeat(64), projectScopes: scopes },
            injectionBoundaries: [], available: true, authentication: 'native-subscription', productVersion: 'test', protocolHash: 'test',
            supportsGenerationLimits: true,
            models: [{ model: 'gpt-5.6-luna', displayName: 'Luna', description: 'Worker', supportedEfforts: ['medium'], defaultEffort: 'medium', isDefault: true, supportsAdaptiveThinking: true }],
          }]
          break
        case 'operator.execute': {
          const payload = call.payload as {
            commandId: string
            profile?: { model: string }
            prompt?: { text?: string }[]
            gouziGrant?: { gouziId: string }
            contextEnvelope: { digest: string }
          }
          const slotId = /:debate-r\d+-([^:]+):1$/u.exec(payload.commandId)?.[1]
          if (slotId === undefined) throw new Error(`cannot identify Debate slot in ${payload.commandId}`)
          const prompt = payload.prompt?.map(block => block.text ?? '').join('\n') ?? ''
          executed.push({
            member, slotId, model: payload.profile?.model, grantedTo: payload.gouziGrant?.gouziId,
            judgeSawEvidence: prompt.includes('Upstream Evidence contents:'),
          })
          const turnId = `turn:${payload.commandId}`
          results.set(turnId, {
            commandId: payload.commandId, sessionId: `session:${member}`, turnId, state: 'settled', stateRevision: 2,
            updatedAt: new Date().toISOString(),
            result: {
              output: [{ type: 'text', text: turnBody(slotId) }],
              stopReason: 'completed',
              usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 2, costUsd: 0.01 },
            },
          })
          value = {
            sessionId: `session:${member}`, turnId, stateRevision: 1,
            contextReceipt: { version: 1, digest: payload.contextEnvelope.digest, receiver: 'remote-resident:codex', outcome: 'accepted', format: 'native', roleFidelity: 'native' },
          }
          break
        }
        case 'operator.inspect': value = results.get((call.payload as { turnId: string }).turnId); break
        case 'operator.events': value = { events: [], nextSequence: 0 }; break
        default: throw new Error(`unexpected remote method ${call.method}`)
      }
      return Response.json({ type: 'server-response', rpcId: call.rpcId, result: { ok: true, value } })
    }))

    const daemon = new OrchestrationDaemon({
      root: orchestrationRoot, dshHome: home, residentClient: new ScriptedKeylessResident() as never,
      modelWorkerProviders: [], schedulerIntervalMs: 10,
    })
    await daemon.start()
    cleanup.push(async () => rm(home, { recursive: true, force: true }))
    cleanup.push(async () => daemon.close())
    const client = new OrchestrationDaemonClient({ root: orchestrationRoot, dshHome: home, autoStart: false, connectTimeoutMs: 2_000 })
    // The service a Host composes: the daemon client plus the member registry it manages.
    const orchestrations = {
      compile: (request: Parameters<typeof client.compile>[0]) => client.compile(request),
      start: (request: Parameters<typeof client.start>[0]) => client.start(request),
      inspect: (runId: Parameters<typeof client.inspect>[0]) => client.inspect(runId),
      control: (request: Parameters<typeof client.control>[0]) => client.control(request),
      readEvents: (request: Parameters<typeof client.readEvents>[0]) => client.readEvents(request),
      readArtifact: (ref: Parameters<typeof client.readArtifact>[0]) => client.readArtifact(ref),
      gouzi: { list: () => client.gouziList(), executionOperators: () => client.gouziExecutionOperators() },
    }
    const context = new Context()
    cleanup.push(async () => context.root.fiber.dispose())
    const debate = new LocalDebateProvider(context, {
      root: join(home, 'debates'),
      executor: new DebateTaskGraphRoundExecutor(orchestrations as never, { pollIntervalMs: 5, timeoutMs: 8_000 }),
      idFactory: () => 'debate-gouzi',
    })
    const roster = ([
      ['constructive-proposer', 'participant', 'alpha'],
      ['skeptical-falsifier', 'participant', 'beta'],
      ['decision-judge', 'judge', 'gamma'],
    ] as const).map(([role, kind, member]) => ({
      version: 1 as const, role, kind, operatorId: `gouzi.${member}.codex`, model: 'gpt-5.6-luna',
      tier: 'medium' as const, source: 'native-subscription' as const, persona: DEFAULT_DEBATE_PERSONAS[role], required: true,
    }))
    const memberPolicy: DebatePolicyV1 = {
      version: 1, mode: 'enabled', roster, budget: defaultDebateBudget(1, roster.length),
      rounds: DEFAULT_DEBATE_ROUNDS, convergence: DEFAULT_DEBATE_CONVERGENCE, preserveDissent: true,
    }

    // A kennel request is the user's explicit choice: the run starts awaiting approval, then is approved.
    const started = await debate.start({
      version: 1, commandId: 'debate-gouzi:start', workspace, prompt: 'Choose the reversible option.',
      objective: 'Reach a bounded decision.', policy: memberPolicy, sourceSessionId: 'session:debate-gouzi',
    })
    expect(started.state).toBe('awaiting_approval')
    expect(executed).toEqual([])
    const completed = await debate.control({
      version: 1, commandId: 'debate-gouzi:approve', runId: started.runId, expectedRevision: started.revision,
      action: 'approve', reason: 'The user asked for this Debate in the kennel.',
    })

    const diagnostics = JSON.stringify({ completed, runs: await client.list(), executed }, null, 2)
    expect(completed.state, diagnostics).toBe('completed')
    // Each role ran on its own member, with that member's grant and the roster's model.
    const bySlot = [...executed].sort((left, right) => left.slotId.localeCompare(right.slotId))
    expect(bySlot.map(({ member, slotId, model, grantedTo }) => [slotId, member, model, grantedTo])).toEqual([
      ['constructive-proposer', 'alpha', 'gpt-5.6-luna', 'alpha'],
      ['decision-judge', 'gamma', 'gpt-5.6-luna', 'gamma'],
      ['skeptical-falsifier', 'beta', 'gpt-5.6-luna', 'beta'],
    ])
    expect(executed.find(value => value.slotId === 'decision-judge')?.judgeSawEvidence).toBe(true)
    // The round graph was admitted for the whole set of members.
    const [run] = await client.list()
    expect(run?.admission?.gouziRecipients?.map(recipient => [recipient.gouziId, recipient.generation, recipient.operatorIds])).toEqual([
      ['alpha', 1, ['gouzi.alpha.codex']], ['beta', 1, ['gouzi.beta.codex']], ['gamma', 1, ['gouzi.gamma.codex']],
    ])
    expect(run?.admission?.gouziRecipient).toBeUndefined()
  }, process.platform === 'win32' ? 30_000 : 20_000)
})
