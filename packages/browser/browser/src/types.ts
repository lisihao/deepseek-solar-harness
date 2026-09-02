/**
 * Provider-neutral contracts for the browser capability seam (`ctx.browser`).
 *
 * The closed plan vocabulary names browser intent and portable outcomes. The
 * separate program contract admits capability-gated page evaluation without
 * exposing provider-native tab ids, snapshot references, transports, profile
 * paths, or debugging protocols.
 *
 * @module @deepseek-ai/dsh-browser/types
 */

import type {
  BrowserOperationId,
  BrowserPageKey,
  BrowserProviderId,
  BrowserWorkspaceId,
} from './brand.ts'

/** Optional behavior a provider can faithfully supply through the v1 seam. */
export type BrowserCapabilityV1 =
  | 'authenticated-profile-reuse'
  | 'named-workspace'
  | 'page-evaluate'
  | 'screenshot'
  | 'semantic-snapshot'
  | 'user-control'

/** Independently selectable v1 execution surfaces implemented by a Provider. */
export type BrowserExecutionLayerV1 = 'portable-plan-v1' | 'browser-js-v1'

/** Browser workspace to activate before executing the plan. */
export type BrowserWorkspaceSelectorV1 =
  | { readonly kind: 'current' }
  | { readonly kind: 'existing'; readonly id: BrowserWorkspaceId }
  | { readonly kind: 'named'; readonly name: string; readonly createIfMissing: boolean }

/** Portable URL match used to bind an already-open page to a plan-local key. */
export type BrowserPageMatchV1 =
  | { readonly kind: 'exact-url'; readonly url: string }
  | { readonly kind: 'url-prefix'; readonly prefix: string }

/** Provider-neutral locator. `index` selects one result after provider-native lookup. */
export type BrowserLocatorV1 =
  | { readonly kind: 'css'; readonly selector: string; readonly index?: number }
  | { readonly kind: 'role'; readonly role: string; readonly name?: string; readonly exact?: boolean; readonly index?: number }
  | { readonly kind: 'text'; readonly text: string; readonly exact?: boolean; readonly index?: number }
  | { readonly kind: 'label'; readonly label: string; readonly exact?: boolean; readonly index?: number }
  | { readonly kind: 'placeholder'; readonly placeholder: string; readonly exact?: boolean; readonly index?: number }
  | { readonly kind: 'test-id'; readonly testId: string; readonly index?: number }

/** Load milestone for operations that wait on navigation. */
export type BrowserLoadStateV1 = 'dom-content-loaded' | 'load' | 'network-idle'

/** Condition for one explicit browser wait operation. */
export type BrowserWaitConditionV1 =
  | { readonly kind: 'load'; readonly page: BrowserPageKey; readonly state: BrowserLoadStateV1 }
  | { readonly kind: 'url'; readonly page: BrowserPageKey; readonly match: BrowserPageMatchV1 }
  | { readonly kind: 'locator'; readonly page: BrowserPageKey; readonly locator: BrowserLocatorV1; readonly state: 'attached' | 'detached' | 'visible' | 'hidden' }
  | { readonly kind: 'control'; readonly control: 'agent' | 'user' }

/** Value requested from a matched element. */
export type BrowserReadTargetV1 =
  | { readonly kind: 'text' }
  | { readonly kind: 'value' }
  | { readonly kind: 'html' }
  | { readonly kind: 'attribute'; readonly name: string }

/** Shared correlation and deadline fields carried by every plan operation. */
export interface BrowserOperationEnvelopeV1 {
  readonly id: BrowserOperationId
  /** Operation-local timeout. Omission delegates the deadline to the provider. */
  readonly timeoutMs?: number
}

/**
 * One provider-neutral browser operation. This is a CLOSED union: new kinds
 * require a coordinated v2-compatible change across Service, Provider, and
 * Consumer packages. Provider-native escape hatches intentionally do not exist.
 */
export type BrowserOperationV1 = BrowserOperationEnvelopeV1 & (
  | { readonly kind: 'open'; readonly page: BrowserPageKey; readonly url: string; readonly reuse: 'never' | 'exact-url'; readonly waitUntil: BrowserLoadStateV1 }
  | { readonly kind: 'select-page'; readonly page: BrowserPageKey; readonly match: BrowserPageMatchV1 }
  | { readonly kind: 'close-page'; readonly page: BrowserPageKey }
  | { readonly kind: 'navigate'; readonly page: BrowserPageKey; readonly url: string; readonly waitUntil: BrowserLoadStateV1 }
  | { readonly kind: 'reload'; readonly page: BrowserPageKey; readonly waitUntil: BrowserLoadStateV1 }
  | { readonly kind: 'pages' }
  | { readonly kind: 'page-info'; readonly page: BrowserPageKey }
  | { readonly kind: 'snapshot'; readonly page: BrowserPageKey }
  | { readonly kind: 'screenshot'; readonly page: BrowserPageKey; readonly fullPage: boolean }
  | { readonly kind: 'click'; readonly page: BrowserPageKey; readonly locator: BrowserLocatorV1 }
  | { readonly kind: 'fill'; readonly page: BrowserPageKey; readonly locator: BrowserLocatorV1; readonly value: string }
  | { readonly kind: 'clear'; readonly page: BrowserPageKey; readonly locator: BrowserLocatorV1 }
  | { readonly kind: 'press'; readonly page: BrowserPageKey; readonly locator: BrowserLocatorV1; readonly key: string }
  | { readonly kind: 'check'; readonly page: BrowserPageKey; readonly locator: BrowserLocatorV1; readonly checked: boolean }
  | { readonly kind: 'select'; readonly page: BrowserPageKey; readonly locator: BrowserLocatorV1; readonly values: readonly string[] }
  | { readonly kind: 'read'; readonly page: BrowserPageKey; readonly locator: BrowserLocatorV1; readonly target: BrowserReadTargetV1 }
  | { readonly kind: 'count'; readonly page: BrowserPageKey; readonly locator: BrowserLocatorV1 }
  | { readonly kind: 'wait'; readonly condition: BrowserWaitConditionV1 }
  | { readonly kind: 'handoff'; readonly note?: string }
  | { readonly kind: 'takeover' }
  | { readonly kind: 'complete'; readonly keep: boolean }
)

/** A complete, ordered browser batch accepted by every v1 Provider. */
export interface BrowserRunPlanV1 {
  readonly version: 1
  readonly workspace: BrowserWorkspaceSelectorV1
  /** Capabilities required by this batch, enforced before its first operation. */
  readonly requiredCapabilities: readonly BrowserCapabilityV1[]
  /** Operations execute in array order; page aliases become usable after binding. */
  readonly operations: readonly BrowserOperationV1[]
}

/** Portable page metadata; provider-native page and target ids stay hidden. */
export interface BrowserPageV1 {
  readonly page: BrowserPageKey
  readonly url: string
  readonly title?: string
}

/** Final persistent workspace state after the ordered batch settles. */
export interface BrowserWorkspaceStateV1 {
  readonly id: BrowserWorkspaceId
  readonly name?: string
  readonly lifecycle: 'active' | 'completed'
  readonly control: 'agent' | 'user'
}

/** Operations that acknowledge success without returning another payload. */
export type BrowserDoneOperationV1 =
  | 'close-page'
  | 'click'
  | 'fill'
  | 'clear'
  | 'press'
  | 'check'
  | 'select'
  | 'wait'
  | 'complete'

/**
 * One ordered operation result. The CLOSED union excludes filesystem paths and
 * provider-native handles; screenshots cross the seam as owned bytes.
 */
export type BrowserOperationResultV1 =
  | { readonly kind: 'done'; readonly id: BrowserOperationId; readonly operation: BrowserDoneOperationV1 }
  | { readonly kind: 'page'; readonly id: BrowserOperationId; readonly operation: 'open' | 'select-page' | 'navigate' | 'reload' | 'page-info'; readonly page: BrowserPageV1 }
  | { readonly kind: 'pages'; readonly id: BrowserOperationId; readonly pages: readonly BrowserPageV1[] }
  | { readonly kind: 'snapshot'; readonly id: BrowserOperationId; readonly content: string }
  | { readonly kind: 'screenshot'; readonly id: BrowserOperationId; readonly mediaType: 'image/png' | 'image/jpeg'; readonly bytes: Uint8Array }
  | { readonly kind: 'read'; readonly id: BrowserOperationId; readonly value: string | null }
  | { readonly kind: 'count'; readonly id: BrowserOperationId; readonly count: number }
  | { readonly kind: 'control'; readonly id: BrowserOperationId; readonly operation: 'handoff' | 'takeover'; readonly control: 'agent' | 'user' }

/** Ordered provider-neutral outcome for a {@link BrowserRunPlanV1}. */
export interface BrowserRunResultV1 {
  readonly version: 1
  readonly workspace: BrowserWorkspaceStateV1
  /** Exactly one result per input operation, in the same order and with the same id. */
  readonly operations: readonly BrowserOperationResultV1[]
}

/** JSON-compatible data accepted and returned by `browser-js-v1`. */
export type BrowserJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly BrowserJsonValue[]
  | { readonly [key: string]: BrowserJsonValue }

/** Bounded result shape required from one browser program. */
export type BrowserProgramOutputContractV1 =
  | { readonly kind: 'none' }
  /** `maxCharacters` counts Unicode grapheme clusters, not UTF-16 code units. */
  | { readonly kind: 'text'; readonly maxCharacters: number }
  /** `maxBytes` counts the UTF-8 encoding of the JSON serialization. */
  | { readonly kind: 'json'; readonly maxBytes: number }

/**
 * Explicit opt-in programmable browser request.
 *
 * `source` is the body of an async `browser-js-v1` function that receives the
 * normative {@link BrowserProgramApiV1}. JavaScript variables, loops, and branches
 * stay inside this single execution. This contract does not sandbox ambient runtime
 * capabilities, so only trusted plugin code may use it; model-facing Consumers must
 * expose typed plans instead. The returned value must satisfy `output`; Provider-
 * native objects and handles may not cross the result.
 */
export interface BrowserRunProgramV1 {
  readonly version: 1
  readonly language: 'browser-js-v1'
  readonly workspace: BrowserWorkspaceSelectorV1
  readonly source: string
  /** Capabilities the Consumer knows its source needs, enforced before execution. */
  readonly requiredCapabilities: readonly BrowserCapabilityV1[]
  readonly output: BrowserProgramOutputContractV1
}

/** Normative portable browser object passed to a `browser-js-v1` source body. */
export interface BrowserProgramApiV1 {
  /** Execute one portable operation and return its portable result. */
  run(operation: BrowserOperationV1): Promise<BrowserOperationResultV1>
  /**
   * Evaluate a JavaScript function expression in the selected page. `argument`
   * and the resolved value are JSON-compatible; DOM or Provider handles never
   * cross this call. Programs using this member require `page-evaluate`.
   */
  evaluate(
    page: BrowserPageKey,
    functionExpression: string,
    argument?: BrowserJsonValue,
  ): Promise<BrowserJsonValue>
}

/** Bounded value returned by one completed browser program. */
export type BrowserProgramOutputV1 =
  | { readonly kind: 'none' }
  | { readonly kind: 'text'; readonly value: string; readonly truncated: boolean }
  | { readonly kind: 'json'; readonly value: BrowserJsonValue }

/** Portable outcome of one `browser-js-v1` execution. */
export interface BrowserRunProgramResultV1 {
  readonly version: 1
  readonly workspace: BrowserWorkspaceStateV1
  readonly output: BrowserProgramOutputV1
}

/** Stable registry and feature metadata published by one browser Provider. */
export interface BrowserProviderDescriptorV1 {
  readonly id: BrowserProviderId
  readonly layers: readonly BrowserExecutionLayerV1[]
  readonly capabilities: readonly BrowserCapabilityV1[]
}

/** A browser backend registered through {@link BrowserRuntime.registerProvider}. */
export interface BrowserProvider {
  readonly descriptor: BrowserProviderDescriptorV1
  /** Cheap local usability check; must not make network calls. */
  available(): boolean
  /** Present exactly when `descriptor.layers` includes `portable-plan-v1`. */
  runPlan?(plan: BrowserRunPlanV1, signal?: AbortSignal): Promise<BrowserRunResultV1>
  /** Present exactly when `descriptor.layers` includes `browser-js-v1`. */
  runProgram?(program: BrowserRunProgramV1, signal?: AbortSignal): Promise<BrowserRunProgramResultV1>
}
