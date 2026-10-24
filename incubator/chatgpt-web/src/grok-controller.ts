import { createHash, randomUUID } from 'node:crypto'
import { chmod, link, lstat, open, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import type {
  GrokBrowserPort,
  GrokExecutionPort,
  GrokMessageObservation,
  GrokPageObservation,
  GrokRequest,
  GrokResource,
  GrokRunRecord,
} from './grok-contract.js'
import {
  GrokRunStore,
  GrokStoreError,
  parseGrokResourceUrl,
  type GrokRunPatch,
  type GrokResourceUrl,
} from './grok-store.js'

const ADMISSION_LOCK_NAME = '.grok-web-admission.lock'
const ADMISSION_FORMAT_VERSION = 1
const LOCK_MODE = 0o600
const MAX_TIMEOUT_MS = 2 * 60 * 60 * 1000
const MAX_POLL_MS = 60 * 1000
const MAX_STABLE_OBSERVATIONS = 10
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024

export interface GrokControllerOptions {
  readonly timeoutMs: number
  readonly pollMs: number
  /** A full answer needs at least two identical, non-busy DOM observations. */
  readonly stableObservations: number
  /** Reject rather than truncate a visible reply beyond this retained-text bound. */
  readonly maxOutputBytes: number
}

export class GrokControllerError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'GrokControllerError'
  }
}

type ActiveOperation = {
  readonly controller: AbortController
  timeout: NodeJS.Timeout
  detachExternalAbort: () => void
  readonly request?: GrokRequest
  promise?: Promise<GrokRunRecord>
  abortDetail?: GrokError
  timedOut: boolean
  allocationStarted: boolean
  intentCommitted: boolean
  resource?: GrokResource
  admissionLease?: string
}

type GrokError = NonNullable<GrokRunRecord['error']>

type Admission =
  | { readonly kind: 'acquired'; readonly lease: string }
  | { readonly kind: 'owned' }
  | { readonly kind: 'busy' }

type AdmissionOwner =
  | { readonly kind: 'absent' }
  | { readonly kind: 'owned'; readonly id: string; readonly lease: string }
  | { readonly kind: 'version' }
  | { readonly kind: 'invalid' }

type ApplyResult = {
  readonly record: GrokRunRecord
  readonly applied: boolean
}

type ReplyCandidate = {
  readonly message: GrokMessageObservation
  readonly route: Extract<GrokResourceUrl, { readonly kind: 'conversation' }>
}

type Reconciliation = {
  readonly record: GrokRunRecord
  readonly candidate?: ReplyCandidate
  readonly pending?: true
  readonly problem?: GrokError
  readonly stop?: true
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code
}

function isStateConflict(error: unknown): boolean {
  return error instanceof GrokStoreError && error.code === 'GROK_STATE_CONFLICT'
}

function isPositiveInteger(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum
}

function isNonNegativeInteger(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback
}

function requestIdentity(request: GrokRequest): string {
  return JSON.stringify({
    id: request.id,
    sessionId: request.sessionId,
    canonical: request.canonical,
    prompt: request.prompt,
    ...(request.modelLabel === undefined ? {} : { modelLabel: request.modelLabel }),
  })
}

function normalizeReceiptText(value: string): string {
  // Receipt matching preserves every character except the documented CRLF
  // rendering difference between the source prompt and visible DOM text.
  return value.replace(/\r\n/g, '\n')
}

function sameStableId(left: string, right: string): boolean {
  return left === right
}

/** The visible DOM container is `response-<uuid>`; `rid` is that UUID alone. */
function routeReplyMatchesMessage(routeReplyId: string, messageId: string): boolean {
  return messageId === routeReplyId || messageId === `response-${routeReplyId}`
}

function unresolved(record: GrokRunRecord): boolean {
  return record.stage === 'created'
    || record.stage === 'preparing'
    || record.stage === 'prepared'
    || record.stage === 'submission-unknown'
    || record.stage === 'submitted'
    || record.stage === 'indeterminate'
}

function terminal(record: GrokRunRecord): boolean {
  return !unresolved(record)
}

function asError(code: string, message: string): GrokError {
  return { code, message }
}

function validMessage(value: unknown): value is GrokMessageObservation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const input = value as Record<string, unknown>
  const keys = Object.keys(input)
  if (keys.some(key => !['id', 'role', 'text', 'hasCopyControl', 'hasArtifacts'].includes(key))) return false
  return typeof input.id === 'string'
    && input.id.length > 0
    && (input.role === 'user' || input.role === 'assistant')
    && typeof input.text === 'string'
    && typeof input.hasCopyControl === 'boolean'
    && typeof input.hasArtifacts === 'boolean'
}

function validObservation(value: unknown): value is GrokPageObservation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const input = value as Record<string, unknown>
  const keys = Object.keys(input)
  if (keys.some(key => ![
    'url', 'authenticated', 'loginRequired', 'challenge', 'busy', 'composerCount', 'composerText', 'submitCount', 'submitEnabled',
    'modelLabel', 'messages', 'errors',
  ].includes(key))) return false
  return typeof input.url === 'string'
    && typeof input.authenticated === 'boolean'
    && typeof input.loginRequired === 'boolean'
    && typeof input.challenge === 'boolean'
    && (input.busy === undefined || typeof input.busy === 'boolean')
    && Number.isSafeInteger(input.composerCount)
    && (input.composerCount as number) >= 0
    && typeof input.composerText === 'string'
    && Number.isSafeInteger(input.submitCount)
    && (input.submitCount as number) >= 0
    && typeof input.submitEnabled === 'boolean'
    && (input.modelLabel === undefined || (typeof input.modelLabel === 'string' && input.modelLabel.length > 0))
    && Array.isArray(input.messages)
    && input.messages.every(validMessage)
    && Array.isArray(input.errors)
    && input.errors.every(error => typeof error === 'string')
}

function conversationUrl(route: Extract<GrokResourceUrl, { readonly kind: 'conversation' }>, replyId?: string): string {
  return `https://grok.com/c/${route.conversationId}${replyId === undefined ? '' : `?rid=${encodeURIComponent(replyId)}`}`
}

function sameConversation(left: Extract<GrokResourceUrl, { readonly kind: 'conversation' }>, right: Extract<GrokResourceUrl, { readonly kind: 'conversation' }>): boolean {
  return left.conversationId.toLowerCase() === right.conversationId.toLowerCase()
}

/**
 * One durable Grok webpage task. It never retries browser effects: after a
 * request id exists, recovery can only inspect its recorded original page.
 */
export class GrokController implements GrokExecutionPort {
  private readonly options: GrokControllerOptions
  private readonly active = new Map<string, ActiveOperation>()
  private readonly ownedResources = new Map<string, GrokResource>()
  private readonly finishes = new Map<string, Promise<void>>()

  constructor(
    private readonly store: GrokRunStore,
    private readonly browser: GrokBrowserPort,
    options: GrokControllerOptions,
  ) {
    if (!isPositiveInteger(options.timeoutMs, MAX_TIMEOUT_MS)
      || !isNonNegativeInteger(options.pollMs, MAX_POLL_MS)
      || !isPositiveInteger(options.stableObservations, MAX_STABLE_OBSERVATIONS)
      || options.stableObservations < 2
      || !isPositiveInteger(options.maxOutputBytes, MAX_OUTPUT_BYTES)) {
      throw new GrokControllerError('GROK_CONTROLLER_OPTIONS_INVALID', 'Grok controller options are invalid')
    }
    this.options = { ...options }
  }

  read(id: string): Promise<GrokRunRecord | undefined> {
    return this.store.read(id)
  }

  start(request: GrokRequest, signal?: AbortSignal): Promise<GrokRunRecord> {
    const current = this.active.get(request.id)
    if (current?.promise) {
      if (!current.request || requestIdentity(current.request) !== requestIdentity(request)) {
        return Promise.reject(new GrokControllerError('GROK_COMMAND_CONFLICT', 'Grok request id was already used with a different request'))
      }
      return current.promise
    }
    const operation = this.newOperation(request, signal)
    const promise = this.runStart(request, operation)
    operation.promise = promise
    this.active.set(request.id, operation)
    this.trackOperation(request.id, operation, promise)
    return promise
  }

  observe(id: string, signal?: AbortSignal): Promise<GrokRunRecord> {
    const current = this.active.get(id)
    if (current?.promise) return current.promise
    const operation = this.newOperation(undefined, signal)
    const promise = this.runObserve(id, operation)
    operation.promise = promise
    this.active.set(id, operation)
    this.trackOperation(id, operation, promise)
    return promise
  }

  private async runStart(request: GrokRequest, operation: ActiveOperation): Promise<GrokRunRecord> {
    const admission = await this.store.createOrRead(request)
    if (!admission.created) return this.resumeExisting(admission.record, operation)
    return this.runFresh(admission.record, operation)
  }

  private async runObserve(id: string, operation: ActiveOperation): Promise<GrokRunRecord> {
    const record = await this.store.read(id)
    if (!record) throw new GrokControllerError('GROK_RUN_NOT_FOUND', 'Grok run was not found')
    return this.resumeExisting(record, operation)
  }

  private async runFresh(initial: GrokRunRecord, operation: ActiveOperation): Promise<GrokRunRecord> {
    let record = initial
    try {
      if (operation.controller.signal.aborted) return this.settleTerminal(record, operation, {
        stage: 'cancelled', error: this.abortDetail(operation),
      })
      const older = await this.unresolvedOther(record.id)
      if (older) return this.settleTerminal(record, operation, {
        stage: 'blocked',
        error: asError('GROK_BUSY', 'Another Grok request remains unresolved; this request was not submitted'),
      })
      const admission = await this.acquireAdmission(record.id)
      if (admission.kind !== 'acquired') return this.settleTerminal(record, operation, {
        stage: 'blocked',
        error: asError('GROK_BUSY', 'Another Grok request owns the admission fence; this request was not submitted'),
      })
      operation.admissionLease = admission.lease

      const latest = await this.store.read(record.id)
      if (!latest) throw new GrokControllerError('GROK_RUN_NOT_FOUND', 'Grok run disappeared during admission')
      record = latest
      if (record.stage !== 'created') return this.returnCurrent(record, operation)

      let applied = await this.apply(record, { stage: 'preparing' })
      record = applied.record
      if (!applied.applied || record.stage !== 'preparing') return this.returnCurrent(record, operation)
      if (operation.controller.signal.aborted) return this.settleTerminal(record, operation, {
        stage: 'cancelled', error: this.abortDetail(operation),
      })

      operation.allocationStarted = true
      const resource = await this.browser.allocate({ id: record.id, sessionId: record.request.sessionId }, operation.controller.signal)
      operation.resource = resource
      this.ownedResources.set(record.id, resource)
      applied = await this.apply(record, { resource })
      record = applied.record
      if (!applied.applied || record.resource === undefined || record.stage !== 'preparing') return this.returnCurrent(record, operation)
      const resourceRoute = parseGrokResourceUrl(record.resource.conversationUrl)
      if (!resourceRoute || resourceRoute.kind !== 'root') return this.settleTerminal(record, operation, {
        stage: 'blocked',
        error: asError('GROK_RESOURCE_NOT_FRESH', 'Grok allocation did not return the observed fresh root page'),
      })
      if (operation.controller.signal.aborted) return this.settleTerminal(record, operation, {
        stage: 'cancelled', error: this.abortDetail(operation),
      })

      const prepared = await this.browser.prepare(record.resource, {
        prompt: record.request.prompt,
        ...(record.request.modelLabel === undefined ? {} : { modelLabel: record.request.modelLabel }),
      }, operation.controller.signal)
      const preflight = this.preflightProblem(record.request, record.resource, prepared)
      if (preflight) return this.settleTerminal(record, operation, { stage: 'blocked', error: preflight })
      applied = await this.apply(record, {
        stage: 'prepared',
        ...(prepared.modelLabel === undefined ? {} : { observedModelLabel: prepared.modelLabel }),
      })
      record = applied.record
      if (!applied.applied || record.stage !== 'prepared' || !record.resource) return this.returnCurrent(record, operation)
      if (operation.controller.signal.aborted) return this.settleTerminal(record, operation, {
        stage: 'cancelled', error: this.abortDetail(operation),
      })

      // `transition()` fsyncs the new revision and its directory before this
      // call. Once this returns, any interrupted click is reconciliation-only.
      applied = await this.apply(record, {
        stage: 'submission-unknown',
        intentAt: new Date().toISOString(),
      })
      record = applied.record
      if (!applied.applied || record.stage !== 'submission-unknown' || !record.intentAt || !record.resource) return this.returnCurrent(record, operation)
      operation.intentCommitted = true
      await this.browser.submit(record.resource, operation.controller.signal)
      return await this.waitForCompletion(record, record.resource, operation)
    } catch (error) {
      const latest = await this.store.read(record.id).catch(() => undefined)
      if (latest) record = latest
      if (record.stage === 'completed') throw error
      return this.handleFailure(record, operation, error)
    }
  }

  /** Existing ids never allocate, prepare, or submit. They can only inspect the saved resource. */
  private async resumeExisting(initial: GrokRunRecord, operation: ActiveOperation): Promise<GrokRunRecord> {
    let record = initial
    if (terminal(record)) return this.returnCurrent(record, operation)
    // A separate process may have appended revision zero milliseconds before
    // it creates its admission fence. Do not steal that window or turn it
    // into a replacement task. A later caller still cannot replay it.
    if (!record.resource && (record.stage === 'created' || record.stage === 'preparing')) return record
    const admission = await this.acquireAdmission(record.id)
    if (admission.kind === 'busy') return record
    if (admission.kind === 'owned') return record
    // Another owner for this id may still be preparing or submitting, so it
    // receives a retained record above. A newly acquired lease is safe for
    // read-only reconciliation only; this path never replays setup or Send.
    operation.admissionLease = admission.lease
    try {
      const latest = await this.store.read(record.id)
      if (!latest) throw new GrokControllerError('GROK_RUN_NOT_FOUND', 'Grok run disappeared during recovery')
      record = latest
      if (terminal(record)) return this.returnCurrent(record, operation)
      if (!record.resource) return this.markIndeterminate(record, operation, asError(
        'GROK_RESOURCE_UNAVAILABLE',
        'The original Grok page was not durably recorded; it will not be recreated or resubmitted',
      ))
      if (operation.controller.signal.aborted) {
        return record.intentAt
          ? this.markIndeterminate(record, operation, this.abortDetail(operation))
          : this.settleTerminal(record, operation, { stage: 'cancelled', error: this.abortDetail(operation) })
      }
      operation.resource = record.resource
      operation.intentCommitted = record.intentAt !== undefined
      return await this.waitForCompletion(record, record.resource, operation)
    } catch (error) {
      const latest = await this.store.read(record.id).catch(() => undefined)
      if (latest) record = latest
      if (record.stage === 'completed') throw error
      return this.handleFailure(record, operation, error)
    }
  }

  private async waitForCompletion(
    initial: GrokRunRecord,
    resource: GrokResource,
    operation: ActiveOperation,
  ): Promise<GrokRunRecord> {
    let record = initial
    let currentResource = resource
    let stable = 0
    let fingerprint: string | undefined
    for (;;) {
      if (operation.controller.signal.aborted) {
        return record.intentAt
          ? this.markIndeterminate(record, operation, this.abortDetail(operation))
          : this.settleTerminal(record, operation, { stage: 'cancelled', error: this.abortDetail(operation) })
      }
      const observation = await this.browser.observe(currentResource, operation.controller.signal)
      const reconciled = await this.reconcile(record, currentResource, observation)
      record = reconciled.record
      currentResource = record.resource ?? currentResource
      if (reconciled.stop) return this.returnCurrent(record, operation)
      if (reconciled.problem) return this.markIndeterminate(record, operation, reconciled.problem)
      const candidate = reconciled.candidate
      if (candidate && observation.busy === false && candidate.message.hasCopyControl && candidate.message.text.trim().length > 0) {
        const nextFingerprint = JSON.stringify([candidate.message.id, candidate.message.text])
        stable = fingerprint === nextFingerprint ? stable + 1 : 1
        fingerprint = nextFingerprint
        if (stable >= this.options.stableObservations) {
          if (Buffer.byteLength(candidate.message.text, 'utf8') > this.options.maxOutputBytes) {
            return this.markIndeterminate(record, operation, asError(
              'GROK_OUTPUT_TOO_LARGE',
              'Visible Grok text exceeds the configured full-retention bound',
            ))
          }
          return this.settleTerminal(record, operation, {
            stage: 'completed',
            output: {
              text: candidate.message.text,
              sha256: createHash('sha256').update(candidate.message.text, 'utf8').digest('hex'),
            },
            error: undefined,
          })
        }
      } else {
        stable = 0
        fingerprint = undefined
      }
      await this.waitForPoll(operation.controller.signal)
    }
  }

  private async reconcile(record: GrokRunRecord, resource: GrokResource, raw: unknown): Promise<Reconciliation> {
    if (!validObservation(raw)) return { record, problem: asError('GROK_OBSERVATION_INVALID', 'Grok page observation has an unsupported shape') }
    const observation = raw
    const pageProblem = this.observationProblem(record, observation)
    if (pageProblem) return { record, problem: pageProblem }
    const route = parseGrokResourceUrl(observation.url)
    if (!route) return { record, problem: asError('GROK_RESOURCE_MISMATCH', 'Observed page is not an allowed Grok root or conversation URL') }

    const users = observation.messages.filter((message): message is GrokMessageObservation => message.role === 'user')
    const assistants = observation.messages.filter((message): message is GrokMessageObservation => message.role === 'assistant')
    let current = record
    let receiptIndex = -1
    if (current.promptReceiptId === undefined) {
      const matching = users.filter(message => normalizeReceiptText(message.text) === normalizeReceiptText(current.request.prompt))
      if (matching.length > 1) return { record: current, problem: asError('GROK_DUPLICATE_PROMPT', 'The original Grok page shows duplicate matching user prompts') }
      if (matching.length === 0) {
        if (users.length > 0) return { record: current, problem: asError('GROK_SUBMISSION_MISMATCH', 'The original Grok page shows a different user prompt') }
        if (assistants.length > 0 || route.kind === 'conversation') {
          return { record: current, problem: asError('GROK_RECEIPT_MISSING', 'A Grok reply or conversation route appeared before the exact original user receipt was confirmed') }
        }
        return { record: current, pending: true }
      }
      const receipt = matching[0]
      if (!receipt || users.length !== 1 || receipt.id.length === 0) {
        return { record: current, problem: asError('GROK_SUBMISSION_MISMATCH', 'The original Grok page does not show one exact user prompt receipt') }
      }
      receiptIndex = observation.messages.indexOf(receipt)
      const resourceAfterReceipt = this.resourceAfterReceipt(resource, route)
      if (resourceAfterReceipt instanceof Error) return { record: current, problem: asError('GROK_RESOURCE_MISMATCH', resourceAfterReceipt.message) }
      const applied = await this.apply(current, {
        stage: 'submitted',
        promptReceiptId: receipt.id,
        ...(resourceAfterReceipt.conversationUrl === current.resource?.conversationUrl ? {} : { resource: resourceAfterReceipt }),
        error: undefined,
      })
      current = applied.record
      if (!applied.applied) return { record: current, stop: true }
    } else {
      const withSavedId = users.filter(message => message.id === current.promptReceiptId)
      if (withSavedId.length === 1) {
        const receipt = withSavedId[0]
        if (!receipt || normalizeReceiptText(receipt.text) !== normalizeReceiptText(current.request.prompt) || users.length !== 1) {
          return { record: current, problem: asError('GROK_SUBMISSION_MISMATCH', 'The saved Grok prompt receipt no longer matches the original request') }
        }
        receiptIndex = observation.messages.indexOf(receipt)
        const resourceAfterReceipt = this.resourceAfterReceipt(resource, route)
        if (resourceAfterReceipt instanceof Error) return { record: current, problem: asError('GROK_RESOURCE_MISMATCH', resourceAfterReceipt.message) }
        if (resourceAfterReceipt.conversationUrl !== current.resource?.conversationUrl || current.stage !== 'submitted') {
          const applied = await this.apply(current, {
            stage: 'submitted',
            ...(resourceAfterReceipt.conversationUrl === current.resource?.conversationUrl ? {} : { resource: resourceAfterReceipt }),
            error: undefined,
          })
          current = applied.record
          if (!applied.applied) return { record: current, stop: true }
        }
      } else if (withSavedId.length > 1 || users.length > 0) {
        return { record: current, problem: asError('GROK_SUBMISSION_MISMATCH', 'The saved Grok prompt receipt is ambiguous or absent') }
      } else {
        const durableRoute = current.resource && parseGrokResourceUrl(current.resource.conversationUrl)
        if (!durableRoute || durableRoute.kind !== 'conversation' || route.kind !== 'conversation' || !sameConversation(durableRoute, route)) {
          return { record: current, problem: asError('GROK_RECEIPT_VIRTUALIZED', 'The original prompt is no longer visible before its saved conversation identity was confirmed') }
        }
        if (!current.replyId) {
          return { record: current, problem: asError('GROK_RECEIPT_VIRTUALIZED', 'The original prompt is virtualized before a stable reply identity was recorded') }
        }
        if (route.replyId !== undefined && !routeReplyMatchesMessage(route.replyId, current.replyId)) {
          return { record: current, problem: asError('GROK_REPLY_MISMATCH', 'The Grok route reply identity does not match the recorded reply') }
        }
      }
    }

    const candidateResult = this.replyCandidate(current, observation, route, receiptIndex)
    if (candidateResult instanceof Error) return { record: current, problem: asError('GROK_ASSISTANT_AMBIGUOUS', candidateResult.message) }
    if (!candidateResult) return { record: current, pending: true }
    if (candidateResult.message.hasArtifacts) {
      return { record: current, problem: asError('GROK_ARTIFACT_OUTPUT_UNSUPPORTED', 'The visible Grok reply includes Canvas, media, or an artifact and is not retained as full ordinary text') }
    }
    if (current.replyId !== undefined && !sameStableId(current.replyId, candidateResult.message.id)) {
      return { record: current, problem: asError('GROK_REPLY_MISMATCH', 'The Grok assistant reply identity changed after it was recorded') }
    }
    if (candidateResult.route.replyId !== undefined && !routeReplyMatchesMessage(candidateResult.route.replyId, candidateResult.message.id)) {
      return { record: current, problem: asError('GROK_REPLY_MISMATCH', 'The Grok conversation route does not identify the visible assistant reply') }
    }
    const durableRoute = current.resource && parseGrokResourceUrl(current.resource.conversationUrl)
    const retainedConversationUrl = candidateResult.route.replyId === undefined
      && durableRoute?.kind === 'conversation'
      && durableRoute.replyId !== undefined
      ? current.resource!.conversationUrl
      : candidateResult.route.replyId === undefined
        ? conversationUrl(candidateResult.route)
        : candidateResult.route.value
    const updatedResource: GrokResource = {
      ...resource,
      conversationUrl: retainedConversationUrl,
    }
    const needsResource = updatedResource.conversationUrl !== current.resource?.conversationUrl
    if (current.replyId === undefined || needsResource) {
      const applied = await this.apply(current, {
        ...(current.replyId === undefined ? { replyId: candidateResult.message.id } : {}),
        ...(needsResource ? { resource: updatedResource } : {}),
      })
      current = applied.record
      if (!applied.applied) return { record: current, stop: true }
    }
    return { record: current, candidate: candidateResult }
  }

  private observationProblem(record: GrokRunRecord, observation: GrokPageObservation): GrokError | undefined {
    if (observation.challenge) return asError('GROK_CHALLENGE_REQUIRED', 'Grok requires a manual challenge before this task can continue')
    if (observation.loginRequired || !observation.authenticated) return asError('GROK_LOGIN_REQUIRED', 'Grok login is required before this task can continue')
    if (observation.errors.length > 0) return asError('GROK_PAGE_ERROR', 'Grok shows a visible page error')
    const expectedModel = record.observedModelLabel ?? record.request.modelLabel
    if (expectedModel !== undefined && observation.modelLabel !== undefined && observation.modelLabel !== expectedModel) {
      return asError('GROK_MODEL_MISMATCH', 'Grok selected model does not match the requested or preflight-observed model')
    }
    return undefined
  }

  private preflightProblem(request: GrokRequest, resource: GrokResource, raw: unknown): GrokError | undefined {
    if (!validObservation(raw)) return asError('GROK_OBSERVATION_INVALID', 'Grok prepare returned an unsupported page observation')
    const observation = raw
    const route = parseGrokResourceUrl(observation.url)
    const storedRoute = parseGrokResourceUrl(resource.conversationUrl)
    if (!route || !storedRoute || route.kind !== 'root' || storedRoute.kind !== 'root' || route.value !== storedRoute.value) {
      return asError('GROK_RESOURCE_MISMATCH', 'Grok prepare did not remain on the allocated fresh root page')
    }
    if (observation.challenge) return asError('GROK_CHALLENGE_REQUIRED', 'Grok requires a manual challenge before submission')
    if (observation.loginRequired || !observation.authenticated) return asError('GROK_LOGIN_REQUIRED', 'Grok login is required before submission')
    if (observation.errors.length > 0) return asError('GROK_PAGE_ERROR', 'Grok shows a visible page error before submission')
    if (observation.composerCount !== 1) return asError('GROK_COMPOSER_COUNT', 'Grok must expose exactly one composer')
    if (observation.submitCount !== 1) return asError('GROK_SUBMIT_COUNT', 'Grok must expose exactly one enabled submit control')
    if (!observation.submitEnabled) return asError('GROK_SUBMIT_DISABLED', 'Grok submit control is not enabled after preparing the prompt')
    if (normalizeReceiptText(observation.composerText) !== normalizeReceiptText(request.prompt)) {
      return asError('GROK_COMPOSER_MISMATCH', 'Grok composer text does not exactly match the requested prompt')
    }
    if (observation.messages.length !== 0) return asError('GROK_TASK_NOT_FRESH', 'The allocated Grok task already contains transcript messages')
    if (request.modelLabel !== undefined && observation.modelLabel !== request.modelLabel) {
      return asError('GROK_MODEL_MISMATCH', 'Grok selected model does not exactly match the requested model')
    }
    return undefined
  }

  private resourceAfterReceipt(resource: GrokResource, observed: GrokResourceUrl): GrokResource | Error {
    const durable = parseGrokResourceUrl(resource.conversationUrl)
    if (!durable) return new Error('The durable Grok resource URL is invalid')
    if (durable.kind === 'root') {
      if (observed.kind === 'root') return resource
      return { ...resource, conversationUrl: conversationUrl(observed) }
    }
    if (observed.kind !== 'conversation' || !sameConversation(durable, observed)) {
      return new Error('Observed Grok page does not match the durable conversation path')
    }
    if (durable.replyId !== undefined && observed.replyId !== undefined && !sameStableId(durable.replyId, observed.replyId)) {
      return new Error('Observed Grok route changes the durable reply identity')
    }
    return resource
  }

  private replyCandidate(
    record: GrokRunRecord,
    observation: GrokPageObservation,
    route: GrokResourceUrl,
    receiptIndex: number,
  ): ReplyCandidate | undefined | Error {
    if (route.kind !== 'conversation') return undefined
    const assistantMessages = observation.messages.filter((message): message is GrokMessageObservation => message.role === 'assistant')
    let candidates: readonly GrokMessageObservation[]
    if (receiptIndex >= 0) {
      candidates = observation.messages.slice(receiptIndex + 1).filter((message): message is GrokMessageObservation => message.role === 'assistant')
      if (assistantMessages.length !== candidates.length) return new Error('The Grok transcript has an assistant message outside the original prompt receipt')
    } else {
      if (!record.replyId) return new Error('The original prompt is virtualized before a reply identity was recorded')
      candidates = assistantMessages.filter(message => message.id === record.replyId)
      if (assistantMessages.length !== candidates.length) return new Error('The virtualized Grok transcript does not expose one recorded assistant reply')
    }
    if (candidates.length === 0) return undefined
    if (candidates.length !== 1) return new Error('The original Grok prompt has multiple subsequent assistant replies')
    const message = candidates[0]
    if (!message || message.id.length === 0) return new Error('The visible Grok assistant reply has no stable identity')
    return { message, route }
  }

  private async handleFailure(record: GrokRunRecord, operation: ActiveOperation, error: unknown): Promise<GrokRunRecord> {
    const detail = this.errorDetail(error, operation)
    if (operation.intentCommitted || record.intentAt !== undefined) return this.markIndeterminate(record, operation, detail)
    if (operation.allocationStarted && operation.resource === undefined) {
      return this.markIndeterminate(record, operation, asError(
        detail.code,
        'Grok allocation outcome is unknown; its original task will not be recreated or resubmitted',
      ))
    }
    return this.settleTerminal(record, operation, {
      stage: operation.abortDetail ? 'cancelled' : 'failed',
      error: detail,
    })
  }

  private abortDetail(operation: ActiveOperation): GrokError {
    if (operation.abortDetail) return operation.abortDetail
    if (operation.timedOut) return asError('GROK_TIMEOUT', 'Grok task timed out locally')
    return asError('GROK_ABORTED', 'Grok task was aborted locally')
  }

  private errorDetail(error: unknown, operation: ActiveOperation): GrokError {
    if (operation.abortDetail) return operation.abortDetail
    if (operation.timedOut) return asError('GROK_TIMEOUT', 'Grok task timed out locally')
    return asError(errorCode(error) ?? 'GROK_BROWSER_ERROR', errorMessage(error, 'Grok browser operation failed'))
  }

  private async settleTerminal(record: GrokRunRecord, operation: ActiveOperation, patch: GrokRunPatch): Promise<GrokRunRecord> {
    const applied = await this.apply(record, patch)
    return this.returnCurrent(applied.record, operation)
  }

  private async markIndeterminate(record: GrokRunRecord, operation: ActiveOperation, error: GrokError): Promise<GrokRunRecord> {
    const applied = await this.apply(record, { stage: 'indeterminate', error })
    const current = applied.record
    if (current.stage === 'completed') return this.returnCurrent(current, operation)
    // An indeterminate operation has stopped every external action. Releasing
    // its own fence permits later read-only reconciliation of this same
    // resource; a different fresh id is still rejected by unresolvedOther().
    if (operation.admissionLease !== undefined) await this.releaseAdmission(current.id, operation.admissionLease)
    return current
  }

  private async returnCurrent(record: GrokRunRecord, operation: ActiveOperation): Promise<GrokRunRecord> {
    let current = record
    try {
      if (current.stage === 'completed') await this.finishCompleted(current.id)
    } catch (error) {
      // The answer is already durably complete. Retain a cleanup failure
      // without replaying finish or poisoning admission for the next task.
      const applied = await this.apply(current, { error: asError('GROK_FINISH_FAILED', errorMessage(error, 'Grok browser cleanup failed')) })
      current = applied.record
    } finally {
      if (terminal(current)) await this.releaseAdmission(current.id, operation.admissionLease)
    }
    return current
  }

  private async apply(record: GrokRunRecord, patch: GrokRunPatch): Promise<ApplyResult> {
    try {
      return { record: await this.store.transition(record.id, record.revision, patch), applied: true }
    } catch (error) {
      if (!isStateConflict(error)) throw error
      const current = await this.store.read(record.id)
      if (!current) throw error
      return { record: current, applied: false }
    }
  }

  private async unresolvedOther(id: string): Promise<GrokRunRecord | undefined> {
    const records = await this.store.list()
    return records.find(record => record.id !== id && unresolved(record))
  }

  private admissionPath(): string {
    return join(this.store.root, ADMISSION_LOCK_NAME)
  }

  private async readAdmissionOwner(path = this.admissionPath()): Promise<AdmissionOwner> {
    try {
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink()) return { kind: 'invalid' }
      const value = JSON.parse(await readFile(path, 'utf8')) as unknown
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return { kind: 'invalid' }
      const entry = value as { formatVersion?: unknown; id?: unknown; lease?: unknown }
      if (entry.formatVersion !== ADMISSION_FORMAT_VERSION) return typeof entry.formatVersion === 'number' ? { kind: 'version' } : { kind: 'invalid' }
      if (typeof entry.id !== 'string' || typeof entry.lease !== 'string') return { kind: 'invalid' }
      return { kind: 'owned', id: entry.id, lease: entry.lease }
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return { kind: 'absent' }
      return { kind: 'invalid' }
    }
  }

  private async acquireAdmission(id: string): Promise<Admission> {
    const path = this.admissionPath()
    const lease = randomUUID()
    const temporary = join(this.store.root, `.${ADMISSION_LOCK_NAME}.${lease}.tmp`)
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(temporary, 'wx', LOCK_MODE)
      await handle.writeFile(JSON.stringify({ formatVersion: ADMISSION_FORMAT_VERSION, id, lease }), 'utf8')
      await handle.sync()
      await handle.close()
      handle = undefined
      try {
        await link(temporary, path)
        await chmod(path, LOCK_MODE)
        return { kind: 'acquired', lease }
      } catch (error) {
        if (!isErrno(error, 'EEXIST')) throw new GrokControllerError('GROK_ADMISSION_FAILED', 'Grok admission fence could not be created')
        const owner = await this.readAdmissionOwner()
        if (owner.kind === 'version') throw new GrokControllerError('GROK_ADMISSION_VERSION', 'Grok admission fence format is unsupported')
        if (owner.kind === 'invalid' || owner.kind === 'absent') throw new GrokControllerError('GROK_ADMISSION_INVALID', 'Grok admission fence is invalid')
        return owner.id === id ? { kind: 'owned' } : { kind: 'busy' }
      }
    } finally {
      if (handle) {
        try { await handle.close() } catch { /* already closed */ }
      }
      try { await unlink(temporary) } catch (error) {
        if (!isErrno(error, 'ENOENT')) throw error
      }
    }
  }

  private async releaseAdmission(id: string, expectedLease?: string): Promise<void> {
    const owner = await this.readAdmissionOwner()
    if (owner.kind === 'absent') return
    if (owner.kind === 'version') throw new GrokControllerError('GROK_ADMISSION_VERSION', 'Grok admission fence format is unsupported')
    if (owner.kind === 'invalid') throw new GrokControllerError('GROK_ADMISSION_INVALID', 'Grok admission fence is invalid')
    if (owner.id !== id || (expectedLease !== undefined && owner.lease !== expectedLease)) return
    const claim = join(this.store.root, `.${ADMISSION_LOCK_NAME}.release-${owner.lease}`)
    let ownsClaim = false
    try {
      try {
        await link(this.admissionPath(), claim)
        ownsClaim = true
      } catch (error) {
        if (isErrno(error, 'EEXIST') || isErrno(error, 'ENOENT')) return
        throw error
      }
      const claimed = await this.readAdmissionOwner(claim)
      const current = await this.readAdmissionOwner()
      if (claimed.kind !== 'owned' || current.kind !== 'owned'
        || claimed.id !== owner.id || claimed.lease !== owner.lease
        || current.id !== owner.id || current.lease !== owner.lease) return
      await unlink(this.admissionPath())
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw new GrokControllerError('GROK_ADMISSION_RELEASE_FAILED', 'Grok admission fence could not be released')
    } finally {
      if (ownsClaim) {
        try { await unlink(claim) } catch (error) {
          if (!isErrno(error, 'ENOENT')) throw new GrokControllerError('GROK_ADMISSION_RELEASE_FAILED', 'Grok admission claim could not be removed')
        }
      }
    }
  }

  private async finishCompleted(id: string): Promise<void> {
    const resource = this.ownedResources.get(id)
    if (!resource) return
    let completion = this.finishes.get(id)
    if (!completion) {
      completion = this.browser.finish(resource).catch((error: unknown) => {
        throw new GrokControllerError('GROK_FINISH_FAILED', errorMessage(error, 'Grok browser cleanup failed'))
      })
      this.finishes.set(id, completion)
    }
    await completion
  }

  private newOperation(request: GrokRequest | undefined, signal?: AbortSignal): ActiveOperation {
    const controller = new AbortController()
    const operation: ActiveOperation = {
      controller,
      timeout: undefined as unknown as NodeJS.Timeout,
      detachExternalAbort: () => undefined,
      request,
      timedOut: false,
      allocationStarted: false,
      intentCommitted: false,
    }
    const onExternalAbort = (): void => this.abort(operation, asError('GROK_ABORTED', 'Grok task was aborted locally'))
    if (signal) {
      if (signal.aborted) onExternalAbort()
      else signal.addEventListener('abort', onExternalAbort, { once: true })
      operation.detachExternalAbort = () => signal.removeEventListener('abort', onExternalAbort)
    }
    operation.timeout = setTimeout(() => {
      operation.timedOut = true
      this.abort(operation, asError('GROK_TIMEOUT', 'Grok task timed out locally'))
    }, this.options.timeoutMs)
    return operation
  }

  private abort(operation: ActiveOperation, detail: GrokError): void {
    if (operation.controller.signal.aborted) return
    operation.abortDetail = detail
    operation.controller.abort()
  }

  private trackOperation(id: string, operation: ActiveOperation, promise: Promise<GrokRunRecord>): void {
    void promise.then(() => this.endOperation(id, operation), () => this.endOperation(id, operation))
  }

  private endOperation(id: string, operation: ActiveOperation): void {
    clearTimeout(operation.timeout)
    operation.detachExternalAbort()
    if (this.active.get(id) === operation) this.active.delete(id)
  }

  private async waitForPoll(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new GrokControllerError('GROK_ABORTED', 'Grok task was aborted locally')
    // A zero configured interval still yields to the timer queue. Otherwise a
    // pending DOM state could starve this operation's own bounded timeout.
    if (this.options.pollMs === 0) {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          signal.removeEventListener('abort', onAbort)
          resolve()
        }, 0)
        const onAbort = (): void => {
          clearTimeout(timeout)
          reject(new GrokControllerError('GROK_ABORTED', 'Grok task was aborted locally'))
        }
        signal.addEventListener('abort', onAbort, { once: true })
      })
      return
    }
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }, this.options.pollMs)
      const onAbort = (): void => {
        clearTimeout(timeout)
        reject(new GrokControllerError('GROK_ABORTED', 'Grok task was aborted locally'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }
}
