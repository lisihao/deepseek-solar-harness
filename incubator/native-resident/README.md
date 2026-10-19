# Solar Native Resident

Unpublished development bundle: `@lisihao/dsh-solar-native-resident`. This plugin owns native Codex/Claude Drivers, persistent session lanes, DSH tool bridging, a durable local TaskGraph and its scheduler. RLM is excluded.

## Ownership and execution

The plugin registers the public `solarNativeResident` Cordis service and `solar_resident` tool. A packaged Node daemon owns one SQLite database and an owner-only Unix socket under `$DSH_HOME/solar/native-resident/`. Clients may disconnect without cancelling admitted work. Explicit graph controls own pause, resume and cancellation; stopping or removing a client is not proof that native work stopped.

Codex uses the public app-server protocol and non-ephemeral threads. Claude uses the official Agent SDK with persisted/resumed sessions. Each product owns its existing authentication/configuration/transcripts; Solar does not copy credentials, launch login or switch accounts. Native configuration remains authoritative; unattended permission handling does not bypass native or DSH tool policy.

The official one-shot subagent plugins remain usable independently. The optional collaboration plugin provides handoff and model-allocation policy; this plugin is the sole graph scheduling authority.

## Configuration

| Field | Meaning |
|---|---|
| `dshHome` | Optional explicit Harness home; omit to use the public Harness home resolver. Plugin state always uses its `solar/native-resident/` child. |
| `codexExecutable` | Optional explicit Codex executable; otherwise use the pinned public Codex package's declared executable. |
| `claudeExecutable` | Optional explicit Claude executable; otherwise use the pinned Agent SDK runtime. |
| `startupTimeoutMs` | Daemon readiness timeout, default 10000 ms. |
| `requestTimeoutMs` | Client RPC timeout, default 30000 ms; a timed-out mutation is not automatically replayed. |

A changed daemon build or executable configuration requires explicitly stopping the existing daemon before switching. The plugin does not terminate an unverified process or silently replace a live execution authority.

## TaskGraphs and lanes

`solar_resident` supports `submit`, `list`, `inspect`, `events`, `models`, `pause`, `resume`, `cancel`, `resolve_retry`, and `resolve_fail`. Mutations require a caller-owned `command_id`; controls/resolutions also require the exact recently inspected revision. Identical settled commands return their original admission receipt; changed input under the same identity conflicts. Inspect separately for current status.

A TaskGraph has `formatVersion: 1`, stable `id`, `label`, existing absolute `cwd`, bounded `maxParallel`, optional absolute Unix-millisecond `notBefore`, and nodes. Each node specifies `id`, `executor` (`codex` or `claude-code`), `prompt`, and optionally `dependsOn`, `scope`, `sessionKey`, `profile`, `notBefore` and bounded `retry`. The exported `/contracts` entry is the canonical TypeScript shape.

Only successful dependencies release a node. Failed dependencies block downstream work. The scheduler checks graph/global capacity, declared overlapping read/write scopes and active session lanes. Absent scope means exclusive workspace use. Scope declarations guide admission; they do not impose filesystem isolation on a native product. Canonical working-directory identities prevent symlink aliases from bypassing conflict checks.

`sessionKey` identifies a persistent lane within one executor and workspace. Tasks using that lane serialize; settled native identity is reused. Model/effort and bridge-catalog changes cannot silently replace the configuration of an existing lane. Different keys allow independent native sessions, subject to admission constraints.

Graph `completed` means all native executions returned confirmed completion. It does not certify tests, code correctness or the user's acceptance criteria. Verification instructions and evidence must still be reviewed.

## Recovery and uncertain effects

Commands and native session identities are persisted before subsequent effects. An interrupted daemon recovers unconfirmed work as `indeterminate`; it does not reissue it. Unknown native/tool effects retain their lane/scope fence until an explicit owner decision. `resolve_retry` authorizes a new attempt; it is not evidence that the old effect never occurred. Retry policies apply only to explicit known codes within configured bounds.

Cancelling active work first reports `cancelling`. A confirmed terminal result settles it as `cancelled`; an unconfirmed interruption becomes `indeterminate` and retains the lane/scope fence. A cancellation request alone is not evidence that execution has stopped.

Queued tasks, eligibility times, session identities and completed results survive daemon restart. This does not promise that a running native process survives machine restart, sleep, lost authentication or Host shutdown.

## Tool bridging and records

Supply explicit `dsh_tools` names when submitting a graph, or use the collaboration plugin's same option. The live calling Agent's visible catalog is sealed into an in-memory capability. Native requests execute through that Agent's public DSH Tool Runtime, including its guards. Capability endpoints/secrets are never graph fields.

The Resident database journals the exact bridge catalog, tool arguments and settled results with idempotent receipts. It is a native-session execution journal. The public rc.2 Tool Runtime does not automatically append a complete external-native trace to the DSH parent transcript; see [extension-point limits](../../docs/blocked-seams.md). If the owning Agent/Host disappears, DSH callbacks fail explicitly or remain unavailable. Native-only work and Host-dependent work therefore have different availability conditions.

The SQLite format has an explicit version; unsupported formats fail rather than becoming an empty database. `daemon.log` contains startup diagnostics. No DSH 3.x database, session, settings or credential import is performed.

## Development verification

From the V4 root, `pnpm check` builds ESM `lib/` and declarations, performs strict type checks, runs keyless graph/native-protocol/SDK/bridge/process-restart tests, installs the built bundle through the published baseline CLI in a disposable home, boots that profile, and checks the homepage. Local socket tests require permission to listen on Unix/loopback sockets.

These tests use explicit fake native execution. They do not prove logged-in model execution or installed-GUI acceptance. No plugin is released or installed into the user's existing application by these commands. Sources remain in `incubator/` until a separately authorized release.
