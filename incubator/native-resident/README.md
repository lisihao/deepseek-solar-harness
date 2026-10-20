# Solar Native Resident

Unpublished source candidate: `@lisihao/dsh-solar-native-resident`. This plugin owns native Codex/Claude drivers, persistent session lanes, DSH tool bridging, a durable local TaskGraph, and its single local scheduler. RLM is excluded. The source implementation and keyless fixtures do not constitute current installed-app or logged-in real-provider acceptance.

## Ownership and execution

The plugin registers the public `solarNativeResident` Cordis service and `solar_resident` tool. A packaged Node daemon owns one SQLite database and an owner-only Unix socket under `$DSH_HOME/solar/native-resident/`. Clients may disconnect without cancelling admitted work. Explicit graph controls own pause, resume, and cancellation; stopping or removing a client is not proof that native work stopped.

Codex uses the public app-server protocol and non-ephemeral threads. Claude uses the official Agent SDK with persisted/resumed sessions. Each product owns its existing authentication, configuration, and transcripts; Solar does not copy credentials, launch login, or switch accounts. Native configuration remains authoritative, and unattended permission handling does not bypass native or DSH tool policy. The official one-shot subagent plugins remain independently usable; native-collaboration supplies handoff/allocation policy but never becomes a second scheduler.

## Configuration and data boundary

| Field | Meaning |
|---|---|
| `dshHome` | Optional explicit Harness home; omit to use the public Harness home resolver. Resident state stays below `solar/native-resident/`. |
| `codexExecutable` | Optional explicit Codex executable; otherwise use the pinned public Codex package executable. |
| `claudeExecutable` | Optional explicit Claude executable; otherwise use the pinned Agent SDK runtime. |
| `startupTimeoutMs` | Daemon readiness timeout, default `10000` ms. |
| `requestTimeoutMs` | Client RPC timeout, default `30000` ms; a timed-out mutation is not automatically replayed. |

The Resident database is the plugin-owned `$DSH_HOME/solar/native-resident/` namespace. Its SQLite schema version is `2`; unsupported schemas fail with a named error rather than becoming an empty database. `daemon.log` contains startup diagnostics. No DSH 3.x database, session, settings, or credential import is performed. A changed daemon build or executable configuration requires an explicitly selected stop/restart boundary; the plugin does not terminate an unverified process or silently replace a live execution authority.

## TaskGraphs, dependencies, and lanes

`solar_resident` supports `submit`, `list`, `inspect`, `events`, `models`, `pause`, `resume`, `cancel`, `resolve_retry`, and `resolve_fail`. Mutations require a caller-owned `command_id`; controls and resolutions require the exact recently inspected revision. Identical settled commands return their original receipt; changed input under the same identity conflicts. Inspect is a separate read of current status.

A TaskGraph has contract format version `1`, a stable `id`, `label`, existing absolute `cwd`, bounded `maxParallel`, optional absolute Unix-millisecond `notBefore`, and nodes. Each node specifies `id`, `executor` (`codex` or `claude-code`), and `prompt`; it may also specify `dependsOn`, `inputFrom`, `scope`, `sessionKey`, `profile`, `notBefore`, and bounded `retry`. The exported `/contracts` entry is canonical.

Only successful `dependsOn` predecessors release a node. A node's optional `inputFrom` list must contain unique direct predecessors already named in `dependsOn`; an unknown, duplicate, or non-predecessor entry fails graph validation before native dispatch. `inputFrom` is the explicit data-transfer boundary: after every named predecessor succeeds, Resident appends the complete predecessor outputs to the actual executable prompt in this exact form:

```text
<node.prompt>

--- BEGIN RESIDENT DEPENDENCY INPUTS (JSON) ---
{"formatVersion":1,"predecessors":[{"nodeId":"<id>","output":"<complete output>"}]}
--- END RESIDENT DEPENDENCY INPUTS ---
```

The predecessor order is the order in `inputFrom`, and the rendered prompt is persisted with the attempt before native execution. The original node prompt and every predecessor output are retained; omitting `inputFrom` means no predecessor output is appended. The node prompt and rendered dependency input each use the existing `1,000,000`-character prompt bound. An over-limit rendered input fails the dependent node with `DEPENDENCY_INPUT_TOO_LARGE` and does not call its driver. A retry reuses the first rendered prompt; it does not re-read later output or invent a new input.

The scheduler also checks graph/global capacity, declared overlapping read/write scopes, and active session lanes. An omitted scope is exclusive over the workspace. Scope declarations guide admission but do not impose filesystem isolation on a native product. Canonical working-directory identities prevent symlink aliases from bypassing conflicts.

`sessionKey` identifies a persistent lane within one executor and workspace. Tasks using that key serialize; after confirmed settlement, the native session identity is reused. A changed model/effort profile or bridge catalog cannot silently replace the existing lane. Different keys allow independent native sessions subject to admission constraints.

Graph `completed` means every native execution returned a confirmed terminal result. It does not certify tests, code correctness, or the user's acceptance criteria; the coordinator still reads outputs and verification evidence.

## Recovery, cancellation, and retry

Commands, attempts, rendered inputs, and native session identities are persisted before subsequent effects. An interrupted daemon recovers unconfirmed work as `indeterminate`; it does not reissue it. Unknown native/tool effects retain their lane and scope fence until an explicit owner decision. `resolve_retry` authorizes a new attempt; it is not evidence that the old effect never occurred. Retry policies apply only to explicitly listed known error codes within configured bounds. Unknown effects never enter automatic retry.

Cancelling active work first reports `cancelling`. A confirmed terminal result settles it as `cancelled`; an unconfirmed interruption becomes `indeterminate` and retains the lane/scope fence. A cancellation request alone is not proof that execution stopped. Queued tasks, eligibility times, session identities, rendered predecessor inputs, and completed results survive daemon restart; a running native process is not promised to survive machine restart, sleep, lost authentication, or Host shutdown.

## Tool bridging and records

Supply explicit `dsh_tools` names when submitting a graph, or use native-collaboration's same option. The live calling Agent's visible catalog is sealed into an in-memory capability. Native requests execute through that Agent's public DSH Tool Runtime and guards. Capability endpoints and secrets are never graph fields. The Resident database journals the exact bridge catalog, tool arguments, and settled results with idempotent receipts. If the owning Agent or Host disappears, DSH callbacks fail explicitly or remain unavailable; native-only and Host-dependent work therefore have different availability conditions.

## Verification boundary

Source tests use explicit fake native execution, injected protocol/SDK doubles, real local files/processes, and disposable homes. They cover graph validation, `inputFrom` rendering and limits, persistence/reopen, session lanes, bridge receipts, cancellation, and unknown-effect fencing. They do not prove logged-in Codex/Claude execution, installed-GUI acceptance, or model quality. The current source change makes no paid model call and does not consume Codex, Gemini, or Claude quota. Sources remain under `incubator/` until a separately authorized release.
