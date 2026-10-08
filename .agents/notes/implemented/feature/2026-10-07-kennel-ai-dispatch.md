# Agent Note: AI selection and Host-owned kennel execution

Status: implemented

English | [中文](2026-10-07-kennel-ai-dispatch.zh.md)

## Problem

A selected member name or an online roster does not prove a current executor or project directory. An unconstrained conversation agent can also confuse a scheduling reply with completed work, change the intended member, or infer permissions from model text. Kennel messages require a traceable selection tied to the actual member execution route.

## Decision

The [kennel dispatcher](../../../../packages/orchestration/ui-gouzi/README.md) consumes only real human messages in `kennel` sessions and logs the message before an independent, tool-free scheduling request. Host-qualified candidates fix member identity, generation, verified default-project directory, operator ids, and `chat`, `read`, or `write` mode. Existing-run control candidates are bound to the exact source session and revision, with inspect, pause, resume, and cancel actions qualified by current state. All model requests, starts, and control effects require session flush to return true before execution. The model returns a supplied candidate id or requests clarification; it cannot create identities, permission scopes, plans, or task results. An explicit recipient restricts the candidate set. The Host rechecks the selected member before compilation and start, then admits standard TaskGraphs without fallback operators, RLM, or Autonomous Mode.

Scheduling configuration belongs to DSH rather than the normal conversation model or private Codex settings. Explicit `dispatcher.jev` takes precedence; otherwise the registered `dispatcher.jevProvider` route uses its first configured model and refuses registration without a model. Without that route, configured DeepSeek performs the judgment. Only an explicit DeepSeek balance failure permits tool-free Codex judgment through the subscription Responses API. Its model is resolved from the actual registered catalog; only the existing authorized account authentication is read, expiry fails, and no native Session is created. Other failures remain failures; neither Jev failure nor generic transport failure changes the model route.

The [physical-operator catalog](../../../../packages/physical-operator/physical-operator/README.md) carries an optional `gouziWorkspace` binding. The remote execution Host resolves the persisted default project through `registeredDirectory`, verifies its real path, and supplies its project identity and scopes. The [execution directory](../../../../packages/orchestration/orchestration-local/README.md) associates that catalog with the actual member registration and generation. Non-local read-only shared-project compilation retains this receiving-host path without resolving it on the scheduling Mac. Older endpoints without the field provide an empty scope list. Generic, stale, mismatched, and unreachable entries cannot establish directory authority.

Greetings execute on the actual selected dog through a `chat` TaskGraph with no filesystem or effect permissions. Read and write requests use Host-fixed scopes; writes are high risk and require independent verification and the existing approval lifecycle. Current write admission is restricted to registered local members with loopback endpoints; full directory-snapshot transfer to another host is outside this authorization. A logged decision is not an execution receipt. Stable submission identity is recorded before start, and an unknown start outcome requires reconciliation of the original command rather than another dispatch. The room hides internal and context records while preserving real user messages, actual error message/code, and attributed task results. Clicking names selects send targets; separate message filters do not change them.

## Governed files and delivery

Fresh receiving catalogs must attest generation limits and governed file policy; older unsupported endpoints fail qualification. Direct Codex file execution exposes only bounded list, read, search, write, and remove operations within sealed read/write and forbidden scopes, rejects symlink traversal, and loads no native tools, configuration, CLI, MCP, or host skills. Private fsynced records retain exact model inputs, SDK outputs, tool arguments, and settled results; they do not claim lossless raw-wire capture. Unknown file effects or post-effect persistence failures remain indeterminate without replay. Token and byte limits apply to observed outputs; the Codex SDK supplies no backend hard output-token cap.

Compatibility preserves provider-default generation for old disabled, tool-free requests without generation limits and the existing sealed single-`typescript_repl` call-only bridge through the direct Codex API loop. The legacy bridge does not call `tool.describe` or invent a generation budget. New kennel requests retain explicit budgets and governed file tools.

Directory snapshots support plain, unborn, and dirty source directories through task-owned checkpoints that exclude `.git` and preserve source index and HEAD. Approved work changes the isolated checkout; independent verification reads its current modified bundle. Strict `model-verdict` acceptance requires an affirmative result, reason, and actual evidence. A negative, missing, malformed, or unevidenced verdict blocks source application. Changes to affected source paths or their parents since checkpoint prevent unconditional overwrite. Delivery persists `applying` before source mutation, rejects pause/cancel during this critical phase, and honors cancellation accepted before it. Unknown delivery requires reconciliation, not another apply.

## Alternatives considered

**Letting the conversation model plan and execute the message.** A scheduling judgment does not need task tools. Restricting the output to qualified candidate ids preserves the Host's authority over members, projects, scopes, and admission.

**Treating online status or a stored path as directory qualification.** These values cannot establish a fresh default-project binding. Actual registrations and verified member-local directories provide the required execution input.

**Falling back after every model or start failure.** An unrelated model error does not establish insufficient balance, and a failed start response can hide an accepted command. Narrow balance fallback and original-command reconciliation avoid silently changing routes or duplicating execution.

## Consequences

Each real message selects one dog. This mechanism does not decompose complex tasks among several dogs, create dog-to-dog conversation, or provide long-term member chat memory. Missing projects or executors, changed generations, invalid decisions, and clarification requests produce explicit failures instead of alternate dispatch. Auxiliary requests and their recorded model outcomes remain in session events so the selection can be reconstructed independently of the UI.

Focused dispatcher and model-route tests exercise candidate validation, fixed graph permissions, logged requests, model failures, and stable submission behavior; remote catalog tests cover verified project scopes and absent or mismatched bindings. Keyless assembled replay covers a real kennel message through the dispatcher and TaskGraph route. Source verification and the successful direct Codex subscription API smoke are separate evidence. The latter establishes a pure API call, not full physical-operator fallback or runtime installation acceptance. Generic file tests do not establish semantic verification quality. The existing native turn/start identity-mismatch error is an actual native execution error, not evidence that the member is offline; native guards remain unchanged.
