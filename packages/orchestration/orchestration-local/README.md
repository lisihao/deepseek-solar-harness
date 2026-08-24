# Local Orchestration

English | [中文](README.zh.md)

This package provides `ctx.orchestrations` through an independent `dsh-orchestratord`. The disposable DSH plugin is a Unix-socket client; the daemon is the only SQLite writer and keeps accepted TaskGraphs running across DSH or Desktop restarts.

Packaged Desktop assigns `desktop-<SemVer>` as the local daemon build identity. The strict handshake rejects a daemon from another application build, asks it to shut down, preserves its SQLite state and artifacts, and then starts the installed build. Source development keeps the explicit `development` identity unless `DSH_BUILD_COMMIT` is supplied.

The daemon hosts the deterministic direct Intent Provider, basic Context Provider, owner-local content-addressed Capsule Registry, quota-aware model allocator, persistent Continuous Harness Provider, graph validator, conflict-aware Scheduler, immutable ExecutionPlan compiler, and a private physical-operator composition that dispatches Resident Claude Code or Codex turns. State lives under `<DSH_HOME>/orchestrations`; the socket is owner-only and the database uses WAL.

The Scheduler starts independent nodes up to the Graph's `maxParallel` bound without a phase-wide barrier. Dependencies, overlapping write/effect scopes, and the worker bound serialize only affected nodes; each wait reason is persisted with the run. Every attempt receives the built-in `context.clean-task` instruction Capsule and a fresh Resident lane, so a reused Codex or Claude Code host does not inherit an earlier native thread or fork the parent conversation history.

The allocator treats every reported allowance window as a simultaneous constraint, prioritizes qualified native-subscription pools, and uses metered API capacity only when the selected objective permits it. Its live capacity recommendation lowers the Scheduler ceiling below `maxParallel`; temporarily busy subscription capacity waits instead of silently spending paid API budget. Near-reset allowance is preferred while it remains usable.

For Resident RLM, the sealed ExecutionPlan contains both the low-tier worker allocation and the high-tier synthesis allocation. The daemon executes bounded branch levels on fresh native lanes, gives parallel leaves distinct solution-completeness, adversarial-failure, evidence-review, and alternative-design lenses, persists every branch as a content-addressed artifact, and then performs one synthesis turn. Synthesis receives bounded but materially complete leaf previews and must derive a coverage checklist instead of merely summarizing consensus. `maxDepth`, `maxChildren`, `maxTurns`, Graph parallelism, and provider capacity are mechanically enforced. The composite occupies one global Scheduler slot, so node-local recursion cannot become a competing TaskGraph or oversubscribe concurrent DAG work.

An automatic retry creates a new attempt only when the node policy names the returned error code and still has attempt budget. Resident response-stream disconnects arrive as retryable `RUNTIME_UNAVAILABLE`; an explicit native-product allowance failure arrives as `QUOTA_EXHAUSTED`. A permitted quota retry excludes the exhausted quota pool (or the exact offer when no pool identity exists) before resealing the next attempt. Malformed results and indeterminate commands are never replayed automatically. Graceful daemon shutdown ends accepted control connections before reporting closure, so a retiring build cannot remain alive behind a non-accepting socket.

While an attempt runs, the daemon copies bounded Resident progress phases into the orchestration event stream. Settlement keeps the complete operator result in its Evidence artifact and adds a bounded user-facing output preview to the terminal event. These projections expose execution and results without copying prompts, private reasoning, terminal screens, or product-local transcripts.

## Model Experience

Indirectly, through `@deepseek-ai/dsh-tool-orchestration`. The daemon stores compiler artifacts and returns bounded projections but adds no prompt section itself.

#### KV Cache effect

Each attempt receives one sealed Context Packet. Later graph, capsule, or capability generations produce a new packet instead of mutating a cached request.

## Known Limitations and Deferred Work

- Baseline capsule bindings support instruction and read-only resource/data references. Tool, MCP, secret, and executable Guard bindings fail closed until a Provider implements their enforcement.
- Claude Code and Codex support pre-dispatch and next-turn injection only; immediate in-turn checkpoint updates return `CAPABILITY_HOTSWAP_UNSUPPORTED`.
- RLM performs bounded recursion inside one sealed node. It is an execution strategy, not another product or global Scheduler; a crash without a provable composite terminal result becomes indeterminate and is never replayed automatically.
