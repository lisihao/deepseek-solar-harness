export interface EgoProcessRequest {
  readonly executable: string
  readonly source: string
  readonly cwd: string
  readonly timeoutMs: number
  readonly stdoutMaxBytes: number
  readonly stderrMaxBytes: number
  readonly signal?: AbortSignal
}
export interface EgoProcessResult {
  readonly stdout: string
  readonly stderr: string
  /** True when stderr retention kept only the bounded tail. */
  readonly stderrTruncated?: boolean
  readonly exitCode: 0
  readonly executionStopped: true
}
export class EgoProcessError extends Error {
  constructor(readonly code: string, message: string, readonly executionStopped: boolean, readonly mayHaveLateEffects: boolean, readonly stderr: string = '') { super(message); this.name = 'EgoProcessError' }
}
