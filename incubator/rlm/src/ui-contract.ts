export interface RunSummary {
  readonly runId: string
  readonly label: string
  readonly state: string
  readonly message: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly modelRequests: number
  readonly result?: string
  readonly traceRef?: string
}

export interface SelfTestReport {
  readonly formatVersion: 1
  readonly kind: 'local-keyless'
  readonly status: 'passed' | 'failed'
  readonly checks: readonly {
    readonly id: string
    readonly passed: boolean
    readonly detail: string
  }[]
  readonly modelRequests: number
  readonly localModelRequests?: number
  readonly resultDirectory: string
}

export interface RlmUiStatus {
  readonly runtime: {
    readonly available: boolean
    readonly message: string
    readonly primeCommit: string
  }
  readonly runs: readonly RunSummary[]
  readonly selftest?: SelfTestReport
}

export interface SelfTestInput {
  readonly commandId: string
}

export interface InspectInput {
  readonly runId: string
}

export interface CancelInput {
  readonly runId: string
}

/** Host-facing RLM control surface; the client transport wraps each result. */
export interface RlmUiApi {
  status(): Promise<RlmUiStatus>
  check(input: SelfTestInput): Promise<SelfTestReport>
  inspect(input: InspectInput): Promise<RunSummary>
  cancel(input: CancelInput): Promise<RunSummary>
}
