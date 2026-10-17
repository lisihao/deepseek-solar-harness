/** Attempt-owned dispatch evidence; cancellation alone never proves settlement. */
import type { PhysicalOperatorExecutionId } from '@deepseek-ai/dsh-physical-operator'

type RequestState = 'preparing' | 'sent' | 'terminal-response' | 'not-sent' | 'unknown'

/** Evidence supplied by the actual request transport, independently of worker success. */
export interface RlmRequestSettlement {
  /** Record that the request has entered the provider dispatch path. */
  sent(): void
  /** Record an authoritative terminal response, including a late response after uncertainty. */
  terminalResponse(): void
  /** Record proof that this request never entered provider dispatch. */
  notSent(): void
  /** Retain an indeterminate provider outcome; abort/connection close cannot clear it. */
  unknown(): void
}

/** One command may make several actual API requests or one Resident turn. */
export interface RlmCommandSettlement {
  /**
   * Read this command's evidence without counting another concurrent command.
   * @returns command-local dispatch, request and resource observations.
   */
  snapshot(): RlmCommandSettlementSnapshot
  /**
   * Reserve a request before its first asynchronous dispatch operation.
   * @returns evidence recorder for that exact request.
   */
  beginRequest(): RlmRequestSettlement
  /** Record that this command will issue no further requests or acceptances. */
  finishDispatch(): void
  /** Record completion of the resources owned by this command's provider. */
  releaseResources(): void
}

/** One command's facts before the enclosing attempt closes admission. */
export interface RlmCommandSettlementSnapshot {
  readonly dispatchFinished: boolean
  readonly resourcesReleased: boolean
  readonly requestCount: number
  readonly pendingRequests: number
  readonly unknownRequests: number
  readonly settled: boolean
}

function commandSnapshot(command: CommandEvidence): RlmCommandSettlementSnapshot {
  const states = [...command.requests.values()]
  const pendingRequests = states.filter(state => state === 'preparing' || state === 'sent').length
  const unknownRequests = states.filter(state => state === 'unknown').length
  return {
    dispatchFinished: command.dispatchFinished,
    resourcesReleased: command.resourcesReleased,
    requestCount: states.length,
    pendingRequests,
    unknownRequests,
    settled: command.dispatchFinished && command.resourcesReleased && pendingRequests === 0 && unknownRequests === 0,
  }
}

/** Derived evidence for one attempt; outcome and usage remain owned elsewhere. */
export interface RlmDispatchSettlementSnapshot {
  readonly admissionClosed: boolean
  readonly commandCount: number
  readonly dispatchingCommands: number
  readonly unreleasedCommands: number
  readonly requestCount: number
  readonly pendingRequests: number
  readonly unknownRequests: number
  readonly settled: boolean
}

interface CommandEvidence {
  dispatchFinished: boolean
  resourcesReleased: boolean
  readonly requests: Map<number, RequestState>
}

/** Tracks all request rounds and late starts under the existing attempt owner. */
export class RlmDispatchSettlementTracker {
  private readonly commands = new Map<PhysicalOperatorExecutionId, CommandEvidence>()
  private admissionClosed = false
  private readonly completion = Promise.withResolvers<void>()

  /** Resolves only after dispatch admission closes and every owned request/resource settles. */
  readonly whenSettled = this.completion.promise

  /**
   * Reserve a command before starting a provider or awaiting its acceptance.
   * @param executionId - exact command identity owned by the current attempt.
   * @returns recorder retained even if acceptance arrives after cancellation.
   */
  beginCommand(executionId: PhysicalOperatorExecutionId): RlmCommandSettlement {
    if (this.admissionClosed) throw new Error('RLM dispatch admission is closed')
    if (this.commands.has(executionId)) throw new Error('RLM command already has settlement evidence')
    const command: CommandEvidence = {
      dispatchFinished: false,
      resourcesReleased: false,
      requests: new Map(),
    }
    this.commands.set(executionId, command)
    return {
      snapshot: () => commandSnapshot(command),
      beginRequest: () => {
        if (this.admissionClosed || command.dispatchFinished) {
          throw new Error('RLM request admission is closed')
        }
        const ordinal = command.requests.size
        command.requests.set(ordinal, 'preparing')
        const update = (next: RequestState): void => {
          const previous = command.requests.get(ordinal)
          const allowed = previous === next
            || (previous === 'preparing' && (next === 'sent' || next === 'not-sent' || next === 'unknown'))
            || (previous === 'sent' && (next === 'terminal-response' || next === 'unknown'))
            || (previous === 'unknown' && next === 'terminal-response')
          if (!allowed) throw new Error('RLM request evidence contradicts a recorded dispatch outcome')
          command.requests.set(ordinal, next)
          this.resolveIfSettled()
        }
        return {
          sent: () => { update('sent') },
          terminalResponse: () => { update('terminal-response') },
          notSent: () => { update('not-sent') },
          unknown: () => { update('unknown') },
        }
      },
      finishDispatch: () => {
        command.dispatchFinished = true
        this.resolveIfSettled()
      },
      releaseResources: () => {
        if (!command.dispatchFinished) throw new Error('RLM command dispatch has not finished')
        command.resourcesReleased = true
        this.resolveIfSettled()
      },
    }
  }

  /** Close new command/request admission before cancellation or final settlement inspection. */
  closeAdmission(): void {
    this.admissionClosed = true
    this.resolveIfSettled()
  }

  /**
   * Read transport and local-resource facts without inferring task success or remote process exit.
   * @returns current derived counts and the complete settlement condition.
   */
  snapshot(): RlmDispatchSettlementSnapshot {
    let dispatchingCommands = 0
    let unreleasedCommands = 0
    let requestCount = 0
    let pendingRequests = 0
    let unknownRequests = 0
    for (const command of this.commands.values()) {
      if (!command.dispatchFinished) dispatchingCommands++
      if (!command.resourcesReleased) unreleasedCommands++
      for (const state of command.requests.values()) {
        requestCount++
        if (state === 'preparing' || state === 'sent') pendingRequests++
        if (state === 'unknown') unknownRequests++
      }
    }
    return {
      admissionClosed: this.admissionClosed,
      commandCount: this.commands.size,
      dispatchingCommands,
      unreleasedCommands,
      requestCount,
      pendingRequests,
      unknownRequests,
      settled: this.admissionClosed && dispatchingCommands === 0 && unreleasedCommands === 0
        && pendingRequests === 0 && unknownRequests === 0,
    }
  }

  private resolveIfSettled(): void {
    if (this.snapshot().settled) this.completion.resolve()
  }
}
