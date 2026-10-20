import { createHash } from 'node:crypto'

/**
 * The Insight workflow is intentionally a source-level contract.  Browser and
 * native bindings live outside this slice; this module only describes the
 * durable requests those bindings must receive and the receipts they must
 * return.
 */
export const INSIGHT_CONFIG_FORMAT_VERSION = 1 as const
export const INSIGHT_STORE_FORMAT_VERSION = 1 as const

export type InsightProvider = 'codex' | 'gemini' | 'chatgpt'
export type InsightArtifactProvider = InsightProvider | 'host'

export type InsightStageName =
  | 'clarify'
  | 'questions'
  | 'plan'
  | 'plan-confirmation'
  | 'research'
  | 'research-fallback'
  | 'critique'
  | 'polish'
  | 'polish-fallback'
  | 'final'

export type InsightStageKind = 'native' | 'host-question' | 'host-confirmation' | 'external' | 'local'

export type InsightStageStatus =
  | 'calling'
  | 'complete'
  | 'needs-input'
  | 'needs-confirmation'
  | 'quota-exhausted'
  | 'unknown'
  | 'paused'
  | 'failed'
  | 'cancelled'
  | 'rejected'
  | 'skipped'

export type InsightRunStatus = 'running' | 'needs-input' | 'needs-confirmation' | 'paused' | 'completed' | 'failed' | 'cancelled'

export interface InsightModelSelection {
  readonly provider: InsightProvider
  /** Native executors may require an exact model id distinct from a display label. */
  readonly modelId?: string
  /** The exact requested label. It is never substituted with an inferred alias. */
  readonly modelLabel: string
  readonly effortLabel?: string
  readonly modeLabel?: string
}

/** What the concrete adapter actually observed, if its surface exposed it. */
export interface InsightObservedSelection {
  readonly availability: 'observed' | 'not-exposed'
  readonly providerLabel?: string
  readonly modelLabel?: string
  readonly effortLabel?: string
  readonly modeLabel?: string
}

export interface InsightTemplate {
  readonly formatVersion: 1
  readonly id: string
  readonly version: string
  readonly text: string
  /** SHA-256 of `text`, recorded so a rendered request can be reconstructed. */
  readonly hash: string
}

export interface InsightStageConfig {
  readonly requested: InsightModelSelection
  readonly template: InsightTemplate
}

export interface InsightConfigV1 {
  readonly formatVersion: 1
  readonly clarification: InsightStageConfig & {
    readonly maxRounds: number
    readonly maxQuestionsPerRound: number
  }
  readonly plan: InsightStageConfig
  readonly research: InsightStageConfig
  readonly fallbackResearch: InsightStageConfig
  readonly critique: InsightStageConfig
  readonly polish: InsightStageConfig
  readonly fallbackPolish: InsightStageConfig
  readonly delivery: {
    /**
     * Studio projects this as a local layout template: its literal `{report}`
     * placeholder is replaced with the complete predecessor Markdown. It is
     * never an instruction to ask a model to rewrite the report.
     */
    readonly template: InsightTemplate
    readonly language: string
    readonly style: string
  }
  readonly researchWaitMs: number
  readonly sizeLimits: {
    /** A full input above this bound is rejected; it is never shortened. */
    readonly maxRenderedInputBytes: number
    /** A full port artifact above this bound is rejected; it is never shortened. */
    readonly maxArtifactBytes: number
  }
  /** The selected fallback, explicitly distinct from ChatGPT Deep Research. */
  readonly geminiQuotaFallback: 'GPT-6 Astra Pro Web search and analysis'
}

export interface InsightStartInput {
  /** Stable UUID supplied by the host session/command owner. */
  readonly id: string
  readonly question: string
  readonly conversationContext: string
}

export interface InsightRunRequest {
  readonly input: InsightStartInput
  /** A complete immutable snapshot; a changed configuration conflicts with an existing run. */
  readonly config: InsightConfigV1
}

export interface InsightExternalResource {
  readonly provider: InsightProvider
  /** Stable correlation identity, initially equal to the immutable stage command id. */
  readonly id: string
  /** A concrete adapter may attach its original remote identity after submission. */
  readonly remoteId?: string
  readonly url?: string
}

export interface InsightProvenance {
  readonly provider: InsightArtifactProvider
  readonly source: string
  readonly visibleEvidence: readonly string[]
  readonly citations: readonly string[]
  readonly limitations: readonly string[]
  readonly fallback?: boolean
  readonly sameProviderReview?: boolean
}

export interface InsightArtifact {
  readonly id: string
  readonly stageCommandId: string
  readonly kind: string
  /** Full, untruncated text exactly as supplied by the producing boundary. */
  readonly text: string
  readonly provenance: InsightProvenance
  readonly createdAt: string
}

export interface InsightQuestion {
  readonly id: string
  readonly text: string
}

export interface InsightAnswer {
  readonly questionId: string
  readonly text: string
}

export interface InsightClarification {
  /** Required when there are no further material questions. */
  readonly brief?: string
  readonly questions: readonly InsightQuestion[]
}

export interface InsightPortArtifact {
  /** Full raw text or Markdown returned by the native/Web stage. */
  readonly text: string
  readonly provenance: InsightProvenance
}

export type InsightStageOutcome =
  | {
    readonly kind: 'complete'
    readonly resource: InsightExternalResource
    readonly observed: InsightObservedSelection
    readonly artifact: InsightPortArtifact
    /** Present only for the bounded native clarification stage. */
    readonly clarification?: InsightClarification
  }
  | {
    readonly kind: 'quota-exhausted'
    readonly resource: InsightExternalResource
    /** Exact visible quota evidence, not an inferred missing counter. */
    readonly evidence: string
    readonly resetInformation?: string
    /** Fallback is legal only when the adapter can establish this exact state. */
    readonly certainty: 'no-active-effect'
  }
  | {
    readonly kind: 'unknown'
    readonly resource: InsightExternalResource
    /** Retained verbatim enough to reconcile the original resource later. */
    readonly reason: string
    readonly observed?: InsightObservedSelection
  }
  | {
    /** Known terminal/no-effect failure. Uncertain transport and selector results remain `unknown`. */
    readonly kind: 'failed'
    readonly resource: InsightExternalResource
    readonly code: string
    readonly reason: string
    readonly certainty: 'no-active-effect' | 'settled'
  }

export type InsightQuestionOutcome =
  | { readonly kind: 'answered'; readonly answers: readonly InsightAnswer[] }
  | { readonly kind: 'pending' }
  | { readonly kind: 'cancelled'; readonly reason: string }

export type InsightPlanConfirmationOutcome =
  | { readonly kind: 'confirmed' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'declined'; readonly reason: string }

export interface InsightStageRecord {
  readonly sequence: number
  readonly stage: InsightStageName
  readonly kind: InsightStageKind
  readonly commandId: string
  readonly status: InsightStageStatus
  readonly round?: number
  readonly requested?: InsightModelSelection
  readonly observed?: InsightObservedSelection
  readonly resource?: InsightExternalResource
  readonly template?: InsightTemplate
  /** The complete rendered template and every prior source asset. */
  readonly renderedInput: string
  readonly assetIds: readonly string[]
  readonly questions?: readonly InsightQuestion[]
  readonly answers?: readonly InsightAnswer[]
  readonly quotaEvidence?: string
  readonly resetInformation?: string
  readonly failureCode?: string
  readonly reason?: string
  readonly intentAt?: string
  readonly completedAt?: string
}

export interface InsightRun {
  readonly formatVersion: 1
  readonly id: string
  readonly revision: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly request: InsightRunRequest
  readonly status: InsightRunStatus
  readonly stages: readonly InsightStageRecord[]
  readonly assets: readonly InsightArtifact[]
  readonly finalMarkdown?: string
  readonly finalProvenance?: readonly string[]
  readonly reason?: string
}

export interface InsightRunPatch {
  readonly status?: InsightRunStatus
  readonly stages?: readonly InsightStageRecord[]
  readonly assets?: readonly InsightArtifact[]
  readonly finalMarkdown?: string
  readonly finalProvenance?: readonly string[]
  readonly reason?: string
}

export interface InsightPortRequestBase {
  readonly runId: string
  readonly stage: InsightStageName
  readonly commandId: string
  readonly template: InsightTemplate
  readonly renderedInput: string
  /** Full durable assets, supplied in addition to the rendered input for adapters that need structure. */
  readonly assets: readonly InsightArtifact[]
  readonly signal: AbortSignal
}

export interface InsightClarifyRequest extends InsightPortRequestBase {
  readonly stage: 'clarify'
  readonly round: number
  readonly requested: InsightModelSelection
  readonly resource: InsightExternalResource
}

export interface InsightExternalExecuteRequest extends InsightPortRequestBase {
  readonly stage: 'plan' | 'research' | 'research-fallback' | 'critique' | 'polish' | 'polish-fallback'
  readonly requested: InsightModelSelection
  readonly resource: InsightExternalResource
}

export interface InsightExternalObserveRequest extends InsightPortRequestBase {
  readonly stage: 'clarify' | 'plan' | 'research' | 'research-fallback' | 'critique' | 'polish' | 'polish-fallback'
  readonly requested: InsightModelSelection
  /** Exactly the durable resource from the calling/unknown stage; never a replacement task. */
  readonly resource: InsightExternalResource
}

export interface InsightQuestionRequest extends InsightPortRequestBase {
  readonly stage: 'questions'
  readonly round: number
  readonly questions: readonly InsightQuestion[]
}

export interface InsightPlanConfirmationRequest extends InsightPortRequestBase {
  readonly stage: 'plan-confirmation'
  readonly plan: InsightArtifact
}

/**
 * Concrete bindings are injected by the host.  The controller never opens a
 * browser or runs a model itself, and it never retries an unresolved effect.
 */
export interface InsightPorts {
  clarify(request: InsightClarifyRequest): Promise<InsightStageOutcome>
  askQuestions(request: InsightQuestionRequest): Promise<InsightQuestionOutcome>
  confirmPlan(request: InsightPlanConfirmationRequest): Promise<InsightPlanConfirmationOutcome>
  execute(request: InsightExternalExecuteRequest): Promise<InsightStageOutcome>
  observe(request: InsightExternalObserveRequest): Promise<InsightStageOutcome>
}

export class InsightContractError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'InsightContractError'
  }
}

export function templateHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function versionedTemplate(id: string, version: string, text: string): InsightTemplate {
  return { formatVersion: 1, id, version, text, hash: templateHash(text) }
}

function template(id: string, text: string): InsightTemplate {
  return versionedTemplate(id, '1', text)
}

/** Requested labels only. Website-visible identities belong in port observations. */
export function defaultInsightConfig(): InsightConfigV1 {
  return {
    formatVersion: 1,
    clarification: {
      maxRounds: 3,
      maxQuestionsPerRound: 3,
      requested: { provider: 'codex', modelId: 'gpt-6.1-sol', modelLabel: 'GPT-6.1 Sol' },
      template: template('clarify', 'Identify only material missing facts. Ask at most three necessary questions, or return a complete research brief.'),
    },
    plan: {
      requested: { provider: 'gemini', modelLabel: '4 Argon', modeLabel: 'Deep Research' },
      template: template('plan', 'Create a source-aware research plan from the complete brief. Do not begin research in this stage.'),
    },
    research: {
      requested: { provider: 'gemini', modelLabel: '4 Argon', modeLabel: 'Deep Research' },
      template: template('research', 'Run the approved research plan. Retain the complete report and only webpage-visible evidence.'),
    },
    fallbackResearch: {
      requested: { provider: 'chatgpt', modelLabel: 'GPT-6 Astra Pro', modeLabel: 'Web search and analysis' },
      template: template('research-fallback', 'Produce a 回落报告 using Web search and analysis. This is not ChatGPT Deep Research.'),
    },
    critique: {
      requested: { provider: 'chatgpt', modelLabel: 'GPT-6 Astra Pro', modeLabel: 'Web search and analysis' },
      template: template('critique', 'Check sources and counterevidence, correct the report, and disclose that this is same-provider review when fallback research used ChatGPT.'),
    },
    polish: {
      requested: { provider: 'gemini', modelLabel: '4 Argon', effortLabel: 'high' },
      template: template('polish', 'Polish the verified report into natural Chinese without changing citations, numbers, qualifiers, or factual claims.'),
    },
    fallbackPolish: {
      requested: { provider: 'chatgpt', modelLabel: 'GPT-6 Astra Pro', modeLabel: 'Web search and analysis' },
      template: template('polish-fallback', 'Polish the verified report in Chinese without deleting citations, numbers, or qualifiers. State that Gemini was unavailable.'),
    },
    delivery: {
      template: template('delivery', '{report}'),
      language: 'Chinese',
      style: 'natural Chinese Markdown',
    },
    researchWaitMs: 3_600_000,
    sizeLimits: {
      maxRenderedInputBytes: 2 * 1024 * 1024,
      maxArtifactBytes: 2 * 1024 * 1024,
    },
    geminiQuotaFallback: 'GPT-6 Astra Pro Web search and analysis',
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function assertTemplate(value: unknown): asserts value is InsightTemplate {
  if (!isPlainObject(value)
    || value.formatVersion !== 1
    || !nonEmpty(value.id)
    || !nonEmpty(value.version)
    || typeof value.text !== 'string'
    || !nonEmpty(value.hash)
    || value.hash !== templateHash(value.text)) {
    throw new InsightContractError('INSIGHT_CONFIG_INVALID', 'Insight template is invalid')
  }
}

function assertSelection(value: unknown): asserts value is InsightModelSelection {
  if (!isPlainObject(value)
    || (value.provider !== 'codex' && value.provider !== 'gemini' && value.provider !== 'chatgpt')
    || (value.modelId !== undefined && !nonEmpty(value.modelId))
    || !nonEmpty(value.modelLabel)
    || (value.effortLabel !== undefined && !nonEmpty(value.effortLabel))
    || (value.modeLabel !== undefined && !nonEmpty(value.modeLabel))) {
    throw new InsightContractError('INSIGHT_CONFIG_INVALID', 'Insight model selection is invalid')
  }
}

function assertStageConfig(value: unknown): asserts value is InsightStageConfig {
  if (!isPlainObject(value)) throw new InsightContractError('INSIGHT_CONFIG_INVALID', 'Insight stage configuration is invalid')
  assertSelection(value.requested)
  assertTemplate(value.template)
}

/** Validates only durable configuration shape; it does not claim provider availability. */
export function assertInsightConfig(value: unknown): asserts value is InsightConfigV1 {
  if (!isPlainObject(value) || value.formatVersion !== INSIGHT_CONFIG_FORMAT_VERSION) {
    throw new InsightContractError('INSIGHT_CONFIG_VERSION', 'Insight configuration format version is unsupported')
  }
  if (!isPlainObject(value.clarification)) throw new InsightContractError('INSIGHT_CONFIG_INVALID', 'Insight clarification configuration is invalid')
  assertStageConfig(value.clarification)
  const maxRounds = value.clarification.maxRounds
  const maxQuestionsPerRound = value.clarification.maxQuestionsPerRound
  if (typeof maxRounds !== 'number' || !Number.isSafeInteger(maxRounds) || maxRounds < 1
    || typeof maxQuestionsPerRound !== 'number' || !Number.isSafeInteger(maxQuestionsPerRound)
    || maxQuestionsPerRound < 1 || maxQuestionsPerRound > 3) {
    throw new InsightContractError('INSIGHT_CONFIG_INVALID', 'Insight clarification bounds are invalid')
  }
  for (const field of ['plan', 'research', 'fallbackResearch', 'critique', 'polish', 'fallbackPolish'] as const) {
    assertStageConfig(value[field])
  }
  if (!isPlainObject(value.delivery) || !nonEmpty(value.delivery.language) || !nonEmpty(value.delivery.style)) {
    throw new InsightContractError('INSIGHT_CONFIG_INVALID', 'Insight delivery configuration is invalid')
  }
  assertTemplate(value.delivery.template)
  const researchWaitMs = value.researchWaitMs
  const limits = value.sizeLimits
  const maxRenderedInputBytes = isPlainObject(limits) ? limits.maxRenderedInputBytes : undefined
  const maxArtifactBytes = isPlainObject(limits) ? limits.maxArtifactBytes : undefined
  if (typeof researchWaitMs !== 'number' || !Number.isSafeInteger(researchWaitMs) || researchWaitMs < 1
    || !isPlainObject(limits)
    || typeof maxRenderedInputBytes !== 'number' || !Number.isSafeInteger(maxRenderedInputBytes) || maxRenderedInputBytes < 1
    || typeof maxArtifactBytes !== 'number' || !Number.isSafeInteger(maxArtifactBytes) || maxArtifactBytes < 1
    || value.geminiQuotaFallback !== 'GPT-6 Astra Pro Web search and analysis') {
    throw new InsightContractError('INSIGHT_CONFIG_INVALID', 'Insight limits or fallback policy are invalid')
  }
}

/** JSON-safe canonical representation used for immutable request comparisons. */
export function stableInsightJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new InsightContractError('INSIGHT_STATE_INVALID', 'Insight state contains a non-finite number')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map((item) => stableInsightJson(item)).join(',')}]`
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableInsightJson(value[key])}`).join(',')}}`
  }
  throw new InsightContractError('INSIGHT_STATE_INVALID', 'Insight state contains a non-JSON value')
}

export function cloneInsight<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function renderInsightTemplate(templateValue: InsightTemplate, sections: readonly { readonly title: string; readonly text: string }[]): string {
  return [
    `<!-- insight-template:${templateValue.id}@${templateValue.version}:${templateValue.hash} -->`,
    templateValue.text,
    ...sections.flatMap((section) => [`\n--- ${section.title} ---`, section.text]),
  ].join('\n')
}
