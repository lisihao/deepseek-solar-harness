/**
 * Physical-operator Service Definition (`ctx.physicalOperators`). The service
 * owns stable identity, discovery, fail-fast capacity admission, and paired
 * execution lifecycle events. Providers own only transport-specific startup,
 * result mapping, availability, and teardown.
 *
 * This is deliberately not an AI4Research scheduler, task graph, filesystem
 * inbox, or state store. Those concerns remain outside the capability seam.
 *
 * @module @deepseek-ai/dsh-physical-operator
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type {
  PhysicalOperator,
  PhysicalOperatorExecutionEndInfo,
  PhysicalOperatorExecutionInfo,
  PhysicalOperatorId,
  PhysicalOperatorExecutionMode,
  PhysicalOperatorProviderRun,
  PhysicalOperatorProviderStartRequest,
  PhysicalOperatorRun,
  PhysicalOperatorStartRequest,
  PhysicalOperatorStatus,
} from './types.ts'
import { PhysicalOperatorExecutionId as executionId, PhysicalOperatorId as operatorId } from './types.ts'
import { PhysicalOperatorError } from './error.ts'

export { PhysicalOperatorError } from './error.ts'
export { PhysicalOperatorExecutionId, PhysicalOperatorId } from './types.ts'
export type {
  PhysicalOperator,
  PhysicalOperatorAvailability,
  PhysicalOperatorDescriptor,
  PhysicalOperatorExecutionEndInfo,
  PhysicalOperatorExecutionMode,
  PhysicalOperatorExecutionInfo,
  PhysicalOperatorProviderRun,
  PhysicalOperatorProviderStartRequest,
  PhysicalOperatorResult,
  PhysicalOperatorRun,
  PhysicalOperatorStartRequest,
  PhysicalOperatorStatus,
  PhysicalOperatorStopReason,
  PhysicalOperatorStopReasonMap,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    physicalOperators: PhysicalOperatorRuntime
  }

  interface Events {
    /**
     * A stable operator became discoverable.
     * @mode emit
     * @param operator - newly registered implementation and descriptor.
     */
    'physical-operator/added'(operator: PhysicalOperator): void
    /**
     * An operator stopped accepting new executions. Accepted runs survive.
     * @mode emit
     * @param id - stable identity removed from discovery.
     */
    'physical-operator/removed'(id: PhysicalOperatorId): void
    /**
     * A provider published an accepted execution.
     * @mode emit
     * @param info - stable operator and unique execution identities.
     */
    'physical-operator/start'(info: PhysicalOperatorExecutionInfo): void
    /**
     * A published execution settled.
     * @mode emit
     * @param info - paired execution identity and terminal reason.
     */
    'physical-operator/end'(info: PhysicalOperatorExecutionEndInfo): void
  }
}

/** Registry and execution admission service for deployment-defined physical operators. */
export class PhysicalOperatorRuntime extends Service {
  private readonly operators = new Map<PhysicalOperatorId, PhysicalOperator>()
  private readonly active = new Map<PhysicalOperatorId, number>()

  constructor(ctx: Context) {
    super(ctx, 'physicalOperators')
  }

  /**
   * Register one operator. The registration follows the caller fiber and is
   * safe to remove while accepted executions finish under holder ownership.
   * @param operator - trusted implementation and immutable descriptor to register.
   * @returns the exact asynchronous Cordis effect disposer.
   */
  registerOperator(operator: PhysicalOperator): () => Promise<void> {
    validateDescriptor(operator.descriptor)
    const id = operator.descriptor.id
    return this.ctx.effect(function* (this: PhysicalOperatorRuntime) {
      if (this.operators.has(id)) {
        throw new PhysicalOperatorError(
          `a physical operator named "${id}" is already registered`,
          'DUPLICATE_OPERATOR',
        )
      }
      this.operators.set(id, operator)
      yield () => {
        this.operators.delete(id)
        this.emitContained('physical-operator/removed', id)
      }
      this.ctx.emit('physical-operator/added', operator)
    }.bind(this), 'physicalOperators.registerOperator()')
  }

  /**
   * Resolve one registered operator, or undefined when it is absent.
   * @param id - stable operator identity to resolve.
   * @returns the current registered implementation, when present.
   */
  getOperator(id: string): PhysicalOperator | undefined {
    return this.operators.get(operatorId(id))
  }

  /**
   * Return live status snapshots in registration order.
   * @returns provider availability combined with service-owned capacity.
   */
  list(): PhysicalOperatorStatus[] {
    return [...this.operators.values()].map(operator => this.statusOf(operator))
  }

  /**
   * Resolve one live status or fail loud for an unknown operator id.
   * @param id - stable operator identity to inspect.
   * @returns the current status snapshot.
   */
  status(id: string): PhysicalOperatorStatus {
    return this.statusOf(this.expectOperator(id))
  }

  /**
   * Admit and publish one execution. Capacity is reserved synchronously before
   * provider startup and released exactly once when the result settles.
   * @param id - stable operator identity to execute.
   * @param request - caller-owned task, parent, and cancellation signal.
   * @returns the accepted, holder-owned execution handle.
   */
  async start(id: string, request: PhysicalOperatorStartRequest): Promise<PhysicalOperatorRun> {
    if (request.signal.aborted) {
      throw new PhysicalOperatorError('physical operator start was already aborted', 'OPERATOR_ABORTED')
    }
    const operator = this.expectOperator(id)
    const status = this.statusOf(operator)
    const mode: PhysicalOperatorExecutionMode = request.mode ?? 'ephemeral'
    if (!status.executionModes.includes(mode)) {
      throw new PhysicalOperatorError(
        `physical operator "${id}" does not support ${mode} execution`,
        'OPERATOR_MODE_UNSUPPORTED',
      )
    }
    if (status.state === 'unavailable') {
      throw new PhysicalOperatorError(
        `physical operator "${id}" is unavailable: ${status.unavailableReason ?? 'no reason reported'}`,
        'OPERATOR_UNAVAILABLE',
      )
    }
    if (status.state === 'busy') {
      throw new PhysicalOperatorError(
        `physical operator "${id}" is at capacity (${status.active}/${status.maxConcurrency})`,
        'OPERATOR_BUSY',
      )
    }

    const stableId = operator.descriptor.id
    const identity: PhysicalOperatorExecutionInfo = {
      executionId: request.executionId ?? executionId(randomUUID()),
      operatorId: stableId,
    }
    this.active.set(stableId, status.active + 1)
    let providerRun: PhysicalOperatorProviderRun
    try {
      const providerRequest: PhysicalOperatorProviderStartRequest = {
        ...request,
        executionId: identity.executionId,
        mode,
      }
      providerRun = await operator.start(providerRequest)
    } catch (error) {
      this.release(stableId)
      throw error
    }

    const result = providerRun.result.then(
      (settled) => {
        this.emitContained('physical-operator/end', { ...identity, stopReason: settled.stopReason })
        return settled
      },
      (error: unknown) => {
        this.emitContained('physical-operator/end', { ...identity, stopReason: 'error' })
        throw error
      },
    ).finally(() => {
      this.release(stableId)
    })
    this.emitContained('physical-operator/start', identity)
    return {
      id: identity.executionId,
      operatorId: stableId,
      result,
      dispose: () => providerRun.dispose(),
    }
  }

  /** Convert one provider plus service-owned capacity to a public snapshot. */
  private statusOf(operator: PhysicalOperator): PhysicalOperatorStatus {
    const descriptor = {
      ...operator.descriptor,
      executionModes: normalizedModes(operator.descriptor.executionModes),
    }
    const active = this.active.get(descriptor.id) ?? 0
    const availability = operator.availability()
    if (!availability.available) {
      return {
        ...descriptor,
        state: 'unavailable',
        active,
        unavailableReason: availability.reason,
      }
    }
    return {
      ...descriptor,
      state: active >= descriptor.maxConcurrency ? 'busy' : 'available',
      active,
    }
  }

  /** Look up one operator or raise the stable absence error. */
  private expectOperator(id: string): PhysicalOperator {
    const operator = this.getOperator(id)
    if (operator === undefined) {
      throw new PhysicalOperatorError(`no physical operator registered for "${id}"`, 'NO_OPERATOR')
    }
    return operator
  }

  /** Release one admission reservation without coupling it to registration lifetime. */
  private release(id: PhysicalOperatorId): void {
    const next = (this.active.get(id) ?? 1) - 1
    if (next <= 0) this.active.delete(id)
    else this.active.set(id, next)
  }

  /** Publish lifecycle/removal telemetry without letting observers change execution. */
  private emitContained(
    name: 'physical-operator/removed' | 'physical-operator/start' | 'physical-operator/end',
    payload: PhysicalOperatorId | PhysicalOperatorExecutionInfo | PhysicalOperatorExecutionEndInfo,
  ): void {
    for (const callback of this.ctx.events.dispatch('emit', [name, payload])) {
      try {
        const returned: unknown = callback(payload)
        void Promise.resolve(returned).catch((error: unknown) => {
          this.ctx.logger.warn(`physical-operator: ${name} listener rejected: ${renderThrown(error)}`)
        })
      } catch (error: unknown) {
        this.ctx.logger.warn(`physical-operator: ${name} listener threw: ${renderThrown(error)}`)
      }
    }
  }
}

/** Reject ambiguous identity, presentation, capacity, and selection metadata. */
function validateDescriptor(descriptor: PhysicalOperator['descriptor']): void {
  const id = String(descriptor.id)
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(id)) {
    throw new PhysicalOperatorError(
      'physical operator id must use lowercase letters, digits, dots, underscores, or hyphens',
      'INVALID_OPERATOR',
    )
  }
  for (const [field, value] of [
    ['displayName', descriptor.displayName],
    ['description', descriptor.description],
  ] as const) {
    if (value.length === 0 || value.trim() !== value) {
      throw new PhysicalOperatorError(`physical operator ${field} must be non-blank and trimmed`, 'INVALID_OPERATOR')
    }
  }
  if (!Number.isSafeInteger(descriptor.maxConcurrency) || descriptor.maxConcurrency < 1) {
    throw new PhysicalOperatorError('physical operator maxConcurrency must be a positive safe integer', 'INVALID_OPERATOR')
  }
  normalizedModes(descriptor.executionModes)
  const tags = new Set<string>()
  for (const tag of descriptor.tags) {
    if (tag.length === 0 || tag.trim() !== tag) {
      throw new PhysicalOperatorError('physical operator tags must be non-blank and trimmed', 'INVALID_OPERATOR')
    }
    if (tags.has(tag)) {
      throw new PhysicalOperatorError(`physical operator has duplicate tag "${tag}"`, 'INVALID_OPERATOR')
    }
    tags.add(tag)
  }
}

/** Normalize an omitted mode list to the original one-shot contract and reject ambiguity. */
function normalizedModes(
  modes: PhysicalOperator['descriptor']['executionModes'],
): readonly PhysicalOperatorExecutionMode[] {
  if (modes === undefined) return ['ephemeral']
  const candidate: unknown = modes
  if (!isUnknownArray(candidate) || candidate.length === 0) {
    throw new PhysicalOperatorError('physical operator executionModes must not be empty', 'INVALID_OPERATOR')
  }
  const unique = new Set<PhysicalOperatorExecutionMode>()
  for (const value of candidate) {
    if (value !== 'ephemeral' && value !== 'resident') {
      throw new PhysicalOperatorError(`unsupported physical operator execution mode: ${String(value)}`, 'INVALID_OPERATOR')
    }
    const mode: PhysicalOperatorExecutionMode = value
    if (unique.has(mode)) {
      throw new PhysicalOperatorError(`duplicate physical operator execution mode: ${mode}`, 'INVALID_OPERATOR')
    }
    unique.add(mode)
  }
  return Object.freeze([...unique])
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value)
}

/** Render a listener failure without allowing hostile coercion to escape containment. */
function renderThrown(value: unknown): string {
  try {
    return value instanceof Error ? `${value.name}: ${value.message}` : String(value)
  } catch {
    return '<unrenderable thrown value>'
  }
}

export default PhysicalOperatorRuntime
