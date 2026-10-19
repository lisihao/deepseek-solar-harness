/** Owner-bound source reads; observations do not establish semantic support. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ResearchRunId } from './action.ts'

/** Explicit registered source Reader identity. */
export type ResearchSourceReaderId = Branded<'ResearchSourceReaderId'>
/** Immutable original source-reading operation identity. */
export type ResearchSourceReadId = Branded<'ResearchSourceReadId'>

/** Complete source request, independently of a later attempt or revision. */
export interface ResearchSourceReadRequest {
  readonly runId: ResearchRunId
  readonly readId: ResearchSourceReadId
  readonly readerId: ResearchSourceReaderId
  readonly revision: number
  readonly bindingSha256: string
  readonly requestedUrl: string
  readonly sourceLabel: string
  readonly inventoryVersion: number | null
}

/** Resource correlated by the original Reader, never reconstructed by opening its URL. */
export interface ResearchSourceResource {
  readonly id: string
  readonly evidence: string
}

/** Full supplied extraction, with independent extent and observable metadata. */
export interface ResearchSourceCapture {
  readonly finalUrl: string
  readonly title: string | null
  readonly author: string | null
  readonly publishedAt: string | null
  readonly version: string | null
  readonly extent: 'full' | 'relevant-passage' | 'search-snippet' | 'title-only' | 'unavailable' | 'not_observed'
  readonly text: string
  readonly textSha256: string
  readonly completeness: 'complete' | 'partial' | 'unknown'
  readonly limitation: string | null
}

/** Actual Reader transport reply; completion is independent of capture extent. */
export interface ResearchSourceObservation {
  readonly requestSha256: string
  readonly state: 'unknown' | 'not-admitted' | 'accepted' | 'completed'
  readonly resource: ResearchSourceResource | null
  readonly capture: ResearchSourceCapture | null
  readonly observedAt: string
  readonly evidence: string
}

/** Retained immutable observations and authorization checks, never a verification-complete flag. */
export interface ResearchSourceReadSnapshot {
  readonly request: ResearchSourceReadRequest
  readonly requestSha256: string
  readonly state: ResearchSourceObservation['state']
  readonly resource: ResearchSourceResource | null
  readonly observations: readonly ResearchSourceObservation[]
  /** Successfully authorized targets, without asserting that a visit occurred. */
  readonly authorizedUrls: readonly string[]
}

/** Original request and correlated resource passed to an explicit Reader. */
export interface ResearchSourceReaderInput {
  readonly request: ResearchSourceReadRequest
  readonly requestSha256: string
  readonly resource: ResearchSourceResource | null
}

/** Current-process source authorization; file/model JSON cannot recreate this callable access. */
export interface ResearchSourceAccess {
  readonly readers: readonly ResearchSourceReaderId[]
  /**
   * Check the exact initial or redirected URL against the current source selection.
   * @param request - Original immutable request.
   * @param actualUrl - Actual target before any visit.
   * @returns Current attributed authorization decision, without asserting a visit occurred.
   */
  authorizeSourceUrl(request: ResearchSourceReadRequest, actualUrl: string): { readonly allowed: boolean; readonly evidence: string }
}

/** Explicit trusted adapter; unsupported interfaces must refuse before the first visit. */
export interface ResearchSourceReader {
  readonly id: ResearchSourceReaderId
  /**
   * Call beforeVisit after every await immediately before each initial/redirected visit.
   * @param input - Retained unknown request.
   * @param signal - Local revocation, not proof of remote cancellation.
   * @param beforeVisit - Synchronous current-Host guard; invoke for every actual target.
   * @returns Actual JSON reply. Throws and lost replies remain unknown and must not be replayed.
   */
  read(input: ResearchSourceReaderInput, signal: AbortSignal, beforeVisit: (actualUrl: string) => void): Promise<unknown>
  /**
   * Inspect only the already correlated resource; never reopen a requested URL.
   * @param input - Original request with a non-null resource supplied by the Provider.
   * @param signal - Current local revocation.
   * @returns Actual observation of that original resource, without another target visit.
   */
  observe(input: ResearchSourceReaderInput, signal: AbortSignal): Promise<unknown>
}
