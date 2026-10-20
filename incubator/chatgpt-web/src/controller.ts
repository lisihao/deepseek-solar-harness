import { randomUUID } from 'node:crypto'
import { chmod, link, lstat, open, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import { WebBrowserError, type WebBrowserAdapter } from './browser-contract.js'
import type { ChatGptPageObservation } from './page-observation.js'
import {
  WebRunStore,
  type WebRunErrorDetail,
  type WebRunObserved,
  type WebRunPatch,
  type WebRunRecord,
  type WebRunRequest,
  type WebRunResource,
} from './store.js'

const ADMISSION_LOCK_NAME = '.chatgpt-web-admission.lock'
const ADMISSION_FORMAT_VERSION = 1
const LOCK_MODE = 0o600
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface WebControllerOptions {
  readonly timeoutMs: number
  readonly pollMs: number
  readonly stableObservations: number
  readonly maxOutputBytes: number
}

type Admission = 'acquired' | 'owned' | 'busy'

type ActiveOperation = {
  readonly controller: AbortController
  timeout: NodeJS.Timeout
  detachExternalAbort: () => void
  readonly request?: WebRunRequest
  promise?: Promise<WebRunRecord>
  abortDetail?: WebRunErrorDetail
  timedOut: boolean
  createStarted: boolean
  mayHaveSubmitted: boolean
  resource?: WebRunResource
}

type ApplyResult = {
  readonly record: WebRunRecord
  readonly applied: boolean
}

type OutputCandidate = {
  readonly text: string
  readonly markdown: string
}

type SubmissionReceipt = {
  readonly resource: WebRunResource
  readonly problem?: WebRunErrorDetail
}

type AdmissionOwner =
  | { readonly kind: 'absent' }
  | { readonly kind: 'owned'; readonly id: string; readonly lease: string }
  | { readonly kind: 'version' }
  | { readonly kind: 'invalid' }

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code
}

function isStateConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'WEB_STATE_CONFLICT'
}

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value)
}

function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback
}

function hasNoLateEffects(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'mayHaveLateEffects' in error
    && (error as { mayHaveLateEffects?: unknown }).mayHaveLateEffects === false
}

function observationLabels(observation: ChatGptPageObservation): WebRunObserved {
  return {
    ...(observation.modelLabel === undefined ? {} : { modelLabel: observation.modelLabel }),
    ...(observation.effortLabel === undefined ? {} : { effortLabel: observation.effortLabel }),
  }
}

function unresolved(stage: WebRunRecord['stage']): boolean {
  return stage === 'prepared'
    || stage === 'ready'
    || stage === 'submission-unknown'
    || stage === 'submitted'
    || stage === 'indeterminate'
}

function releasesAdmission(stage: WebRunRecord['stage']): boolean {
  return stage === 'completed' || stage === 'blocked' || stage === 'failed' || stage === 'cancelled'
}

function outputBytes(output: OutputCandidate): number {
  return Buffer.byteLength(output.text, 'utf8') + Buffer.byteLength(output.markdown, 'utf8')
}

function requestSnapshot(request: WebRunRequest): WebRunRequest {
  return {
    prompt: request.prompt,
    ...(request.modelLabel === undefined ? {} : { modelLabel: request.modelLabel }),
    ...(request.effortLabel === undefined ? {} : { effortLabel: request.effortLabel }),
  }
}

function requestsEqual(left: WebRunRequest | undefined, right: WebRunRequest): boolean {
  return left !== undefined
    && left.prompt === right.prompt
    && left.modelLabel === right.modelLabel
    && left.effortLabel === right.effortLabel
}

function normalizeReceiptText(value: string): string {
  return value.replace(/\r\n?/g, '\n')
}

function isChatGptHttpsUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') return false
    const host = parsed.hostname.toLowerCase()
    return host === 'chatgpt.com'
      || host.endsWith('.chatgpt.com')
      || host === 'chat.openai.com'
      || host.endsWith('.chat.openai.com')
  } catch {
    return false
  }
}

function isConversationUrl(value: string): boolean {
  if (!isChatGptHttpsUrl(value)) return false
  try {
    return new URL(value).pathname.startsWith('/c/')
  } catch {
    return false
  }
}

function sameAdmission(left: AdmissionOwner, right: AdmissionOwner): boolean {
  return left.kind === 'owned'
    && right.kind === 'owned'
    && left.id === right.id
    && left.lease === right.lease
}

function admissionReadError(owner: AdmissionOwner): WebBrowserError | undefined {
  if (owner.kind === 'version') {
    return new WebBrowserError('WEB_ADMISSION_VERSION', 'Web admission fence format version is unsupported')
  }
  if (owner.kind === 'invalid') {
    return new WebBrowserError('WEB_ADMISSION_INVALID', 'Web admission fence is invalid')
  }
  return undefined
}

/**
 * Coordinates one visible ChatGPT webpage request without retrying any browser
 * action after its durable effect might be unknown.
 */
export class WebController {
  private readonly options: WebControllerOptions
  private readonly active = new Map<string, ActiveOperation>()
  private readonly ownedResources = new Map<string, WebRunResource>()
  private readonly finishes = new Map<string, Promise<void>>()
  private disposed = false
  private disposePromise?: Promise<void>

  constructor(
    private readonly store: WebRunStore,
    private readonly browser: WebBrowserAdapter,
    options: WebControllerOptions,
  ) {
    if (!isPositiveInteger(options.timeoutMs)
      || !isNonNegativeInteger(options.pollMs)
      || !isPositiveInteger(options.stableObservations)
      || !isNonNegativeInteger(options.maxOutputBytes)) {
      throw new WebBrowserError('WEB_CONTROLLER_OPTIONS_INVALID', 'Web controller options are invalid')
    }
    this.options = { ...options }
  }

  async list(): Promise<readonly WebRunRecord[]> {
    return this.store.list()
  }

  async read(id: string): Promise<WebRunRecord | undefined> {
    return this.store.read(id)
  }

  start(id: string, request: WebRunRequest, signal?: AbortSignal): Promise<WebRunRecord> {
    if (this.disposed) return Promise.reject(new WebBrowserError('WEB_CONTROLLER_DISPOSED', 'Web controller was disposed'))
    const snapshot = requestSnapshot(request)
    const current = this.active.get(id)
    if (current?.promise) {
      if (!requestsEqual(current.request, snapshot)) {
        return Promise.reject(new WebBrowserError('WEB_COMMAND_CONFLICT', 'Web run id was already used with a different request'))
      }
      return current.promise
    }

    const operation = this.newOperation(snapshot, signal)
    const promise = this.runStart(id, snapshot, operation)
    operation.promise = promise
    this.active.set(id, operation)
    this.trackOperation(id, operation, promise)
    return promise
  }

  observe(id: string, signal?: AbortSignal): Promise<WebRunRecord> {
    if (this.disposed) return Promise.reject(new WebBrowserError('WEB_CONTROLLER_DISPOSED', 'Web controller was disposed'))
    const current = this.active.get(id)
    if (current?.promise) return current.promise

    const operation = this.newOperation(undefined, signal)
    const promise = this.runObserve(id, operation)
    operation.promise = promise
    this.active.set(id, operation)
    this.trackOperation(id, operation, promise)
    return promise
  }

  async cancel(id: string): Promise<WebRunRecord> {
    const active = this.active.get(id)
    if (active?.promise) {
      this.abort(active, { code: 'WEB_CANCELLED', message: 'Web run was cancelled locally' })
      return active.promise
    }

    const record = await this.store.read(id)
    if (!record) throw new WebBrowserError('WEB_RUN_NOT_FOUND', 'Web run was not found')
    if (!unresolved(record.stage)) return record

    if (record.stage === 'ready') {
      return this.settleKnown(record, {
        stage: 'cancelled',
        error: { code: 'WEB_CANCELLED', message: 'Web run was cancelled before submission' },
      })
    }

    // A durable prepared record can have been written immediately before a
    // crashed create call. Without a resource receipt, it cannot be replayed.
    return this.markIndeterminate(record, {
      code: 'WEB_CANCELLED',
      message: 'Web run was cancelled locally; remote submission remains unknown',
    })
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise
    this.disposed = true
    this.disposePromise = this.runDispose()
    return this.disposePromise
  }

  private async runStart(id: string, request: WebRunRequest, operation: ActiveOperation): Promise<WebRunRecord> {
    let record: WebRunRecord | undefined
    try {
      const previous = await this.store.read(id)
      record = await this.store.create(id, request)

      // A command id is a durable identity. Reopening it can only report its
      // current record; it never creates a replacement TaskSpace or resubmits.
      if (previous) return record

      const earlier = await this.unresolvedOther(id)
      if (earlier) {
        return this.settleKnown(record, {
          stage: 'blocked',
          error: { code: 'WEB_BUSY', message: 'Another web run is unresolved' },
        })
      }

      const admission = await this.acquireAdmission(id)
      if (admission === 'busy') {
        return this.settleKnown(record, {
          stage: 'blocked',
          error: { code: 'WEB_BUSY', message: 'Another web run owns the admission fence' },
        })
      }
      if (admission === 'owned') {
        // A second controller for the same run may observe it, but may never
        // replay setup or submission while its durable owner is still active.
        return (await this.store.read(id)) ?? record
      }

      if (operation.controller.signal.aborted) return this.cancelledBeforeSubmission(record, operation)

      operation.createStarted = true
      const resource = await this.browser.create(id, operation.controller.signal)
      operation.resource = resource
      this.ownedResources.set(id, resource)

      let applied = await this.apply(record, { resource })
      record = applied.record
      if (!applied.applied || record.stage !== 'prepared') return this.returnCurrent(record)
      if (operation.controller.signal.aborted) return this.cancelledBeforeSubmission(record, operation)

      const prepared = await this.browser.prepare(resource, request, operation.controller.signal)
      const observed = observationLabels(prepared)
      const preflight = this.preflightProblem(request, prepared)
      if (preflight) {
        return this.settleKnown(record, { stage: 'blocked', observed, error: preflight })
      }

      applied = await this.apply(record, { stage: 'ready', observed })
      record = applied.record
      if (!applied.applied || record.stage !== 'ready') return this.returnCurrent(record)
      if (operation.controller.signal.aborted) return this.cancelledBeforeSubmission(record, operation)

      // This journal entry is deliberately before the browser click. Any
      // interruption after it is treated as unknown until the same resource is
      // explicitly reconciled.
      applied = await this.apply(record, { stage: 'submission-unknown', observed })
      record = applied.record
      if (!applied.applied || record.stage !== 'submission-unknown') return this.returnCurrent(record)
      if (operation.controller.signal.aborted) return this.cancelledBeforeSubmission(record, operation)

      operation.mayHaveSubmitted = true
      const submitted = await this.browser.submit(resource, request, operation.controller.signal)
      const reconciled = await this.reconcileSubmission(record, request, submitted)
      record = reconciled
      if (reconciled.stage !== 'submitted') return reconciled
      const reconciledResource = reconciled.resource ?? resource
      operation.resource = reconciledResource
      this.ownedResources.set(id, reconciledResource)
      return await this.waitForCompletion(reconciled, reconciledResource, request, operation, submitted)
    } catch (error) {
      if (!record) throw error
      if (errorCode(error) === 'WEB_FINISH_FAILED') throw error
      return this.handleStartFailure(record, operation, error)
    }
  }

  private async runObserve(id: string, operation: ActiveOperation): Promise<WebRunRecord> {
    let record: WebRunRecord | undefined
    try {
      record = await this.store.read(id)
      if (!record) throw new WebBrowserError('WEB_RUN_NOT_FOUND', 'Web run was not found')
      if (!unresolved(record.stage)) return record
      if (record.stage === 'ready') return record
      if (!record.resource) {
        return this.markIndeterminate(record, {
          code: 'WEB_RESOURCE_UNAVAILABLE',
          message: 'Web run has no durable TaskSpace resource to reconcile',
        })
      }
      const resource = record.resource

      const admission = await this.acquireAdmission(id)
      if (admission === 'busy') {
        return this.markIndeterminate(record, {
          code: 'WEB_BUSY',
          message: 'Another web run owns the admission fence',
        })
      }
      if (operation.controller.signal.aborted) {
        return this.markIndeterminate(record, this.abortDetail(operation))
      }

      operation.resource = resource
      operation.mayHaveSubmitted = record.stage === 'submission-unknown'
        || record.stage === 'submitted'
        || record.stage === 'indeterminate'
      this.ownedResources.set(id, resource)

      const observation = await this.browser.observe(resource, operation.controller.signal)
      const reconciled = await this.reconcileSubmission(record, record.request, observation)
      record = reconciled
      if (reconciled.stage !== 'submitted') return reconciled
      const reconciledResource = reconciled.resource ?? resource
      operation.resource = reconciledResource
      this.ownedResources.set(id, reconciledResource)
      return await this.waitForCompletion(reconciled, reconciledResource, record.request, operation, observation)
    } catch (error) {
      if (!record) throw error
      if (errorCode(error) === 'WEB_FINISH_FAILED') throw error
      return this.markIndeterminate(record, this.errorDetail(error, operation))
    }
  }

  private async waitForCompletion(
    record: WebRunRecord,
    resource: WebRunResource,
    request: WebRunRequest,
    operation: ActiveOperation,
    firstObservation: ChatGptPageObservation,
  ): Promise<WebRunRecord> {
    let observation: ChatGptPageObservation | undefined = firstObservation
    let currentRecord = record
    let currentResource = resource
    let stable = 0
    let fingerprint: string | undefined

    for (;;) {
      if (operation.controller.signal.aborted) {
        return this.markIndeterminate(currentRecord, this.abortDetail(operation))
      }

      const current = observation ?? await this.browser.observe(currentResource, operation.controller.signal)
      observation = undefined
      const receipt = this.submissionReceipt(request, currentRecord.observed, currentResource, current)
      if (receipt.problem) return this.markIndeterminate(currentRecord, receipt.problem)
      if (receipt.resource !== currentResource) {
        const applied = await this.apply(currentRecord, { resource: receipt.resource })
        currentRecord = applied.record
        if (!applied.applied || currentRecord.stage !== 'submitted' || !currentRecord.resource) {
          return this.returnCurrent(currentRecord)
        }
        currentResource = currentRecord.resource
        operation.resource = currentResource
        this.ownedResources.set(currentRecord.id, currentResource)
      }

      const candidate = this.outputCandidate(current)
      if (candidate && !current.generating && currentResource.conversationUrl !== undefined) {
        const nextFingerprint = JSON.stringify([candidate.text, candidate.markdown])
        stable = fingerprint === nextFingerprint ? stable + 1 : 1
        fingerprint = nextFingerprint
        if (stable >= this.options.stableObservations) {
          if (outputBytes(candidate) > this.options.maxOutputBytes) {
            return this.markIndeterminate(currentRecord, {
              code: 'WEB_OUTPUT_TOO_LARGE',
              message: 'Visible ChatGPT output exceeds the configured full-retention bound',
            })
          }
          return this.settleKnown(currentRecord, {
            stage: 'completed',
            output: candidate,
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

  private async reconcileSubmission(
    record: WebRunRecord,
    request: WebRunRequest,
    observation: ChatGptPageObservation,
  ): Promise<WebRunRecord> {
    if (!record.resource) {
      return this.markIndeterminate(record, {
        code: 'WEB_RESOURCE_UNAVAILABLE',
        message: 'Web run has no durable TaskSpace resource to reconcile',
      })
    }
    const receipt = this.submissionReceipt(request, record.observed, record.resource, observation)
    if (receipt.problem) return this.markIndeterminate(record, receipt.problem)
    if (record.stage === 'submitted' && receipt.resource === record.resource) return record

    const patch: WebRunPatch = {
      stage: 'submitted',
      error: undefined,
      ...(receipt.resource === record.resource ? {} : { resource: receipt.resource }),
    }
    const applied = await this.apply(record, patch)
    return applied.record
  }

  private preflightProblem(request: WebRunRequest, observation: ChatGptPageObservation): WebRunErrorDetail | undefined {
    if (observation.loginRequired) {
      return { code: 'WEB_LOGIN_REQUIRED', message: 'ChatGPT login is required before submission' }
    }
    if (observation.visibleError) {
      return { code: 'WEB_PAGE_ERROR', message: 'The ChatGPT page shows a visible error' }
    }
    if (observation.composerCount !== 1) {
      return { code: 'WEB_COMPOSER_COUNT', message: 'ChatGPT page must expose exactly one composer' }
    }
    if (observation.hasAttachments) {
      return { code: 'WEB_ATTACHMENTS_PRESENT', message: 'ChatGPT composer has attachments' }
    }
    if (observation.composerText.length !== 0) {
      return { code: 'WEB_COMPOSER_DIRTY', message: 'ChatGPT composer contains an existing draft' }
    }
    if (observation.userMessageCount !== 0 || observation.assistantMessages.length !== 0) {
      return { code: 'WEB_CONVERSATION_NOT_EMPTY', message: 'ChatGPT TaskSpace is not a fresh empty conversation' }
    }
    return this.preflightSelectionProblem(request, observation)
  }

  private submissionReceipt(
    request: WebRunRequest,
    verified: WebRunObserved | undefined,
    resource: WebRunResource,
    observation: ChatGptPageObservation,
  ): SubmissionReceipt {
    if (observation.loginRequired) {
      return { resource, problem: { code: 'WEB_LOGIN_REQUIRED', message: 'ChatGPT login is required while reconciling submission' } }
    }
    if (observation.visibleError) {
      return { resource, problem: { code: 'WEB_PAGE_ERROR', message: 'The ChatGPT page shows a visible error' } }
    }
    const selection = this.observedSelectionProblem(request, verified, observation)
    if (selection) return { resource, problem: selection }
    if (observation.userMessageCount !== 1
      || observation.userMessages.length !== 1
      || observation.userMessages[0] === undefined
      || normalizeReceiptText(observation.userMessages[0]) !== normalizeReceiptText(request.prompt)) {
      return {
        resource,
        problem: {
          code: 'WEB_SUBMISSION_MISMATCH',
          message: 'The original TaskSpace does not show exactly one matching user message',
        },
      }
    }
    if (observation.assistantMessages.length > 1) {
      return {
        resource,
        problem: {
          code: 'WEB_ASSISTANT_AMBIGUOUS',
          message: 'The original TaskSpace shows multiple assistant messages',
        },
      }
    }
    if (!isChatGptHttpsUrl(observation.url)) {
      return {
        resource,
        problem: { code: 'WEB_RESOURCE_MISMATCH', message: 'Observed page is not a ChatGPT HTTPS conversation' },
      }
    }
    if (resource.conversationUrl !== undefined) {
      if (resource.conversationUrl !== observation.url) {
        return {
          resource,
          problem: { code: 'WEB_RESOURCE_MISMATCH', message: 'Observed page does not match the durable conversation URL' },
        }
      }
      return { resource }
    }
    return isConversationUrl(observation.url)
      ? { resource: { ...resource, conversationUrl: observation.url } }
      : { resource }
  }

  private preflightSelectionProblem(request: WebRunRequest, observation: ChatGptPageObservation): WebRunErrorDetail | undefined {
    if (!observation.modelLabel) {
      return { code: 'WEB_MODEL_UNKNOWN', message: 'ChatGPT selected model could not be observed' }
    }
    if (request.modelLabel !== undefined && observation.modelLabel !== request.modelLabel) {
      return { code: 'WEB_MODEL_MISMATCH', message: 'ChatGPT selected model does not match the requested model' }
    }
    if (request.effortLabel !== undefined && observation.effortLabel !== request.effortLabel) {
      return { code: 'WEB_EFFORT_MISMATCH', message: 'ChatGPT selected effort does not match the requested effort' }
    }
    return undefined
  }

  private observedSelectionProblem(
    request: WebRunRequest,
    verified: WebRunObserved | undefined,
    observation: ChatGptPageObservation,
  ): WebRunErrorDetail | undefined {
    if (observation.modelLabel !== undefined) {
      const expected = verified?.modelLabel ?? request.modelLabel
      if (expected !== undefined && observation.modelLabel !== expected) {
        return { code: 'WEB_MODEL_MISMATCH', message: 'ChatGPT selected model changed after preflight' }
      }
    }
    if (observation.effortLabel !== undefined) {
      const expected = verified?.effortLabel ?? request.effortLabel
      if (expected !== undefined && observation.effortLabel !== expected) {
        return { code: 'WEB_EFFORT_MISMATCH', message: 'ChatGPT selected effort changed after preflight' }
      }
    }
    return undefined
  }

  private outputCandidate(observation: ChatGptPageObservation): OutputCandidate | undefined {
    if (observation.assistantMessages.length !== 1) return undefined
    const message = observation.assistantMessages[0]
    if (!message || message.text.trim().length === 0) return undefined
    return { text: message.text, markdown: message.markdown }
  }

  private async handleStartFailure(
    record: WebRunRecord,
    operation: ActiveOperation,
    error: unknown,
  ): Promise<WebRunRecord> {
    const detail = this.errorDetail(error, operation)
    if (operation.mayHaveSubmitted && !hasNoLateEffects(error)) {
      return this.markIndeterminate(record, detail)
    }
    if (operation.createStarted && !operation.resource && !hasNoLateEffects(error)) {
      return this.markIndeterminate(record, detail)
    }
    const stage = operation.abortDetail ? 'cancelled' : 'failed'
    return this.settleKnown(record, { stage, error: detail })
  }

  private async cancelledBeforeSubmission(record: WebRunRecord, operation: ActiveOperation): Promise<WebRunRecord> {
    return this.settleKnown(record, {
      stage: 'cancelled',
      error: this.abortDetail(operation),
    })
  }

  private abortDetail(operation: ActiveOperation): WebRunErrorDetail {
    if (operation.abortDetail) return operation.abortDetail
    if (operation.timedOut) return { code: 'WEB_TIMEOUT', message: 'Web run timed out locally' }
    return { code: 'WEB_ABORTED', message: 'Web run was aborted locally' }
  }

  private errorDetail(error: unknown, operation: ActiveOperation): WebRunErrorDetail {
    if (operation.abortDetail) return operation.abortDetail
    if (operation.timedOut) return { code: 'WEB_TIMEOUT', message: 'Web run timed out locally' }
    return {
      code: errorCode(error) ?? 'WEB_BROWSER_ERROR',
      message: errorMessage(error, 'Web browser operation failed'),
    }
  }

  private async settleKnown(record: WebRunRecord, patch: WebRunPatch): Promise<WebRunRecord> {
    const applied = await this.apply(record, patch)
    const current = applied.record
    if (current.stage === 'completed') await this.finishOwned(current.id)
    if (releasesAdmission(current.stage)) await this.releaseAdmission(current.id)
    return current
  }

  private async markIndeterminate(record: WebRunRecord, error: WebRunErrorDetail): Promise<WebRunRecord> {
    const applied = await this.apply(record, { stage: 'indeterminate', error })
    const current = applied.record
    if (releasesAdmission(current.stage)) return this.returnCurrent(current)
    await this.ensureFence(current.id)
    return current
  }

  private async returnCurrent(record: WebRunRecord): Promise<WebRunRecord> {
    if (record.stage === 'completed') await this.finishOwned(record.id)
    if (releasesAdmission(record.stage)) await this.releaseAdmission(record.id)
    return record
  }

  private async apply(record: WebRunRecord, patch: WebRunPatch): Promise<ApplyResult> {
    try {
      return { record: await this.store.transition(record.id, record.revision, patch), applied: true }
    } catch (error) {
      if (!isStateConflict(error)) throw error
      const current = await this.store.read(record.id)
      if (!current) throw error
      return { record: current, applied: false }
    }
  }

  private async unresolvedOther(id: string): Promise<WebRunRecord | undefined> {
    const records = await this.store.list()
    return records.find((record) => record.id !== id && unresolved(record.stage))
  }

  private admissionPath(): string {
    return join(this.store.root, ADMISSION_LOCK_NAME)
  }

  private async readAdmissionOwner(path = this.admissionPath()): Promise<AdmissionOwner> {
    try {
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink()) return { kind: 'invalid' }
      const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
      if (typeof parsed !== 'object' || parsed === null) return { kind: 'invalid' }
      const value = parsed as { formatVersion?: unknown; id?: unknown; lease?: unknown }
      if (typeof value.formatVersion !== 'number' || !Number.isInteger(value.formatVersion)) return { kind: 'invalid' }
      if (value.formatVersion !== ADMISSION_FORMAT_VERSION) return { kind: 'version' }
      if (typeof value.id !== 'string'
        || !isUuid(value.id)
        || typeof value.lease !== 'string'
        || !isUuid(value.lease)) {
        return { kind: 'invalid' }
      }
      return { kind: 'owned', id: value.id, lease: value.lease }
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return { kind: 'absent' }
      return { kind: 'invalid' }
    }
  }

  private async acquireAdmission(id: string): Promise<Admission> {
    const path = this.admissionPath()
    const temporary = join(this.store.root, `.${ADMISSION_LOCK_NAME}.${randomUUID()}.tmp`)
    const lease = randomUUID()
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
        return 'acquired'
      } catch (error) {
        if (!isErrno(error, 'EEXIST')) {
          throw new WebBrowserError('WEB_ADMISSION_FAILED', 'Web admission fence could not be created')
        }
        const owner = await this.readAdmissionOwner()
        const invalid = admissionReadError(owner)
        if (invalid) throw invalid
        if (owner.kind === 'absent') {
          throw new WebBrowserError('WEB_ADMISSION_INVALID', 'Web admission fence disappeared during acquisition')
        }
        return owner.kind === 'owned' && owner.id === id ? 'owned' : 'busy'
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

  private async ensureFence(id: string): Promise<void> {
    const admission = await this.acquireAdmission(id)
    if (admission === 'busy') return
  }

  private async releaseAdmission(id: string): Promise<void> {
    const owner = await this.readAdmissionOwner()
    if (owner.kind !== 'owned' || owner.id !== id) return
    const claim = join(this.store.root, `.${ADMISSION_LOCK_NAME}.release-${owner.lease}`)
    let ownsClaim = false
    try {
      try {
        await link(this.admissionPath(), claim)
        ownsClaim = true
      } catch (error) {
        // A claim from this lease means another releaser owns the only safe
        // deletion attempt. An old or malformed claim is intentionally not
        // reclaimed automatically.
        if (isErrno(error, 'EEXIST') || isErrno(error, 'ENOENT')) return
        throw error
      }

      // `link()` can run after a different controller has released the old
      // lock and acquired a new one. Compare the inode we claimed with the
      // owner read before deleting the public admission path.
      const claimed = await this.readAdmissionOwner(claim)
      const current = await this.readAdmissionOwner()
      if (!sameAdmission(owner, claimed) || !sameAdmission(owner, current)) return
      await unlink(this.admissionPath())
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) {
        throw new WebBrowserError('WEB_ADMISSION_RELEASE_FAILED', 'Web admission fence could not be released')
      }
    } finally {
      if (ownsClaim) {
        const claimed = await this.readAdmissionOwner(claim)
        if (sameAdmission(owner, claimed)) {
          try {
            await unlink(claim)
          } catch (error) {
            if (!isErrno(error, 'ENOENT')) {
              throw new WebBrowserError('WEB_ADMISSION_RELEASE_FAILED', 'Web admission release claim could not be removed')
            }
          }
        }
      }
    }
  }

  private async finishOwned(id: string): Promise<void> {
    const resource = this.ownedResources.get(id)
    if (!resource) return
    let finishing = this.finishes.get(id)
    if (!finishing) {
      finishing = this.browser.finish(resource).catch((error: unknown) => {
        throw new WebBrowserError('WEB_FINISH_FAILED', errorMessage(error, 'Web browser cleanup failed'))
      })
      this.finishes.set(id, finishing)
    }
    await finishing
  }

  private newOperation(request: WebRunRequest | undefined, signal?: AbortSignal): ActiveOperation {
    const controller = new AbortController()
    const operation: ActiveOperation = {
      controller,
      timeout: undefined as unknown as NodeJS.Timeout,
      detachExternalAbort: () => undefined,
      request,
      timedOut: false,
      createStarted: false,
      mayHaveSubmitted: false,
    }
    const onExternalAbort = (): void => {
      this.abort(operation, { code: 'WEB_ABORTED', message: 'Web run was aborted locally' })
    }
    if (signal) {
      if (signal.aborted) onExternalAbort()
      else signal.addEventListener('abort', onExternalAbort, { once: true })
      operation.detachExternalAbort = () => signal.removeEventListener('abort', onExternalAbort)
    }
    operation.timeout = setTimeout(() => {
      operation.timedOut = true
      this.abort(operation, { code: 'WEB_TIMEOUT', message: 'Web run timed out locally' })
    }, this.options.timeoutMs)
    return operation
  }

  private abort(operation: ActiveOperation, detail: WebRunErrorDetail): void {
    if (operation.controller.signal.aborted) return
    operation.abortDetail = detail
    operation.controller.abort()
  }

  private trackOperation(id: string, operation: ActiveOperation, promise: Promise<WebRunRecord>): void {
    void promise.then(
      () => this.endOperation(id, operation),
      () => this.endOperation(id, operation),
    )
  }

  private endOperation(id: string, operation: ActiveOperation): void {
    clearTimeout(operation.timeout)
    operation.detachExternalAbort()
    if (this.active.get(id) === operation) this.active.delete(id)
  }

  private async waitForPoll(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new WebBrowserError('WEB_ABORTED', 'Web run was aborted locally')
    if (this.options.pollMs === 0) return
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }, this.options.pollMs)
      const onAbort = (): void => {
        clearTimeout(timeout)
        reject(new WebBrowserError('WEB_ABORTED', 'Web run was aborted locally'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  private async runDispose(): Promise<void> {
    const active = Array.from(this.active.values())
    for (const operation of active) {
      this.abort(operation, { code: 'WEB_DISPOSED', message: 'Web controller was disposed locally' })
    }
    const outcomes = await Promise.allSettled([
      ...active.flatMap((operation) => operation.promise ? [operation.promise] : []),
    ])
    const failed = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
    if (failed) throw failed.reason
  }

}
