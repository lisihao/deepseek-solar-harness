# @deepseek-ai/dsh-browser

English | [中文](README.zh.md)

`BrowserRuntime` (`ctx.browser`) is the provider-neutral browser automation Service Definition. It lets Consumers submit one ordered, versioned browser plan without importing a browser product, extension protocol, or native page identifier.

| Package kind | Responsibility |
|---|---|
| `@deepseek-ai/dsh-browser` | Service: portable vocabulary, Provider registry, selection, cancellation, and errors |
| Browser Provider package | Browser transport, workspace/page lifecycle, authenticated profile, native error mapping |
| Browser Consumer package | Model/tool schema, policy, plan construction, attachment persistence, result presentation |

This package does not register a tool, install a browser extension, or include a Provider. Providers and Consumers depend on this package; they do not depend on each other.

## Service API (`ctx.browser`)

| Member | Semantics |
|---|---|
| `registerProvider(provider)` | Registers one Provider id and returns a fiber-bound disposer; duplicates fail |
| `capabilities(layer)` | Returns portable capabilities from the Provider that would execute that layer now |
| `runPlan(plan, signal?)` | Executes an ordered `BrowserRunPlanV1` and returns `BrowserRunResultV1` |
| `runProgram(program, signal?)` | Explicitly executes one capability-gated `browser-js-v1` source body |

`available()` is a cheap local check and must not make a network call. Provider selection happens at each `capabilities(layer)`, `runPlan()`, or `runProgram()` call:

| Situation | Outcome |
|---|---|
| configured id is registered and available | use it |
| configured id is absent | `BROWSER_PROVIDER_CONFIGURED_MISSING` |
| configured id is unavailable | `BROWSER_PROVIDER_CONFIGURED_UNAVAILABLE` |
| no configured id and exactly one Provider is available | use it |
| no configured id and none is available | `BROWSER_UNAVAILABLE` |
| no configured id and multiple are available | `BROWSER_PROVIDER_AMBIGUOUS` |

Selection therefore never depends on registration or HMR order. A Consumer may branch on `capabilities(layer)` but must not branch on a Provider id. Selection also filters by `descriptor.layers`, so a plan-only Provider cannot silently run a program.

## Two v1 execution layers

`portable-plan-v1` is the default interoperability layer. It is suitable for ordinary plugins because the Service owns its closed, typed vocabulary and a Consumer never supplies executable source.

`BrowserRunPlanV1` selects the current, existing, or named workspace, declares required capabilities, and carries an ordered operation array. The Service rejects missing capabilities before the first operation. `BrowserPageKey` and `BrowserOperationId` are Consumer-minted aliases scoped to that plan. `BrowserWorkspaceId` is a stable Provider-minted identity that may be used by a later plan.

The closed operation union covers page selection and lifecycle, navigation, page metadata, semantic snapshots, screenshots, locator interaction, reads, waits, explicit user handoff/takeover, and completion with an explicit `keep` decision. The locator union covers CSS and accessible role, text, label, placeholder, and test-id lookup. New operation or result kinds require a coordinated Service/Provider/Consumer contract change.

`BrowserRunResultV1` returns the final workspace lifecycle/control state and exactly one ordered result for each operation. Screenshots are returned as `Uint8Array` plus media type; a Consumer decides whether and where to persist them. No filesystem path crosses this seam.

The plan contract intentionally excludes Provider-native tab ids, snapshot refs, native workspace commands, extension messages, profile directories, arbitrary source, debugging-protocol commands, and transport details. Providers translate between the portable plan and their native protocol.

`browser-js-v1` is a separate explicit opt-in layer for workloads that need single-execution variables, loops, branches, locators, and page evaluation. `BrowserRunProgramV1.source` is the body of an async function that receives `BrowserProgramApiV1`: `browser.run(operation)` executes one portable operation and `browser.evaluate(page, functionExpression, argument?)` executes a function expression in the page.

This layer is a trusted-plugin executable surface, not a hostile-code or model-facing security sandbox. A Provider runtime may expose ambient Node.js, filesystem, network, module-loading, or Provider globals even though none of those capabilities is portable or part of `BrowserProgramApiV1`. A model-facing Consumer must expose only typed `runPlan` input and must never accept arbitrary model-authored `source` for `runProgram`.

The program declares `requiredCapabilities`; the Service checks them before execution. Its return value must satisfy an explicit `none`, bounded `text`, or bounded JSON output contract. Program-local variables, locators, page objects, DOM objects, and Provider-native handles die with that one execution and cannot be returned for a later call.

## Errors and recovery

`BrowserError` has a closed portable `BrowserErrorCode` and an optional `operationId`. Providers throw the same class for expected browser failures; the Service preserves those errors and normalizes unknown failures as `BROWSER_PROVIDER_FAILED` with their cause. Cancellation before or during Provider execution becomes `BROWSER_ABORTED`.

Portable operational codes distinguish user control, inactive workspaces, stale pages, timeouts, unsupported operations, and protocol failures. Recovery remains explicit: a Consumer can submit a new plan that selects the stable workspace, rebinds plan-local page keys, takes control, or completes it. The Service never retries an operation because replaying a click or form fill could duplicate an effect.

Layer and capability mismatches fail before source execution. The Service enforces text output bounds and rejects oversized JSON instead of treating an unbounded program result as success.

## Security boundary

- The Service trusts typed same-process plans; the Consumer validates model or user JSON before constructing them.
- A Provider validates and bounds every extension, process, or network message at its own untrusted boundary.
- `browser-js-v1` trusts its source. The Service bounds its declared result but does not confine ambient runtime access.
- `handoff` and `takeover` are explicit operations. A Provider must return `BROWSER_USER_CONTROL` rather than acting while the user owns control.
- Page evaluation exists only in the opt-in `browser-js-v1` layer and requires the declared `page-evaluate` capability. Debugging protocols remain outside the public seam.

## Model Experience

### Consumer-rendered browser outcomes

#### What the model sees

Nothing directly from this package; a Consumer decides how bounded `BrowserRunResultV1` / `BrowserRunProgramResultV1` data or structured `BrowserError` metadata enters a tool result.

#### Token effect

No direct token cost; the Consumer owns snapshot truncation, screenshot attachment references, and result presentation.

#### KV Cache effect

No direct invalidation; this Service registers no prompt, tool schema, or Session context entry.

## Known Limitations and Deferred Work

- No Provider or Consumer is bundled, so execution fails until a Provider is registered and no model-facing browser tool exists from this package alone.
- The Service package remains Provider-neutral. The separate `@deepseek-ai/dsh-browser-ego-lite` Provider, `@deepseek-ai/dsh-tool-browser` Consumer, and `@deepseek-ai/dsh-ego-lite-browser` Bundle form the shipped Ego Lite integration; the external browser's installation and onboarding lifecycle remain outside this Service.
- The v1 contract deliberately has no downloads, file upload, PDF extraction, or debugging-protocol operation. Page evaluation is program-only.
- Availability has no event stream; callers observe it through `capabilities(layer)` or execution-time portable errors.
- The Service does not persist workspace metadata or screenshots. Providers own native state and Consumers own harness attachments or durable records.
