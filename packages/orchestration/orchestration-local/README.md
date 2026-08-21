# Local Orchestration

English | [中文](README.zh.md)

This package provides `ctx.orchestrations` through an independent `dsh-orchestratord`. The disposable DSH plugin is a Unix-socket client; the daemon is the only SQLite writer and keeps accepted TaskGraphs running across DSH or Desktop restarts.

The daemon hosts the deterministic direct Intent Provider, basic Context Provider, owner-local content-addressed Capsule Registry, graph validator, conflict-aware Scheduler, immutable ExecutionPlan compiler, and a private physical-operator composition that dispatches only Resident Claude Code or Codex turns. State lives under `<DSH_HOME>/orchestrations`; the socket is owner-only and the database uses WAL.

The Scheduler starts independent nodes up to the Graph's `maxParallel` bound without a phase-wide barrier. Dependencies, overlapping write/effect scopes, and the worker bound serialize only affected nodes; each wait reason is persisted with the run. Every attempt receives the built-in `context.clean-task` instruction Capsule and a fresh Resident lane, so a reused Codex or Claude Code host does not inherit an earlier native thread or fork the parent conversation history.

While an attempt runs, the daemon copies bounded Resident progress phases into the orchestration event stream. Settlement keeps the complete operator result in its Evidence artifact and adds a bounded user-facing output preview to the terminal event. These projections expose execution and results without copying prompts, private reasoning, terminal screens, or product-local transcripts.

## Model Experience

Indirectly, through `@deepseek-ai/dsh-tool-orchestration`. The daemon stores compiler artifacts and returns bounded projections but adds no prompt section itself.

#### KV Cache effect

Each attempt receives one sealed Context Packet. Later graph, capsule, or capability generations produce a new packet instead of mutating a cached request.

## Known Limitations and Deferred Work

- Baseline capsule bindings support instruction and read-only resource/data references. Tool, MCP, secret, and executable Guard bindings fail closed until a Provider implements their enforcement.
- Claude Code and Codex support pre-dispatch and next-turn injection only; immediate in-turn checkpoint updates return `CAPABILITY_HOTSWAP_UNSUPPORTED`.
