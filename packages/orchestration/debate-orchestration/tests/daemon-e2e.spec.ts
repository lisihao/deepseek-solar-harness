import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { DebatePolicyV1 } from '@deepseek-ai/dsh-debate'
import { LocalDebateProvider } from '@deepseek-ai/dsh-debate-local'
import {
  OrchestrationDaemon,
  OrchestrationDaemonClient,
} from '@deepseek-ai/dsh-orchestration-local'
import { afterEach, describe, expect, it } from 'vitest'
import { DebateTaskGraphRoundExecutor } from '../src/index.ts'

interface ScriptedResidentRequest {
  readonly commandId: string
  readonly operatorId: string
  readonly profile?: { readonly model: string }
  readonly prompt?: readonly { readonly type: string; readonly text?: string }[]
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
  participantSettled = 0
  peakParticipants = 0
  judgeStartedAfterParticipants = false
  judgeReceivedParticipantEvidence = false
  private activeParticipants = 0
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
    const slotId = /:debate-r1-([^:]+):1$/u.exec(request.commandId)?.[1]
    if (slotId === undefined) throw new Error(`fixture could not identify Debate slot from ${request.commandId}`)
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
        this.participantSettled += 1
        this.turns.set(turnId, resultValue)
        resolve(resultValue)
      }, 40))
    } else {
      const prompt = request.prompt?.map(block => block.text ?? '').join('\n') ?? ''
      this.judgeStartedAfterParticipants = this.participantSettled === 2
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
      maxInputTokens: 1_000,
      maxOutputTokens: 1_000,
      maxTotalTokens: 2_000,
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
    for (const action of cleanup.splice(0).reverse()) await action()
  })

  it('completes one Debate through the real daemon with parallel participants and an Evidence-fenced judge', async () => {
    // Keep the Unix socket path below the macOS sockaddr_un length limit.
    const home = await mkdtemp('/tmp/dsh-debate-e2e-')
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
  })
})
