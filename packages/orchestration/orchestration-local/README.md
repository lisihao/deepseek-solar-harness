# Local Orchestration

English | [中文](README.zh.md)

This package provides `ctx.orchestrations` through an independent `dsh-orchestratord`. The disposable DSH plugin is a Unix-socket client; the daemon is the only SQLite writer and keeps accepted TaskGraphs running across DSH or Desktop restarts.

The daemon hosts the deterministic direct Intent Provider, basic Context Provider, owner-local content-addressed Capsule Registry, graph validator, conflict-aware Scheduler, immutable ExecutionPlan compiler, and a private physical-operator composition that dispatches only Resident Claude Code or Codex turns. State lives under `<DSH_HOME>/orchestrations`; the socket is owner-only and the database uses WAL.

## Model Experience

Indirectly, through `@deepseek-ai/dsh-tool-orchestration`. The daemon stores compiler artifacts and returns bounded projections but adds no prompt section itself.

#### KV Cache effect

Each attempt receives one sealed Context Packet. Later graph, capsule, or capability generations produce a new packet instead of mutating a cached request.

## Known Limitations and Deferred Work

- Baseline capsule bindings support instruction and read-only resource/data references. Tool, MCP, secret, and executable Guard bindings fail closed until a Provider implements their enforcement.
- Claude Code and Codex support pre-dispatch and next-turn injection only; immediate in-turn checkpoint updates return `CAPABILITY_HOTSWAP_UNSUPPORTED`.
