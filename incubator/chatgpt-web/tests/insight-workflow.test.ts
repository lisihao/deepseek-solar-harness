import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  defaultInsightConfig,
  type InsightClarifyRequest,
  type InsightConfigV1,
  type InsightExternalExecuteRequest,
  type InsightExternalObserveRequest,
  type InsightPlanConfirmationRequest,
  type InsightPortArtifact,
  type InsightPorts,
  type InsightQuestionRequest,
  type InsightStageOutcome,
} from '../src/insight-contract.js'
import { InsightStore } from '../src/insight-store.js'
import { InsightController } from '../src/insight-workflow.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-insight-'))
  roots.push(root)
  return join(root, 'state')
}

function config(overrides: Partial<InsightConfigV1> = {}): InsightConfigV1 {
  return { ...defaultInsightConfig(), ...overrides }
}

function artifact(provider: 'codex' | 'gemini' | 'chatgpt', text: string): InsightPortArtifact {
  return {
    text,
    provenance: {
      provider,
      source: `${provider} visible result`,
      visibleEvidence: [`${provider} visible status`],
      citations: ['https://example.test/source'],
      limitations: ['Only webpage-visible activity is retained.'],
    },
  }
}

function complete(
  request: InsightClarifyRequest | InsightExternalExecuteRequest | InsightExternalObserveRequest,
  text: string,
  clarification?: { readonly brief?: string; readonly questions: readonly { readonly id: string; readonly text: string }[] },
): InsightStageOutcome {
  return {
    kind: 'complete',
    resource: { ...request.resource, remoteId: `remote:${request.commandId}` },
    observed: { availability: 'not-exposed' },
    artifact: artifact(request.requested.provider, text),
    ...(clarification === undefined ? {} : { clarification }),
  }
}

function quota(request: InsightExternalExecuteRequest): InsightStageOutcome {
  return {
    kind: 'quota-exhausted',
    resource: { ...request.resource },
    evidence: 'Gemini webpage displayed a stage-specific quota exhausted notice.',
    resetInformation: 'No reset time displayed.',
    certainty: 'no-active-effect',
  }
}

function unknown(request: InsightExternalExecuteRequest, reason = 'network timeout after submit is not ruled out'): InsightStageOutcome {
  return {
    kind: 'unknown',
    resource: { ...request.resource, remoteId: `remote:${request.commandId}` },
    reason,
  }
}

function failed(
  request: InsightClarifyRequest | InsightExternalExecuteRequest,
  code: string,
  reason: string,
  certainty: 'no-active-effect' | 'settled' = 'no-active-effect',
): InsightStageOutcome {
  return { kind: 'failed', resource: { ...request.resource }, code, reason, certainty }
}

type Calls = {
  readonly clarify: InsightClarifyRequest[]
  readonly questions: InsightQuestionRequest[]
  readonly confirmation: InsightPlanConfirmationRequest[]
  readonly execute: InsightExternalExecuteRequest[]
  readonly observe: InsightExternalObserveRequest[]
}

function calls(): Calls {
  return { clarify: [], questions: [], confirmation: [], execute: [], observe: [] }
}

function input(id = randomUUID()) {
  return {
    id,
    question: '需要保留的用户问题：比较方案 A 和 B。',
    conversationContext: `完整上下文开始\n${'上下文原文 '.repeat(600)}\n完整上下文结束`,
  }
}

function answerPorts(callsValue: Calls, handlers: {
  clarify: (request: InsightClarifyRequest) => Promise<InsightStageOutcome> | InsightStageOutcome
  execute: (request: InsightExternalExecuteRequest) => Promise<InsightStageOutcome> | InsightStageOutcome
  observe?: (request: InsightExternalObserveRequest) => Promise<InsightStageOutcome> | InsightStageOutcome
  question?: (request: InsightQuestionRequest) => Promise<Awaited<ReturnType<InsightPorts['askQuestions']>>> | Awaited<ReturnType<InsightPorts['askQuestions']>>
  confirmation?: (request: InsightPlanConfirmationRequest) => Promise<Awaited<ReturnType<InsightPorts['confirmPlan']>>> | Awaited<ReturnType<InsightPorts['confirmPlan']>>
}): InsightPorts {
  return {
    async clarify(request) {
      callsValue.clarify.push(request)
      return handlers.clarify(request)
    },
    async askQuestions(request) {
      callsValue.questions.push(request)
      return handlers.question?.(request) ?? { kind: 'answered', answers: request.questions.map((question) => ({ questionId: question.id, text: '精确保留的用户答案。' })) }
    },
    async confirmPlan(request) {
      callsValue.confirmation.push(request)
      return handlers.confirmation?.(request) ?? { kind: 'confirmed' }
    },
    async execute(request) {
      callsValue.execute.push(request)
      return handlers.execute(request)
    },
    async observe(request) {
      callsValue.observe.push(request)
      return handlers.observe?.(request) ?? complete(request, 'Observed report 42 [1] https://example.test/source')
    },
  }
}

describe('InsightController', () => {
  it('runs the fixed path with persisted Q&A and complete uncollapsed handoffs', async () => {
    const root = await makeRoot()
    const received = calls()
    const originalInput = input()
    const rawReport = `${'完整 Gemini 报告段落\n'.repeat(900)}42 [1] https://example.test/source`
    const ports = answerPorts(received, {
      clarify: async (request) => request.round === 1
        ? complete(request, 'Need one material answer.', { questions: [{ id: 'scope', text: '比较的目标读者是谁？' }] })
        : complete(request, 'Clarification response after answer.', { brief: '完整研究简报：比较方案 A 与 B；目标读者已由用户明确。', questions: [] }),
      execute: async (request) => {
        switch (request.stage) {
          case 'plan': return complete(request, '完整研究计划：保留每项证据与反证。')
          case 'research': return complete(request, rawReport)
          case 'critique': return complete(request, `已复核：${rawReport}`)
          case 'polish': return complete(request, `润色版：${rawReport}`)
          default: throw new Error(`unexpected ${request.stage}`)
        }
      },
    })
    const controller = new InsightController({ store: new InsightStore(root), ports, config: config() })

    const run = await controller.start(originalInput)

    expect(run.status).toBe('completed')
    expect(run.stages.map((stage) => stage.stage)).toEqual([
      'clarify', 'questions', 'clarify', 'plan', 'plan-confirmation', 'research', 'critique', 'polish', 'final',
    ])
    expect(received.questions).toHaveLength(1)
    expect(run.stages.find((stage) => stage.stage === 'questions')?.answers).toEqual([{ questionId: 'scope', text: '精确保留的用户答案。' }])
    expect(run.assets.find((assetValue) => assetValue.kind === 'clarification-answers')?.text).toContain('精确保留的用户答案。')
    expect(run.assets.find((assetValue) => assetValue.kind === 'gemini-research-report')?.text).toBe(rawReport)
    expect(run.finalMarkdown).toContain(rawReport)
    expect(run.finalMarkdown).toContain('来源与限制')

    const plan = received.execute.find((request) => request.stage === 'plan')
    const research = received.execute.find((request) => request.stage === 'research')
    const critique = received.execute.find((request) => request.stage === 'critique')
    const polish = received.execute.find((request) => request.stage === 'polish')
    expect(plan?.renderedInput).toContain(originalInput.conversationContext)
    expect(plan?.renderedInput).toContain('精确保留的用户答案。')
    expect(research?.renderedInput).toContain('完整研究计划：保留每项证据与反证。')
    expect(critique?.renderedInput).toContain(rawReport)
    expect(polish?.renderedInput).toContain(`已复核：${rawReport}`)
    expect(config().clarification.requested).toMatchObject({ modelId: 'gpt-6.1-sol', modelLabel: 'GPT-6.1 Sol' })
    expect(config().researchWaitMs).toBe(3_600_000)
  })

  it('uses only the selected known-quota fallback and labels the final report', async () => {
    const root = await makeRoot()
    const received = calls()
    const ports = answerPorts(received, {
      clarify: async (request) => complete(request, 'Brief raw', { brief: '完整研究简报。', questions: [] }),
      execute: async (request) => {
        switch (request.stage) {
          case 'plan': return complete(request, '完整计划。')
          case 'research': return quota(request)
          case 'research-fallback': return complete(request, '回落研究报告：42 [1] https://example.test/source')
          case 'critique': return complete(request, '复核后的报告：42 [1] https://example.test/source')
          case 'polish-fallback': return complete(request, '润色回落报告：42 [1] https://example.test/source')
          default: throw new Error(`unexpected ${request.stage}`)
        }
      },
    })
    const controller = new InsightController({ store: new InsightStore(root), ports, config: config() })

    const run = await controller.start(input())

    expect(run.status).toBe('completed')
    expect(received.execute.map((request) => request.stage)).toEqual(['plan', 'research', 'research-fallback', 'critique', 'polish-fallback'])
    const fallback = received.execute.find((request) => request.stage === 'research-fallback')
    expect(fallback?.requested).toEqual({ provider: 'chatgpt', modelLabel: 'GPT-6 Astra Pro', modeLabel: 'Web search and analysis' })
    expect(fallback?.renderedInput).toContain('回落报告')
    expect(received.execute.find((request) => request.stage === 'critique')?.renderedInput).toContain('同一提供方复核')
    expect(run.assets.find((assetValue) => assetValue.kind === 'fallback-research-report')?.provenance.fallback).toBe(true)
    expect(run.assets.find((assetValue) => assetValue.kind === 'verified-report')?.provenance.sameProviderReview).toBe(true)
    expect(run.finalMarkdown).toContain('回落报告')
    expect(run.finalMarkdown).toContain('同一提供方复核')
  })

  it('fences an unknown research effect, then a restarted controller observes the original resource without replaying it', async () => {
    const root = await makeRoot()
    const firstCalls = calls()
    let originalResearch: InsightExternalExecuteRequest | undefined
    const firstPorts = answerPorts(firstCalls, {
      clarify: async (request) => complete(request, 'Brief', { brief: '完整研究简报。', questions: [] }),
      execute: async (request) => {
        if (request.stage === 'plan') return complete(request, '计划。')
        if (request.stage === 'research') {
          originalResearch = request
          return unknown(request)
        }
        throw new Error(`should not run ${request.stage}`)
      },
    })
    const runId = randomUUID()
    const runInput = input(runId)
    const first = new InsightController({ store: new InsightStore(root), ports: firstPorts, config: config() })
    const paused = await first.start(runInput)

    expect(paused.status).toBe('paused')
    const durableResearch = paused.stages.find((stage) => stage.stage === 'research')
    expect(durableResearch?.status).toBe('unknown')
    expect(firstCalls.execute.map((request) => request.stage)).toEqual(['plan', 'research'])
    expect(originalResearch).toBeDefined()

    const restartCalls = calls()
    const restartedPorts = answerPorts(restartCalls, {
      clarify: async () => { throw new Error('clarify must not replay') },
      execute: async (request) => {
        if (request.stage === 'research') throw new Error('research must not replay')
        if (request.stage === 'critique') return complete(request, '复核：42 [1] https://example.test/source')
        if (request.stage === 'polish') return complete(request, '润色：42 [1] https://example.test/source')
        throw new Error(`unexpected execute ${request.stage}`)
      },
      observe: async (request) => {
        expect(request.commandId).toBe(originalResearch?.commandId)
        expect(request.resource.id).toBe(originalResearch?.resource.id)
        expect(request.resource.remoteId).toBe(`remote:${originalResearch?.commandId}`)
        return complete(request, '原任务观察到的研究报告：42 [1] https://example.test/source')
      },
    })
    const restarted = new InsightController({ store: new InsightStore(root), ports: restartedPorts, config: config() })
    const final = await restarted.start(runInput)

    expect(final.status).toBe('completed')
    expect(restartCalls.observe).toHaveLength(1)
    expect(restartCalls.observe[0]?.stage).toBe('research')
    expect(restartCalls.execute.map((request) => request.stage)).toEqual(['critique', 'polish'])
    expect(final.assets.find((assetValue) => assetValue.kind === 'gemini-research-report')?.text).toContain('原任务观察到')
  })

  it('rejects changed input/configuration for the same durable run and refuses unknown on-disk formats', async () => {
    const root = await makeRoot()
    const received = calls()
    const ports = answerPorts(received, {
      clarify: async (request) => complete(request, 'Brief', { brief: '简报。', questions: [] }),
      execute: async (request) => {
        if (request.stage === 'plan') return complete(request, '计划。')
        if (request.stage === 'research') return complete(request, '研究：42 [1] https://example.test/source')
        if (request.stage === 'critique') return complete(request, '复核：42 [1] https://example.test/source')
        if (request.stage === 'polish') return complete(request, '润色：42 [1] https://example.test/source')
        throw new Error(`unexpected ${request.stage}`)
      },
    })
    const runInput = input()
    const first = new InsightController({ store: new InsightStore(root), ports, config: config() })
    await first.start(runInput)

    await expect(first.start({ ...runInput, question: 'changed input' })).rejects.toMatchObject({ code: 'INSIGHT_COMMAND_CONFLICT' })
    const changedConfig = config({ researchWaitMs: 3_600_001 })
    const second = new InsightController({ store: new InsightStore(root), ports, config: changedConfig })
    await expect(second.start(runInput)).rejects.toMatchObject({ code: 'INSIGHT_COMMAND_CONFLICT' })

    const malformedRoot = await makeRoot()
    const malformedId = randomUUID()
    await mkdir(join(malformedRoot, malformedId), { recursive: true })
    await writeFile(join(malformedRoot, malformedId, '0.json'), '{"formatVersion":99}', 'utf8')
    await expect(new InsightStore(malformedRoot).read(malformedId)).rejects.toMatchObject({ code: 'INSIGHT_STATE_VERSION' })
  })

  it('cancels local waiting while leaving a research effect unknown and preserves earlier full assets', async () => {
    const root = await makeRoot()
    const received = calls()
    let researchStarted: (() => void) | undefined
    const researchReady = new Promise<void>((resolve) => { researchStarted = resolve })
    const ports = answerPorts(received, {
      clarify: async (request) => complete(request, 'Raw clarify', { brief: '完整研究简报，不可丢失。', questions: [] }),
      execute: async (request) => {
        if (request.stage === 'plan') return complete(request, '完整计划，不可丢失。')
        if (request.stage === 'research') {
          researchStarted?.()
          return new Promise<InsightStageOutcome>((resolve) => {
            request.signal.addEventListener('abort', () => resolve(unknown(request, 'local cancellation cannot prove remote cancellation')), { once: true })
          })
        }
        throw new Error(`must not reach ${request.stage}`)
      },
    })
    const runInput = input()
    const controller = new InsightController({
      store: new InsightStore(root),
      ports,
      config: config({ researchWaitMs: 10_000 }),
    })

    const started = controller.start(runInput)
    await researchReady
    expect(controller.start(runInput)).toBe(started)
    const cancelled = await controller.cancel(runInput.id)
    const returned = await started

    expect(cancelled.status).toBe('cancelled')
    expect(returned.status).toBe('cancelled')
    expect(cancelled.stages.find((stage) => stage.stage === 'research')).toMatchObject({ status: 'unknown' })
    expect(cancelled.assets.find((assetValue) => assetValue.kind === 'research-brief')?.text).toBe('完整研究简报，不可丢失。')
    expect(cancelled.assets.find((assetValue) => assetValue.kind === 'research-plan')?.text).toBe('完整计划，不可丢失。')
    expect(received.execute.map((request) => request.stage)).toEqual(['plan', 'research'])
  })

  it('records a known preflight failure without quota fallback or an unknown-effect fence', async () => {
    const root = await makeRoot()
    const received = calls()
    const ports = answerPorts(received, {
      clarify: async (request) => complete(request, 'Brief', { brief: '完整研究简报。', questions: [] }),
      execute: async (request) => {
        if (request.stage === 'plan') return complete(request, '计划。')
        if (request.stage === 'research') return failed(request, 'WEB_MODEL_UNAVAILABLE', 'Requested Gemini model is not available before submission.')
        throw new Error(`must not execute ${request.stage}`)
      },
    })
    const controller = new InsightController({ store: new InsightStore(root), ports, config: config() })

    const run = await controller.start(input())

    expect(run.status).toBe('failed')
    expect(run.stages.find((stage) => stage.stage === 'research')).toMatchObject({ status: 'failed', failureCode: 'WEB_MODEL_UNAVAILABLE' })
    expect(received.execute.map((request) => request.stage)).toEqual(['plan', 'research'])
    expect(received.execute.some((request) => request.stage === 'research-fallback')).toBe(false)
    expect(run.stages.some((stage) => stage.status === 'unknown')).toBe(false)
  })

  it('does not retry or observe a settled native clarification failure', async () => {
    const root = await makeRoot()
    const received = calls()
    const ports = answerPorts(received, {
      clarify: async (request) => failed(request, 'NATIVE_TASK_FAILED', 'Native clarifier reached a terminal failure.', 'settled'),
      execute: async () => { throw new Error('no external stage may run') },
    })
    const runInput = input()
    const controller = new InsightController({ store: new InsightStore(root), ports, config: config() })

    const first = await controller.start(runInput)
    const repeated = await controller.start(runInput)
    const resumed = await controller.resume(runInput.id)

    expect(first.status).toBe('failed')
    expect(repeated.status).toBe('failed')
    expect(resumed.status).toBe('failed')
    expect(first.stages[0]).toMatchObject({ stage: 'clarify', status: 'failed', failureCode: 'NATIVE_TASK_FAILED' })
    expect(received.clarify).toHaveLength(1)
    expect(received.observe).toHaveLength(0)
  })
})
