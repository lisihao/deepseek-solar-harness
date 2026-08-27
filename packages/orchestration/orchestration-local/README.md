# Local Orchestration

English | [中文](README.zh.md)

This package provides `ctx.orchestrations` through an independent `dsh-orchestratord`. The disposable DSH plugin is a Unix-socket client; the daemon is the only SQLite writer and keeps accepted TaskGraphs running across DSH or Desktop restarts.

Packaged Desktop assigns `desktop-<SemVer>` as the local daemon build identity. The strict handshake rejects a daemon from another application build, asks it to shut down, preserves its SQLite state and artifacts, and then starts the installed build. Source development keeps the explicit `development` identity unless `DSH_BUILD_COMMIT` is supplied.

The daemon hosts the deterministic direct Intent Provider, basic Context Provider, owner-local content-addressed Capsule Registry, quota-aware model allocator, persistent Continuous Harness Provider, graph validator, conflict-aware Scheduler, immutable ExecutionPlan compiler, and a private physical-operator composition that dispatches Resident Claude Code or Codex turns. State lives under `<DSH_HOME>/orchestrations`; the socket is owner-only and the database uses WAL.

The Scheduler starts independent nodes up to the Graph's `maxParallel` bound without a phase-wide barrier. Dependencies, overlapping write/effect scopes, and the worker bound serialize only affected nodes; each wait reason is persisted with the run. Every attempt receives the built-in `context.clean-task` instruction Capsule and a fresh Resident lane, so a reused Codex or Claude Code host does not inherit an earlier native thread or fork the parent conversation history.

The allocator treats every reported allowance window as a simultaneous constraint, prioritizes qualified native-subscription pools, and uses metered API capacity only when the selected objective permits it. Its live capacity recommendation lowers the Scheduler ceiling below `maxParallel`; temporarily busy subscription capacity waits instead of silently spending paid API budget. Near-reset allowance is preferred while it remains usable.

An optional versioned `remote-operators.json` catalog projects Resident capacity from multiple DSH Product Servers into the same physical-operator seam. Every projected identity is namespaced as `remote.<server>.<operator>`, so quota, concurrency, Trace, and sealed ExecutionPlan ownership stay attributable to one Server. Qualification failure on one member marks only that member unavailable and does not block healthy local or remote Providers. A transient disconnect after a durable turn is accepted keeps polling the same Server and never replays the command elsewhere; loss of the admission receipt becomes `COMMAND_INDETERMINATE` because a second Server cannot prove that the first one rejected the command.

An optional versioned `cluster.json` gives a fixed Product Server membership one TaskGraph authority. Each member persists its own term, vote, leader lease, and replicated logical orchestration state. A node may mutate Scheduler state only while it holds a non-expired majority lease. Before any sealed attempt reaches a Resident or model-worker Provider, the leader renews that lease and brings enough followers to its current `commitIndex`; only then can the external product call begin. A follower never replays an accepted command and rejects stale-term replicas. Desktop descriptions expose only the bounded leader projection required for multi-Server ingress selection; vote, heartbeat, export, and install remain admin-only Remote Sync operations.

Every member must use the same `cluster.json` membership and reach its peers through authenticated loopback tunnels. First release replication sends a complete logical snapshot, verifies every content-addressed artifact digest, and installs it transactionally while preserving the receiver's local election identity. The full snapshot is intentionally bounded by the Remote Sync request limit; incremental state transfer is deferred for very large orchestration stores.

For Resident RLM, the sealed ExecutionPlan contains a high-tier root allocation and a subscription-first low-tier default child allocation. The root model uses the persistent `typescript_repl` namespace to inspect programmable context, admit asynchronous recursive children, receive explicit family messages, and continue durable goals or heartbeats. The model chooses the child topology at runtime; DSH only enforces `maxDepth`, `maxChildren`, `maxTurns`, Graph parallelism, and provider capacity. Every child and continuation has a stable Receipt and a content-addressed result artifact. The composite occupies one global Scheduler slot, so node-local recursion cannot become a competing TaskGraph or oversubscribe concurrent DAG work.

Prime-compatible Autonomous Mode is an optional policy around that same sealed RLM lane. After each settled root or continuation turn, the daemon durably accounts non-cached input, output, and cache-write tokens, evaluates host quality gates before limits, and either reuses the same native Session for one bounded continuation or settles with an explicit reason. A passing gate is the only successful terminal condition when gates are configured; exhausting continuations, turns, tokens, elapsed time, or gate retries never becomes apparent success. Failed unchanged work consumes another retry without rerunning the command. Gate children inherit the shared credential-scrubbed environment, are tree-terminated on timeout or cancellation, and reach process quiescence before the attempt continues. This loop persists in the orchestration database and remains subordinate to the one TaskGraph Scheduler.

Prime-compatible automatic refinement is root-only and runs at a real turn boundary after 25 assistant turns or a recorded compaction checkpoint, with a 20-minute cooldown. A native-subscription model first reviews whether a durable lesson exists and only then plans independently applicable Harness edits. Failed or crash-uncertain review phases are not replayed automatically, and the background path does not silently fall back to a metered API. Executable TypeScript Skills are resolved from managed aliases to trusted `skillProviderModules`; model-supplied package paths are never imported.

An automatic retry creates a new attempt only when the node policy names the returned error code and still has attempt budget. Resident response-stream disconnects arrive as retryable `RUNTIME_UNAVAILABLE`; an explicit native-product allowance failure arrives as `QUOTA_EXHAUSTED`. A permitted quota retry excludes the exhausted quota pool (or the exact offer when no pool identity exists) before resealing the next attempt. Malformed results and indeterminate commands are never replayed automatically. Graceful daemon shutdown ends accepted control connections before reporting closure, so a retiring build cannot remain alive behind a non-accepting socket.

While an attempt runs, the daemon copies bounded Resident progress phases into the orchestration event stream. Settlement keeps the complete operator result in its Evidence artifact and adds a bounded user-facing output preview to the terminal event. Protocol version 4 includes digest-verified `artifact.read`, schema-v3 durable Autonomous state, and the term-fenced cluster control methods, so an authenticated projection can load a retained Evidence result on demand without copying prompts, private reasoning, terminal screens, or product-local transcripts into the event stream.

## Model Experience

Indirectly, through `@deepseek-ai/dsh-tool-orchestration`. The daemon stores compiler artifacts and returns bounded projections but adds no prompt section itself.

#### KV Cache effect

Each attempt receives one sealed Context Packet. Later graph, capsule, or capability generations produce a new packet instead of mutating a cached request.

## Known Limitations and Deferred Work

- Baseline capsule bindings support instruction and read-only resource/data references. Tool, MCP, secret, and executable Guard bindings fail closed until a Provider implements their enforcement.
- Claude Code and Codex support pre-dispatch and next-turn injection only; immediate in-turn checkpoint updates return `CAPABILITY_HOTSWAP_UNSUPPORTED`.
- RLM performs bounded recursion inside one sealed node. It is an execution strategy, not another product or global Scheduler; a crash without a provable composite terminal result becomes indeterminate and is never replayed automatically.
- Autonomous Mode is opt-in and currently uses host shell quality gates; it does not infer a task-specific end condition when no gate is configured.
- The base bundle contains no production Skill catalog. Deployments install trusted Skill Provider plugins explicitly; a managed entry whose Provider is absent remains visible but unavailable.
- Remote members currently execute read-only/result-producing nodes against an already available Server workspace. Cross-machine Git worktree synchronization remains a separate layer and is not implied by remote Provider discovery or Scheduler-state replication.
- Cluster membership is fixed configuration in the first release. Membership changes and incremental replicas require an explicit future protocol revision; a two-member cluster cannot continue scheduling after either member fails because it no longer has a majority.
