/** TypeScript callers of the plain-Node study fixture; supplier evidence remains independently verified at runtime. */
import type { RequestAdmission, RequestAdmissionInput, RequestAdmissionTicket } from '@deepseek-ai/dsh-llm'
import type { ModelWorkerToolBridgeV1 } from '@deepseek-ai/dsh-model-worker'
import type { RlmChildResultContentV1, RlmRuntimeSessionId } from '@deepseek-ai/dsh-rlm-runtime'
import type { EvaluationAttempt, EvaluationLedger, EvaluationUsage } from '../../../src/evaluation-ledger.ts'

/** The five request-specific evidence fields passed through to the original ledger. */
export interface Study8TokenBound {
  readonly model: string
  readonly bodySha256: string
  readonly evidenceSHA256: string
  readonly inputTokensUpperBound: number
  readonly reasoningInclusiveOutputUpperBound: number
}

/** The original ledger instance and its synchronous admission function. */
export interface Study8LedgerBinding {
  readonly ledger: EvaluationLedger
  admit(label: string, facts: RequestAdmissionInput, proof: Study8TokenBound): RequestAdmissionTicket
}

/** Attempt fields used for cumulative accounting and post-admission identity checks. */
type Study8Attempt = Pick<EvaluationAttempt, 'state' | 'reservedInput' | 'reservedOutput'>
  & Partial<Pick<EvaluationAttempt, 'model' | 'bodySha256' | 'usage'>>

/** Read-only ledger projection consumed by the trial admission wrapper. */
interface Study8LedgerView {
  snapshot(): { readonly state: { readonly attempts: readonly Study8Attempt[] } }
}

/** Applicable price fields used by the upper-bound accounting projection. */
interface Study8Tariff {
  readonly currency: string
  readonly inputPerMillionUpper: number
  readonly outputPerMillionUpper: number
}

/** Observed usage is absent while any admitted attempt lacks settlement. */
export interface Study8Account {
  readonly acceptedAttempts: number
  readonly complete: boolean
  readonly inputHeldOrUsed: number
  readonly outputHeldOrUsed: number
  readonly unknown: boolean
  readonly actualTokens: EvaluationUsage | null
  readonly currency: string
  readonly tariffCostUpper: number
  readonly actualBilledCost: null
}

/** The existing fixed study caps; this declaration does not configure a run. */
export const STUDY8_LIMITS: Readonly<{
  inputTokens: number
  outputTokens: number
  httpAttempts: number
  concurrentRequests: number
  maxOutputTokensPerRequest: number
}>

/** Fixed model-visible fixture instruction. */
export const STUDY8_PROMPT: string

/** Settle a local receipt wait or report that cancellation left its remote outcome unknown. */
export function study8Wait<T>(promise: T | PromiseLike<T>, signal: AbortSignal): Promise<
  { readonly state: 'settled'; readonly value: T }
  | { readonly state: 'failed'; readonly error: unknown }
  | { readonly state: 'unknown'; readonly reason: string }
>

/** Keep the child Worker execution identity distinct from the command that spawned it. */
export function study8ChildContent(
  request: { readonly childSessionId: string; readonly commandId: string },
  value: Pick<RlmChildResultContentV1, 'stopReason' | 'output'>,
): RlmChildResultContentV1 & { readonly spawnCommandId: string }

/** Reject incomplete controller inputs before a claim or Worker request is created. */
export function validateStudy8Binding(options: unknown): void

/** Read and verify the existing three frozen input files. */
export function loadFrozenStudy8(paths: Readonly<Record<'cases' | 'freeze' | 'schedule', string>>): Promise<{
  readonly schedule: readonly Readonly<Record<string, unknown>>[]
  readonly cases: readonly Readonly<Record<string, unknown>>[]
  readonly hashes: Readonly<Record<'cases' | 'freeze' | 'schedule', string>>
}>

/** Count held or settled resources without replacing absent usage with zero. */
export function study8Accounting(attempts: readonly Study8Attempt[], quote: Study8Tariff): Study8Account

/** Bind ticket creation directly to this original ledger instance. */
export function study8LedgerBinding(ledger: EvaluationLedger): Study8LedgerBinding

/** Refuse inconsistent proof, outstanding requests or exhausted trial caps before admitting the physical request. */
export function study8Admission(
  ledger: Study8LedgerView,
  binding: Pick<Study8LedgerBinding, 'admit'>,
  bound: { forRequest(facts: RequestAdmissionInput): Study8TokenBound | undefined },
  route: Pick<RequestAdmissionInput, 'model' | 'thinking' | 'reasoningEffort'>,
  label: string,
  priorRows: number,
  quote: Study8Tariff,
  check: () => void,
): RequestAdmission

/** Forward tool calls through the actual local Runtime bridge and retain uncertain receipt outcomes. */
export function study8CellBridge(
  runtime: { modelToolBridge(sessionId: RlmRuntimeSessionId): Promise<ModelWorkerToolBridgeV1> },
  home: string,
  signal: AbortSignal,
): Promise<{
  check(): void
  readonly cells: Map<string, { readonly state: 'forwarded' | 'settled' | 'unknown' }>
  bridge(sessionId: RlmRuntimeSessionId): Promise<ModelWorkerToolBridgeV1>
  close(): Promise<void>
}>

/** Execute the fixed sequence only after controller evidence passes the runtime preflight checks. */
export function runStudy8(ctx: unknown, options: unknown): Promise<{
  readonly runId: string
  readonly reportPath: string
  readonly rows: readonly (Readonly<Record<string, unknown>> & { readonly status: string; readonly executionId: string | null })[]
}>
