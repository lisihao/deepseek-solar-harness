/** Continuous Harness capability seam. @module @deepseek-ai/dsh-continual-harness */

import { Context, Service } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'

export type ContinualHarnessScope = 'session' | 'workspace'
export type ContinualHarnessEntryKind = 'instruction' | 'memory' | 'skill' | 'subagent-pattern' | 'outcome'

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

export interface ContinualHarnessSnapshotRequest {
  readonly workspace: string
  readonly sessionId?: string
  readonly scope: ContinualHarnessScope
  readonly role: string
  readonly task: string
  readonly limit: number
}

export interface ContinualHarnessSnapshotV1 {
  readonly version: 1
  readonly scope: ContinualHarnessScope
  readonly scopeId: string
  readonly generation: number
  readonly entries: readonly ContinualHarnessEntryV1[]
  readonly generatedAt: string
  readonly snapshotSha256: string
}

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

  abstract snapshot(request: ContinualHarnessSnapshotRequest): Promise<ContinualHarnessSnapshotV1>
  abstract recordOutcome(request: ContinualHarnessOutcomeRequest): Promise<ContinualHarnessEntryV1>
}

export default ContinualHarnessService
