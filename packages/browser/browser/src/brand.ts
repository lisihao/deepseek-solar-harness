/** Runtime constructors for the browser seam's compile-time-only branded ids. */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Stable identity of one registered browser provider. */
export type BrowserProviderId = Branded<'BrowserProviderId'>

/** Stable provider-minted identity of a persistent browser workspace. */
export type BrowserWorkspaceId = Branded<'BrowserWorkspaceId'>

/** Consumer-minted page alias scoped to one BrowserRunPlanV1. */
export type BrowserPageKey = Branded<'BrowserPageKey'>

/** Consumer-minted operation identity scoped to one BrowserRunPlanV1. */
export type BrowserOperationId = Branded<'BrowserOperationId'>

/**
 * Brand a validated stable provider id.
 * @param value - validated deployment-owned provider identity.
 * @returns the branded provider identity.
 */
export const BrowserProviderId = (value: string): BrowserProviderId => value as BrowserProviderId

/**
 * Brand a provider-minted persistent workspace id.
 * @param value - stable workspace identity returned by a Provider.
 * @returns the branded workspace identity.
 */
export const BrowserWorkspaceId = (value: string): BrowserWorkspaceId => value as BrowserWorkspaceId

/**
 * Brand a consumer-minted plan-local page alias.
 * @param value - page alias unique within one plan or program.
 * @returns the branded page key.
 */
export const BrowserPageKey = (value: string): BrowserPageKey => value as BrowserPageKey

/**
 * Brand a consumer-minted plan-local operation id.
 * @param value - operation identity unique within one plan or program.
 * @returns the branded operation identity.
 */
export const BrowserOperationId = (value: string): BrowserOperationId => value as BrowserOperationId
