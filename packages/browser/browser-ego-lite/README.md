# @deepseek-ai/dsh-browser-ego-lite

English | [中文](README.zh.md)

Ego Lite Service Provider for [`@deepseek-ai/dsh-browser`](../browser/README.md). It translates portable plans and trusted-plugin programs into one `ego-browser nodejs` invocation through `ctx.subprocess`; Providers and Consumers never exchange Ego `targetId`, snapshot `@N` refs, native handles, profile paths, or extension messages.

The adapter is frozen against upstream [`v1.2.5`](https://github.com/citrolabs/ego-lite/tree/v1.2.5) at commit [`fd3aae7146cf6c9c52014a9752f411bf9978ae93`](https://github.com/citrolabs/ego-lite/commit/fd3aae7146cf6c9c52014a9752f411bf9978ae93). Its primary contracts are the upstream [agent skill](https://github.com/citrolabs/ego-lite/blob/v1.2.5/skills/ego-browser/SKILL.md), [stdin runner](https://github.com/citrolabs/ego-lite/blob/v1.2.5/package/ego-browser/src/run.ts), [stable errors](https://github.com/citrolabs/ego-lite/blob/v1.2.5/package/ego-browser/src/ego-errors.ts), [hard-stop output sink](https://github.com/citrolabs/ego-lite/blob/v1.2.5/package/ego-browser/src/output-sink.ts), and [update notice](https://github.com/citrolabs/ego-lite/blob/v1.2.5/package/ego-browser/src/update-notice.ts).

## Configuration

| Field | Default | Meaning |
|---|---:|---|
| `executable` | discovery | Absolute `ego-browser` path. Omission probes `~/.local/bin/ego-browser`, then the helper bundled at `/Applications/ego lite.app/Contents/Frameworks/ego Framework.framework/Versions/Current/Helpers/ego-browser`. No shell or PATH lookup is used. |
| `cwd` | DSH process cwd | Absolute working directory for each isolated command. |
| `graceMs` | `2000` | Managed process-tree termination grace. |
| `stdoutMaxBytes` | `8388608` | Complete framed stdout bound. Overflow fails with `BROWSER_OUTPUT_LIMIT`. |
| `stderrMaxBytes` | `262144` | Retained stderr diagnostic-tail bound. |
| `operationTimeoutMs` | `30000` | Provider default for operations without `timeoutMs`. |

An invalid configured executable fails plugin load. Failed automatic discovery registers `ego-lite` as unavailable, so `ctx.browser` reports `BROWSER_UNAVAILABLE` without starting a process.

## Process and result protocol

Each call uses exactly `[resolvedExecutable, "nodejs"]`, no shell, and one complete JavaScript program as closed stdin. `ctx.subprocess` owns credential-scrubbed environment inheritance, cancellation, tree termination, and bounded output collection. A prefixed one-line JSON frame carries the result or stable error; all subprocess JSON is validated before it becomes a browser result. Loss on either collected stream fails with `BROWSER_OUTPUT_LIMIT`.

The upstream trailing `[ego-browser:notice]` update line is removed from the result channel and sent to the DSH logger as out-of-band diagnostics. It never changes success or error classification.

Native `EGO_TASK_SPACE_USER_IN_CONTROL` maps to `BROWSER_USER_CONTROL`; `EGO_TASK_SPACE_INACTIVE` maps to `BROWSER_WORKSPACE_INACTIVE`. The first hard stop latches inside the one heredoc even if trusted source catches it, blocks further browser calls, and fails the request. The Provider never retries, claims, or takes over automatically. Only an explicit portable `takeover` operation calls `taskSpaces.takeOver`.

## Translation fidelity

The Provider supports named and stable `ego-lite:<numeric-id>` task spaces; exact-URL open/reuse and selection; close, navigation, reload, page metadata, snapshot and bounded screenshot bytes; semantic/CSS locator interactions and reads; waits; explicit handoff/takeover; completion; and page evaluation inside `browser-js-v1`.

| Upstream v1.2.5 contract | DSH realization | Status |
|---|---|---|
| One `ego-browser nodejs` heredoc composes a complete task | `browser-js-v1` preserves one process and JavaScript variables, branches, loops, actions, and verification | faithful |
| Agent work is isolated in reusable task spaces with the user's browser state | Portable named/existing workspaces map to stable `ego-lite:<id>` identities | faithful |
| Snapshot, semantic locators, actions, waits, capture, and evaluation | Typed portable operations cover the model-safe subset; trusted plugins retain capture, handoff/takeover, and evaluation | faithful with split authority |
| User-control and inactive-space errors are hard stops | The first native hard stop is latched and mapped to a stable `BrowserError`; no implicit retry or takeover | faithful |
| Update notices are out-of-band CLI diagnostics | Notices go to DSH logging and never alter the framed result | adapted |
| Native current-space lookup, guaranteed fresh-tab creation, and raw page listing | Rejected as unsupported because the public helpers cannot preserve DSH's portable identity contract | deliberate omission |

`browser-js-v1` preserves Ego's central single-heredoc behavior: trusted plugin code can keep JavaScript variables, loops, branches, locators, actions, evaluation, verification, and completion inside one process. Ego heredocs execute in Node.js, so this layer is a **trusted-plugin executable surface, not a model-facing security sandbox**. The Provider does not use `vm`, a static blacklist, or lexical shadowing to claim otherwise. A model-facing Consumer must expose only typed `runPlan`; it must never accept arbitrary model-authored `source` for `runProgram`.

Program-local page aliases map to native `targetId` only inside the generated heredoc. They and every DOM/native handle die with the process. The returned value is limited by the declared `none`, grapheme-bounded `text`, or UTF-8-byte-bounded JSON output contract.

## Model Experience

### Consumer-owned browser execution

#### What the model sees

Nothing directly from this Provider package. The shipped `@deepseek-ai/dsh-tool-browser` Consumer owns the model-facing schema and renders only typed `runPlan` results or portable errors; it does not expose `browser-js-v1` source execution to a model.

#### Token effect

No direct token cost. A Consumer owns snapshot truncation, screenshot attachment references, and bounded result presentation.

#### KV Cache effect

No direct invalidation. This Provider registers no prompt, tool schema, or Session context entry.

## Known Limitations and Deferred Work

- **The binary remains an external prerequisite** — this package does not redistribute Ego Lite or manage its extension/onboarding lifecycle. `@deepseek-ai/dsh-tool-browser` supplies the model Consumer, `@deepseek-ai/dsh-ego-lite-browser` supplies the Bundle, and DSH Desktop composes both by default. Real installed-browser acceptance remains pending until Ego Lite onboarding is complete; fixture coverage is not presented as that evidence.
- **`current` workspace is unsupported** — upstream v1.2.5 public helpers do not expose a lossless selected-task-space identity, so the Provider fails with `BROWSER_UNSUPPORTED_OPERATION` before launch.
- **`open` with `reuse: "never"` is unsupported** — the public `browser` facade exposes `openOrReuseTab` but not `newTab`, so the Provider does not pretend it can guarantee a fresh page.
- **`pages` is unsupported** — upstream returns native `targetId` values while the portable result requires Consumer-minted page keys; the Provider fails instead of exporting or persisting native identifiers.
- **Screenshot transport uses an ephemeral Ego-process file** — the heredoc reads the PNG into its framed result and unlinks it before returning. No path crosses `ctx.browser`, but a process crash can leave Ego's temporary screenshot behind.
- **Node execution is trusted** — program source can access the ambient Ego Node process. Capability declarations describe browser behavior; they do not confine executable source.
