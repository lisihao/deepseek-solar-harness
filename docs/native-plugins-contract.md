# Native collaboration and durable execution

Status: implementation authorized by 昊哥 on 2026-10-19. This supersedes the documentation-only and deferred-first-plugin wording for these two plugins only. It does not authorize installing into the existing app, paid model probes, release tags, market publication, upstream messages, or recurring development automation.

## Ownership and affected paths

- `incubator/native-collaboration/`: one bundle for self-contained handoff, cooperation and model/executor allocation policy using advertised native catalogs and supported explicit selections.
- `incubator/native-resident/`: one bundle owning native Drivers, persisted sessions and lanes, bidirectional DSH/native tool integration, a durable TaskGraph, and the only local graph scheduler. Its modules are internal to this plugin, not a V4 core package.
- Root build/test files and `tools/`: shared development infrastructure; root market workspace globs still include only `plugins/*`.
- Integration plan, extraction list, homepage, and this document: updated with actual source and verification status.

The coordinator owns the shared contract, package assembly, integration tests, Git, and delivery. Independent workers have exclusive ownership of the collaboration directory, Resident `src/core` and core tests, or Resident `src/drivers` and driver tests. No competing writers modify these paths.

## Public integration boundary

`native-resident/src/contracts.ts` is the versioned contract. The Resident bundle publishes `solarNativeResident` through Cordis's public service API. Collaboration uses it optionally; ordinary one-shot tasks keep using official `ctx.subagents.startActivation()` with the actual calling Agent. No private provider maps, patched native providers, custom upstream session events, or renamed third-party adapters are permitted.

The Resident service talks to its own packaged Node daemon over an owner-only Unix socket. Only the daemon owns the SQLite database, graph scheduling, execution receipts, native-session mapping, and native drivers. Disposing a client detaches it; explicitly cancelling a graph interrupts active tasks. Admission remains durable across client disconnects. An independent daemon is plugin-owned code; no installed-app file is modified.

## Observable acceptance

1. Both built bundles register and dispose correctly in the published rc.2 host and install in a scratch profile using the actual baseline CLI, without API keys or model requests.
2. Collaboration preserves chosen executor, cwd, main model, input scope, expected output and verification instructions. Unsupported overrides and missing Resident service produce explicit errors.
3. The graph validates IDs/dependencies/DAGs. Only successful dependencies release a node. Failure blocks dependents. Future `notBefore` times, bounded parallelism, native-session reuse and overlapping read/write scopes govern admission. One scheduler owns all graphs, including cross-graph conflicts.
4. Before a native effect, persist its immutable command identity and attempt. Duplicate identical submission returns the original admission; different input with the same command ID conflicts. A crash leaves an in-flight command indeterminate rather than replaying it. Recovery can resume settled native sessions; uncertain native effects require an explicit owner decision.
5. Pause stops new admissions; resume continues eligible nodes; cancel stops waiting nodes and requests interruption of active native work. Active work remains `cancelling` until a confirmed terminal result; an unconfirmed interruption becomes `indeterminate` and retains its lane/scope fence. Revision checks reject stale controls. Retries require explicit known error codes and bounds; unknown effects never enter automatic retry.
6. Reopen a real persistent database and restart the actual packaged daemon. Observe queued/scheduled graphs, native session identities and results survive; no duplicate dispatch occurs. Reject unknown persisted format/protocol versions.
7. Keyless tests use injected native protocol/SDK doubles and real local processes/files. They are not proof of logged-in native model behavior. Real-provider and installed-GUI acceptance remain separately recorded.

## Scope of scheduling and recovery

Scheduling includes DAG dependencies, future absolute eligibility, capacity, workspace conflicts, pause/resume/cancel, and bounded explicit retry. Collaboration owns allocation policy; Resident owns admission and execution. Allocation uses advertised models or explicit native defaults and never changes the main Agent model or silently falls back to another account. No calendar/cron service or periodic production task is activated. Distributed leaders, remote members, automatic account switching, and legacy database import are outside this pair's implementation. 昊哥 explicitly excluded RLM and will commission it separately.

Native tool integration must preserve native tools while routing bridged DSH calls through the original live Agent's public Tool Runtime, guards and logging. A bridge is an explicit runtime capability; endpoint secrets are not graph data. Missing or disconnected DSH ownership must fail explicitly and must never bypass permissions. Durable tool-call receipts prevent replay of an uncertain side effect. Native session lanes and selected profiles remain stable; conflicting continuation requests are serialized or rejected.

The inspected official native providers are one-shot, so Resident calls the native products' public protocols/SDK rather than trying to resume an official subagent activation. Native credentials stay owned by each product. Plugin-owned records live only under `$DSH_HOME/solar/native-resident/`; native products retain ownership of their own authentication and transcript locations. No tokens or native histories are copied into Solar storage.

Daemon survival is distinct from machine-restart execution survival. An unconfirmed in-flight task is fenced and reported as indeterminate; ordinary queued work can be scheduled after recovery. The plugin does not claim to keep tools supplied by a stopped Harness Host available. UI disconnect, explicit interruption, service shutdown and uninstall have separate documented meanings.

## Delivery boundary

This is L3 verification because it introduces persistence. At the stable boundary run build, strict type checks, focused native/graph/lifecycle tests, built-bundle scratch-profile tests, and homepage checks once. Record all checks as run/not run and their actual outcomes. Existing app/profile installation remains outside this source-development authorization. There is no version bump, `.app`, release tag or market index publication.
