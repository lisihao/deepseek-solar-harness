/**
 * Durable coordinated ChatGPT Web sessions for the explicit Resident mode.
 *
 * A lane is owned by its parent DSH session and a caller-selected lane suffix.
 * Browser state remains the user's authenticated ChatGPT state; only receipts
 * required to avoid replaying a possibly sent prompt enter the parent log.
 *
 * @module @deepseek-ai/dsh-physical-operator-chatgpt-web/web-session
 */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { BrowserError, type BrowserJsonValue, type BrowserRunProgramV1 } from '@deepseek-ai/dsh-browser'
import {
  PhysicalOperatorError,
  type PhysicalOperatorProgressEvent,
  type PhysicalOperatorProgressPage,
  type PhysicalOperatorProviderRun,
  type PhysicalOperatorProviderStartRequest,
  type PhysicalOperatorResult,
} from '@deepseek-ai/dsh-physical-operator'
import { receiveOperatorContextEnvelope, renderOperatorContextEnvelopeText } from '@deepseek-ai/dsh-system-prompt'
import {
  buildCoordinatedWebInspectProgram,
  buildCoordinatedWebPollProgram,
  buildCoordinatedWebPrepareProgram,
  buildCoordinatedWebSubmissionProofProgram,
  buildCoordinatedWebSubmitProgram,
  type CoordinatedWebPrepareProgramRequest,
  type CoordinatedWebSubmitProgramRequest,
} from './web-session-browser.ts'
import type { WebModelPreferences } from './model-catalog.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Pre-send identity for one command. It proves only that DSH began a
     * browser attempt; it never proves that ChatGPT accepted the prompt.
     */
    'chatgpt-web/intent': {
      commandId: string
      parentId: string
      laneId: string
      laneKey: string
      workspaceName: string
      promptSha256: string
      targetUrl: string
      connectorName: string
      baselineUserMessageIds: string[]
      profile?: WebModelPreferences
    }
    /**
     * A website observation proved the exact native user message created for
     * one command in its owned lane.
     */
    'chatgpt-web/accepted': {
      commandId: string
      parentId: string
      laneId: string
      laneKey: string
      workspaceName: string
      conversationId: string
      conversationUrl: string
      userMessageId: string
      connectorName: string
      requestIds: string[]
    }
    /**
     * A strong terminal signal or exact final action produced one completed
     * assistant result for the accepted native user message.
     */
    'chatgpt-web/completed': {
      commandId: string
      parentId: string
      laneId: string
      laneKey: string
      conversationId: string
      conversationUrl: string
      userMessageId: string
      assistantMessageId: string
      response: string
      responseSha256: string
      truncated: boolean
      model: string
      effort?: string
      requestIds: string[]
    }
    /**
     * A known local refusal before the send click. It prevents a duplicate
     * command from silently re-evaluating a changed browser draft or connector.
     */
    'chatgpt-web/rejected': {
      commandId: string
      parentId: string
      laneId: string
      laneKey: string
      code: string
    }
    /**
     * A send click returned before a native user-message identity was observed.
     * The candidate page is retained solely for a no-send recovery inspection.
     */
    'chatgpt-web/submission-pending': {
      commandId: string
      parentId: string
      laneId: string
      laneKey: string
      candidateUrl: string
      baselineUserMessageIds: string[]
    }
    /** Exact user-turn observation reached a stopped or failed provider outcome. */
    'chatgpt-web/terminal': {
      commandId: string
      parentId: string
      laneId: string
      laneKey: string
      outcome: 'stopped' | 'failed'
    }
  }
}

/** A verified current native turn observation delivered to the MCP owner. */
export interface CoordinatedWebSessionObservation {
  /** DSH command whose native user turn was observed. */
  readonly commandId: string
  /** ChatGPT conversation id, omitted only when exact ownership was not proven. */
  readonly conversationId?: string
  /** Exact page URL currently holding the observed native turn. */
  readonly conversationUrl?: string
  /** Exact native user-message id for this command only. */
  readonly userMessageId?: string
  /** Exact assistant message paired with the native user turn, when present. */
  readonly assistantMessageId?: string
  /** Request ids read only from the exact native user turn's bounded React props. */
  readonly requestIds: readonly string[]
  /** Exact current assistant content, when the paired assistant node exists. */
  readonly response?: string
  /** Website-observed model label, or `unknown` when the turn exposes none. */
  readonly model: string
  /** Website-observed reasoning label, if the native message metadata exposes one. */
  readonly effort?: string
  /** Whether ChatGPT currently exposes an active generation control. */
  readonly generating: boolean
  /** Terminal state for this exact native user turn; only `completed` is success. */
  readonly terminal: 'running' | 'completed' | 'stopped' | 'failed' | 'indeterminate'
  /** Whether the browser truncated response text to retain its JSON bound. */
  readonly truncated?: boolean
}

/** Deployment-owned controls for a coordinated ChatGPT Web lane. */
export interface CoordinatedWebSessionOptions {
  /** Prefix used to derive an isolated named workspace for one durable lane. */
  readonly workspaceName: string
  /** ChatGPT root page used for a fresh lane. */
  readonly url: string
  /** Total bounded time spent observing one accepted native user turn. */
  readonly generationTimeoutMs: number
  /** Total bounded time spent proving a click created one native user message. */
  readonly submissionTimeoutMs: number
  /** Delay between separate short browser-js-v1 observations. */
  readonly pollIntervalMs: number
  /** Maximum JSON result size accepted from each browser program. */
  readonly outputMaxBytes: number
  /** Actual ChatGPT MCP app that must already appear as an attached composer control. */
  readonly connectorName: string
  /** Explicit model and reasoning controls captured at dispatch for one command. */
  readonly profile?: WebModelPreferences
  /**
   * Optional already-rendered request text. A caller may supply this only when
   * it used the same text rendering as this provider's context envelope path.
   */
  readonly renderedPrompt?: string
  /** Receives every exact-turn polling observation for MCP ownership proof. */
  readonly onObservation?: (observation: CoordinatedWebSessionObservation) => void | Promise<void>
  /**
   * Returns whether the external MCP owner has no accepted tool work pending.
   * A visually final ChatGPT response remains non-terminal while this is false.
   */
  readonly canFinish: () => boolean
}

interface LaneIdentity {
  readonly commandId: string
  readonly parentId: string
  readonly laneId: string
  readonly laneKey: string
  readonly workspaceName: string
}

interface IntentReceipt {
  readonly commandId: string
  readonly parentId: string
  readonly laneId: string
  readonly laneKey: string
  readonly workspaceName: string
  readonly promptSha256: string
  readonly targetUrl: string
  readonly connectorName: string
  readonly baselineUserMessageIds: readonly string[]
  readonly profile?: WebModelPreferences
  readonly sequence: number
}

interface AcceptedReceipt {
  readonly commandId: string
  readonly parentId: string
  readonly laneId: string
  readonly laneKey: string
  readonly workspaceName: string
  readonly conversationId: string
  readonly conversationUrl: string
  readonly userMessageId: string
  readonly connectorName: string
  readonly requestIds: readonly string[]
  readonly sequence: number
}

interface CompletedReceipt {
  readonly commandId: string
  readonly parentId: string
  readonly laneId: string
  readonly laneKey: string
  readonly conversationId: string
  readonly conversationUrl: string
  readonly userMessageId: string
  readonly assistantMessageId: string
  readonly response: string
  readonly responseSha256: string
  readonly truncated: boolean
  readonly model: string
  readonly effort?: string
  readonly requestIds: readonly string[]
  readonly sequence: number
}

interface RejectedReceipt {
  readonly commandId: string
  readonly parentId: string
  readonly laneId: string
  readonly laneKey: string
  readonly code: string
}

type BrowserObservation = Omit<CoordinatedWebSessionObservation, 'commandId'>

type SubmitOutcome =
  | { readonly status: 'accepted'; readonly observation: BrowserObservation }
  | { readonly status: 'submission-pending'; readonly candidateUrl?: string }
  | { readonly status: 'model-selection-unavailable' }
  | { readonly status: 'draft-present'; readonly inputCharacters: number; readonly attachmentCount: number }
  | { readonly status: 'connector-required' }
  | { readonly status: 'lane-active' }
  | { readonly status: 'lane-unowned' }
  | { readonly status: 'identity-unproven' }
  | { readonly status: 'input-unavailable' }
  | { readonly status: 'submission-failed' }
  | { readonly status: 'protocol-error' }

type PrepareOutcome = { readonly status: 'ready'; readonly baselineUserMessageIds: readonly string[] }
  | Exclude<SubmitOutcome, { readonly status: 'accepted' } | { readonly status: 'submission-pending' }>

type PollOutcome = { readonly status: 'observation'; readonly observation: BrowserObservation }
  | { readonly status: 'protocol-error' }

const DEFAULT_LANE_ID = 'main'
const WEB_SESSION_RECEIVER = 'chatgpt-web'

/**
 * Start a recoverable Resident-mode ChatGPT Web run.
 *
 * A same command id returns a persisted completed result or observes the
 * recorded native user turn. It never sends a second prompt after a durable
 * pre-send intent exists without an accepted native user-message receipt.
 * @param ctx - Context exposing the provider-neutral browser service.
 * @param request - service-normalized Resident execution request.
 * @param options - deployment bounds, attached MCP app, and observation sink.
 * @returns holder-owned physical-operator run with parent-log-backed continuity.
 */
export async function runCoordinatedWebSession(
  ctx: Context,
  request: PhysicalOperatorProviderStartRequest,
  options: CoordinatedWebSessionOptions,
): Promise<PhysicalOperatorProviderRun> {
  if (request.mode !== 'resident') {
    throw new PhysicalOperatorError('ChatGPT Web coordinated sessions require resident execution', 'OPERATOR_MODE_UNSUPPORTED')
  }
  if (request.signal.aborted) {
    throw new PhysicalOperatorError('ChatGPT Web execution was aborted before startup', 'OPERATOR_ABORTED')
  }
  assertOptions(options)
  const profile = normalizedProfile(options.profile)
  const lane = laneIdentity(request, options.workspaceName)
  const prompt = promptForRequest(request, options.renderedPrompt)
  const promptSha256 = sha256(prompt)
  const contextReceipt = request.contextEnvelope === undefined
    ? undefined
    : receiveOperatorContextEnvelope(request.contextEnvelope, WEB_SESSION_RECEIVER, 'text')
  const reuseProblem = commandReuseProblem(request, lane, promptSha256, options.connectorName, profile)
  if (reuseProblem !== undefined) return indeterminateRun(reuseProblem, contextReceipt)
  const completed = completedForCommand(request, lane)
  if (completed !== undefined) {
    return completedRun(completed, lane, contextReceipt)
  }
  const rejected = rejectedForCommand(request, lane)
  if (rejected !== undefined) {
    return rejectedRun(rejected, contextReceipt)
  }
  const priorIntent = intentForCommand(request, lane)
  if (priorIntent !== undefined && (priorIntent.promptSha256 !== promptSha256
    || priorIntent.connectorName !== options.connectorName || !sameProfile(priorIntent.profile, profile))) {
    return indeterminateRun(
      new PhysicalOperatorError('ChatGPT Web command inputs diverge from its durable pre-send intent', 'CHATGPT_WEB_INDETERMINATE'),
      contextReceipt,
    )
  }
  const latestAccepted = latestAcceptedForLane(request, lane)
  if (priorIntent !== undefined) {
    return liveRun(ctx, request, options, lane, priorIntent, false, latestAccepted, contextReceipt)
  }
  const preparation = await prepareIntent(ctx, request, options, lane, latestAccepted, prompt, profile)
  if (preparation.status !== 'ready') return indeterminateRun(prepareError(preparation), contextReceipt)
  const racedProblem = commandReuseProblem(request, lane, promptSha256, options.connectorName, profile)
  if (racedProblem !== undefined) return indeterminateRun(racedProblem, contextReceipt)
  const racedIntent = intentForCommand(request, lane)
  if (racedIntent !== undefined) {
    return liveRun(ctx, request, options, lane, racedIntent, false, latestAcceptedForLane(request, lane), contextReceipt)
  }
  const intent = appendIntent(
    request,
    lane,
    promptSha256,
    options.connectorName,
    latestAccepted?.conversationUrl ?? options.url,
    preparation.baselineUserMessageIds,
    profile,
  )
  return liveRun(ctx, request, options, lane, intent, true, latestAccepted, contextReceipt)
}

function liveRun(
  ctx: Context,
  request: PhysicalOperatorProviderStartRequest,
  options: CoordinatedWebSessionOptions,
  lane: LaneIdentity,
  intent: IntentReceipt,
  freshIntent: boolean,
  latestAccepted: AcceptedReceipt | undefined,
  contextReceipt: PhysicalOperatorProviderRun['contextReceipt'],
): PhysicalOperatorProviderRun {
  const progress = new ProgressLog(lane.commandId)
  progress.append('chatgpt-web.resident.intent', { phase: 'intent', laneId: lane.laneId })
  const controller = new AbortController()
  const forwardAbort = (): void => { controller.abort(request.signal.reason) }
  request.signal.addEventListener('abort', forwardAbort, { once: true })
  const result = executeCoordinatedRun(ctx, request, options, lane, intent, freshIntent, latestAccepted, progress, controller.signal)
    .catch((error: unknown): PhysicalOperatorResult => {
      if (controller.signal.aborted || error instanceof BrowserError && error.code === 'BROWSER_ABORTED') {
        progress.append('chatgpt-web.resident.aborted', { phase: 'aborted' })
        return { output: [], stopReason: 'aborted', continuity: continuity(lane, request.parent.session.seq) }
      }
      progress.append('chatgpt-web.resident.failed', { phase: 'failed', code: errorCode(error) })
      throw error
    })
    .finally(() => { request.signal.removeEventListener('abort', forwardAbort) })
  let disposal: Promise<void> | undefined
  return {
    ...contextReceipt === undefined ? {} : { contextReceipt },
    // This is a local durable lane receipt. It says DSH accepted the command;
    // `chatgpt-web/accepted` alone proves a website-side submission.
    receipt: { sessionId: lane.laneKey, turnId: lane.commandId, stateRevision: intent.sequence },
    result,
    readEvents: (afterSequence, limit, signal) => progress.read(afterSequence, limit, signal),
    dispose: (): Promise<void> => {
      if (disposal !== undefined) return disposal
      controller.abort(new Error('ChatGPT Web coordinated session was disposed'))
      disposal = settleForDisposal(result)
      return disposal
    },
  }
}

/**
 * Read and freeze the exact user-message baseline before a durable intent can
 * authorize one send click. This program has no fill or click operation.
 */
async function prepareIntent(
  ctx: Context,
  request: PhysicalOperatorProviderStartRequest,
  options: CoordinatedWebSessionOptions,
  lane: LaneIdentity,
  previous: AcceptedReceipt | undefined,
  prompt: string,
  profile: WebModelPreferences | undefined,
): Promise<PrepareOutcome> {
  const previousCompleted = previous === undefined
    ? undefined
    : completedForCommandId(request, lane, previous.commandId)
  const preparation: CoordinatedWebPrepareProgramRequest = {
    workspaceName: lane.workspaceName,
    url: previous?.conversationUrl ?? options.url,
    outputMaxBytes: options.outputMaxBytes,
    prompt,
    connectorName: options.connectorName,
    freshLane: previous === undefined,
    baselineUserMessageIds: [],
    modelSelectionTimeoutMs: options.submissionTimeoutMs,
    pollIntervalMs: options.pollIntervalMs,
    submissionTimeoutMs: options.submissionTimeoutMs,
    ...profile === undefined ? {} : { profile },
    ...previous === undefined ? {} : {
      previousTurn: {
        conversationUrl: previous.conversationUrl,
        userMessageId: previous.userMessageId,
        ...previousCompleted?.assistantMessageId === undefined
          ? {}
          : { assistantMessageId: previousCompleted.assistantMessageId },
      },
    },
  }
  return prepareOutcome(await jsonOutput(ctx, buildCoordinatedWebPrepareProgram(preparation), request.signal))
}

async function executeCoordinatedRun(
  ctx: Context,
  request: PhysicalOperatorProviderStartRequest,
  options: CoordinatedWebSessionOptions,
  lane: LaneIdentity,
  intent: IntentReceipt,
  freshIntent: boolean,
  latestAccepted: AcceptedReceipt | undefined,
  progress: ProgressLog,
  signal: AbortSignal,
): Promise<PhysicalOperatorResult> {
  const existingAccepted = acceptedForCommand(request, lane)
  if (existingAccepted !== undefined) {
    return await observeAcceptedRun(ctx, request, options, lane, existingAccepted, progress, signal)
  }
  if (!freshIntent) {
    await inspectAmbiguousIntent(ctx, request, options, lane, intent, progress, signal)
  }
  let previous = latestAccepted
  if (previous !== undefined && completedForCommandId(request, lane, previous.commandId) === undefined) {
    const prior = await observeAcceptedRun(ctx, request, options, lane, previous, progress, signal)
    if (prior.stopReason !== 'completed') {
      throw new PhysicalOperatorError('ChatGPT Web lane has an unfinished or stopped prior command', 'CHATGPT_WEB_LANE_ACTIVE')
    }
    previous = latestAcceptedForLane(request, lane)
  }
  return await submitNewCommand(ctx, request, options, lane, intent, previous, progress, signal)
}

async function submitNewCommand(
  ctx: Context,
  request: PhysicalOperatorProviderStartRequest,
  options: CoordinatedWebSessionOptions,
  lane: LaneIdentity,
  intent: IntentReceipt,
  previous: AcceptedReceipt | undefined,
  progress: ProgressLog,
  signal: AbortSignal,
): Promise<PhysicalOperatorResult> {
  const prompt = promptForRequest(request, options.renderedPrompt)
  const previousCompleted = previous === undefined
    ? undefined
    : completedForCommandId(request, lane, previous.commandId)
  const submitRequest: CoordinatedWebSubmitProgramRequest = {
    workspaceName: lane.workspaceName,
    url: previous?.conversationUrl ?? options.url,
    outputMaxBytes: options.outputMaxBytes,
    prompt,
    connectorName: options.connectorName,
    freshLane: previous === undefined,
    baselineUserMessageIds: intent.baselineUserMessageIds,
    modelSelectionTimeoutMs: options.submissionTimeoutMs,
    pollIntervalMs: options.pollIntervalMs,
    submissionTimeoutMs: options.submissionTimeoutMs,
    ...intent.profile === undefined ? {} : { profile: intent.profile },
    ...previous === undefined ? {} : {
      previousTurn: {
        conversationUrl: previous.conversationUrl,
        userMessageId: previous.userMessageId,
        ...previousCompleted?.assistantMessageId === undefined
          ? {}
          : { assistantMessageId: previousCompleted.assistantMessageId },
      },
    },
  }
  progress.append('chatgpt-web.resident.submitting', { phase: 'submitting', laneId: lane.laneId })
  const initial = submitOutcome(await jsonOutput(ctx, buildCoordinatedWebSubmitProgram(submitRequest), signal))
  if (initial.status === 'accepted') {
    const accepted = appendAccepted(request, lane, options.connectorName, initial.observation)
    await deliverObservation(options, lane.commandId, initial.observation)
    progress.append('chatgpt-web.resident.accepted', { phase: 'accepted' })
    return await observeAcceptedRun(ctx, request, options, lane, accepted, progress, signal)
  }
  if (initial.status === 'submission-pending') {
    const candidateUrl = initial.candidateUrl ?? intent.targetUrl
    request.parent.session.append('chatgpt-web/submission-pending', {
      commandId: lane.commandId,
      parentId: lane.parentId,
      laneId: lane.laneId,
      laneKey: lane.laneKey,
      candidateUrl,
      baselineUserMessageIds: [...intent.baselineUserMessageIds],
    }, { ignorable: true })
    return await proveSubmittedCommand(
      ctx,
      request,
      options,
      lane,
      candidateUrl,
      intent.baselineUserMessageIds,
      progress,
      signal,
    )
  }
  const error = submitError(initial)
  request.parent.session.append('chatgpt-web/rejected', {
    commandId: lane.commandId,
    parentId: lane.parentId,
    laneId: lane.laneId,
    laneKey: lane.laneKey,
    code: error.code,
  }, { ignorable: true })
  throw error
}

async function proveSubmittedCommand(
  ctx: Context,
  request: PhysicalOperatorProviderStartRequest,
  options: CoordinatedWebSessionOptions,
  lane: LaneIdentity,
  candidateUrl: string,
  baselineUserMessageIds: readonly string[],
  progress: ProgressLog,
  signal: AbortSignal,
): Promise<PhysicalOperatorResult> {
  if (!isExactChatGptConversationUrl(candidateUrl)) {
    throw new PhysicalOperatorError(
      'ChatGPT Web cannot recover an unproven send without an exact recorded conversation URL',
      'CHATGPT_WEB_INDETERMINATE',
    )
  }
  const deadline = Date.now() + options.submissionTimeoutMs
  const prompt = promptForRequest(request, options.renderedPrompt)
  while (Date.now() <= deadline) {
    await delay(options.pollIntervalMs, signal)
    const proof = submissionProofOutcome(await jsonOutput(ctx, buildCoordinatedWebSubmissionProofProgram({
      workspaceName: lane.workspaceName,
      url: candidateUrl,
      outputMaxBytes: options.outputMaxBytes,
      prompt,
      baselineUserMessageIds,
    }), signal))
    if (proof.status === 'accepted') {
      const accepted = appendAccepted(request, lane, options.connectorName, proof.observation)
      await deliverObservation(options, lane.commandId, proof.observation)
      progress.append('chatgpt-web.resident.accepted', { phase: 'accepted' })
      return await observeAcceptedRun(ctx, request, options, lane, accepted, progress, signal)
    }
    if (proof.status === 'identity-unproven') {
      throw new PhysicalOperatorError('ChatGPT Web cannot prove which native user message belongs to this command', 'CHATGPT_WEB_INDETERMINATE')
    }
    if (proof.status === 'protocol-error') {
      throw new PhysicalOperatorError('ChatGPT Web returned an invalid submission-proof result', 'CHATGPT_WEB_PROTOCOL')
    }
    if (proof.candidateUrl !== undefined && proof.candidateUrl !== candidateUrl) {
      candidateUrl = proof.candidateUrl
      request.parent.session.append('chatgpt-web/submission-pending', {
        commandId: lane.commandId,
        parentId: lane.parentId,
        laneId: lane.laneId,
        laneKey: lane.laneKey,
        candidateUrl,
        baselineUserMessageIds: [...baselineUserMessageIds],
      }, { ignorable: true })
    }
  }
  throw new PhysicalOperatorError('ChatGPT Web did not prove prompt acceptance before the submission timeout', 'CHATGPT_WEB_INDETERMINATE')
}

async function observeAcceptedRun(
  ctx: Context,
  request: PhysicalOperatorProviderStartRequest,
  options: CoordinatedWebSessionOptions,
  lane: LaneIdentity,
  accepted: AcceptedReceipt,
  progress: ProgressLog,
  signal: AbortSignal,
): Promise<PhysicalOperatorResult> {
  const completed = completedForCommandId(request, lane, accepted.commandId)
  if (completed !== undefined) return resultForCompleted(completed, lane)
  const deadline = Date.now() + options.generationTimeoutMs
  while (Date.now() <= deadline) {
    const currentCompleted = completedForCommandId(request, lane, accepted.commandId)
    if (currentCompleted !== undefined) return resultForCompleted(currentCompleted, lane)
    const outcome = pollOutcome(await jsonOutput(ctx, buildCoordinatedWebPollProgram({
      workspaceName: accepted.workspaceName,
      url: accepted.conversationUrl,
      outputMaxBytes: options.outputMaxBytes,
      userMessageId: accepted.userMessageId,
    }), signal))
    if (outcome.status !== 'observation') {
      throw new PhysicalOperatorError('ChatGPT Web returned an invalid polling result', 'CHATGPT_WEB_PROTOCOL')
    }
    const observation = outcome.observation
    if (!sameNativeTurn(accepted, observation)) {
      throw new PhysicalOperatorError('ChatGPT Web no longer proves the accepted native user-turn identity', 'CHATGPT_WEB_INDETERMINATE')
    }
    await deliverObservation(options, accepted.commandId, observation)
    progress.append('chatgpt-web.resident.waiting', {
      phase: 'waiting',
      generating: observation.generating,
      terminal: observation.terminal,
    })
    if (observation.terminal === 'completed') {
      if (!canFinish(options)) {
        progress.append('chatgpt-web.resident.waiting', { phase: 'waiting', toolPending: true })
        await delay(options.pollIntervalMs, signal)
        continue
      }
      if (observation.response === undefined || observation.response.length === 0) {
        throw new PhysicalOperatorError('ChatGPT Web completed without an exact non-empty assistant response', 'CHATGPT_WEB_OUTPUT_UNAVAILABLE')
      }
      const receipt = appendCompleted(request, lane, accepted, observation)
      progress.append('chatgpt-web.resident.completed', { phase: 'completed', truncated: receipt.truncated })
      return resultForCompleted(receipt, lane)
    }
    if (observation.terminal === 'stopped' || observation.terminal === 'failed') {
      request.parent.session.append('chatgpt-web/terminal', {
        commandId: accepted.commandId,
        parentId: lane.parentId,
        laneId: lane.laneId,
        laneKey: lane.laneKey,
        outcome: observation.terminal,
      }, { ignorable: true })
      progress.append('chatgpt-web.resident.terminal', { phase: 'terminal', outcome: observation.terminal })
      return {
        output: [],
        stopReason: observation.terminal === 'stopped' ? 'aborted' : 'error',
        continuity: continuity(lane, request.parent.session.seq),
      }
    }
    await delay(options.pollIntervalMs, signal)
  }
  throw new PhysicalOperatorError('ChatGPT Web did not reach a verified terminal state before the generation timeout', 'CHATGPT_WEB_TIMEOUT')
}

async function inspectAmbiguousIntent(
  ctx: Context,
  request: PhysicalOperatorProviderStartRequest,
  options: CoordinatedWebSessionOptions,
  lane: LaneIdentity,
  intent: IntentReceipt,
  progress: ProgressLog,
  signal: AbortSignal,
): Promise<never> {
  const pending = pendingForCommand(request, lane)
  const expectedUrl = pending?.candidateUrl ?? intent.targetUrl
  const outcome = inspectOutcome(await jsonOutput(ctx, buildCoordinatedWebInspectProgram({
    workspaceName: lane.workspaceName,
    url: expectedUrl,
    expectedUrl,
    outputMaxBytes: options.outputMaxBytes,
  }), signal))
  progress.append('chatgpt-web.resident.indeterminate', {
    phase: 'indeterminate',
    pageMatched: outcome.status === 'inspected',
  })
  throw new PhysicalOperatorError(
    'ChatGPT Web has a durable pre-send intent without an accepted native user-message receipt; it will not resend automatically',
    'CHATGPT_WEB_INDETERMINATE',
  )
}

function appendIntent(
  request: PhysicalOperatorProviderStartRequest,
  lane: LaneIdentity,
  promptSha256: string,
  connectorName: string,
  targetUrl: string,
  baselineUserMessageIds: readonly string[],
  profile: WebModelPreferences | undefined,
): IntentReceipt {
  const event = request.parent.session.append('chatgpt-web/intent', {
    commandId: lane.commandId,
    parentId: lane.parentId,
    laneId: lane.laneId,
    laneKey: lane.laneKey,
    workspaceName: lane.workspaceName,
    promptSha256,
    targetUrl,
    connectorName,
    baselineUserMessageIds: [...baselineUserMessageIds],
    ...profile === undefined ? {} : { profile },
  }, { ignorable: true })
  return { ...event.data, sequence: event.seq }
}

function appendAccepted(
  request: PhysicalOperatorProviderStartRequest,
  lane: LaneIdentity,
  connectorName: string,
  observation: BrowserObservation,
): AcceptedReceipt {
  if (!hasExactNativeIdentity(observation)) {
    throw new PhysicalOperatorError('ChatGPT Web accepted observation is missing exact native message identity', 'CHATGPT_WEB_INDETERMINATE')
  }
  const existing = acceptedForCommand(request, lane)
  if (existing !== undefined) return existing
  const event = request.parent.session.append('chatgpt-web/accepted', {
    commandId: lane.commandId,
    parentId: lane.parentId,
    laneId: lane.laneId,
    laneKey: lane.laneKey,
    workspaceName: lane.workspaceName,
    conversationId: observation.conversationId,
    conversationUrl: observation.conversationUrl,
    userMessageId: observation.userMessageId,
    connectorName,
    requestIds: [...observation.requestIds],
  }, { ignorable: true })
  return { ...event.data, sequence: event.seq }
}

function appendCompleted(
  request: PhysicalOperatorProviderStartRequest,
  lane: LaneIdentity,
  accepted: AcceptedReceipt,
  observation: BrowserObservation,
): CompletedReceipt {
  const existing = completedForCommandId(request, lane, accepted.commandId)
  if (existing !== undefined) return existing
  if (observation.assistantMessageId === undefined || observation.response === undefined) {
    throw new PhysicalOperatorError('ChatGPT Web completed observation is missing exact assistant content', 'CHATGPT_WEB_INDETERMINATE')
  }
  const event = request.parent.session.append('chatgpt-web/completed', {
    commandId: accepted.commandId,
    parentId: lane.parentId,
    laneId: lane.laneId,
    laneKey: lane.laneKey,
    conversationId: accepted.conversationId,
    conversationUrl: accepted.conversationUrl,
    userMessageId: accepted.userMessageId,
    assistantMessageId: observation.assistantMessageId,
    response: observation.response,
    responseSha256: sha256(observation.response),
    truncated: observation.truncated === true,
    model: observation.model,
    ...observation.effort === undefined ? {} : { effort: observation.effort },
    requestIds: [...observation.requestIds],
  }, { ignorable: true })
  return { ...event.data, sequence: event.seq }
}

function completedRun(
  completed: CompletedReceipt,
  lane: LaneIdentity,
  contextReceipt: PhysicalOperatorProviderRun['contextReceipt'],
): PhysicalOperatorProviderRun {
  return {
    ...contextReceipt === undefined ? {} : { contextReceipt },
    receipt: { sessionId: lane.laneKey, turnId: lane.commandId, stateRevision: completed.sequence },
    result: Promise.resolve(resultForCompleted(completed, lane)),
    readEvents: () => Promise.resolve({ events: [], nextSequence: 0 }),
    dispose: () => Promise.resolve(),
  }
}

function rejectedRun(
  rejected: RejectedReceipt,
  contextReceipt: PhysicalOperatorProviderRun['contextReceipt'],
): PhysicalOperatorProviderRun {
  return {
    ...contextReceipt === undefined ? {} : { contextReceipt },
    result: Promise.reject(new PhysicalOperatorError(
      `ChatGPT Web command previously stopped before submission (${rejected.code})`,
      rejected.code,
    )),
    readEvents: () => Promise.resolve({ events: [], nextSequence: 0 }),
    dispose: () => Promise.resolve(),
  }
}

function indeterminateRun(
  error: PhysicalOperatorError,
  contextReceipt: PhysicalOperatorProviderRun['contextReceipt'],
): PhysicalOperatorProviderRun {
  return {
    ...contextReceipt === undefined ? {} : { contextReceipt },
    result: Promise.reject(error),
    readEvents: () => Promise.resolve({ events: [], nextSequence: 0 }),
    dispose: () => Promise.resolve(),
  }
}

function resultForCompleted(completed: CompletedReceipt, lane: LaneIdentity): PhysicalOperatorResult {
  return {
    output: [{ type: 'text', text: completed.response }],
    stopReason: 'completed',
    continuity: continuity(lane, completed.sequence),
  }
}

function continuity(lane: LaneIdentity, stateRevision: number): NonNullable<PhysicalOperatorResult['continuity']> {
  return { sessionId: lane.laneKey, stateRevision }
}

function laneIdentity(request: PhysicalOperatorProviderStartRequest, workspacePrefix: string): LaneIdentity {
  const parentId = String(request.parent.id)
  const laneId = request.residentLaneId ?? DEFAULT_LANE_ID
  if (laneId.length === 0 || laneId.trim() !== laneId) {
    throw new PhysicalOperatorError('ChatGPT Web resident lane id must be a non-empty trimmed string', 'INVALID_RESULT')
  }
  const laneKey = `${parentId}:${laneId}`
  return {
    commandId: String(request.executionId),
    parentId,
    laneId,
    laneKey,
    workspaceName: `${workspacePrefix}-lane-${sha256(laneKey).slice(0, 16)}`,
  }
}

function promptForRequest(request: PhysicalOperatorProviderStartRequest, renderedPrompt: string | undefined): string {
  if (renderedPrompt !== undefined) {
    if (renderedPrompt.trim().length === 0) {
      throw new PhysicalOperatorError('ChatGPT Web rendered prompt must not be empty', 'INVALID_RESULT')
    }
    return renderedPrompt
  }
  if (request.contextEnvelope !== undefined) return renderOperatorContextEnvelopeText(request.contextEnvelope)
  const text: string[] = []
  for (const block of request.prompt) {
    if (block.type !== 'text') {
      throw new PhysicalOperatorError('ChatGPT Web accepts text prompt blocks only', 'INVALID_RESULT')
    }
    text.push(block.text)
  }
  const task = text.join('\n')
  if (task.trim().length === 0) {
    throw new PhysicalOperatorError('ChatGPT Web prompt must not be empty', 'INVALID_RESULT')
  }
  return request.systemPrompt === undefined || request.systemPrompt.length === 0
    ? task
    : `${request.systemPrompt}\n\n---\n\n${task}`
}

function assertOptions(options: CoordinatedWebSessionOptions): void {
  for (const [name, value] of Object.entries({
    workspaceName: options.workspaceName,
    url: options.url,
    connectorName: options.connectorName,
  })) {
    if (value.length === 0 || value.trim() !== value) {
      throw new PhysicalOperatorError(`ChatGPT Web ${name} must be a non-empty trimmed string`, name === 'connectorName' ? 'CHATGPT_WEB_CONNECTOR_REQUIRED' : 'INVALID_RESULT')
    }
  }
  for (const [name, value] of Object.entries({
    generationTimeoutMs: options.generationTimeoutMs,
    submissionTimeoutMs: options.submissionTimeoutMs,
    pollIntervalMs: options.pollIntervalMs,
    outputMaxBytes: options.outputMaxBytes,
  })) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new PhysicalOperatorError(`ChatGPT Web ${name} must be a positive finite number`, 'INVALID_RESULT')
    }
  }
  if (typeof options.canFinish !== 'function') {
    throw new PhysicalOperatorError('ChatGPT Web coordinated sessions require a tool-completion gate', 'INVALID_RESULT')
  }
}

/** Normalize a dispatch-captured visible model profile before it enters a receipt. */
function normalizedProfile(profile: WebModelPreferences | undefined): WebModelPreferences | undefined {
  if (profile === undefined) return undefined
  let model: string | undefined
  let effort: string | undefined
  for (const [name, value] of Object.entries(profile)) {
    if (name !== 'model' && name !== 'effort') {
      throw new PhysicalOperatorError(`ChatGPT Web profile contains unsupported ${name}`, 'MODEL_SELECTION_UNAVAILABLE')
    }
    if (typeof value !== 'string' || value.length === 0 || value.length > 256 || value.trim() !== value) {
      throw new PhysicalOperatorError(`ChatGPT Web profile ${name} must be a bounded trimmed string`, 'MODEL_SELECTION_UNAVAILABLE')
    }
    if (name === 'model') model = value
    else effort = value
  }
  return model === undefined && effort === undefined
    ? undefined
    : Object.freeze({ ...model === undefined ? {} : { model }, ...effort === undefined ? {} : { effort } })
}

function sameProfile(left: WebModelPreferences | undefined, right: WebModelPreferences | undefined): boolean {
  return left?.model === right?.model && left?.effort === right?.effort
}

function intentForCommand(request: PhysicalOperatorProviderStartRequest, lane: LaneIdentity): IntentReceipt | undefined {
  for (const event of [...request.parent.session.events].reverse()) {
    if (event.type !== 'chatgpt-web/intent' || !sameLane(event.data, lane) || event.data.commandId !== lane.commandId) continue
    return { ...event.data, sequence: event.seq }
  }
  return undefined
}

/**
 * Reject an execution id that was already bound to another lane or immutable
 * rendered prompt. A completed response never authorizes a different command
 * to reuse its id, even when the caller changed only the lane suffix.
 */
function commandReuseProblem(
  request: PhysicalOperatorProviderStartRequest,
  lane: LaneIdentity,
  promptSha256: string,
  connectorName: string,
  profile: WebModelPreferences | undefined,
): PhysicalOperatorError | undefined {
  let sawReceipt = false
  let matchingIntent: IntentReceipt | undefined
  for (const event of request.parent.session.events) {
    switch (event.type) {
      case 'chatgpt-web/intent': {
        if (event.data.commandId !== lane.commandId) continue
        sawReceipt = true
        if (!sameLane(event.data, lane)) {
          return new PhysicalOperatorError('ChatGPT Web execution id is already bound to a different resident lane', 'CHATGPT_WEB_INDETERMINATE')
        }
        matchingIntent = { ...event.data, sequence: event.seq }
        break
      }
      case 'chatgpt-web/accepted':
      case 'chatgpt-web/completed':
      case 'chatgpt-web/rejected':
      case 'chatgpt-web/submission-pending':
      case 'chatgpt-web/terminal':
        if (event.data.commandId !== lane.commandId) continue
        sawReceipt = true
        if (!sameLane(event.data, lane)) {
          return new PhysicalOperatorError('ChatGPT Web execution id is already bound to a different resident lane', 'CHATGPT_WEB_INDETERMINATE')
        }
        break
      default:
        break
    }
  }
  if (!sawReceipt) return undefined
  if (matchingIntent === undefined) {
    return new PhysicalOperatorError('ChatGPT Web command receipts are missing their durable pre-send intent', 'CHATGPT_WEB_INDETERMINATE')
  }
  if (matchingIntent.promptSha256 !== promptSha256 || matchingIntent.connectorName !== connectorName
    || !sameProfile(matchingIntent.profile, profile)) {
    return new PhysicalOperatorError('ChatGPT Web execution id is already bound to different rendered command inputs', 'CHATGPT_WEB_INDETERMINATE')
  }
  return undefined
}

function acceptedForCommand(request: PhysicalOperatorProviderStartRequest, lane: LaneIdentity): AcceptedReceipt | undefined {
  for (const event of [...request.parent.session.events].reverse()) {
    if (event.type !== 'chatgpt-web/accepted' || !sameLane(event.data, lane) || event.data.commandId !== lane.commandId) continue
    return { ...event.data, sequence: event.seq }
  }
  return undefined
}

function completedForCommand(request: PhysicalOperatorProviderStartRequest, lane: LaneIdentity): CompletedReceipt | undefined {
  return completedForCommandId(request, lane, lane.commandId)
}

function completedForCommandId(
  request: PhysicalOperatorProviderStartRequest,
  lane: LaneIdentity,
  commandId: string,
): CompletedReceipt | undefined {
  for (const event of [...request.parent.session.events].reverse()) {
    if (event.type !== 'chatgpt-web/completed' || !sameLane(event.data, lane) || event.data.commandId !== commandId) continue
    return { ...event.data, sequence: event.seq }
  }
  return undefined
}

function rejectedForCommand(request: PhysicalOperatorProviderStartRequest, lane: LaneIdentity): RejectedReceipt | undefined {
  for (const event of [...request.parent.session.events].reverse()) {
    if (event.type !== 'chatgpt-web/rejected' || !sameLane(event.data, lane) || event.data.commandId !== lane.commandId) continue
    return event.data
  }
  return undefined
}

function pendingForCommand(request: PhysicalOperatorProviderStartRequest, lane: LaneIdentity) {
  for (const event of [...request.parent.session.events].reverse()) {
    if (event.type !== 'chatgpt-web/submission-pending' || !sameLane(event.data, lane) || event.data.commandId !== lane.commandId) continue
    return event.data
  }
  return undefined
}

function latestAcceptedForLane(request: PhysicalOperatorProviderStartRequest, lane: LaneIdentity): AcceptedReceipt | undefined {
  for (const event of [...request.parent.session.events].reverse()) {
    if (event.type !== 'chatgpt-web/accepted' || !sameLane(event.data, lane)) continue
    return { ...event.data, sequence: event.seq }
  }
  return undefined
}

function sameLane(data: { readonly parentId: string; readonly laneId: string; readonly laneKey: string }, lane: LaneIdentity): boolean {
  return data.parentId === lane.parentId && data.laneId === lane.laneId && data.laneKey === lane.laneKey
}

function sameNativeTurn(receipt: AcceptedReceipt, observation: BrowserObservation): boolean {
  return observation.terminal !== 'indeterminate'
    && observation.conversationId === receipt.conversationId
    && observation.conversationUrl === receipt.conversationUrl
    && observation.userMessageId === receipt.userMessageId
}

async function jsonOutput(
  ctx: Context,
  program: BrowserRunProgramV1,
  signal: AbortSignal,
): Promise<BrowserJsonValue> {
  const result = await ctx.browser.runProgram(program, signal)
  if (result.output.kind !== 'json') {
    throw new PhysicalOperatorError('ChatGPT Web browser program returned a non-JSON result', 'CHATGPT_WEB_PROTOCOL')
  }
  return result.output.value
}

function submitOutcome(value: BrowserJsonValue): SubmitOutcome {
  const record = asRecord(value)
  if (record === undefined || typeof record.status !== 'string') return { status: 'protocol-error' }
  switch (record.status) {
    case 'accepted': {
      const observation = acceptedObservation(record.observation)
      return observation === undefined ? { status: 'protocol-error' } : { status: 'accepted', observation }
    }
    case 'submission-pending': {
      const candidateUrl = recoverableCandidateUrl(record.candidateUrl)
      return candidateUrl === undefined ? { status: 'submission-pending' } : { status: 'submission-pending', candidateUrl }
    }
    case 'model-selection-unavailable': return { status: 'model-selection-unavailable' }
    case 'draft-present':
      return isNonNegativeInteger(record.inputCharacters) && isNonNegativeInteger(record.attachmentCount)
        ? { status: 'draft-present', inputCharacters: record.inputCharacters, attachmentCount: record.attachmentCount }
        : { status: 'protocol-error' }
    case 'connector-required': return { status: 'connector-required' }
    case 'lane-active': return { status: 'lane-active' }
    case 'lane-unowned': return { status: 'lane-unowned' }
    case 'identity-unproven': return { status: 'identity-unproven' }
    case 'input-unavailable': return { status: 'input-unavailable' }
    case 'submission-failed': return { status: 'submission-failed' }
    default: return { status: 'protocol-error' }
  }
}

function prepareOutcome(value: BrowserJsonValue): PrepareOutcome {
  const record = asRecord(value)
  if (record === undefined || typeof record.status !== 'string') return { status: 'protocol-error' }
  if (record.status === 'ready') {
    const baseline = boundedIdentityList(record.beforeUserIds)
    return baseline === undefined ? { status: 'protocol-error' } : { status: 'ready', baselineUserMessageIds: baseline }
  }
  return submitOutcome(value) as Exclude<PrepareOutcome, { readonly status: 'ready' }>
}

function submissionProofOutcome(value: BrowserJsonValue): { readonly status: 'accepted'; readonly observation: BrowserObservation }
  | { readonly status: 'submission-pending'; readonly candidateUrl?: string }
  | { readonly status: 'identity-unproven' } | { readonly status: 'protocol-error' } {
  const record = asRecord(value)
  if (record === undefined || typeof record.status !== 'string') return { status: 'protocol-error' }
  if (record.status === 'accepted') {
    const observation = acceptedObservation(record.observation)
    return observation === undefined ? { status: 'protocol-error' } : { status: 'accepted', observation }
  }
  if (record.status === 'submission-pending') {
    const candidateUrl = recoverableCandidateUrl(record.candidateUrl)
    return candidateUrl === undefined ? { status: 'submission-pending' } : { status: 'submission-pending', candidateUrl }
  }
  if (record.status === 'identity-unproven') return { status: 'identity-unproven' }
  return { status: 'protocol-error' }
}

/** Parse an accepted wrapper only when it carries one exact native turn. */
function acceptedObservation(value: BrowserJsonValue | undefined): BrowserObservation | undefined {
  const record = asRecord(value)
  if (record?.identity !== 'exact') return undefined
  const observation = parseObservation(value)
  return observation !== undefined && hasExactNativeIdentity(observation) ? observation : undefined
}

function pollOutcome(value: BrowserJsonValue): PollOutcome {
  const record = asRecord(value)
  if (record?.status !== 'observation') return { status: 'protocol-error' }
  const observation = parseObservation(record.observation)
  return observation === undefined ? { status: 'protocol-error' } : { status: 'observation', observation }
}

function inspectOutcome(value: BrowserJsonValue): { readonly status: 'inspected' | 'identity-unproven' } | { readonly status: 'protocol-error' } {
  const record = asRecord(value)
  if (record?.status === 'inspected' || record?.status === 'identity-unproven') return { status: record.status }
  return { status: 'protocol-error' }
}

function parseObservation(value: BrowserJsonValue | undefined): BrowserObservation | undefined {
  const record = asRecord(value)
  if (record === undefined || typeof record.identity !== 'string' || typeof record.generating !== 'boolean'
    || !isTerminal(record.terminal) || !Array.isArray(record.requestIds) || typeof record.model !== 'string') return undefined
  const requestIds = record.requestIds.every(isBoundedString) ? [...record.requestIds] : undefined
  if (requestIds === undefined) return undefined
  const base = {
    requestIds,
    model: record.model.length === 0 ? 'unknown' : record.model,
    generating: record.generating,
    terminal: record.terminal,
    ...typeof record.conversationId === 'string' ? { conversationId: record.conversationId } : {},
    ...typeof record.conversationUrl === 'string' ? { conversationUrl: record.conversationUrl } : {},
    ...typeof record.userMessageId === 'string' ? { userMessageId: record.userMessageId } : {},
    ...typeof record.assistantMessageId === 'string' ? { assistantMessageId: record.assistantMessageId } : {},
    ...typeof record.response === 'string' ? { response: record.response } : {},
    ...record.truncated === true ? { truncated: true } : {},
    ...typeof record.effort === 'string' ? { effort: record.effort } : {},
  }
  if (record.identity === 'unproven') {
    return { ...base, requestIds: [], terminal: 'indeterminate', model: 'unknown' }
  }
  if (record.identity !== 'exact' || base.conversationId === undefined || base.conversationUrl === undefined || base.userMessageId === undefined) {
    return undefined
  }
  return base
}

/** Require the browser result to name one bounded native turn in its exact ChatGPT URL. */
function hasExactNativeIdentity(observation: BrowserObservation): observation is BrowserObservation & {
  readonly conversationId: string
  readonly conversationUrl: string
  readonly userMessageId: string
} {
  return observation.terminal !== 'indeterminate'
    && observation.conversationId !== undefined && isBoundedString(observation.conversationId)
    && observation.conversationUrl !== undefined && isExactChatGptConversationUrl(observation.conversationUrl, observation.conversationId)
    && observation.userMessageId !== undefined && isBoundedString(observation.userMessageId)
}

/** Keep recovery navigation on a concrete chatgpt.com conversation page. */
function isExactChatGptConversationUrl(value: string, expectedConversationId?: string): boolean {
  try {
    const parsed = new URL(value)
    const match = /^\/c\/([^/?#]+)$/.exec(parsed.pathname)
    const conversationId = match?.[1]
    return parsed.protocol === 'https:' && parsed.hostname === 'chatgpt.com'
      && parsed.port.length === 0 && parsed.username.length === 0 && parsed.password.length === 0
      && parsed.search.length === 0 && parsed.hash.length === 0 && conversationId !== undefined && isBoundedString(conversationId)
      && (expectedConversationId === undefined || conversationId === expectedConversationId)
  } catch {
    return false
  }
}

/** Discard browser JSON candidate pages unless recovery can open them exactly. */
function recoverableCandidateUrl(value: BrowserJsonValue | undefined): string | undefined {
  return typeof value === 'string' && isExactChatGptConversationUrl(value) ? value : undefined
}

function submitError(outcome: Exclude<SubmitOutcome, { readonly status: 'accepted' } | { readonly status: 'submission-pending' }>): PhysicalOperatorError {
  switch (outcome.status) {
    case 'model-selection-unavailable':
      return new PhysicalOperatorError(
        'ChatGPT Web could not verify the dispatch-selected model or reasoning control before submission',
        'MODEL_SELECTION_UNAVAILABLE',
      )
    case 'draft-present':
      return new PhysicalOperatorError(
        `ChatGPT Web has an existing composer draft or attachment (inputCharacters=${outcome.inputCharacters}, attachments=${outcome.attachmentCount})`,
        'CHATGPT_WEB_DRAFT_PRESENT',
      )
    case 'connector-required':
      return new PhysicalOperatorError('ChatGPT Web requires the configured MCP app to be visibly attached to the composer', 'CHATGPT_WEB_CONNECTOR_REQUIRED')
    case 'lane-active':
      return new PhysicalOperatorError('ChatGPT Web lane has an active generation and will not send another command', 'CHATGPT_WEB_LANE_ACTIVE')
    case 'lane-unowned':
      return new PhysicalOperatorError('ChatGPT Web fresh lane is not an empty owned root conversation', 'CHATGPT_WEB_LANE_UNOWNED')
    case 'identity-unproven':
      return new PhysicalOperatorError('ChatGPT Web cannot prove the selected lane belongs to the expected native turn', 'CHATGPT_WEB_INDETERMINATE')
    case 'input-unavailable':
      return new PhysicalOperatorError('ChatGPT Web input is unavailable in the selected browser workspace', 'RUNTIME_UNAVAILABLE')
    case 'submission-failed':
      return new PhysicalOperatorError('ChatGPT Web did not accept the prepared prompt', 'CHATGPT_WEB_SUBMIT_FAILED')
    case 'protocol-error':
      return new PhysicalOperatorError('ChatGPT Web returned an invalid browser program result', 'CHATGPT_WEB_PROTOCOL')
  }
}

function prepareError(outcome: Exclude<PrepareOutcome, { readonly status: 'ready' }>): PhysicalOperatorError {
  return submitError(outcome)
}

async function deliverObservation(
  options: CoordinatedWebSessionOptions,
  commandId: string,
  observation: BrowserObservation,
): Promise<void> {
  if (options.onObservation === undefined) return
  try {
    await options.onObservation({ ...observation, commandId })
  } catch (error) {
    throw new PhysicalOperatorError('ChatGPT Web observation sink rejected MCP ownership proof', 'CHATGPT_WEB_OBSERVATION_FAILED', { cause: error })
  }
}

function canFinish(options: CoordinatedWebSessionOptions): boolean {
  try {
    return options.canFinish()
  } catch (error) {
    throw new PhysicalOperatorError('ChatGPT Web tool-completion gate failed', 'CHATGPT_WEB_OBSERVATION_FAILED', { cause: error })
  }
}

function asRecord(value: BrowserJsonValue | undefined): Readonly<Record<string, BrowserJsonValue>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, BrowserJsonValue>>
    : undefined
}

function isBoundedString(value: BrowserJsonValue): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
}

function boundedIdentityList(value: BrowserJsonValue | undefined): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > 256 || !value.every(isBoundedString)) return undefined
  const identities = [...value]
  return new Set(identities).size === identities.length ? identities : undefined
}

function isNonNegativeInteger(value: BrowserJsonValue | undefined): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isTerminal(value: BrowserJsonValue | undefined): value is BrowserObservation['terminal'] {
  return value === 'running' || value === 'completed' || value === 'stopped' || value === 'failed' || value === 'indeterminate'
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function errorCode(error: unknown): string {
  if (error instanceof BrowserError || error instanceof PhysicalOperatorError) return error.code
  return 'CHATGPT_WEB_PROVIDER_FAILED'
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortReason(signal))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, milliseconds)
    const abort = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      reject(abortReason(signal))
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('ChatGPT Web coordinated session was aborted')
}

async function settleForDisposal(result: Promise<PhysicalOperatorResult>): Promise<void> {
  try {
    await result
  } catch {
    // Disposal only establishes quiescence. The holder still receives the
    // original terminal failure from `result`.
  }
}

/** Content-free progress retained only for the holder's bounded reader. */
class ProgressLog {
  private sequence = 0
  private readonly events: PhysicalOperatorProgressEvent[] = []

  constructor(private readonly commandId: string) {}

  append(type: string, data: Readonly<Record<string, unknown>>): void {
    this.sequence += 1
    this.events.push(Object.freeze({
      sequence: this.sequence,
      type,
      time: new Date().toISOString(),
      data: Object.freeze({ ...data, commandId: this.commandId }),
    }))
  }

  read(afterSequence: number, limit: number, signal?: AbortSignal): Promise<PhysicalOperatorProgressPage> {
    if (signal?.aborted) {
      return Promise.reject(new PhysicalOperatorError('ChatGPT Web progress read was aborted', 'OPERATOR_ABORTED'))
    }
    const events = this.events.filter(event => event.sequence > afterSequence).slice(0, Math.max(0, limit))
    return Promise.resolve({ events, nextSequence: events.at(-1)?.sequence ?? afterSequence })
  }
}
