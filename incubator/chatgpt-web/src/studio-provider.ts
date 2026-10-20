import { join } from 'node:path'

import type {
  JsonObject,
  JsonValue,
  StudioEdge,
  StudioGraph,
  StudioIssue,
  StudioNode,
  StudioNodeKind,
  StudioProvider,
  StudioRun,
} from '@lisihao/dsh-solar-native-collaboration/studio-contracts'
import {
  cloneInsight,
  renderInsightTemplate,
  stableInsightJson,
  templateHash,
  versionedTemplate,
  type InsightAnswer,
  type InsightArtifact,
  type InsightClarification,
  type InsightClarifyRequest,
  type InsightConfigV1,
  type InsightExternalResource,
  type InsightModelSelection,
  type InsightObservedSelection,
  type InsightPlanConfirmationRequest,
  type InsightPlanConfirmationOutcome,
  type InsightPortArtifact,
  type InsightQuestion,
  type InsightQuestionOutcome,
  type InsightQuestionRequest,
  type InsightStageOutcome,
  type InsightTemplate,
} from './insight-contract.js'
import {
  StudioExecutionStore,
  StudioExecutionStoreError,
  studioRunFromRecord,
  type StudioExecutionPatch,
  type StudioExecutionPhase,
  type StudioExecutionRecord,
  type StudioNodeExecution,
  type StudioPhaseExecution,
} from './studio-execution-store.js'

export type StudioExternalPhase = 'web' | 'clarify' | 'plan' | 'research' | 'thinking' | 'search' | 'review'

export interface StudioPortContext {
  /** Stable full-workflow identity. It is the Studio command id, not a phase id. */
  readonly runId: string
  readonly sessionId: string
  readonly nodeId: string
  readonly nodeKind: StudioNodeKind
  /** Immutable local phase identity; it does not imply a new provider page. */
  readonly phase: StudioExternalPhase | 'clarify' | 'questions' | 'confirmation'
}

export interface StudioExternalPortRequest extends StudioPortContext {
  readonly phase: StudioExternalPhase
  readonly commandId: string
  /** For Gemini research, plan and research may intentionally share this resource. */
  readonly resource: InsightExternalResource
  readonly requested: InsightModelSelection
  readonly template: InsightTemplate
  readonly renderedInput: string
  readonly assets: readonly InsightArtifact[]
  readonly signal?: AbortSignal
}

export interface StudioClarifyPortRequest extends InsightClarifyRequest, StudioPortContext {
  readonly nodeKind: 'clarify'
  readonly phase: 'clarify'
}

export interface StudioQuestionPortRequest extends InsightQuestionRequest, StudioPortContext {
  readonly nodeKind: 'clarify'
  readonly phase: 'questions'
}

export interface StudioPlanConfirmationPortRequest extends InsightPlanConfirmationRequest, StudioPortContext {
  readonly nodeKind: 'gemini-research'
  readonly phase: 'confirmation'
}

/**
 * The concrete binding intentionally has a richer request than InsightPorts:
 * ordinary Web stages must not pretend to be critique/search stages merely to
 * fit the fixed Insight controller's union.
 */
export interface StudioBoundPorts {
  clarify(request: StudioClarifyPortRequest): Promise<InsightStageOutcome>
  askQuestions(request: StudioQuestionPortRequest): Promise<InsightQuestionOutcome>
  confirmPlan(request: StudioPlanConfirmationPortRequest): Promise<InsightPlanConfirmationOutcome>
  execute(request: StudioExternalPortRequest): Promise<InsightStageOutcome>
  observe(request: StudioExternalPortRequest): Promise<InsightStageOutcome>
  /** Called once from the original completed execution after its result is durable. */
  finished?(runId: string, sessionId: string): Promise<void>
}

export interface StudioProviderOptions {
  /** Plugin-owned persistent root supplied by the Host binding. */
  readonly root: string
  readonly ports: StudioBoundPorts
}

export interface WebStudioGraphConfig {
  readonly requested: InsightModelSelection
  readonly template: InsightTemplate
  readonly title?: string
  readonly parameters?: JsonObject
  readonly metadata?: JsonObject
}

export interface WebStudioGraphInput {
  readonly sessionId: string
  readonly context: string
  readonly question: string
  readonly config: WebStudioGraphConfig
}

export interface InsightStudioGraphInput {
  readonly sessionId: string
  readonly context: string
  readonly question: string
  readonly config: InsightConfigV1
}

export interface StudioExecutionProvider extends StudioProvider {
  readonly store: StudioExecutionStore
  /** Explicit recovery may advance a known-no-effect phase. Inspect never does. */
  resume(sessionId: string, commandId: string, signal?: AbortSignal): Promise<StudioRun>
}

export type StudioProviderErrorCode = 'STUDIO_GRAPH_INVALID' | 'STUDIO_SESSION_MISMATCH' | 'STUDIO_COMMAND_CONFLICT' | 'STUDIO_RUN_NOT_FOUND' | 'STUDIO_PORT_INVALID'

export class StudioProviderError extends Error {
  constructor(readonly code: StudioProviderErrorCode, message: string, readonly issues?: readonly StudioIssue[]) {
    super(message)
    this.name = 'StudioProviderError'
  }
}

type ActiveOperation = {
  readonly signature: string
  readonly signal?: AbortSignal
  promise?: Promise<StudioRun>
  finished: boolean
}

type Applied = { readonly record: StudioExecutionRecord; readonly applied: boolean }

const WEB_KINDS = new Set<StudioNodeKind>(['chatgpt-web'])
const INSIGHT_KINDS = new Set<StudioNodeKind>(['clarify', 'gemini-research', 'gemini-thinking', 'chatgpt-search', 'chatgpt-review', 'output'])
const ALL_KINDS = new Set<StudioNodeKind>(['native', 'chatgpt-web', 'clarify', 'gemini-research', 'gemini-thinking', 'chatgpt-search', 'chatgpt-review', 'output'])
const OUTPUT_REPORT_PLACEHOLDER = '{report}'

function providerError(code: StudioProviderErrorCode, message: string, issues?: readonly StudioIssue[]): StudioProviderError {
  return new StudioProviderError(code, message, issues)
}

function now(): string {
  return new Date().toISOString()
}

function portSignal(signal: AbortSignal | undefined): AbortSignal {
  return signal ?? new AbortController().signal
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function cloneJson<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function asJsonObject(value: unknown): JsonObject {
  return cloneJson(value as JsonObject)
}

function equal(left: unknown, right: unknown): boolean {
  return stableInsightJson(left) === stableInsightJson(right)
}

function phaseId(commandId: string, nodeId: string, phase: StudioExecutionPhase, occurrence = 1): string {
  return `studio:${commandId}:${nodeId}:${phase}:${occurrence}`
}

function nodeState(record: StudioExecutionRecord, nodeId: string): StudioNodeExecution | undefined {
  return record.nodes.find((node) => node.nodeId === nodeId)
}

function graphNode(record: StudioExecutionRecord, nodeId: string): StudioNode | undefined {
  return record.graph.nodes.find((node) => node.id === nodeId)
}

function replaceNode(record: StudioExecutionRecord, replacement: StudioNodeExecution): readonly StudioNodeExecution[] {
  return record.nodes.map((node) => node.nodeId === replacement.nodeId ? replacement : node)
}

function phaseState(node: StudioNodeExecution, phase: StudioExecutionPhase): StudioPhaseExecution | undefined {
  for (let index = node.phases.length - 1; index >= 0; index -= 1) {
    const value = node.phases[index]
    if (value?.phase === phase) return value
  }
  return undefined
}

function phaseByCommand(record: StudioExecutionRecord, commandId: string): { readonly node: StudioNodeExecution; readonly phase: StudioPhaseExecution } | undefined {
  for (const node of record.nodes) {
    const phase = node.phases.find((candidate) => candidate.commandId === commandId)
    if (phase) return { node, phase }
  }
  return undefined
}

function replacePhase(node: StudioNodeExecution, replacement: StudioPhaseExecution): StudioNodeExecution {
  return { ...node, phases: node.phases.map((phase) => phase.commandId === replacement.commandId ? replacement : phase) }
}

function artifactById(record: StudioExecutionRecord, id: string | undefined): InsightArtifact | undefined {
  return id === undefined ? undefined : record.artifacts.find((artifact) => artifact.id === id)
}

function artifactForPhase(record: StudioExecutionRecord, phase: StudioPhaseExecution): InsightArtifact | undefined {
  const id = phase.assetIds[phase.assetIds.length - 1]
  return artifactById(record, id)
}

function edgeMaps(graph: StudioGraph): { readonly incoming: ReadonlyMap<string, readonly string[]>; readonly outgoing: ReadonlyMap<string, readonly string[]>; readonly order?: readonly string[] } {
  const incoming = new Map<string, string[]>()
  const outgoing = new Map<string, string[]>()
  for (const node of graph.nodes) {
    incoming.set(node.id, [])
    outgoing.set(node.id, [])
  }
  for (const edge of graph.edges) {
    incoming.get(edge.target)?.push(edge.source)
    outgoing.get(edge.source)?.push(edge.target)
  }
  const degree = new Map([...incoming.entries()].map(([id, values]) => [id, values.length]))
  const queue = graph.nodes.filter((node) => degree.get(node.id) === 0).map((node) => node.id)
  const order: string[] = []
  while (queue.length > 0) {
    const id = queue.shift()
    if (!id) continue
    order.push(id)
    for (const target of outgoing.get(id) ?? []) {
      const next = (degree.get(target) ?? 0) - 1
      degree.set(target, next)
      if (next === 0) queue.push(target)
    }
  }
  return { incoming, outgoing, ...(order.length === graph.nodes.length ? { order } : {}) }
}

function validSelection(value: unknown): value is InsightModelSelection {
  return isObject(value)
    && (value.provider === 'codex' || value.provider === 'gemini' || value.provider === 'chatgpt')
    && nonEmpty(value.modelLabel)
    && (value.modelId === undefined || nonEmpty(value.modelId))
    && (value.effortLabel === undefined || nonEmpty(value.effortLabel))
    && (value.modeLabel === undefined || nonEmpty(value.modeLabel))
}

function validTemplate(value: unknown): value is InsightTemplate {
  return isObject(value)
    && value.formatVersion === 1
    && nonEmpty(value.id)
    && nonEmpty(value.version)
    && typeof value.text === 'string'
    && nonEmpty(value.hash)
    && value.hash === templateHash(value.text)
}

function selectionFrom(node: StudioNode, field = 'requested'): InsightModelSelection | undefined {
  const value = node.parameters[field]
  return validSelection(value) ? cloneInsight(value) : undefined
}

function templateFrom(node: StudioNode, field = 'template'): InsightTemplate {
  const value = node.parameters[field]
  if (validTemplate(value)) {
    // The editable node prompt owns only its main template. Research plan and
    // fallback templates are independent configuration fields.
    if (field !== 'template' || value.text === node.prompt) return cloneInsight(value)
    return versionedTemplate(value.id, `${value.version}:edited`, node.prompt)
  }
  return versionedTemplate(`studio-${node.kind}`, 'edited-1', node.prompt)
}

function resourceFor(requested: InsightModelSelection, commandId: string): InsightExternalResource {
  return { provider: requested.provider, id: commandId }
}

function resourceProgression(base: InsightExternalResource, received: InsightExternalResource): InsightExternalResource | undefined {
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
  return isObject(value)
    && (value.availability === 'observed' || value.availability === 'not-exposed')
    && ['providerLabel', 'modelLabel', 'effortLabel', 'modeLabel'].every((field) => value[field] === undefined || typeof value[field] === 'string')
}

function validArtifact(value: unknown, provider: InsightModelSelection['provider']): value is InsightPortArtifact {
  if (!isObject(value) || typeof value.text !== 'string') return false
  const provenance = value.provenance
  if (!isObject(provenance) || provenance.provider !== provider || !nonEmpty(provenance.source)) return false
  return ['visibleEvidence', 'citations', 'limitations'].every((field) => {
    const items = provenance[field]
    return Array.isArray(items) && items.every((item: unknown) => typeof item === 'string')
  })
}

function validResource(value: unknown): value is InsightExternalResource {
  return isObject(value)
    && (value.provider === 'codex' || value.provider === 'gemini' || value.provider === 'chatgpt')
    && nonEmpty(value.id)
    && (value.remoteId === undefined || nonEmpty(value.remoteId))
    && (value.url === undefined || nonEmpty(value.url))
}

function validQuestions(value: unknown, max: number): value is readonly InsightQuestion[] {
  if (!Array.isArray(value) || value.length > max) return false
  const ids = new Set<string>()
  return value.every((question) => isObject(question)
    && nonEmpty(question.id)
    && nonEmpty(question.text)
    && !ids.has(question.id)
    && (ids.add(question.id), true))
}

function validOutcome(phase: StudioPhaseExecution, value: unknown, clarifyMax = 3): value is InsightStageOutcome {
  if (!isObject(value) || !validResource(value.resource) || !phase.resource || resourceProgression(phase.resource, value.resource) === undefined) return false
  if (value.kind === 'complete') {
    const requested = phase.requested
    if (!requested || !validObserved(value.observed) || !validArtifact(value.artifact, requested.provider)) return false
    if (phase.phase === 'clarify') {
      const clarification = value.clarification
      return isObject(clarification)
        && validQuestions(clarification.questions, clarifyMax)
        && (clarification.questions.length > 0 || nonEmpty(clarification.brief))
    }
    return true
  }
  if (value.kind === 'quota-exhausted') return nonEmpty(value.evidence) && value.certainty === 'no-active-effect'
  if (value.kind === 'unknown') return nonEmpty(value.reason) && (value.observed === undefined || validObserved(value.observed))
  return value.kind === 'failed'
    && nonEmpty(value.code)
    && nonEmpty(value.reason)
    && (value.certainty === 'no-active-effect' || value.certainty === 'settled')
}

function answerComplete(questions: readonly InsightQuestion[], answers: readonly InsightAnswer[]): boolean {
  if (questions.length !== answers.length) return false
  const expected = new Set(questions.map((question) => question.id))
  const seen = new Set<string>()
  return answers.every((answer) => nonEmpty(answer.questionId) && nonEmpty(answer.text) && expected.has(answer.questionId) && !seen.has(answer.questionId) && (seen.add(answer.questionId), true))
}

function answerText(questions: readonly InsightQuestion[], answers: readonly InsightAnswer[]): string {
  const values = new Map(answers.map((answer) => [answer.questionId, answer.text]))
  return questions.map((question) => `question-id: ${question.id}\nquestion: ${question.text}\nanswer:\n${values.get(question.id) ?? ''}`).join('\n\n')
}

function asContext(graph: StudioGraph): { readonly context: string; readonly question: string; readonly config: string } | undefined {
  const context = graph.metadata.context
  const question = graph.metadata.question
  if (typeof context !== 'string' || typeof question !== 'string') return undefined
  return { context, question, config: JSON.stringify(graph.parameters.config ?? {}) }
}

function predecessorArtifacts(record: StudioExecutionRecord, nodeId: string): readonly InsightArtifact[] {
  const maps = edgeMaps(record.graph)
  const sourceIds = maps.incoming.get(nodeId) ?? []
  const artifacts: InsightArtifact[] = []
  for (const sourceId of sourceIds) {
    const source = nodeState(record, sourceId)
    const artifact = source === undefined ? undefined : artifactById(record, source.outputAssetId)
    if (artifact) artifacts.push(artifact)
  }
  return artifacts
}

function completeWebRequestInput(node: StudioNode, assets: readonly InsightArtifact[]): string | undefined {
  if (node.kind !== 'chatgpt-web' || node.parameters.inputForm !== 'complete-request') return undefined
  if (assets.length === 0) return node.prompt
  // A captured ordinary-Web request already contains its complete serialized
  // conversation. Dependencies are the only additional material permitted on
  // rerun, kept in a JSON boundary without reapplying template or context.
  return `${node.prompt}\n\n${JSON.stringify({ predecessorOutputs: assets.map((artifact) => artifact.text) })}`
}

function renderInput(record: StudioExecutionRecord, node: StudioNode, template: InsightTemplate, assets: readonly InsightArtifact[], extra: readonly { readonly title: string; readonly text: string }[] = []): string {
  const completeRequest = completeWebRequestInput(node, assets)
  if (completeRequest !== undefined) return completeRequest
  const context = asContext(record.graph)
  const predecessors = assets.length === 0
    ? '(no predecessor output)'
    : assets.map((artifact) => [
      `asset-id: ${artifact.id}`,
      `provenance: ${JSON.stringify(artifact.provenance)}`,
      'full-text:',
      artifact.text,
    ].join('\n')).join('\n\n==========\n\n')
  return renderInsightTemplate(template, [
    { title: 'Session id', text: record.graph.sessionId },
    { title: 'Original user question', text: context?.question ?? '' },
    { title: 'Complete conversation context', text: context?.context ?? '' },
    { title: 'Captured graph configuration', text: context?.config ?? '{}' },
    { title: 'Edited node prompt', text: node.prompt },
    { title: 'Complete predecessor outputs', text: predecessors },
    ...extra,
  ])
}

function phaseArtifact(record: StudioExecutionRecord, phase: StudioPhaseExecution): InsightArtifact | undefined {
  return artifactForPhase(record, phase)
}

function resultArtifact(phase: StudioPhaseExecution, kind: string, artifact: InsightPortArtifact, fallback: boolean, sameProviderReview: boolean): InsightArtifact {
  return {
    id: `${phase.commandId}:output`,
    stageCommandId: phase.commandId,
    kind,
    text: artifact.text,
    provenance: {
      ...cloneInsight(artifact.provenance),
      ...(fallback ? { fallback: true, source: `回落报告：${artifact.provenance.source}` } : {}),
      ...(sameProviderReview ? { sameProviderReview: true } : {}),
    },
    createdAt: now(),
  }
}

function hasFallback(record: StudioExecutionRecord): boolean {
  return record.artifacts.some((artifact) => artifact.provenance.fallback === true)
}

function phaseIsUnresolved(phase: StudioPhaseExecution): boolean {
  return phase.status === 'calling' || phase.status === 'unknown'
}

function externalPhase(phase: StudioPhaseExecution): phase is StudioPhaseExecution & { readonly resource: InsightExternalResource; readonly requested: InsightModelSelection; readonly template: InsightTemplate } {
  return phase.resource !== undefined && phase.requested !== undefined && phase.template !== undefined
}

/** Default ordinary Web graph: no search is selected or implied. */
export function buildWebStudioGraph(input: WebStudioGraphInput): StudioGraph {
  const node: StudioNode = {
    id: 'chatgpt-web',
    label: 'ChatGPT Web',
    kind: 'chatgpt-web',
    prompt: input.question,
    parameters: {
      requested: asJsonObject(input.config.requested as unknown as JsonObject),
      template: asJsonObject(input.config.template as unknown as JsonObject),
      ...(input.config.parameters === undefined ? {} : cloneJson(input.config.parameters)),
    },
    metadata: { context: input.context, question: input.question, ...(input.config.metadata === undefined ? {} : cloneJson(input.config.metadata)) },
    position: { x: 80, y: 80 },
  }
  return {
    formatVersion: 1,
    id: `web:${input.sessionId}`,
    sessionId: input.sessionId,
    providerId: 'web',
    title: input.config.title ?? 'ChatGPT Web',
    nodes: [node],
    edges: [],
    parameters: { config: asJsonObject(input.config as unknown as JsonObject) },
    metadata: { context: input.context, question: input.question },
  }
}

/** Default editable Insight graph. The Gemini research node owns plan → confirmation → research phases. */
export function buildInsightStudioGraph(input: InsightStudioGraphInput): StudioGraph {
  const config = cloneInsight(input.config)
  const node = (id: string, label: string, kind: StudioNodeKind, prompt: string, parameters: JsonObject, x: number): StudioNode => ({
    id,
    label,
    kind,
    prompt,
    parameters,
    metadata: { context: input.context, question: input.question },
    position: { x, y: 120 },
  })
  const nodes: StudioNode[] = [
    node('clarify', '明确研究问题', 'clarify', config.clarification.template.text, {
      requested: asJsonObject(config.clarification.requested as unknown as JsonObject),
      template: asJsonObject(config.clarification.template as unknown as JsonObject),
      maxRounds: config.clarification.maxRounds,
      maxQuestionsPerRound: config.clarification.maxQuestionsPerRound,
    }, 60),
    node('gemini-research', 'Gemini 深度研究', 'gemini-research', config.research.template.text, {
      requested: asJsonObject(config.research.requested as unknown as JsonObject),
      template: asJsonObject(config.research.template as unknown as JsonObject),
      planRequested: asJsonObject(config.plan.requested as unknown as JsonObject),
      planTemplate: asJsonObject(config.plan.template as unknown as JsonObject),
      fallbackRequested: asJsonObject(config.fallbackResearch.requested as unknown as JsonObject),
      fallbackTemplate: asJsonObject(config.fallbackResearch.template as unknown as JsonObject),
    }, 330),
    node('chatgpt-review', 'ChatGPT 核验', 'chatgpt-review', config.critique.template.text, {
      requested: asJsonObject(config.critique.requested as unknown as JsonObject),
      template: asJsonObject(config.critique.template as unknown as JsonObject),
    }, 600),
    node('gemini-thinking', 'Gemini 文字润色', 'gemini-thinking', config.polish.template.text, {
      requested: asJsonObject(config.polish.requested as unknown as JsonObject),
      template: asJsonObject(config.polish.template as unknown as JsonObject),
      fallbackRequested: asJsonObject(config.fallbackPolish.requested as unknown as JsonObject),
      fallbackTemplate: asJsonObject(config.fallbackPolish.template as unknown as JsonObject),
    }, 870),
    node('output', '交付报告', 'output', config.delivery.template.text, {
      template: asJsonObject(config.delivery.template as unknown as JsonObject),
    }, 1140),
  ]
  const edges: StudioEdge[] = nodes.slice(1).map((target, index) => ({ id: `edge-${index + 1}`, source: nodes[index]?.id ?? '', target: target.id }))
  return {
    formatVersion: 1,
    id: `insight:${input.sessionId}`,
    sessionId: input.sessionId,
    providerId: 'insight',
    title: 'Insight',
    nodes,
    edges,
    parameters: { config: asJsonObject(config as unknown as JsonObject) },
    metadata: { context: input.context, question: input.question },
  }
}

class EditableStudioProvider implements StudioExecutionProvider {
  readonly store: StudioExecutionStore
  private readonly active = new Map<string, ActiveOperation>()

  constructor(
    readonly id: 'web' | 'insight',
    readonly label: string,
    private readonly options: StudioProviderOptions,
  ) {
    this.store = new StudioExecutionStore(join(options.root, 'studio-executions'))
  }

  async validate(graph: StudioGraph): Promise<readonly StudioIssue[]> {
    const issues: StudioIssue[] = []
    if (graph.formatVersion !== 1) issues.push({ field: 'formatVersion', message: 'Unsupported graph format version' })
    if (graph.providerId !== this.id) issues.push({ field: 'providerId', message: `Graph provider must be ${this.id}` })
    if (!nonEmpty(graph.sessionId)) issues.push({ field: 'sessionId', message: 'Session id is required' })
    const context = asContext(graph)
    if (!context) issues.push({ field: 'metadata', message: 'Graph must retain exact context and question strings' })
    const allowed = this.id === 'web' ? WEB_KINDS : INSIGHT_KINDS
    const ids = new Set<string>()
    for (const node of graph.nodes) {
      if (!nonEmpty(node.id) || ids.has(node.id)) issues.push({ nodeId: node.id, field: 'id', message: 'Node id must be unique and non-empty' })
      ids.add(node.id)
      if (!ALL_KINDS.has(node.kind) || !allowed.has(node.kind)) issues.push({ nodeId: node.id, field: 'kind', message: 'Node kind is not permitted by this provider' })
      if (node.kind !== 'output' && !nonEmpty(node.prompt)) issues.push({ nodeId: node.id, field: 'prompt', message: 'Executable node prompt is required' })
      if (node.kind === 'output' && !node.prompt.includes(OUTPUT_REPORT_PLACEHOLDER)) {
        issues.push({ nodeId: node.id, field: 'prompt', message: 'Output layout template must contain literal {report}' })
      }
      if (!Number.isFinite(node.position.x) || !Number.isFinite(node.position.y)) issues.push({ nodeId: node.id, field: 'position', message: 'Node position must be finite' })
      if (node.kind !== 'output') {
        if (!validSelection(selectionFrom(node))) issues.push({ nodeId: node.id, field: 'parameters.requested', message: 'Requested model selection is invalid' })
        if (!validTemplate(node.parameters.template)) issues.push({ nodeId: node.id, field: 'parameters.template', message: 'Versioned template is invalid' })
      }
      if (node.kind === 'gemini-research') {
        if (!validSelection(selectionFrom(node, 'planRequested'))) issues.push({ nodeId: node.id, field: 'parameters.planRequested', message: 'Research plan selection is invalid' })
        if (!validTemplate(node.parameters.planTemplate)) issues.push({ nodeId: node.id, field: 'parameters.planTemplate', message: 'Research plan template is invalid' })
      }
    }
    const executable = graph.nodes.filter((node) => node.kind !== 'output')
    if (executable.length === 0) issues.push({ field: 'nodes', message: 'Graph has no executable node' })
    const edgeIds = new Set<string>()
    for (const edge of graph.edges) {
      if (!nonEmpty(edge.id) || edgeIds.has(edge.id)) issues.push({ field: 'edges', message: 'Edge id must be unique and non-empty' })
      edgeIds.add(edge.id)
      if (!ids.has(edge.source) || !ids.has(edge.target) || edge.source === edge.target) issues.push({ field: 'edges', message: 'Edge endpoint is invalid' })
    }
    const maps = edgeMaps(graph)
    for (const node of graph.nodes) {
      if (node.kind === 'output' && (maps.outgoing.get(node.id)?.length ?? 0) > 0) {
        issues.push({ nodeId: node.id, field: 'edges', message: 'Output nodes must be DAG sinks' })
      }
    }
    if (maps.order === undefined) issues.push({ field: 'edges', message: 'Graph must be acyclic' })
    return issues
  }

  execute(request: { readonly commandId: string; readonly sessionId: string; readonly graph: StudioGraph; readonly signal?: AbortSignal }): Promise<StudioRun> {
    if (request.sessionId !== request.graph.sessionId) return Promise.reject(providerError('STUDIO_SESSION_MISMATCH', 'Execution session does not match the graph snapshot'))
    const signature = stableInsightJson(request.graph)
    const active = this.active.get(request.commandId)
    if (active?.promise) {
      if (active.signature !== signature) return Promise.reject(providerError('STUDIO_COMMAND_CONFLICT', 'Active command has a different graph snapshot'))
      return active.promise
    }
    return this.launch(request.commandId, signature, request.signal, async (operation) => {
      const issues = await this.validate(request.graph)
      if (issues.length > 0) throw providerError('STUDIO_GRAPH_INVALID', 'Studio graph is invalid', issues)
      const created = await this.store.create(request.commandId, request.graph)
      if (!created.created) {
        const unresolved = this.unresolved(created.record)
        return studioRunFromRecord(unresolved === undefined
          ? created.record
          : await this.observe(created.record, unresolved.node, unresolved.phase, request.signal))
      }
      const record = await this.advance(created.record, operation, true)
      return studioRunFromRecord(record)
    })
  }

  async inspect(sessionId: string, commandId: string): Promise<StudioRun> {
    const active = this.active.get(commandId)
    if (active?.promise) {
      const current = await this.store.read(sessionId, commandId)
      if (!current) throw providerError('STUDIO_RUN_NOT_FOUND', 'Studio run was not found')
      return studioRunFromRecord(current)
    }
    const record = await this.store.read(sessionId, commandId)
    if (!record) throw providerError('STUDIO_RUN_NOT_FOUND', 'Studio run was not found')
    const unresolved = this.unresolved(record)
    if (!unresolved) return studioRunFromRecord(record)
    const observed = await this.observe(record, unresolved.node, unresolved.phase, undefined)
    return studioRunFromRecord(observed)
  }

  resume(sessionId: string, commandId: string, signal?: AbortSignal): Promise<StudioRun> {
    const active = this.active.get(commandId)
    if (active?.promise) return active.promise
    return this.launch(commandId, `resume:${commandId}`, signal, async (operation) => {
      const record = await this.store.read(sessionId, commandId)
      if (!record) throw providerError('STUDIO_RUN_NOT_FOUND', 'Studio run was not found')
      const result = await this.advance(record, operation, true)
      return studioRunFromRecord(result)
    })
  }

  private launch(commandId: string, signature: string, signal: AbortSignal | undefined, task: (operation: ActiveOperation) => Promise<StudioRun>): Promise<StudioRun> {
    const operation: ActiveOperation = { signature, signal, finished: false }
    const promise = task(operation).finally(() => {
      if (this.active.get(commandId) === operation) this.active.delete(commandId)
    })
    operation.promise = promise
    this.active.set(commandId, operation)
    return promise
  }

  private async advance(initial: StudioExecutionRecord, operation: ActiveOperation, mayExecute: boolean): Promise<StudioExecutionRecord> {
    let record = initial
    for (let step = 0; step < 96; step += 1) {
      const current = await this.store.read(record.graph.sessionId, record.commandId)
      if (!current) throw providerError('STUDIO_RUN_NOT_FOUND', 'Studio run was not found')
      record = current
      const unresolved = this.unresolved(record)
      if (unresolved) {
        record = await this.observe(record, unresolved.node, unresolved.phase, operation.signal)
        if (!mayExecute || record.status === 'unknown' || record.status === 'failed' || record.status === 'cancelled') return record
        continue
      }
      if (record.status === 'completed' || record.status === 'failed' || record.status === 'cancelled' || record.status === 'unknown') return record
      if (operation.signal?.aborted) return this.abort(record)
      if (!mayExecute) return record

      const waiting = this.waiting(record)
      if (waiting) {
        record = waiting.phase.phase === 'questions'
          ? await this.answerQuestions(record, waiting.node, waiting.phase, operation.signal)
          : await this.confirmPlan(record, waiting.node, waiting.phase, operation.signal)
        if (record.status === 'needs-input' || record.status === 'unknown' || record.status === 'failed') return record
        continue
      }

      const ready = this.readyNode(record)
      if (ready) {
        record = await this.progressNode(record, ready, operation.signal)
        if (record.status === 'needs-input' || record.status === 'unknown' || record.status === 'failed') return record
        continue
      }
      if (record.nodes.every((node) => node.status === 'completed')) {
        record = await this.completeRun(record, operation)
        return record
      }
      return this.fail(record, 'STUDIO_GRAPH_BLOCKED')
    }
    return this.fail(record, 'STUDIO_TRANSITION_LIMIT')
  }

  private unresolved(record: StudioExecutionRecord): { readonly node: StudioNodeExecution; readonly phase: StudioPhaseExecution } | undefined {
    for (const node of record.nodes) {
      const phase = node.phases.find(phaseIsUnresolved)
      if (phase) return { node, phase }
    }
    return undefined
  }

  private waiting(record: StudioExecutionRecord): { readonly node: StudioNodeExecution; readonly phase: StudioPhaseExecution } | undefined {
    for (const node of record.nodes) {
      const phase = node.phases.find((candidate) => candidate.status === 'needs-input' || candidate.status === 'needs-confirmation')
      if (phase) return { node, phase }
    }
    return undefined
  }

  private readyNode(record: StudioExecutionRecord): StudioNodeExecution | undefined {
    const maps = edgeMaps(record.graph)
    for (const nodeId of maps.order ?? []) {
      const node = nodeState(record, nodeId)
      if (!node || node.status !== 'pending' && node.status !== 'running') continue
      const predecessors = maps.incoming.get(nodeId) ?? []
      if (predecessors.every((id) => nodeState(record, id)?.status === 'completed')) return node
    }
    return undefined
  }

  private async progressNode(record: StudioExecutionRecord, state: StudioNodeExecution, signal?: AbortSignal): Promise<StudioExecutionRecord> {
    const node = graphNode(record, state.nodeId)
    if (!node) return this.fail(record, 'STUDIO_NODE_MISSING')
    switch (node.kind) {
      case 'chatgpt-web': return this.progressSimple(record, state, node, 'web', signal)
      case 'chatgpt-search': return this.progressSimple(record, state, node, 'search', signal)
      case 'chatgpt-review': return this.progressSimple(record, state, node, 'review', signal)
      case 'gemini-thinking': return this.progressThinking(record, state, node, signal)
      case 'clarify': return this.progressClarify(record, state, node, signal)
      case 'gemini-research': return this.progressResearch(record, state, node, signal)
      case 'output': return this.progressOutput(record, state, node)
      default: return this.fail(record, 'STUDIO_NODE_KIND_INVALID')
    }
  }

  private async progressSimple(record: StudioExecutionRecord, state: StudioNodeExecution, node: StudioNode, phaseName: 'web' | 'search' | 'review', signal?: AbortSignal): Promise<StudioExecutionRecord> {
    const phase = phaseState(state, phaseName)
    if (phase?.status === 'complete') return this.completeNode(record, state, phase)
    if (phase?.status === 'quota-exhausted') return this.fail(record, 'STUDIO_PROVIDER_QUOTA_EXHAUSTED')
    if (phase) return record
    return this.startExternal(record, state, node, phaseName, selectionFrom(node), templateFrom(node), undefined, signal)
  }

  private async progressThinking(record: StudioExecutionRecord, state: StudioNodeExecution, node: StudioNode, signal?: AbortSignal): Promise<StudioExecutionRecord> {
    const phase = phaseState(state, 'thinking')
    if (phase?.status === 'complete') return this.completeNode(record, state, phase)
    if (phase?.status === 'quota-exhausted') {
      const fallback = phaseState(state, 'search')
      if (fallback?.status === 'complete') return this.completeNode(record, state, fallback)
      if (fallback) return record
      return this.startExternal(record, state, node, 'search', selectionFrom(node, 'fallbackRequested'), templateFrom(node, 'fallbackTemplate'), undefined, signal, true)
    }
    if (phase) return record
    return this.startExternal(record, state, node, 'thinking', selectionFrom(node), templateFrom(node), undefined, signal)
  }

  private async progressClarify(record: StudioExecutionRecord, state: StudioNodeExecution, node: StudioNode, signal?: AbortSignal): Promise<StudioExecutionRecord> {
    const clarifications = state.phases.filter((phase) => phase.phase === 'clarify')
    const last = clarifications[clarifications.length - 1]
    const maxRounds = typeof node.parameters.maxRounds === 'number' && Number.isSafeInteger(node.parameters.maxRounds) ? node.parameters.maxRounds : 3
    const maxQuestions = typeof node.parameters.maxQuestionsPerRound === 'number' && Number.isSafeInteger(node.parameters.maxQuestionsPerRound) ? Math.min(3, node.parameters.maxQuestionsPerRound) : 3
    if (last?.status === 'complete') {
      const questions = last.questions ?? []
      if (questions.length === 0) return this.completeNode(record, state, last)
      const questionPhase = state.phases.findLast((phase) => phase.phase === 'questions' && phase.round === last.round)
      if (!questionPhase) return this.startQuestions(record, state, node, last, questions, signal)
      if (questionPhase.status === 'complete') {
        const round = clarifications.length + 1
        if (round > maxRounds) return this.needsInput(record, state, 'STUDIO_CLARIFICATION_ROUND_LIMIT')
        return this.startClarify(record, state, node, round, maxQuestions, signal)
      }
      return record
    }
    if (last?.status === 'quota-exhausted' || last?.status === 'failed') return this.fail(record, 'STUDIO_CLARIFY_FAILED')
    if (last) return record
    return this.startClarify(record, state, node, 1, maxQuestions, signal)
  }

  private async progressResearch(record: StudioExecutionRecord, state: StudioNodeExecution, node: StudioNode, signal?: AbortSignal): Promise<StudioExecutionRecord> {
    const plan = phaseState(state, 'plan')
    if (!plan) return this.startExternal(record, state, node, 'plan', selectionFrom(node, 'planRequested'), templateFrom(node, 'planTemplate'), undefined, signal)
    if (plan.status !== 'complete') {
      if (plan.status === 'quota-exhausted') return this.progressResearchFallback(record, state, node, signal)
      return record
    }
    const planArtifact = phaseArtifact(record, plan)
    if (!planArtifact || !plan.resource) return this.fail(record, 'STUDIO_PLAN_ARTIFACT_OR_RESOURCE_MISSING')
    const confirmation = phaseState(state, 'confirmation')
    if (!confirmation) return this.startConfirmation(record, state, node, plan, planArtifact, signal)
    if (confirmation.status !== 'complete') return record
    const research = phaseState(state, 'research')
    if (!research) {
      return this.startExternal(record, state, node, 'research', selectionFrom(node), templateFrom(node), plan.resource, signal, false, plan.resource, [planArtifact])
    }
    if (research.status === 'complete') return this.completeNode(record, state, research)
    if (research.status === 'quota-exhausted') {
      return this.progressResearchFallback(record, state, node, signal, planArtifact)
    }
    return record
  }

  private async progressResearchFallback(
    record: StudioExecutionRecord,
    state: StudioNodeExecution,
    node: StudioNode,
    signal: AbortSignal | undefined,
    planArtifact?: InsightArtifact,
  ): Promise<StudioExecutionRecord> {
    const fallback = phaseState(state, 'search')
    if (fallback?.status === 'complete') return this.completeNode(record, state, fallback)
    if (fallback) return record
    // When Gemini rejects the plan before admission, predecessorArtifacts
    // carries the full clarified brief and there is deliberately no plan asset.
    return this.startExternal(
      record,
      state,
      node,
      'search',
      selectionFrom(node, 'fallbackRequested'),
      templateFrom(node, 'fallbackTemplate'),
      undefined,
      signal,
      true,
      undefined,
      planArtifact === undefined ? [] : [planArtifact],
    )
  }

  private async progressOutput(record: StudioExecutionRecord, state: StudioNodeExecution, node: StudioNode): Promise<StudioExecutionRecord> {
    const complete = phaseState(state, 'output')
    if (complete?.status === 'complete') return this.completeNode(record, state, complete)
    const assets = predecessorArtifacts(record, node.id)
    const template = templateFrom(node)
    const phase: StudioPhaseExecution = {
      nodeId: node.id,
      phase: 'output',
      commandId: phaseId(record.commandId, node.id, 'output'),
      status: 'complete',
      template,
      renderedInput: renderInput(record, node, template, assets),
      assetIds: [],
      intentAt: now(),
      completedAt: now(),
    }
    // Output is local layout only. It never dispatches a model or interprets
    // prompt text beyond the literal report insertion placeholder.
    const output = this.finalText(record, assets, node.prompt)
    const artifact: InsightArtifact = {
      id: `${phase.commandId}:output`,
      stageCommandId: phase.commandId,
      kind: 'studio-output',
      text: output,
      provenance: { provider: 'host', source: 'Studio output assembly', visibleEvidence: [], citations: [], limitations: this.omissionLabels(record) },
      createdAt: now(),
    }
    const nextPhase = { ...phase, assetIds: [artifact.id] }
    const nextNode: StudioNodeExecution = { ...state, status: 'completed', phases: [...state.phases, nextPhase], outputAssetId: artifact.id }
    return (await this.apply(record, { status: 'running', nodes: replaceNode(record, nextNode), artifacts: [...record.artifacts, artifact] })).record
  }

  private async startClarify(record: StudioExecutionRecord, state: StudioNodeExecution, node: StudioNode, round: number, maxQuestions: number, signal?: AbortSignal): Promise<StudioExecutionRecord> {
    const selection = selectionFrom(node)
    if (!selection) return this.fail(record, 'STUDIO_CLARIFY_SELECTION_INVALID')
    const template = templateFrom(node)
    const commandId = phaseId(record.commandId, node.id, 'clarify', round)
    const assets = predecessorArtifacts(record, node.id)
    const phase: StudioPhaseExecution = {
      nodeId: node.id,
      phase: 'clarify',
      round,
      commandId,
      status: 'calling',
      resource: resourceFor(selection, commandId),
      requested: selection,
      template,
      renderedInput: renderInput(record, node, template, assets, [{ title: 'Clarification round', text: String(round) }]),
      assetIds: [],
      intentAt: now(),
    }
    const persisted = await this.beginPhase(record, state, phase)
    if (!persisted.applied) return persisted.record
    const current = phaseByCommand(persisted.record, commandId)
    if (!current) return persisted.record
    let outcome: unknown
    try {
      outcome = await this.options.ports.clarify({
        runId: persisted.record.commandId,
        sessionId: persisted.record.graph.sessionId,
        nodeId: node.id,
        nodeKind: 'clarify',
        phase: 'clarify',
        stage: 'clarify',
        commandId,
        round,
        resource: cloneInsight(current.phase.resource as InsightExternalResource),
        requested: cloneInsight(selection),
        template: cloneInsight(template),
        renderedInput: current.phase.renderedInput,
        assets: cloneInsight(assets),
        signal: portSignal(signal),
      })
    } catch {
      return this.unknown(persisted.record, current.node, current.phase, 'STUDIO_PORT_THROWN_BEFORE_KNOWN_RECEIPT')
    }
    return this.applyOutcome(persisted.record, commandId, outcome, maxQuestions)
  }

  private async startQuestions(record: StudioExecutionRecord, state: StudioNodeExecution, node: StudioNode, clarify: StudioPhaseExecution, questions: readonly InsightQuestion[], signal?: AbortSignal): Promise<StudioExecutionRecord> {
    const commandId = phaseId(record.commandId, node.id, 'questions', state.phases.filter((phase) => phase.phase === 'questions').length + 1)
    const template = clarify.template ?? templateFrom(node)
    const assets = predecessorArtifacts(record, node.id)
    const phase: StudioPhaseExecution = {
      nodeId: node.id,
      phase: 'questions',
      round: clarify.round,
      commandId,
      status: 'needs-input',
      template,
      renderedInput: renderInput(record, node, template, assets, [{ title: 'Necessary material questions', text: questions.map((question) => `${question.id}: ${question.text}`).join('\n') }]),
      assetIds: [],
      questions: cloneInsight(questions),
      intentAt: now(),
    }
    const nextNode: StudioNodeExecution = { ...state, status: 'needs-input', phases: [...state.phases, phase] }
    const persisted = await this.apply(record, { status: 'needs-input', nodes: replaceNode(record, nextNode) })
    if (!persisted.applied) return persisted.record
    const current = phaseByCommand(persisted.record, commandId)
    return current ? this.answerQuestions(persisted.record, current.node, current.phase, signal) : persisted.record
  }

  private async answerQuestions(record: StudioExecutionRecord, state: StudioNodeExecution, phase: StudioPhaseExecution, signal?: AbortSignal): Promise<StudioExecutionRecord> {
    const node = graphNode(record, state.nodeId)
    if (!node || !phase.questions || !phase.template) return this.fail(record, 'STUDIO_QUESTION_STATE_INVALID')
    let outcome: InsightQuestionOutcome
    try {
      outcome = await this.options.ports.askQuestions({
        runId: record.commandId,
        sessionId: record.graph.sessionId,
        nodeId: node.id,
        nodeKind: 'clarify',
        phase: 'questions',
        stage: 'questions',
        commandId: phase.commandId,
        round: phase.round ?? state.phases.filter((candidate) => candidate.phase === 'questions').length,
        template: phase.template,
        renderedInput: phase.renderedInput,
        assets: cloneInsight(predecessorArtifacts(record, node.id)),
        questions: cloneInsight(phase.questions),
        signal: portSignal(signal),
      })
    } catch {
      return record
    }
    if (outcome.kind === 'pending') return record
    if (outcome.kind === 'cancelled') return this.fail(record, 'STUDIO_QUESTION_INPUT_CANCELLED')
    if (!answerComplete(phase.questions, outcome.answers)) return record
    const artifact: InsightArtifact = {
      id: `${phase.commandId}:answers`,
      stageCommandId: phase.commandId,
      kind: 'clarification-answers',
      text: answerText(phase.questions, outcome.answers),
      provenance: { provider: 'host', source: 'Exact host answers', visibleEvidence: [], citations: [], limitations: [] },
      createdAt: now(),
    }
    const nextPhase: StudioPhaseExecution = { ...phase, status: 'complete', answers: cloneInsight(outcome.answers), assetIds: [...phase.assetIds, artifact.id], completedAt: now() }
    const nextNode = replacePhase(state, nextPhase)
    return (await this.apply(record, { status: 'running', nodes: replaceNode(record, { ...nextNode, status: 'running' }), artifacts: [...record.artifacts, artifact] })).record
  }

  private async startConfirmation(record: StudioExecutionRecord, state: StudioNodeExecution, node: StudioNode, plan: StudioPhaseExecution, planArtifact: InsightArtifact, signal?: AbortSignal): Promise<StudioExecutionRecord> {
    const template = plan.template ?? templateFrom(node, 'planTemplate')
    const commandId = phaseId(record.commandId, node.id, 'confirmation')
    const phase: StudioPhaseExecution = {
      nodeId: node.id,
      phase: 'confirmation',
      commandId,
      status: 'needs-confirmation',
      template,
      renderedInput: renderInput(record, node, template, [...predecessorArtifacts(record, node.id), planArtifact], [{ title: 'Plan requires explicit approval', text: planArtifact.text }]),
      assetIds: [],
      intentAt: now(),
    }
    const nextNode: StudioNodeExecution = { ...state, status: 'needs-input', phases: [...state.phases, phase] }
    const persisted = await this.apply(record, { status: 'needs-input', nodes: replaceNode(record, nextNode) })
    if (!persisted.applied) return persisted.record
    const current = phaseByCommand(persisted.record, commandId)
    return current ? this.confirmPlan(persisted.record, current.node, current.phase, signal) : persisted.record
  }

  private async confirmPlan(record: StudioExecutionRecord, state: StudioNodeExecution, phase: StudioPhaseExecution, signal?: AbortSignal): Promise<StudioExecutionRecord> {
    const node = graphNode(record, state.nodeId)
    const plan = phaseState(state, 'plan')
    const artifact = plan === undefined ? undefined : phaseArtifact(record, plan)
    if (!node || !plan || !artifact || !phase.template) return this.fail(record, 'STUDIO_CONFIRMATION_STATE_INVALID')
    let outcome: InsightPlanConfirmationOutcome
    try {
      outcome = await this.options.ports.confirmPlan({
        runId: record.commandId,
        sessionId: record.graph.sessionId,
        nodeId: node.id,
        nodeKind: 'gemini-research',
        phase: 'confirmation',
        stage: 'plan-confirmation',
        commandId: phase.commandId,
        template: phase.template,
        renderedInput: phase.renderedInput,
        assets: cloneInsight([...predecessorArtifacts(record, node.id), artifact]),
        plan: cloneInsight(artifact),
        signal: portSignal(signal),
      })
    } catch {
      return record
    }
    if (outcome.kind === 'pending') return record
    if (outcome.kind === 'declined') return this.fail(record, 'STUDIO_PLAN_NOT_CONFIRMED')
    const next = replacePhase(state, { ...phase, status: 'complete', completedAt: now() })
    return (await this.apply(record, { status: 'running', nodes: replaceNode(record, { ...next, status: 'running' }) })).record
  }

  private async startExternal(
    record: StudioExecutionRecord,
    state: StudioNodeExecution,
    node: StudioNode,
    phaseName: StudioExternalPhase,
    requested: InsightModelSelection | undefined,
    template: InsightTemplate,
    inheritedResource: InsightExternalResource | undefined,
    signal?: AbortSignal,
    fallback = false,
    sourceResource: InsightExternalResource | undefined = undefined,
    extraAssets: readonly InsightArtifact[] = [],
  ): Promise<StudioExecutionRecord> {
    if (!requested) return this.fail(record, 'STUDIO_NODE_SELECTION_INVALID')
    const occurrence = state.phases.filter((phase) => phase.phase === phaseName).length + 1
    const commandId = phaseId(record.commandId, node.id, phaseName, occurrence)
    const resource = inheritedResource ?? resourceFor(requested, commandId)
    const assets = [...predecessorArtifacts(record, node.id), ...extraAssets]
    const phase: StudioPhaseExecution = {
      nodeId: node.id,
      phase: phaseName,
      commandId,
      status: 'calling',
      resource: cloneInsight(resource),
      ...(sourceResource === undefined ? {} : { sourceResource: cloneInsight(sourceResource) }),
      requested: cloneInsight(requested),
      template: cloneInsight(template),
      renderedInput: renderInput(record, node, template, assets, fallback ? [{ title: 'Fallback disclosure', text: '回落报告：Gemini 已明确返回本阶段额度耗尽且无活动 effect；本阶段使用 GPT-6 Astra Pro Web search and analysis。' }] : []),
      assetIds: [],
      intentAt: now(),
    }
    const persisted = await this.beginPhase(record, state, phase)
    if (!persisted.applied) return persisted.record
    const current = phaseByCommand(persisted.record, commandId)
    if (!current || !externalPhase(current.phase)) return persisted.record
    let outcome: unknown
    try {
      outcome = await this.options.ports.execute({
        runId: persisted.record.commandId,
        sessionId: persisted.record.graph.sessionId,
        nodeId: node.id,
        nodeKind: fallback ? 'chatgpt-search' : node.kind,
        phase: phaseName,
        commandId,
        resource: cloneInsight(current.phase.resource),
        requested: cloneInsight(current.phase.requested),
        template: cloneInsight(current.phase.template),
        renderedInput: current.phase.renderedInput,
        assets: cloneInsight(assets),
        signal,
      })
    } catch {
      return this.unknown(persisted.record, current.node, current.phase, 'STUDIO_PORT_THROWN_BEFORE_KNOWN_RECEIPT')
    }
    return this.applyOutcome(persisted.record, commandId, outcome, 3, fallback)
  }

  private async beginPhase(record: StudioExecutionRecord, state: StudioNodeExecution, phase: StudioPhaseExecution): Promise<Applied> {
    const nextNode: StudioNodeExecution = { ...state, status: 'running', phases: [...state.phases, phase] }
    return this.apply(record, { status: 'running', nodes: replaceNode(record, nextNode) })
  }

  private async observe(record: StudioExecutionRecord, state: StudioNodeExecution, phase: StudioPhaseExecution, signal?: AbortSignal): Promise<StudioExecutionRecord> {
    const node = graphNode(record, state.nodeId)
    if (!node || !externalPhase(phase)) return this.fail(record, 'STUDIO_UNRESOLVED_PHASE_INVALID')
    let outcome: unknown
    try {
      outcome = await this.options.ports.observe({
        runId: record.commandId,
        sessionId: record.graph.sessionId,
        nodeId: node.id,
        nodeKind: phase.phase === 'search' && phase.requested.provider === 'chatgpt' ? 'chatgpt-search' : node.kind,
        phase: phase.phase as StudioExternalPhase,
        commandId: phase.commandId,
        resource: cloneInsight(phase.resource),
        requested: cloneInsight(phase.requested),
        template: cloneInsight(phase.template),
        renderedInput: phase.renderedInput,
        assets: cloneInsight(predecessorArtifacts(record, node.id)),
        signal,
      })
    } catch {
      return phase.status === 'unknown' ? record : this.unknown(record, state, phase, 'STUDIO_OBSERVE_THROWN_BEFORE_KNOWN_RECEIPT')
    }
    const maxQuestions = node.kind === 'clarify'
      && typeof node.parameters.maxQuestionsPerRound === 'number'
      && Number.isSafeInteger(node.parameters.maxQuestionsPerRound)
      ? Math.min(3, node.parameters.maxQuestionsPerRound)
      : 3
    return this.applyOutcome(record, phase.commandId, outcome, maxQuestions, phase.phase === 'search' && phase.requested.provider === 'chatgpt')
  }

  private async applyOutcome(record: StudioExecutionRecord, commandId: string, outcome: unknown, clarifyMax: number, fallback = false): Promise<StudioExecutionRecord> {
    const fresh = await this.store.read(record.graph.sessionId, record.commandId)
    if (!fresh) throw providerError('STUDIO_RUN_NOT_FOUND', 'Studio run was not found')
    const current = phaseByCommand(fresh, commandId)
    if (!current || !phaseIsUnresolved(current.phase)) return fresh
    if (!validOutcome(current.phase, outcome, clarifyMax)) return this.unknown(fresh, current.node, current.phase, 'STUDIO_PORT_OUTCOME_INVALID')
    if (outcome.kind === 'unknown') return this.unknown(fresh, current.node, current.phase, outcome.reason, outcome.resource, outcome.observed)
    if (outcome.kind === 'failed') return this.knownFailure(fresh, current.node, current.phase, outcome)
    if (outcome.kind === 'quota-exhausted') return this.quota(fresh, current.node, current.phase, outcome)
    const resource = resourceProgression(current.phase.resource as InsightExternalResource, outcome.resource)
    if (!resource) return this.unknown(fresh, current.node, current.phase, 'STUDIO_RESOURCE_CONFLICT')
    const node = graphNode(fresh, current.node.nodeId)
    if (!node) return this.fail(fresh, 'STUDIO_NODE_MISSING')
    const sameProviderReview = node.kind === 'chatgpt-review' && hasFallback(fresh)
    const artifact = resultArtifact(current.phase, `studio-${node.kind}`, outcome.artifact, fallback, sameProviderReview)
    let nextPhase: StudioPhaseExecution = {
      ...current.phase,
      status: 'complete',
      resource,
      observed: cloneInsight(outcome.observed),
      assetIds: [...current.phase.assetIds, artifact.id],
      completedAt: now(),
    }
    if (current.phase.phase === 'clarify') {
      const clarification = outcome.clarification as InsightClarification
      nextPhase = { ...nextPhase, questions: cloneInsight(clarification.questions) }
      if (clarification.questions.length === 0) {
        const brief: InsightArtifact = {
          id: `${current.phase.commandId}:brief`,
          stageCommandId: current.phase.commandId,
          kind: 'research-brief',
          text: clarification.brief ?? '',
          provenance: { ...cloneInsight(outcome.artifact.provenance), source: 'Studio clarification brief' },
          createdAt: now(),
        }
        nextPhase = { ...nextPhase, assetIds: [...nextPhase.assetIds, brief.id] }
        const nextNode = replacePhase(current.node, nextPhase)
        return (await this.apply(fresh, { status: 'running', nodes: replaceNode(fresh, { ...nextNode, status: 'running', outputAssetId: brief.id }), artifacts: [...fresh.artifacts, artifact, brief] })).record
      }
    }
    const nextNode = replacePhase(current.node, nextPhase)
    return (await this.apply(fresh, { status: 'running', nodes: replaceNode(fresh, { ...nextNode, status: 'running', outputAssetId: artifact.id }), artifacts: [...fresh.artifacts, artifact] })).record
  }

  private async unknown(record: StudioExecutionRecord, state: StudioNodeExecution, phase: StudioPhaseExecution, reason: string, received?: InsightExternalResource, observed?: InsightObservedSelection): Promise<StudioExecutionRecord> {
    if (!phase.resource) return this.fail(record, 'STUDIO_UNRESOLVED_RESOURCE_MISSING')
    if (phase.status === 'unknown') return record
    const resource = received === undefined ? phase.resource : resourceProgression(phase.resource, received)
    if (!resource || (phase.observed !== undefined && observed !== undefined && !equal(phase.observed, observed))) return this.fail(record, 'STUDIO_RESOURCE_OR_OBSERVATION_CONFLICT')
    const nextPhase: StudioPhaseExecution = {
      ...phase,
      status: 'unknown',
      resource,
      ...(phase.observed === undefined && observed !== undefined ? { observed: cloneInsight(observed) } : {}),
      reason: phase.reason ?? reason,
    }
    const nextNode = replacePhase(state, nextPhase)
    return (await this.apply(record, { status: 'unknown', nodes: replaceNode(record, { ...nextNode, status: 'unknown' }), message: record.message ?? reason })).record
  }

  private async knownFailure(
    record: StudioExecutionRecord,
    state: StudioNodeExecution,
    phase: StudioPhaseExecution,
    outcome: Extract<InsightStageOutcome, { readonly kind: 'failed' }>,
  ): Promise<StudioExecutionRecord> {
    if (!phase.resource) return this.fail(record, 'STUDIO_FAILED_RESOURCE_MISSING')
    const resource = resourceProgression(phase.resource, outcome.resource)
    if (!resource) return this.fail(record, 'STUDIO_RESOURCE_CONFLICT')
    const nextPhase: StudioPhaseExecution = {
      ...phase,
      status: 'failed',
      resource,
      failureCode: outcome.code,
      reason: outcome.reason,
      completedAt: now(),
    }
    const nextNode = replacePhase(state, nextPhase)
    return (await this.apply(record, {
      status: 'failed',
      nodes: replaceNode(record, { ...nextNode, status: 'failed', error: `${outcome.code}: ${outcome.reason}` }),
      message: `${outcome.code}: ${outcome.reason}`,
    })).record
  }

  private async quota(record: StudioExecutionRecord, state: StudioNodeExecution, phase: StudioPhaseExecution, outcome: Extract<InsightStageOutcome, { readonly kind: 'quota-exhausted' }>): Promise<StudioExecutionRecord> {
    if (!phase.resource) return this.fail(record, 'STUDIO_QUOTA_RESOURCE_MISSING')
    const resource = resourceProgression(phase.resource, outcome.resource)
    if (!resource) return this.fail(record, 'STUDIO_RESOURCE_CONFLICT')
    const nextPhase: StudioPhaseExecution = {
      ...phase,
      status: 'quota-exhausted',
      resource,
      quotaEvidence: outcome.evidence,
      ...(outcome.resetInformation === undefined ? {} : { resetInformation: outcome.resetInformation }),
      completedAt: now(),
    }
    const node = graphNode(record, state.nodeId)
    const canFallback = phase.requested?.provider === 'gemini' && node !== undefined && (
      node.kind === 'gemini-research' && (phase.phase === 'plan' || phase.phase === 'research')
      || node.kind === 'gemini-thinking' && phase.phase === 'thinking'
    )
    const nextNode = replacePhase(state, nextPhase)
    return (await this.apply(record, {
      status: canFallback ? 'running' : 'failed',
      nodes: replaceNode(record, { ...nextNode, status: canFallback ? 'running' : 'failed', ...(canFallback ? {} : { error: 'STUDIO_PROVIDER_QUOTA_EXHAUSTED' }) }),
      ...(canFallback ? {} : { message: 'STUDIO_PROVIDER_QUOTA_EXHAUSTED' }),
    })).record
  }

  private async completeNode(record: StudioExecutionRecord, state: StudioNodeExecution, phase: StudioPhaseExecution): Promise<StudioExecutionRecord> {
    const output = phaseArtifact(record, phase)
    if (!output) return this.fail(record, 'STUDIO_NODE_OUTPUT_MISSING')
    return (await this.apply(record, { status: 'running', nodes: replaceNode(record, { ...state, status: 'completed', outputAssetId: output.id }) })).record
  }

  private async completeRun(record: StudioExecutionRecord, operation: ActiveOperation): Promise<StudioExecutionRecord> {
    const maps = edgeMaps(record.graph)
    const terminalNodes = record.graph.nodes.filter((node) => (maps.outgoing.get(node.id)?.length ?? 0) === 0)
    if (terminalNodes.length === 0) return this.fail(record, 'STUDIO_TERMINAL_NODE_MISSING')
    const terminalArtifacts: InsightArtifact[] = []
    for (const node of terminalNodes) {
      const state = nodeState(record, node.id)
      const artifact = state === undefined ? undefined : artifactById(record, state.outputAssetId)
      if (!artifact) return this.fail(record, 'STUDIO_TERMINAL_OUTPUT_MISSING')
      terminalArtifacts.push(artifact)
    }
    const onlyTerminal = terminalNodes.length === 1 ? terminalNodes[0] : undefined
    const output = onlyTerminal?.kind === 'output'
      ? terminalArtifacts[0]?.text
      : this.finalText(record, terminalArtifacts)
    if (output === undefined) return this.fail(record, 'STUDIO_FINAL_OUTPUT_MISSING')
    const completed = (await this.apply(record, { status: 'completed', output, message: record.message ?? this.omissionLabels(record).join(' ') })).record
    if (!operation.finished) {
      operation.finished = true
      try { await this.options.ports.finished?.(completed.commandId, completed.graph.sessionId) } catch { /* local lifecycle notification is never a rerun trigger */ }
    }
    return completed
  }

  private finalText(record: StudioExecutionRecord, assets: readonly InsightArtifact[], layoutTemplate = OUTPUT_REPORT_PLACEHOLDER): string {
    const body = assets.length === 0 ? '' : assets.map((artifact) => artifact.text).join('\n\n---\n\n')
    const labels = this.omissionLabels(record)
    const formatted = layoutTemplate.replaceAll(OUTPUT_REPORT_PLACEHOLDER, body)
    return [formatted, '', '---', '', '## 流程说明', ...labels.map((label) => `- ${label}`)].join('\n')
  }

  private omissionLabels(record: StudioExecutionRecord): readonly string[] {
    const kinds = new Set(record.graph.nodes.map((node) => node.kind))
    const labels: string[] = []
    if (!kinds.has('gemini-research') && !kinds.has('chatgpt-search')) labels.push('研究阶段已省略；本输出不声称完成研究。')
    if (!kinds.has('chatgpt-review')) labels.push('独立复核阶段已省略；本输出未声明独立验证。')
    if (!kinds.has('gemini-thinking')) labels.push('润色阶段已省略。')
    if (hasFallback(record)) {
      labels.push('回落报告：Gemini 阶段以明确额度耗尽且无活动 effect 为条件回落到 GPT-6 Astra Pro Web search and analysis。')
      if (kinds.has('chatgpt-review')) labels.push('同一提供方复核：回落研究与 ChatGPT 复核不构成独立外部验证。')
    }
    return labels
  }

  private async needsInput(record: StudioExecutionRecord, state: StudioNodeExecution, reason: string): Promise<StudioExecutionRecord> {
    return (await this.apply(record, { status: 'needs-input', nodes: replaceNode(record, { ...state, status: 'needs-input', error: reason }), message: reason })).record
  }

  private async abort(record: StudioExecutionRecord): Promise<StudioExecutionRecord> {
    const unresolved = this.unresolved(record)
    if (!unresolved) return (await this.apply(record, { status: 'cancelled', message: 'STUDIO_CANCELLED_LOCAL' })).record
    return this.unknown(record, unresolved.node, unresolved.phase, 'STUDIO_CANCELLED_LOCAL_UNKNOWN_EFFECT')
  }

  private async fail(record: StudioExecutionRecord, reason: string): Promise<StudioExecutionRecord> {
    if (record.status === 'completed') return record
    return (await this.apply(record, { status: 'failed', message: record.message ?? reason })).record
  }

  private async apply(record: StudioExecutionRecord, patch: StudioExecutionPatch): Promise<Applied> {
    try {
      return { record: await this.store.transition(record.commandId, record.revision, patch), applied: true }
    } catch (error) {
      if (!(error instanceof StudioExecutionStoreError) || error.code !== 'STUDIO_STATE_CONFLICT') throw error
      const current = await this.store.read(record.graph.sessionId, record.commandId)
      if (!current) throw providerError('STUDIO_RUN_NOT_FOUND', 'Studio run was not found')
      return { record: current, applied: false }
    }
  }
}

export function createWebStudioProvider(options: StudioProviderOptions): StudioExecutionProvider {
  return new EditableStudioProvider('web', 'ChatGPT Web', options)
}

export function createInsightStudioProvider(options: StudioProviderOptions): StudioExecutionProvider {
  return new EditableStudioProvider('insight', 'Insight', options)
}
