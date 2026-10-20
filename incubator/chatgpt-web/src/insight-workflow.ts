import {
  assertInsightConfig,
  cloneInsight,
  renderInsightTemplate,
  stableInsightJson,
  type InsightAnswer,
  type InsightArtifact,
  type InsightClarification,
  type InsightClarifyRequest,
  type InsightConfigV1,
  type InsightExternalExecuteRequest,
  type InsightExternalObserveRequest,
  type InsightExternalResource,
  type InsightModelSelection,
  type InsightObservedSelection,
  type InsightPlanConfirmationRequest,
  type InsightPortArtifact,
  type InsightPorts,
  type InsightProvenance,
  type InsightQuestion,
  type InsightQuestionRequest,
  type InsightRun,
  type InsightRunRequest,
  type InsightStartInput,
  type InsightStageName,
  type InsightStageRecord,
  type InsightStageOutcome,
  type InsightTemplate,
} from './insight-contract.js'
import { InsightStore, InsightStoreError } from './insight-store.js'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EXTERNAL_STAGES = new Set<InsightStageName>([
  'clarify',
  'plan',
  'research',
  'research-fallback',
  'critique',
  'polish',
  'polish-fallback',
])

export type InsightWorkflowErrorCode =
  | 'INSIGHT_RUN_NOT_FOUND'
  | 'INSIGHT_COMMAND_CONFLICT'
  | 'INSIGHT_INPUT_INVALID'
  | 'INSIGHT_CONTROLLER_LIMIT'

export class InsightWorkflowError extends Error {
  constructor(readonly code: InsightWorkflowErrorCode, message: string) {
    super(message)
    this.name = 'InsightWorkflowError'
  }
}

export interface InsightControllerOptions {
  readonly store: InsightStore
  readonly ports: InsightPorts
  readonly config: InsightConfigV1
}

type ActiveOperation = {
  readonly signature: string
  readonly controller: AbortController
  readonly allowCancelledReconcile: boolean
  promise?: Promise<InsightRun>
}

type Applied = {
  readonly run: InsightRun
  readonly applied: boolean
}

type ExternalDescriptor = {
  readonly stage: Extract<InsightStageName, 'clarify' | 'plan' | 'research' | 'research-fallback' | 'critique' | 'polish' | 'polish-fallback'>
  readonly kind: 'native' | 'external'
  readonly round?: number
  readonly extraSections?: readonly { readonly title: string; readonly text: string }[]
}

function workflowError(code: InsightWorkflowErrorCode, message: string): InsightWorkflowError {
  return new InsightWorkflowError(code, message)
}

function isStateConflict(error: unknown): boolean {
  return error instanceof InsightStoreError && error.code === 'INSIGHT_STATE_CONFLICT'
}

function now(): string {
  return new Date().toISOString()
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right
  return stableInsightJson(left) === stableInsightJson(right)
}

function stageId(runId: string, stage: InsightStageName, occurrence = 1): string {
  return `insight:${runId}:${stage}:${occurrence}`
}

function stageAt(run: InsightRun, commandId: string): InsightStageRecord | undefined {
  return run.stages.find((stage) => stage.commandId === commandId)
}

function replaceStage(run: InsightRun, replacement: InsightStageRecord): readonly InsightStageRecord[] {
  return run.stages.map((stage) => stage.commandId === replacement.commandId ? replacement : stage)
}

function latestStage(run: InsightRun, stage: InsightStageName): InsightStageRecord | undefined {
  for (let index = run.stages.length - 1; index >= 0; index -= 1) {
    const value = run.stages[index]
    if (value?.stage === stage) return value
  }
  return undefined
}

function assetByKind(run: InsightRun, kind: string): InsightArtifact | undefined {
  for (let index = run.assets.length - 1; index >= 0; index -= 1) {
    const value = run.assets[index]
    if (value?.kind === kind) return value
  }
  return undefined
}

function stageIsUnresolved(stage: InsightStageRecord): boolean {
  return stage.status === 'calling' || stage.status === 'unknown'
}

function externalStage(stage: InsightStageRecord): stage is InsightStageRecord & {
  readonly stage: InsightExternalObserveRequest['stage']
  readonly requested: InsightModelSelection
  readonly resource: InsightExternalResource
  readonly template: InsightTemplate
} {
  return EXTERNAL_STAGES.has(stage.stage)
    && stage.requested !== undefined
    && stage.resource !== undefined
    && stage.template !== undefined
}

function requiredStageTemplate(config: InsightConfigV1, stage: ExternalDescriptor['stage']): InsightTemplate {
  switch (stage) {
    case 'clarify': return config.clarification.template
    case 'plan': return config.plan.template
    case 'research': return config.research.template
    case 'research-fallback': return config.fallbackResearch.template
    case 'critique': return config.critique.template
    case 'polish': return config.polish.template
    case 'polish-fallback': return config.fallbackPolish.template
  }
}

function requiredStageSelection(config: InsightConfigV1, stage: ExternalDescriptor['stage']): InsightModelSelection {
  switch (stage) {
    case 'clarify': return config.clarification.requested
    case 'plan': return config.plan.requested
    case 'research': return config.research.requested
    case 'research-fallback': return config.fallbackResearch.requested
    case 'critique': return config.critique.requested
    case 'polish': return config.polish.requested
    case 'polish-fallback': return config.fallbackPolish.requested
  }
}

function fullAssetText(assets: readonly InsightArtifact[]): string {
  if (assets.length === 0) return '(no prior durable artifacts)'
  return assets.map((asset) => [
    `asset-id: ${asset.id}`,
    `stage-command-id: ${asset.stageCommandId}`,
    `kind: ${asset.kind}`,
    `provenance: ${JSON.stringify(asset.provenance)}`,
    'full-text:',
    asset.text,
  ].join('\n')).join('\n\n==========\n\n')
}

function answerText(questions: readonly InsightQuestion[], answers: readonly InsightAnswer[]): string {
  const byId = new Map(answers.map((answer) => [answer.questionId, answer.text]))
  return questions.map((question) => [
    `question-id: ${question.id}`,
    `question: ${question.text}`,
    'answer:',
    byId.get(question.id) ?? '',
  ].join('\n')).join('\n\n')
}

function copyResource(base: InsightExternalResource, received: InsightExternalResource): InsightExternalResource | undefined {
  if (base.provider !== received.provider || base.id !== received.id) return undefined
  if (base.remoteId !== undefined && base.remoteId !== received.remoteId) return undefined
  if (base.url !== undefined && base.url !== received.url) return undefined
  return {
    provider: base.provider,
    id: base.id,
    ...(received.remoteId === undefined ? {} : { remoteId: received.remoteId }),
    ...(received.url === undefined ? {} : { url: received.url }),
  }
}

function validObserved(value: unknown): value is InsightObservedSelection {
  if (!isObject(value) || (value.availability !== 'observed' && value.availability !== 'not-exposed')) return false
  return ['providerLabel', 'modelLabel', 'effortLabel', 'modeLabel'].every((field) => value[field] === undefined || typeof value[field] === 'string')
}

function validResource(value: unknown): value is InsightExternalResource {
  return isObject(value)
    && (value.provider === 'codex' || value.provider === 'gemini' || value.provider === 'chatgpt')
    && isNonEmptyString(value.id)
    && (value.remoteId === undefined || isNonEmptyString(value.remoteId))
    && (value.url === undefined || isNonEmptyString(value.url))
}

function validProvenance(value: unknown, provider: InsightModelSelection['provider']): value is InsightProvenance {
  if (!isObject(value) || value.provider !== provider || !isNonEmptyString(value.source)) return false
  for (const field of ['visibleEvidence', 'citations', 'limitations']) {
    if (!Array.isArray(value[field]) || !value[field].every((item) => typeof item === 'string')) return false
  }
  return (value.fallback === undefined || typeof value.fallback === 'boolean')
    && (value.sameProviderReview === undefined || typeof value.sameProviderReview === 'boolean')
}

function validPortArtifact(value: unknown, provider: InsightModelSelection['provider']): value is InsightPortArtifact {
  return isObject(value) && typeof value.text === 'string' && validProvenance(value.provenance, provider)
}

function validQuestions(value: unknown): value is readonly InsightQuestion[] {
  if (!Array.isArray(value) || value.length > 3) return false
  const seen = new Set<string>()
  return value.every((question) => isObject(question)
    && isNonEmptyString(question.id)
    && isNonEmptyString(question.text)
    && !seen.has(question.id)
    && (seen.add(question.id), true))
}

function validClarification(value: unknown, maxQuestions: number): value is InsightClarification {
  if (!isObject(value) || !validQuestions(value.questions) || value.questions.length > maxQuestions) return false
  if (value.brief !== undefined && typeof value.brief !== 'string') return false
  return value.questions.length > 0 || isNonEmptyString(value.brief)
}

function validOutcome(stage: InsightStageRecord, value: unknown, maxQuestions: number): value is InsightStageOutcome {
  if (!externalStage(stage) || !isObject(value) || !validResource(value.resource)) return false
  const resource = value.resource
  if (copyResource(stage.resource, resource) === undefined) return false
  if (value.kind === 'complete') {
    return validObserved(value.observed)
      && validPortArtifact(value.artifact, stage.requested.provider)
      && (stage.stage !== 'clarify' || validClarification(value.clarification, maxQuestions))
  }
  if (value.kind === 'quota-exhausted') {
    return isNonEmptyString(value.evidence)
      && value.certainty === 'no-active-effect'
      && (value.resetInformation === undefined || typeof value.resetInformation === 'string')
  }
  if (value.kind === 'unknown') {
    return isNonEmptyString(value.reason) && (value.observed === undefined || validObserved(value.observed))
  }
  if (value.kind === 'failed') {
    return isNonEmptyString(value.code)
      && isNonEmptyString(value.reason)
      && (value.certainty === 'no-active-effect' || value.certainty === 'settled')
  }
  return false
}

function visibleTokens(text: string): readonly string[] {
  const matches = text.match(/https?:\/\/[^\s)\]]+|\[(?:\d+(?:[,\-–]\d+)*)\]|[-+]?\d[\d,]*(?:\.\d+)?(?:%|年|月|日|次|个|小时|分钟)?/gu) ?? []
  return [...new Set(matches)]
}

/** Deliberately conservative: catches visible number/citation loss, not semantic equivalence. */
export function validateVisibleFidelity(before: string, after: string): readonly string[] {
  const missing = visibleTokens(before).filter((token) => !after.includes(token))
  return [...new Set(missing)]
}

/**
 * Durable orchestration for the fixed Insight path.  It owns no browser,
 * native runner, model client, or user interface.
 */
export class InsightController {
  private readonly store: InsightStore
  private readonly ports: InsightPorts
  private readonly config: InsightConfigV1
  private readonly active = new Map<string, ActiveOperation>()

  constructor(options: InsightControllerOptions) {
    assertInsightConfig(options.config)
    this.store = options.store
    this.ports = options.ports
    this.config = cloneInsight(options.config)
  }

  start(input: InsightStartInput): Promise<InsightRun> {
    const request = this.requestFor(input)
    const signature = stableInsightJson(request)
    const current = this.active.get(input.id)
    if (current?.promise) {
      if (current.signature !== signature) return Promise.reject(workflowError('INSIGHT_COMMAND_CONFLICT', 'Insight run id is active with different input or configuration'))
      return current.promise
    }
    return this.launch(input.id, signature, false, async (operation) => {
      await this.store.create(input.id, request)
      return this.advance(input.id, operation)
    })
  }

  async inspect(id: string): Promise<InsightRun | undefined> {
    this.assertId(id)
    return this.store.read(id)
  }

  resume(id: string): Promise<InsightRun> {
    this.assertId(id)
    const current = this.active.get(id)
    if (current?.promise) return current.promise
    return this.launch(id, `resume:${id}`, true, async (operation) => {
      const run = await this.store.read(id)
      if (!run) throw workflowError('INSIGHT_RUN_NOT_FOUND', 'Insight run was not found')
      return this.advance(id, operation)
    })
  }

  async cancel(id: string): Promise<InsightRun> {
    this.assertId(id)
    const operation = this.active.get(id)
    operation?.controller.abort()
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const run = await this.store.read(id)
      if (!run) throw workflowError('INSIGHT_RUN_NOT_FOUND', 'Insight run was not found')
      if (run.status === 'completed' || run.status === 'cancelled') return run
      const unresolved = run.stages.find(stageIsUnresolved)
      const changedStages = unresolved === undefined
        ? run.stages.map((stage) => (stage.status === 'needs-input' || stage.status === 'needs-confirmation')
          ? { ...stage, status: 'cancelled' as const, reason: stage.reason ?? 'INSIGHT_CANCELLED_LOCAL', completedAt: now() }
          : stage)
        : replaceStage(run, { ...unresolved, status: 'unknown', reason: unresolved.reason ?? 'INSIGHT_CANCELLED_LOCAL_UNKNOWN_EFFECT' })
      const applied = await this.apply(run, {
        status: 'cancelled',
        stages: changedStages,
        reason: run.reason ?? 'INSIGHT_CANCELLED_LOCAL',
      })
      if (applied.applied) return applied.run
    }
    throw workflowError('INSIGHT_CONTROLLER_LIMIT', 'Insight cancellation did not obtain a stable revision')
  }

  private launch(
    id: string,
    signature: string,
    allowCancelledReconcile: boolean,
    task: (operation: ActiveOperation) => Promise<InsightRun>,
  ): Promise<InsightRun> {
    const operation: ActiveOperation = { signature, controller: new AbortController(), allowCancelledReconcile }
    const promise = task(operation).finally(() => {
      if (this.active.get(id) === operation) this.active.delete(id)
    })
    operation.promise = promise
    this.active.set(id, operation)
    return promise
  }

  private requestFor(input: InsightStartInput): InsightRunRequest {
    this.assertId(input.id)
    if (!isNonEmptyString(input.question) || typeof input.conversationContext !== 'string') {
      throw workflowError('INSIGHT_INPUT_INVALID', 'Insight question and conversation context are invalid')
    }
    return {
      input: cloneInsight(input),
      config: cloneInsight(this.config),
    }
  }

  private assertId(id: string): void {
    if (typeof id !== 'string' || !UUID_PATTERN.test(id)) throw workflowError('INSIGHT_INPUT_INVALID', 'Insight run id must be a UUID')
  }

  private async advance(id: string, operation: ActiveOperation): Promise<InsightRun> {
    for (let step = 0; step < 64; step += 1) {
      const run = await this.store.read(id)
      if (!run) throw workflowError('INSIGHT_RUN_NOT_FOUND', 'Insight run was not found')
      const unresolved = run.stages.find(stageIsUnresolved)
      if (unresolved) {
        if (run.status === 'cancelled' && !operation.allowCancelledReconcile) return run
        const observed = await this.observeUnresolved(run, unresolved, operation)
        if (observed.status === 'cancelled' || observed.status === 'paused' || observed.status === 'needs-input' || observed.status === 'needs-confirmation') return observed
        continue
      }
      if (operation.controller.signal.aborted) return this.afterAbort(id)
      if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled' || run.status === 'paused') return run
      if (run.status === 'needs-input') {
        if (run.reason === 'INSIGHT_CLARIFICATION_ROUND_LIMIT') return run
        const questions = latestStage(run, 'questions')
        if (!questions || questions.status !== 'needs-input') return this.pause(run, 'INSIGHT_QUESTIONS_STATE_INVALID')
        return this.askQuestions(run, questions, operation)
      }
      if (run.status === 'needs-confirmation') {
        const confirmation = latestStage(run, 'plan-confirmation')
        if (!confirmation || confirmation.status !== 'needs-confirmation') return this.pause(run, 'INSIGHT_CONFIRMATION_STATE_INVALID')
        return this.confirmPlan(run, confirmation, operation)
      }

      const brief = assetByKind(run, 'research-brief')
      if (!brief) {
        const clarify = latestStage(run, 'clarify')
        if (clarify?.status === 'complete' && clarify.questions && clarify.questions.length > 0) {
          const questions = latestStage(run, 'questions')
          if (!questions || questions.round !== clarify.round) return this.beginQuestions(run, clarify, operation)
          if (questions.status === 'complete') {
            const nextRound = (clarify.round ?? 0) + 1
            if (nextRound > run.request.config.clarification.maxRounds) return this.needsInput(run, 'INSIGHT_CLARIFICATION_ROUND_LIMIT')
            return this.beginExternal(run, { stage: 'clarify', kind: 'native', round: nextRound }, operation)
          }
          return this.askQuestions(run, questions, operation)
        }
        const nextRound = (clarify?.round ?? 0) + 1
        if (nextRound > run.request.config.clarification.maxRounds) return this.needsInput(run, 'INSIGHT_CLARIFICATION_ROUND_LIMIT')
        return this.beginExternal(run, { stage: 'clarify', kind: 'native', round: nextRound }, operation)
      }

      const plan = assetByKind(run, 'research-plan')
      if (!plan) return this.beginExternal(run, { stage: 'plan', kind: 'external' }, operation)

      const confirmation = latestStage(run, 'plan-confirmation')
      if (!confirmation || confirmation.status !== 'complete') return this.beginConfirmation(run, plan, operation)

      const research = assetByKind(run, 'gemini-research-report') ?? assetByKind(run, 'fallback-research-report')
      if (!research) {
        const geminiResearch = latestStage(run, 'research')
        if (geminiResearch?.status === 'quota-exhausted') {
          return this.beginExternal(run, {
            stage: 'research-fallback',
            kind: 'external',
            extraSections: [{ title: 'Required fallback disclosure', text: '回落报告：Gemini Deep Research 已有明确的阶段相关额度耗尽证据；此阶段使用 GPT-6 Astra Pro 网页搜索与分析，不是 ChatGPT Deep Research。' }],
          }, operation)
        }
        return this.beginExternal(run, { stage: 'research', kind: 'external' }, operation)
      }

      const critique = assetByKind(run, 'verified-report')
      if (!critique) {
        const fallback = assetByKind(run, 'fallback-research-report') !== undefined
        return this.beginExternal(run, {
          stage: 'critique',
          kind: 'external',
          extraSections: fallback
            ? [{ title: 'Required disclosure', text: '同一提供方复核：研究回落路径和本次复核均使用 ChatGPT 网页能力；这不是独立外部验证。' }]
            : [],
        }, operation)
      }

      const polished = assetByKind(run, 'polished-report')
      if (!polished) {
        const geminiKnownExhausted = run.stages.some((stage) => stage.requested?.provider === 'gemini' && stage.status === 'quota-exhausted')
        const geminiPolish = latestStage(run, 'polish')
        if (geminiKnownExhausted || geminiPolish?.status === 'quota-exhausted') {
          return this.beginExternal(run, {
            stage: 'polish-fallback',
            kind: 'external',
            extraSections: [{ title: 'Required fallback disclosure', text: 'Gemini 已有明确额度耗尽结果；本次使用 GPT-6 Astra Pro 网页搜索与分析进行润色。' }],
          }, operation)
        }
        return this.beginExternal(run, { stage: 'polish', kind: 'external' }, operation)
      }

      return this.finish(run, polished)
    }
    throw workflowError('INSIGHT_CONTROLLER_LIMIT', 'Insight workflow exceeded its local transition limit')
  }

  private render(run: InsightRun, template: InsightTemplate, extra: readonly { readonly title: string; readonly text: string }[] = []): string {
    return renderInsightTemplate(template, [
      { title: 'Original user question', text: run.request.input.question },
      { title: 'Complete conversation context', text: run.request.input.conversationContext },
      { title: 'Complete prior durable artifacts', text: fullAssetText(run.assets) },
      ...extra,
    ])
  }

  private async beginExternal(run: InsightRun, descriptor: ExternalDescriptor, operation: ActiveOperation): Promise<InsightRun> {
    const config = run.request.config
    const template = requiredStageTemplate(config, descriptor.stage)
    const requested = requiredStageSelection(config, descriptor.stage)
    const commandId = stageId(run.id, descriptor.stage, descriptor.round ?? 1)
    const already = stageAt(run, commandId)
    if (already) {
      if (stageIsUnresolved(already)) return this.observeUnresolved(run, already, operation)
      return run
    }
    const renderedInput = this.render(run, template, descriptor.extraSections)
    const resource: InsightExternalResource = { provider: requested.provider, id: commandId }
    const stage: InsightStageRecord = {
      sequence: run.stages.length + 1,
      stage: descriptor.stage,
      kind: descriptor.kind,
      commandId,
      status: Buffer.byteLength(renderedInput, 'utf8') > config.sizeLimits.maxRenderedInputBytes ? 'paused' : 'calling',
      ...(descriptor.round === undefined ? {} : { round: descriptor.round }),
      requested: cloneInsight(requested),
      resource,
      template: cloneInsight(template),
      renderedInput,
      assetIds: [],
      intentAt: now(),
      ...(Buffer.byteLength(renderedInput, 'utf8') > config.sizeLimits.maxRenderedInputBytes
        ? { reason: 'INSIGHT_RENDERED_INPUT_TOO_LARGE', completedAt: now() }
        : {}),
    }
    const applied = await this.apply(run, {
      status: stage.status === 'calling' ? 'running' : 'paused',
      stages: [...run.stages, stage],
      ...(stage.status === 'calling' ? {} : { reason: 'INSIGHT_RENDERED_INPUT_TOO_LARGE' }),
    })
    if (!applied.applied) {
      const raced = stageAt(applied.run, commandId)
      return raced && stageIsUnresolved(raced) ? this.observeUnresolved(applied.run, raced, operation) : applied.run
    }
    if (stage.status !== 'calling') return applied.run
    const persisted = stageAt(applied.run, commandId)
    return persisted ? this.executeNew(applied.run, persisted, operation) : applied.run
  }

  private async executeNew(run: InsightRun, stage: InsightStageRecord, operation: ActiveOperation): Promise<InsightRun> {
    if (!externalStage(stage)) return this.pause(run, 'INSIGHT_EXTERNAL_STAGE_INVALID')
    if (operation.controller.signal.aborted) return this.afterAbort(run.id)
    const requestBase = {
      runId: run.id,
      stage: stage.stage,
      commandId: stage.commandId,
      template: stage.template,
      renderedInput: stage.renderedInput,
      assets: cloneInsight(run.assets),
      requested: cloneInsight(stage.requested),
      resource: cloneInsight(stage.resource),
      signal: operation.controller.signal,
    }
    let outcome: unknown
    try {
      outcome = stage.stage === 'clarify'
        ? await this.waitForExternal(run, stage.stage, this.ports.clarify({ ...requestBase, stage: 'clarify', round: stage.round ?? 1 } satisfies InsightClarifyRequest))
        : await this.waitForExternal(run, stage.stage, this.ports.execute({ ...requestBase, stage: stage.stage as InsightExternalExecuteRequest['stage'] } satisfies InsightExternalExecuteRequest))
    } catch {
      return this.unknown(run, stage, 'INSIGHT_PORT_THROWN_BEFORE_KNOWN_RECEIPT', undefined, operation)
    }
    if (outcome === LOCAL_WAIT_TIMEOUT) return this.unknown(run, stage, 'INSIGHT_LOCAL_WAIT_TIMEOUT', undefined, operation)
    if (operation.controller.signal.aborted) return this.afterAbort(run.id)
    const applied = await this.applyExternalOutcome(run, stage.commandId, outcome, operation)
    return applied.status === 'running' ? this.advance(applied.id, operation) : applied
  }

  private async observeUnresolved(run: InsightRun, stage: InsightStageRecord, operation: ActiveOperation): Promise<InsightRun> {
    if (!externalStage(stage)) return this.pause(run, 'INSIGHT_UNRESOLVED_STAGE_INVALID')
    if (operation.controller.signal.aborted) return this.afterAbort(run.id)
    let outcome: unknown
    try {
      outcome = await this.waitForExternal(run, stage.stage, this.ports.observe({
        runId: run.id,
        stage: stage.stage,
        commandId: stage.commandId,
        template: stage.template,
        renderedInput: stage.renderedInput,
        assets: cloneInsight(run.assets),
        requested: cloneInsight(stage.requested),
        resource: cloneInsight(stage.resource),
        signal: operation.controller.signal,
      }))
    } catch {
      return stage.status === 'unknown'
        ? run
        : this.unknown(run, stage, 'INSIGHT_OBSERVE_THROWN_BEFORE_KNOWN_RECEIPT', undefined, operation)
    }
    if (outcome === LOCAL_WAIT_TIMEOUT) return this.unknown(run, stage, 'INSIGHT_LOCAL_WAIT_TIMEOUT', undefined, operation)
    if (operation.controller.signal.aborted) return this.afterAbort(run.id)
    const applied = await this.applyExternalOutcome(run, stage.commandId, outcome, operation)
    return applied.status === 'running' ? this.advance(applied.id, operation) : applied
  }

  private async applyExternalOutcome(run: InsightRun, commandId: string, outcome: unknown, operation: ActiveOperation): Promise<InsightRun> {
    const current = await this.store.read(run.id)
    if (!current) throw workflowError('INSIGHT_RUN_NOT_FOUND', 'Insight run was not found')
    const stage = stageAt(current, commandId)
    if (!stage || !stageIsUnresolved(stage)) return current
    if (!validOutcome(stage, outcome, current.request.config.clarification.maxQuestionsPerRound)) {
      return this.unknown(current, stage, 'INSIGHT_PORT_OUTCOME_INVALID', undefined, operation)
    }
    if (outcome.kind === 'unknown') return this.unknown(current, stage, outcome.reason, outcome.observed, operation, outcome.resource)
    if (outcome.kind === 'failed') return this.knownFailure(current, stage, outcome)
    if (outcome.kind === 'quota-exhausted') return this.quotaExhausted(current, stage, outcome)
    return this.completeExternal(current, stage, outcome, operation)
  }

  private async knownFailure(
    run: InsightRun,
    stage: InsightStageRecord,
    outcome: Extract<InsightStageOutcome, { readonly kind: 'failed' }>,
  ): Promise<InsightRun> {
    if (!externalStage(stage)) return this.pause(run, 'INSIGHT_EXTERNAL_STAGE_INVALID')
    const resource = copyResource(stage.resource, outcome.resource)
    if (!resource) return this.pause(run, 'INSIGHT_RESOURCE_CONFLICT')
    const next: InsightStageRecord = {
      ...stage,
      status: 'failed',
      resource,
      failureCode: outcome.code,
      reason: outcome.reason,
      completedAt: now(),
    }
    return (await this.apply(run, {
      status: 'failed',
      stages: replaceStage(run, next),
      reason: `${outcome.code}: ${outcome.reason}`,
    })).run
  }

  private async unknown(
    run: InsightRun,
    stage: InsightStageRecord,
    reason: string,
    observed: InsightObservedSelection | undefined,
    operation: ActiveOperation,
    resource?: InsightExternalResource,
  ): Promise<InsightRun> {
    if (!externalStage(stage)) return this.pause(run, 'INSIGHT_UNRESOLVED_STAGE_INVALID')
    if (stage.status === 'unknown') return run
    const mergedResource = resource === undefined ? stage.resource : copyResource(stage.resource, resource)
    if (!mergedResource || (stage.observed !== undefined && observed !== undefined && !sameJson(stage.observed, observed))) {
      return this.pause(run, 'INSIGHT_RESOURCE_OR_OBSERVATION_CONFLICT')
    }
    const next: InsightStageRecord = {
      ...stage,
      status: 'unknown',
      resource: mergedResource,
      ...(stage.observed === undefined && observed !== undefined ? { observed: cloneInsight(observed) } : {}),
      reason: stage.reason ?? reason,
    }
    const applied = await this.apply(run, {
      status: operation.controller.signal.aborted || run.status === 'cancelled' ? 'cancelled' : 'paused',
      stages: replaceStage(run, next),
      reason: run.reason ?? (operation.controller.signal.aborted ? 'INSIGHT_CANCELLED_LOCAL' : reason),
    })
    return applied.run
  }

  private async quotaExhausted(run: InsightRun, stage: InsightStageRecord, outcome: Extract<InsightStageOutcome, { readonly kind: 'quota-exhausted' }>): Promise<InsightRun> {
    if (!externalStage(stage)) return this.pause(run, 'INSIGHT_EXTERNAL_STAGE_INVALID')
    const resource = copyResource(stage.resource, outcome.resource)
    if (!resource) return this.pause(run, 'INSIGHT_RESOURCE_CONFLICT')
    const next: InsightStageRecord = {
      ...stage,
      status: 'quota-exhausted',
      resource,
      quotaEvidence: outcome.evidence,
      ...(outcome.resetInformation === undefined ? {} : { resetInformation: outcome.resetInformation }),
      completedAt: now(),
    }
    const permitsFallback = stage.requested.provider === 'gemini' && (stage.stage === 'research' || stage.stage === 'polish')
    const applied = await this.apply(run, {
      status: permitsFallback ? 'running' : 'paused',
      stages: replaceStage(run, next),
      ...(permitsFallback ? {} : { reason: 'INSIGHT_QUOTA_EXHAUSTED_NO_ALLOWED_FALLBACK' }),
    })
    return applied.run
  }

  private async completeExternal(
    run: InsightRun,
    stage: InsightStageRecord,
    outcome: Extract<InsightStageOutcome, { readonly kind: 'complete' }>,
    operation: ActiveOperation,
  ): Promise<InsightRun> {
    if (!externalStage(stage)) return this.pause(run, 'INSIGHT_EXTERNAL_STAGE_INVALID')
    if (stage.observed !== undefined && !sameJson(stage.observed, outcome.observed)) return this.pause(run, 'INSIGHT_OBSERVED_SELECTION_CONFLICT')
    const resource = copyResource(stage.resource, outcome.resource)
    if (!resource) return this.pause(run, 'INSIGHT_RESOURCE_CONFLICT')
    const fullArtifact = this.createArtifact(run, stage, outcome.artifact, this.artifactKind(stage.stage, run), now())
    const additions: InsightArtifact[] = [fullArtifact]
    let updatedStage: InsightStageRecord = {
      ...stage,
      status: 'complete',
      resource,
      observed: cloneInsight(outcome.observed),
      assetIds: [...stage.assetIds, fullArtifact.id],
      completedAt: now(),
    }
    let runStatus: InsightRun['status'] = run.status === 'cancelled' ? 'cancelled' : 'running'
    let runReason: string | undefined

    if (stage.stage === 'clarify') {
      const clarification = outcome.clarification
      if (!clarification) return this.unknown(run, stage, 'INSIGHT_CLARIFICATION_MISSING', undefined, operation)
      if (clarification.questions.length === 0) {
        const brief = clarification.brief
        if (!brief) return this.unknown(run, stage, 'INSIGHT_BRIEF_MISSING', undefined, operation)
        const briefArtifact = this.derivedArtifact(run, stage, 'research-brief', brief, {
          ...outcome.artifact.provenance,
          source: 'Native clarification research brief',
        }, now())
        additions.push(briefArtifact)
        updatedStage = { ...updatedStage, assetIds: [...updatedStage.assetIds, briefArtifact.id] }
      } else {
        updatedStage = { ...updatedStage, questions: cloneInsight(clarification.questions) }
      }
    }

    if (stage.stage === 'polish' || stage.stage === 'polish-fallback') {
      const before = assetByKind(run, 'verified-report')
      if (!before) return this.pause(run, 'INSIGHT_PRE_POLISH_ASSET_MISSING')
      const missing = validateVisibleFidelity(before.text, outcome.artifact.text)
      if (missing.length > 0) {
        updatedStage = {
          ...updatedStage,
          status: 'rejected',
          reason: 'INSIGHT_POLISH_VISIBLE_FIDELITY_LOSS',
        }
        runStatus = run.status === 'cancelled' ? 'cancelled' : 'paused'
        runReason = 'INSIGHT_POLISH_VISIBLE_FIDELITY_LOSS'
      }
    }
    const applied = await this.apply(run, {
      status: runStatus,
      stages: replaceStage(run, updatedStage),
      assets: [...run.assets, ...additions],
      ...(runReason === undefined ? {} : { reason: runReason }),
    })
    return applied.run
  }

  private artifactKind(stage: InsightStageName, run: InsightRun): string {
    switch (stage) {
      case 'clarify': return 'clarification-response'
      case 'plan': return 'research-plan'
      case 'research': return 'gemini-research-report'
      case 'research-fallback': return 'fallback-research-report'
      case 'critique': return 'verified-report'
      case 'polish':
      case 'polish-fallback': return 'polished-report'
      default: return `stage-${stage}-artifact`
    }
  }

  private createArtifact(run: InsightRun, stage: InsightStageRecord, artifact: InsightPortArtifact, kind: string, createdAt: string): InsightArtifact {
    const fallback = stage.stage === 'research-fallback' || stage.stage === 'polish-fallback'
    const sameProviderReview = stage.stage === 'critique' && assetByKind(run, 'fallback-research-report') !== undefined
    return this.derivedArtifact(run, stage, kind, artifact.text, {
      ...cloneInsight(artifact.provenance),
      ...(fallback ? { fallback: true, source: `回落报告：${artifact.provenance.source}` } : {}),
      ...(sameProviderReview ? { sameProviderReview: true } : {}),
    }, createdAt)
  }

  private derivedArtifact(_run: InsightRun, stage: InsightStageRecord, kind: string, text: string, provenance: InsightProvenance, createdAt: string): InsightArtifact {
    return {
      id: `${stage.commandId}:${kind}`,
      stageCommandId: stage.commandId,
      kind,
      text,
      provenance: cloneInsight(provenance),
      createdAt,
    }
  }

  private async beginQuestions(run: InsightRun, clarify: InsightStageRecord, operation: ActiveOperation): Promise<InsightRun> {
    const questions = clarify.questions
    if (!questions || !clarify.round) return this.pause(run, 'INSIGHT_QUESTIONS_MISSING')
    const commandId = stageId(run.id, 'questions', clarify.round)
    const existing = stageAt(run, commandId)
    if (existing) return this.askQuestions(run, existing, operation)
    const renderedInput = this.render(run, run.request.config.clarification.template, [{ title: 'Necessary questions', text: questions.map((question) => `${question.id}: ${question.text}`).join('\n') }])
    const stage: InsightStageRecord = {
      sequence: run.stages.length + 1,
      stage: 'questions',
      kind: 'host-question',
      commandId,
      status: 'needs-input',
      round: clarify.round,
      template: cloneInsight(run.request.config.clarification.template),
      renderedInput,
      assetIds: [],
      questions: cloneInsight(questions),
      intentAt: now(),
    }
    const applied = await this.apply(run, { status: 'needs-input', stages: [...run.stages, stage] })
    if (!applied.applied) return applied.run
    const persisted = stageAt(applied.run, commandId)
    return persisted ? this.askQuestions(applied.run, persisted, operation) : applied.run
  }

  private async askQuestions(run: InsightRun, stage: InsightStageRecord, operation: ActiveOperation): Promise<InsightRun> {
    if (stage.stage !== 'questions' || stage.status !== 'needs-input' || !stage.questions || !stage.round || !stage.template) {
      return this.pause(run, 'INSIGHT_QUESTIONS_STATE_INVALID')
    }
    if (operation.controller.signal.aborted) return this.afterAbort(run.id)
    let outcome: Awaited<ReturnType<InsightPorts['askQuestions']>>
    try {
      outcome = await this.ports.askQuestions({
        runId: run.id,
        stage: 'questions',
        commandId: stage.commandId,
        template: stage.template,
        renderedInput: stage.renderedInput,
        assets: cloneInsight(run.assets),
        questions: cloneInsight(stage.questions),
        round: stage.round,
        signal: operation.controller.signal,
      } satisfies InsightQuestionRequest)
    } catch {
      return run
    }
    if (operation.controller.signal.aborted) return (await this.store.read(run.id)) ?? run
    if (outcome.kind === 'pending') return run
    if (outcome.kind === 'cancelled') {
      const next = { ...stage, status: 'cancelled' as const, reason: outcome.reason, completedAt: now() }
      return (await this.apply(run, { status: 'cancelled', stages: replaceStage(run, next), reason: 'INSIGHT_QUESTION_INPUT_CANCELLED' })).run
    }
    if (!this.completeAnswers(stage.questions, outcome.answers)) return run
    const asset = this.derivedArtifact(run, stage, 'clarification-answers', answerText(stage.questions, outcome.answers), {
      provider: 'host',
      source: 'Exact answers supplied through the host conversation',
      visibleEvidence: [],
      citations: [],
      limitations: [],
    }, now())
    const next: InsightStageRecord = {
      ...stage,
      status: 'complete',
      answers: cloneInsight(outcome.answers),
      assetIds: [...stage.assetIds, asset.id],
      completedAt: now(),
    }
    const applied = await this.apply(run, { status: 'running', stages: replaceStage(run, next), assets: [...run.assets, asset] })
    return applied.run.status === 'running' ? this.advance(applied.run.id, operation) : applied.run
  }

  private completeAnswers(questions: readonly InsightQuestion[], answers: readonly InsightAnswer[]): boolean {
    if (answers.length !== questions.length) return false
    const expected = new Set(questions.map((question) => question.id))
    const actual = new Set<string>()
    for (const answer of answers) {
      if (!expected.has(answer.questionId) || actual.has(answer.questionId) || !isNonEmptyString(answer.text)) return false
      actual.add(answer.questionId)
    }
    return actual.size === expected.size
  }

  private async beginConfirmation(run: InsightRun, plan: InsightArtifact, operation: ActiveOperation): Promise<InsightRun> {
    const commandId = stageId(run.id, 'plan-confirmation')
    const existing = stageAt(run, commandId)
    if (existing) return this.confirmPlan(run, existing, operation)
    const template = run.request.config.plan.template
    const renderedInput = this.render(run, template, [{ title: 'Plan awaiting explicit confirmation', text: plan.text }])
    const stage: InsightStageRecord = {
      sequence: run.stages.length + 1,
      stage: 'plan-confirmation',
      kind: 'host-confirmation',
      commandId,
      status: 'needs-confirmation',
      template: cloneInsight(template),
      renderedInput,
      assetIds: [],
      intentAt: now(),
    }
    const applied = await this.apply(run, { status: 'needs-confirmation', stages: [...run.stages, stage] })
    if (!applied.applied) return applied.run
    const persisted = stageAt(applied.run, commandId)
    return persisted ? this.confirmPlan(applied.run, persisted, operation) : applied.run
  }

  private async confirmPlan(run: InsightRun, stage: InsightStageRecord, operation: ActiveOperation): Promise<InsightRun> {
    if (stage.stage !== 'plan-confirmation' || stage.status !== 'needs-confirmation' || !stage.template) return this.pause(run, 'INSIGHT_CONFIRMATION_STATE_INVALID')
    const plan = assetByKind(run, 'research-plan')
    if (!plan) return this.pause(run, 'INSIGHT_PLAN_MISSING')
    if (operation.controller.signal.aborted) return (await this.store.read(run.id)) ?? run
    let outcome: Awaited<ReturnType<InsightPorts['confirmPlan']>>
    try {
      outcome = await this.ports.confirmPlan({
        runId: run.id,
        stage: 'plan-confirmation',
        commandId: stage.commandId,
        template: stage.template,
        renderedInput: stage.renderedInput,
        assets: cloneInsight(run.assets),
        plan: cloneInsight(plan),
        signal: operation.controller.signal,
      } satisfies InsightPlanConfirmationRequest)
    } catch {
      return run
    }
    if (operation.controller.signal.aborted) return (await this.store.read(run.id)) ?? run
    if (outcome.kind === 'pending') return run
    if (outcome.kind === 'declined') {
      const next = { ...stage, status: 'rejected' as const, reason: outcome.reason, completedAt: now() }
      return (await this.apply(run, { status: 'paused', stages: replaceStage(run, next), reason: 'INSIGHT_PLAN_NOT_CONFIRMED' })).run
    }
    const next = { ...stage, status: 'complete' as const, completedAt: now() }
    const applied = await this.apply(run, { status: 'running', stages: replaceStage(run, next) })
    return applied.run.status === 'running' ? this.advance(applied.run.id, operation) : applied.run
  }

  private async finish(run: InsightRun, polished: InsightArtifact): Promise<InsightRun> {
    const commandId = stageId(run.id, 'final')
    if (stageAt(run, commandId)) return run
    const fallbackResearch = assetByKind(run, 'fallback-research-report') !== undefined
    const fallbackPolish = latestStage(run, 'polish-fallback')?.status === 'complete'
    const labels = [
      `研究路径：${fallbackResearch ? 'GPT-6 Astra Pro 网页搜索与分析（回落报告）' : 'Gemini 4 Argon Deep Research'}`,
      `复核路径：GPT-6 Astra Pro 网页搜索与分析${fallbackResearch ? '；同一提供方复核，不构成独立外部验证' : ''}`,
      `润色路径：${fallbackPolish ? 'GPT-6 Astra Pro 网页搜索与分析（Gemini 已知额度耗尽后的回落）' : 'Gemini 4 Argon（high）'}`,
      '网页模型和模式的实际显示身份以各阶段端口保存的 observed 字段为准；未公开的字段不作推断。',
    ]
    const finalMarkdown = [
      polished.text,
      '',
      '---',
      '',
      '## 来源与限制',
      ...labels.map((label) => `- ${label}`),
    ].join('\n')
    const renderedInput = this.render(run, run.request.config.delivery.template, [{ title: 'Selected polished report', text: polished.text }])
    const stage: InsightStageRecord = {
      sequence: run.stages.length + 1,
      stage: 'final',
      kind: 'local',
      commandId,
      status: 'complete',
      template: cloneInsight(run.request.config.delivery.template),
      renderedInput,
      assetIds: [polished.id],
      completedAt: now(),
    }
    return (await this.apply(run, {
      status: 'completed',
      stages: [...run.stages, stage],
      finalMarkdown,
      finalProvenance: labels,
    })).run
  }

  private async needsInput(run: InsightRun, reason: string): Promise<InsightRun> {
    return (await this.apply(run, { status: 'needs-input', reason })).run
  }

  private async pause(run: InsightRun, reason: string): Promise<InsightRun> {
    if (run.status === 'cancelled') return run
    return (await this.apply(run, { status: 'paused', reason })).run
  }

  private async afterAbort(id: string): Promise<InsightRun> {
    const current = await this.store.read(id)
    if (!current) throw workflowError('INSIGHT_RUN_NOT_FOUND', 'Insight run was not found')
    if (current.status === 'cancelled') return current
    return this.cancel(id)
  }

  private async apply(run: InsightRun, patch: Parameters<InsightStore['transition']>[2]): Promise<Applied> {
    try {
      return { run: await this.store.transition(run.id, run.revision, patch), applied: true }
    } catch (error) {
      if (!isStateConflict(error)) throw error
      const current = await this.store.read(run.id)
      if (!current) throw workflowError('INSIGHT_RUN_NOT_FOUND', 'Insight run was not found')
      return { run: current, applied: false }
    }
  }

  private async waitForExternal<T>(run: InsightRun, stage: InsightStageName, promise: Promise<T>): Promise<T | typeof LOCAL_WAIT_TIMEOUT> {
    if (stage !== 'research' && stage !== 'research-fallback') return promise
    let timeout: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        promise,
        new Promise<typeof LOCAL_WAIT_TIMEOUT>((resolve) => {
          timeout = setTimeout(() => resolve(LOCAL_WAIT_TIMEOUT), run.request.config.researchWaitMs)
        }),
      ])
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }
}

const LOCAL_WAIT_TIMEOUT = Symbol('INSIGHT_LOCAL_WAIT_TIMEOUT')
