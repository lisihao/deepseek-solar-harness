# Browser Automation

English | [中文](browser.zh.md)

The browser automation capability is a provider-neutral seam for controlling an installed browser through `ctx.browser`. It is separate from [`ctx.web`](web.md): Web search and fetch retrieve resources, while browser automation drives an interactive page, preserves a named workspace when the Provider supports it, and can reuse the user's existing login state.

The seam has three independently replaceable roles:

- [`@deepseek-ai/dsh-browser`](../../packages/browser/browser) owns the Service Definition, portable contracts, Provider registry, selection, cancellation, and errors.
- [`@deepseek-ai/dsh-browser-ego-lite`](../../packages/browser/browser-ego-lite) adapts the separately installed Ego Lite browser without exposing its native target ids or snapshot references.
- [`@deepseek-ai/dsh-tool-browser`](../../packages/browser/tool-browser) is the model Consumer. It exposes only the closed `portable-plan-v1` vocabulary, not arbitrary JavaScript.

Other trusted plugins inject `browser` and depend only on the Service Definition. They never import the Ego Lite Provider. A deployment can therefore replace Ego Lite with another Provider without changing Consumers.

Source: [`packages/browser/browser/src/types.ts`](../../packages/browser/browser/src/types.ts) and [`packages/browser/browser/src/index.ts`](../../packages/browser/browser/src/index.ts)

## Execution layers

`portable-plan-v1` is an ordered, typed batch of navigation, discovery, locator, interaction, wait, screenshot, and completion operations. The model-facing tool accepts only this layer and bounds a plan to 64 operations. Providers either implement the declared operation or reject it explicitly; the seam does not silently fall back to another transport.

`browser-js-v1` is a separate opt-in surface for trusted plugins that need variables, loops, branches, locators, or page evaluation inside one browser transaction. Its source is executable and is not a model security sandbox. A Consumer must never forward untrusted model text to `runProgram()`.

## Selection and lifecycle

Provider selection is deterministic. A configured Provider id must exist, be locally available, support the requested layer, and satisfy all requested capabilities. Without an explicit id, exactly one usable Provider may be selected; zero or multiple candidates fail loudly. Registration returns a disposer, so HMR and Bundle removal do not leave a stale Provider behind.

Persistent browser profile data and task workspaces remain owned by the Provider. DSH receives normalized results and portable handles only. User control is authoritative: when the Provider reports `USER_IN_CONTROL` or an inactive workspace, the caller stops and surfaces that state instead of retrying or taking control.

The Ego Lite Bundle does not redistribute the browser binary. The user installs and onboards Ego Lite separately; an unavailable executable keeps the Provider unavailable without breaking unrelated DSH features.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxbrowser--browserruntime"></a>

### `ctx.browser` — `BrowserRuntime`

Registry and execution authority for the browser capability seam.

Provider resolution happens for every call. Explicit selection fails closed when missing or unavailable; implicit selection succeeds only when exactly one provider is locally usable, so registration and HMR order never decide.

```ts cordis-catalog
/**
 * Register one backend. Duplicate stable ids fail instead of replacing a live
 * Provider. The returned disposer is also tied to the contributing Cordis fiber.
 * @param provider - browser backend and its stable descriptor.
 * @returns a disposer that unregisters this Provider.
 */
registerProvider(provider: BrowserProvider): () => void

/**
 * Portable capabilities of the Provider that would execute one layer now.
 * @param layer - explicit execution layer to resolve.
 * @returns the selected Provider's portable capability names.
 */
capabilities(layer: BrowserExecutionLayerV1): readonly BrowserCapabilityV1[]

/**
 * Execute one ordered v1 plan. The Provider receives the exact plan and abort
 * signal. Portable Provider errors survive; arbitrary failures are normalized.
 * @param plan - closed, ordered portable operation plan.
 * @param signal - optional cancellation forwarded to the Provider.
 * @returns the Provider's normalized ordered result.
 */
async runPlan(plan: BrowserRunPlanV1, signal?: AbortSignal): Promise<BrowserRunResultV1>

/**
 * Execute one explicitly opted-in `browser-js-v1` program. This method never
 * converts a plan into source and never retries or takes control implicitly.
 * @param program - source, workspace, required capabilities, and output bound.
 * @param signal - optional cancellation forwarded to the Provider.
 * @returns the bounded provider-neutral program result.
 */
async runProgram( program: BrowserRunProgramV1, signal?: AbortSignal, ): Promise<BrowserRunProgramResultV1>
```

Source: [`packages/browser/browser/src/index.ts:72`](../../packages/browser/browser/src/index.ts)
<!-- END GENERATED cordis-surface -->
