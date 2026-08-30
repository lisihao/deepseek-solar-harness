# Agent Note: Persistent TaskGraph compilation pipeline and monotonic capability binding

Status: implemented

English | [中文](2026-08-17-persistent-taskgraph-compilation-pipeline.zh.md)

## Problem

The existing workflow engine executes foreground model-written scripts, the jobs registry is process-local, and Resident Physical Operators persist native product continuity without owning a TaskGraph. Complex work therefore lacks one durable authority for dependency readiness, conflicting effects, approval, retries, evidence, and recovery. Folding planning, knowledge retrieval, capability discovery, and dispatch into one scheduler would make later Intent or Context Compiler providers able to mutate execution state and would create another authority beside the scheduler.

## Decision

`dsh-orchestratord` is the sole writer for durable orchestration state. It persists certified logical graphs, node state, attempts, evidence references, immutable compilation artifacts, and append-only events in one SQLite WAL database under the Harness home. A disposable `ctx.orchestrations` Provider connects over owner-only local IPC (Unix socket on POSIX, local named pipe on Windows), so DSH and Desktop restarts do not stop accepted runs. A POSIX control path that exceeds the macOS Unix-socket byte limit maps to the same deterministic owner-specific temporary-address contract as Resident execution; only the socket moves, while orchestration state remains under the Harness home.

The packaged Desktop assigns `desktop-<SemVer>` as the daemon build identity. The client rejects a protocol, schema, method-set, or build mismatch with `ORCHESTRATION_VERSION_MISMATCH`; auto-start drains that incompatible daemon before starting the installed build against the same persistent state. Development composition keeps the explicit `development` identity unless the caller supplies `DSH_BUILD_COMMIT`.

Run compilation is an ordered, immutable pipeline: raw request to `IntentIRV1`, requirement artifact, logical TaskGraph, validation, Plan Certificate, and Run. A ready node follows capability resolution, context compilation, operator selection, ExecutionPlan sealing, approval, and dispatch. The `ctx.intentCompiler`, `ctx.contextCompiler`, and `ctx.capabilityCapsules` services are independent Provider seams; none can create a Run, mutate a Graph, or dispatch an operator.

The certified Graph is the maximum authority for each node. Late-bound capsules may implement or reduce its capability, effect, scope, and approved-secret budgets but cannot enlarge them. A required enlargement returns the run to approval with a new graph revision and certificate. Each accepted physical attempt has a new stable `orch:<run>:<node>:<attempt>` execution identity and immutable `NodeExecutionPlanV1`; retries never rewrite an accepted attempt, and an indeterminate receipt never auto-replays.

Current product Providers bind capsules before dispatch and at the next turn. The capability-update vocabulary includes generations and checkpoint states, but Claude Code and Codex do not claim in-turn checkpoint support. Events and results are fenced by attempt and capability generation so a late older result cannot settle newer execution.

AI4Research remains a read-only source of generic scheduling lessons, not a runtime dependency or second state authority. Its research workflows, Sprint vocabulary, Evidence schemas, tmux transport, and file-backed graph state do not enter these packages.

## Alternatives considered

- **Extend the workflow engine** — its model-written foreground script and process-owned child lifecycle do not provide durable graph revisions, receipts, or crash reconciliation.
- **Use the jobs registry as the scheduler** — jobs expose generic background execution but do not own dependency, scope, effect, approval, or evidence semantics and do not survive a process restart through the current local Provider.
- **Put compiler hooks inside the scheduler** — arbitrary hooks could mutate live state and make compiler upgrades change accepted attempts. Versioned artifacts and capability seams preserve reproducibility instead.
- **Use `dynamicCordisRunner` for capsules** — model-generated process-memory packages have neither durable catalog identity nor certified authority bounds.
- **Copy AI4Research's scheduler and tmux carrier** — that would copy research-specific state and establish two TaskGraph authorities. Only generic algorithms and golden cases inform the DSH implementation.

## Consequences

The daemon and artifact store add a local process and forward-only state schema, while users gain restart-continuous graph execution and a single auditable state authority. Each attempt performs more compilation work, but its exact capability, context, operator, approval, and verification inputs become content-verifiable. Advanced Intent, Context, and Capsule providers can replace baseline providers without changing Scheduler state transitions. True in-turn capability changes remain unavailable until a physical Provider supplies a stable checkpoint and generation-fenced continuation.
