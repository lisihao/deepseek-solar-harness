/** Continuous Harness capability seam. @module @deepseek-ai/dsh-continual-harness */

import { Context, Service } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'

/** Durable scope used to select Continuous Harness entries. */
export type ContinualHarnessScope = 'session' | 'workspace'
/** Supported bounded entry categories. */
export type ContinualHarnessEntryKind = 'instruction' | 'memory' | 'skill' | 'subagent-pattern' | 'outcome'

/** One bounded, content-addressed Continuous Harness entry. */
export interface ContinualHarnessEntryV1 {
  readonly version: 1
  readonly entryId: string
  readonly scope: ContinualHarnessScope
  readonly scopeId: string
  readonly kind: ContinualHarnessEntryKind
  readonly text: string
  readonly tags: readonly string[]
  readonly evidenceRefs: readonly string[]
  readonly createdAt: string
  readonly digest: string
}

/** Input used to compile a node-local Continuous Harness snapshot. */
export interface ContinualHarnessSnapshotRequest {
  readonly workspace: string
  readonly sessionId?: string
  readonly scope: ContinualHarnessScope
  readonly role: string
  readonly task: string
  readonly limit: number
}

/** Immutable entry snapshot sealed into one node attempt. */
export interface ContinualHarnessSnapshotV1 {
  readonly version: 1
  readonly scope: ContinualHarnessScope
  readonly scopeId: string
  readonly generation: number
  readonly entries: readonly ContinualHarnessEntryV1[]
  readonly generatedAt: string
  readonly snapshotSha256: string
}

/** Bounded outcome written after a node settles. */
export interface ContinualHarnessOutcomeRequest {
  readonly runId: string
  readonly nodeId: string
  readonly workspace: string
  readonly sessionId?: string
  readonly scope: ContinualHarnessScope
  readonly role: string
  readonly task: string
  readonly outcome: 'passed' | 'failed'
  readonly evidenceRefs: readonly string[]
}

/** Structured Continuous Harness validation or availability failure. */
export class ContinualHarnessError extends HarnessError {
  constructor(message: string, code: 'HARNESS_INVALID' | 'HARNESS_UNAVAILABLE') {
    super(message, code)
    this.name = 'ContinualHarnessError'
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context { continualHarness: ContinualHarnessService }
}

/** Snapshot/outcome seam; the Scheduler only consumes immutable snapshots. */
export abstract class ContinualHarnessService extends Service {
  constructor(ctx: Context) {
    if (new.target === ContinualHarnessService) throw new Error('@deepseek-ai/dsh-continual-harness is an abstract seam; load a Provider')
    super(ctx, 'continualHarness')
  }

  /**
   * Compile a bounded immutable snapshot for one session or workspace scope.
   * @param request Scope, task, and entry-limit policy for the snapshot.
   * @returns The content-addressed Continuous Harness snapshot.
   */
  abstract snapshot(request: ContinualHarnessSnapshotRequest): Promise<ContinualHarnessSnapshotV1>
  /**
   * Record a bounded task outcome after an orchestration node settles.
   * @param request Bounded outcome summary and Evidence references.
   * @returns The idempotently stored harness entry.
   */
  abstract recordOutcome(request: ContinualHarnessOutcomeRequest): Promise<ContinualHarnessEntryV1>
}

export default ContinualHarnessService
