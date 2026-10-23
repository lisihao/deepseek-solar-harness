import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import type {
  GraphSnapshot,
  ResidentApi,
  TaskGraph,
  TaskNode,
} from '@lisihao/dsh-solar-native-resident/contracts'

import type { StudioClarifyPortRequest, StudioExternalPortRequest } from './studio-provider.js'
import type {
  InsightClarification,
  InsightExternalResource,
  InsightObservedSelection,
  InsightPortArtifact,
  InsightStageOutcome,
  InsightQuestion,
} from './insight-contract.js'

const CLARIFIER_WORKSPACE = 'clarifier-workspace'
const NODE_ID = 'clarifier'
const MAX_WAIT_MS = 60_000
const MAX_POLL_MS = 5_000
const DEFAULT_WAIT_MS = 60_000
const DEFAULT_POLL_MS = 250
const MAX_QUESTIONS = 3
const TERMINAL = new Set<GraphSnapshot['status']>(['completed', 'failed', 'cancelled', 'indeterminate'])

const CLARIFIER_PROTOCOL = [
  'This is a text-only clarification stage.',
  'Do not read or write files, run commands, use shell or other tools, or access the network.',
  'The TaskNode scope is a declaration only; it is not operating-system isolation.',
  'Ask only material questions that are necessary to clarify the request.',
  'If there are no material questions, set questions to [] and put the complete clarified brief in brief.',
  'Return exactly one JSON object with exactly these fields:',
  '{"brief":"string","questions":[{"id":"string","text":"string"}]}',
  'Every question id and text must be a non-empty string, and question ids must be unique.',
  'Do not include Markdown, a code fence, hidden reasoning, commentary, or any other field.',
].join('\n')

export interface NativeClarifierOptions {
  /** Plugin-owned persistent root supplied by the Host binding. */
  readonly root: string
  /** Resolve the currently registered Native Resident service. */
  readonly resident: () => ResidentApi
  /** Record the exact native prompt before Resident admission. */
  readonly logRequest?: (sessionId: string, text: string) => Promise<void>
  /** Local observation window; it never cancels Resident work. */
  readonly waitMs?: number
  /** Poll interval for local observation. */
  readonly pollMs?: number
}
export interface NativeClarifier {
  clarify(request: StudioClarifyPortRequest): Promise<InsightStageOutcome>
  observe(request: StudioExternalPortRequest): Promise<InsightStageOutcome>
}

type ClarifierRequest = StudioClarifyPortRequest | StudioExternalPortRequest
type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function hashId(prefix: string, commandId: string): string {
  return `${prefix}-${createHash('sha256').update(commandId, 'utf8').digest('hex')}`
}

function graphId(commandId: string): string {
  return hashId('native-clarifier-graph', commandId)
}

function submitCommandId(commandId: string): string {
  return hashId('native-clarifier-submit', commandId)
}

function requestResource(request: ClarifierRequest, id: string): InsightExternalResource {
  return {
    provider: 'codex',
    id: request.resource.id,
    remoteId: id,
    ...(request.resource.url === undefined ? {} : { url: request.resource.url }),
  }
}

function outcomeResource(request: ClarifierRequest, id: string): InsightExternalResource {
  return requestResource(request, id)
}

function observedSelection(): InsightObservedSelection {
  // Resident persists the requested profile, but the Codex driver does not
  // expose a visible website-style selection receipt to this binding.
  return { availability: 'not-exposed' }
}

function artifact(rawOutput: string): InsightPortArtifact {
  return {
    text: rawOutput,
    provenance: {
      provider: 'codex',
      source: 'Native Resident Codex clarification output',
      visibleEvidence: [],
      citations: [],
      limitations: ['No hidden reasoning was requested or captured.'],
    },
  }
}

function failed(
  resource: InsightExternalResource,
  code: string,
  reason: string,
  certainty: 'no-active-effect' | 'settled',
): InsightStageOutcome {
  return { kind: 'failed', resource, code, reason, certainty }
}

function unknown(resource: InsightExternalResource, reason: string): InsightStageOutcome {
  return { kind: 'unknown', resource, reason }
}

function validateOptions(options: NativeClarifierOptions): { readonly root: string; readonly waitMs: number; readonly pollMs: number } {
  if (!nonEmptyString(options.root)) throw new Error('NATIVE_CLARIFIER_ROOT_INVALID: root must be a non-empty path.')
  const root = isAbsolute(options.root) ? options.root : resolve(options.root)
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > MAX_WAIT_MS) {
    throw new Error(`NATIVE_CLARIFIER_WAIT_INVALID: waitMs must be an integer between 0 and ${MAX_WAIT_MS}.`)
  }
  if (!Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > MAX_POLL_MS) {
    throw new Error(`NATIVE_CLARIFIER_POLL_INVALID: pollMs must be an integer between 1 and ${MAX_POLL_MS}.`)
  }
  return { root, waitMs, pollMs }
}

function validateRequest(request: ClarifierRequest): string | undefined {
  if (!isRecord(request)) return 'The clarification request is not an object.'
  if (!nonEmptyString(request.commandId)) return 'The clarification request has no command id.'
  if (!nonEmptyString(request.sessionId)) return 'The clarification request has no session id.'
  if (!nonEmptyString(request.renderedInput)) return 'The clarification request has no rendered input.'
  if (!isRecord(request.requested) || request.requested.provider !== 'codex') {
    return 'Native clarification only supports the Codex provider.'
  }
  if (!nonEmptyString(request.requested.modelId)) {
    return 'Native clarification requires an explicit requested.modelId; modelLabel is not used as an id.'
  }
  if (!isRecord(request.resource) || request.resource.provider !== 'codex' || !nonEmptyString(request.resource.id)) {
    return 'Native clarification requires a Codex resource with a non-empty id.'
  }
  return undefined
}

function actualPrompt(renderedInput: string): string {
  return `${renderedInput}\n\n=== NATIVE CLARIFICATION OUTPUT CONTRACT ===\n${CLARIFIER_PROTOCOL}`
}

function graphFor(request: StudioClarifyPortRequest, workspace: string, prompt: string): TaskGraph {
  const profile = {
    model: request.requested.modelId as string,
    ...(request.requested.effortLabel === undefined ? {} : { reasoningEffort: request.requested.effortLabel }),
  }
  const node: TaskNode = {
    id: NODE_ID,
    executor: 'codex',
    prompt,
    // This declaration communicates that the node is text-only. Resident's
    // scope is scheduling metadata, not an operating-system sandbox.
    scope: { read: [], write: [] },
    profile,
  }
  return {
    formatVersion: 1,
    id: graphId(request.commandId),
    label: 'Native clarification',
    cwd: workspace,
    maxParallel: 1,
    nodes: [node],
  }
}

function stripOuterCodeFence(rawOutput: string): string {
  const trimmed = rawOutput.trim()
  const match = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed)
  return match?.[1] ?? trimmed
}

function parseClarification(rawOutput: string): InsightClarification | undefined {
  let value: unknown
  try {
    value = JSON.parse(stripOuterCodeFence(rawOutput)) as unknown
  } catch {
    return undefined
  }
  if (!isRecord(value) || Object.keys(value).length !== 2 || !Object.prototype.hasOwnProperty.call(value, 'brief') || !Object.prototype.hasOwnProperty.call(value, 'questions')) {
    return undefined
  }
  if (typeof value.brief !== 'string' || !Array.isArray(value.questions) || value.questions.length > MAX_QUESTIONS) return undefined
  const ids = new Set<string>()
  const questions: InsightQuestion[] = []
  for (const rawQuestion of value.questions) {
    if (!isRecord(rawQuestion) || Object.keys(rawQuestion).length !== 2 || !Object.prototype.hasOwnProperty.call(rawQuestion, 'id') || !Object.prototype.hasOwnProperty.call(rawQuestion, 'text')) return undefined
    if (!nonEmptyString(rawQuestion.id) || !nonEmptyString(rawQuestion.text) || ids.has(rawQuestion.id)) return undefined
    ids.add(rawQuestion.id)
    questions.push({ id: rawQuestion.id, text: rawQuestion.text })
  }
  if (questions.length === 0 && value.brief.trim().length === 0) return undefined
  return { brief: value.brief, questions }
}

function nodeFor(snapshot: GraphSnapshot): GraphSnapshot['nodes'][number] | undefined {
  return snapshot.nodes.find(node => node.id === NODE_ID) ?? snapshot.nodes[0]
}

function terminalOutcome(request: ClarifierRequest, graph: TaskGraph, snapshot: GraphSnapshot): InsightStageOutcome {
  const resource = outcomeResource(request, graph.id)
  if (snapshot.graph.id !== graph.id) {
    return unknown(resource, `Resident returned graph ${snapshot.graph.id}, expected ${graph.id}.`)
  }
  if (snapshot.status === 'indeterminate') {
    const node = nodeFor(snapshot)
    const detail = node?.error === undefined ? 'Resident reported an indeterminate native outcome.' : `${node.error.code}: ${node.error.message}`
    return unknown(resource, detail)
  }
  if (snapshot.status === 'cancelled' || snapshot.status === 'failed') {
    const node = nodeFor(snapshot)
    const code = node?.error?.code ?? (snapshot.status === 'cancelled' ? 'NATIVE_CLARIFIER_GRAPH_CANCELLED' : 'NATIVE_CLARIFIER_GRAPH_FAILED')
    const reason = node?.error === undefined ? `Resident graph ended with status ${snapshot.status}.` : node.error.message
    return failed(resource, code, reason, 'settled')
  }
  if (snapshot.status !== 'completed') return unknown(resource, `Resident graph is still ${snapshot.status}.`)
  const node = nodeFor(snapshot)
  if (node?.status !== 'succeeded' || typeof node.output !== 'string') {
    return failed(resource, 'NATIVE_CLARIFIER_OUTPUT_MISSING', 'Resident reported completion without a successful clarification output.', 'settled')
  }
  const clarification = parseClarification(node.output)
  if (clarification === undefined) {
    return failed(resource, 'NATIVE_CLARIFIER_OUTPUT_INVALID', 'Native clarification output did not match the strict JSON contract; it was not retried.', 'settled')
  }
  return {
    kind: 'complete',
    resource,
    observed: observedSelection(),
    artifact: artifact(node.output),
    clarification,
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function residentApi(options: NativeClarifierOptions): ResidentApi | undefined {
  try {
    const value = options.resident()
    if (!value || typeof value.submit !== 'function' || typeof value.inspect !== 'function') return undefined
    return value
  } catch {
    return undefined
  }
}

async function waitForSnapshot(
  resident: Pick<ResidentApi, 'inspect'>,
  graphIdValue: string,
  waitMs: number,
  pollMs: number,
  signal: AbortSignal,
): Promise<{ readonly snapshot?: GraphSnapshot; readonly aborted: boolean; readonly timedOut: boolean }> {
  const deadline = Date.now() + waitMs
  for (;;) {
    if (signal.aborted) return { aborted: true, timedOut: false }
    const snapshot = await resident.inspect(graphIdValue)
    if (signal.aborted) return { aborted: true, timedOut: false }
    if (TERMINAL.has(snapshot.status)) return { snapshot, aborted: false, timedOut: false }
    if (Date.now() >= deadline) return { snapshot, aborted: false, timedOut: true }
    try {
      await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())), undefined, { signal })
    } catch (error) {
      if (signal.aborted) return { aborted: true, timedOut: false }
      throw error
    }
  }
}

function makeBeforeSubmitFailure(request: ClarifierRequest, code: string, reason: string): InsightStageOutcome {
  return failed(outcomeResource(request, graphId(request.commandId)), code, reason, 'no-active-effect')
}

export function createNativeClarifier(options: NativeClarifierOptions): NativeClarifier {
  const normalized = validateOptions(options)
  const operations = new Map<string, { readonly fingerprint: string; readonly promise: Promise<InsightStageOutcome> }>()

  const clarify = async (request: StudioClarifyPortRequest): Promise<InsightStageOutcome> => {
    const error = validateRequest(request)
    if (error !== undefined) return makeBeforeSubmitFailure(request, 'NATIVE_CLARIFIER_REQUEST_INVALID', error)
    const fingerprint = JSON.stringify({
      sessionId: request.sessionId,
      resource: request.resource,
      requested: request.requested,
      renderedInput: request.renderedInput,
    })
    const prior = operations.get(request.commandId)
    if (prior !== undefined) {
      if (prior.fingerprint !== fingerprint) return makeBeforeSubmitFailure(request, 'NATIVE_CLARIFIER_COMMAND_CONFLICT', 'The command id was already used with different clarification input.')
      return prior.promise
    }
    const promise = runClarify(request, normalized, options)
    operations.set(request.commandId, { fingerprint, promise })
    return promise
  }

  const observe = async (request: StudioExternalPortRequest): Promise<InsightStageOutcome> => {
    const error = validateRequest(request)
    const graphReference = nonEmptyString(request.resource?.remoteId) ? request.resource.remoteId : graphId(request.commandId)
    const resource = outcomeResource(request, graphReference)
    if (error !== undefined) return unknown(resource, error)
    const signal = request.signal ?? new AbortController().signal
    if (signal.aborted) return unknown(resource, 'Local observation was cancelled; the original Resident graph was not cancelled.')
    const resident = residentApi(options)
    if (resident === undefined) return unknown(resource, 'Native Resident is unavailable; the original graph was not submitted again.')
    try {
      const waited = await waitForSnapshot(resident, graphReference, normalized.waitMs, normalized.pollMs, signal)
      if (waited.aborted) return unknown(resource, 'Local observation was cancelled; Resident work was not cancelled.')
      if (waited.snapshot === undefined) return unknown(resource, 'Resident observation returned no snapshot.')
      if (waited.timedOut) return unknown(resource, `Local observation timed out after ${normalized.waitMs} ms; the original graph remains the only resource.`)
      return terminalOutcome(request, { formatVersion: 1, id: graphReference, label: 'Native clarification', cwd: normalized.root, maxParallel: 1, nodes: [] }, waited.snapshot)
    } catch (caught) {
      return unknown(resource, `Resident observation failed after the original graph was retained: ${errorText(caught)}`)
    }
  }

  return { clarify, observe }
}

async function runClarify(
  request: StudioClarifyPortRequest,
  normalized: { readonly root: string; readonly waitMs: number; readonly pollMs: number },
  options: NativeClarifierOptions,
): Promise<InsightStageOutcome> {
  const resource = outcomeResource(request, graphId(request.commandId))
  if (request.signal.aborted) return failed(resource, 'NATIVE_CLARIFIER_ABORTED_BEFORE_SUBMIT', 'Local cancellation happened before Resident submission.', 'no-active-effect')
  const resident = residentApi(options)
  if (resident === undefined) return failed(resource, 'NATIVE_CLARIFIER_RESIDENT_UNAVAILABLE', 'Native Resident is unavailable; no graph was submitted.', 'no-active-effect')
  const workspace = join(normalized.root, CLARIFIER_WORKSPACE)
  try {
    await mkdir(workspace, { recursive: true })
  } catch (caught) {
    return failed(resource, 'NATIVE_CLARIFIER_WORKSPACE_UNAVAILABLE', `The clarifier workspace could not be created: ${errorText(caught)}`, 'no-active-effect')
  }
  const prompt = actualPrompt(request.renderedInput)
  const graph = graphFor(request, workspace, prompt)
  try {
    if (options.logRequest !== undefined) await options.logRequest(request.sessionId, prompt)
  } catch (caught) {
    return failed(resource, 'NATIVE_CLARIFIER_REQUEST_LOG_FAILED', `The complete native prompt was not recorded: ${errorText(caught)}`, 'no-active-effect')
  }
  if (request.signal.aborted) return failed(resource, 'NATIVE_CLARIFIER_ABORTED_BEFORE_SUBMIT', 'Local cancellation happened before Resident submission.', 'no-active-effect')
  let submitted = false
  try {
    submitted = true
    await resident.submit({ commandId: submitCommandId(request.commandId), graph })
  } catch (caught) {
    return unknown(resource, `Resident submission outcome is unknown after the submit call: ${errorText(caught)}`)
  }
  if (!submitted) return failed(resource, 'NATIVE_CLARIFIER_NOT_SUBMITTED', 'Resident submission did not start.', 'no-active-effect')
  try {
    const waited = await waitForSnapshot(resident, graph.id, normalized.waitMs, normalized.pollMs, request.signal)
    if (waited.aborted) return unknown(resource, 'Local observation was cancelled; Resident work was not cancelled.')
    if (waited.snapshot === undefined) return unknown(resource, 'Resident observation returned no snapshot after submission.')
    if (waited.timedOut) return unknown(resource, `Local observation timed out after ${normalized.waitMs} ms; the submitted graph was not cancelled.`)
    return terminalOutcome(request, graph, waited.snapshot)
  } catch (caught) {
    return unknown(resource, `Resident observation failed after submission; the original effect remains unresolved: ${errorText(caught)}`)
  }
}
