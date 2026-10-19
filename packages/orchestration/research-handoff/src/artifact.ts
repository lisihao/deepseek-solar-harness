/** Shared immutable research artifact and transfer data. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ResearchActionId, ResearchRunId } from './action.ts'

/** Opaque owner-scoped research artifact identity; a digest is not an access capability. */
export type ResearchArtifactId = Branded<'ResearchArtifactId'>

/** Independent capture observation, retaining the original page and extraction provenance. */
export interface ResearchCaptureSource {
  readonly page: string
  readonly conversation: string | null
  readonly method: 'dom-text' | 'download' | 'manual-import'
  readonly capturedAt: string
  readonly extent: 'complete' | 'partial' | 'unknown'
  readonly endEvidence: string | null
}

/** Append-only artifact input; expectedVersion is the last observed version of this role. */
export interface ResearchArtifactInput {
  readonly artifactId: ResearchArtifactId
  readonly actionId: ResearchActionId
  readonly role: 'gemini-plan' | 'gemini-report' | 'chatgpt-report' | 'verification'
  readonly expectedVersion: number
  readonly source: ResearchCaptureSource
  readonly bytes: Uint8Array
}

/** Exact retained bytes with independent capture extent and original action provenance. */
export interface ResearchArtifactSnapshot {
  readonly runId: ResearchRunId
  readonly artifactId: ResearchArtifactId
  readonly actionId: ResearchActionId
  readonly requestSha256: string
  readonly role: ResearchArtifactInput['role']
  readonly version: number
  readonly source: ResearchCaptureSource
  readonly sha256: string
  readonly bytes: Uint8Array
}

/** One complete ordered UTF-8 segment with byte offsets in the original artifact. */
export interface ResearchTextChunk {
  readonly index: number
  readonly byteStart: number
  readonly byteEnd: number
  readonly sha256: string
  readonly text: string
}

/** Local transfer evidence only; actual submitted message or attachment mapping needs separate observations. */
export interface ResearchTextHandoff {
  readonly format: 'research-text-handoff/v1'
  readonly artifactId: ResearchArtifactId
  readonly artifactVersion: number
  readonly sha256: string
  readonly totalBytes: number
  readonly chunkCount: number
  readonly chunks: readonly ResearchTextChunk[]
}
