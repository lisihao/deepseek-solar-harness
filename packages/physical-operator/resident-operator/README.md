# @deepseek-ai/dsh-resident-operator

English | [中文](README.zh.md)

Service Definition for durable resident physical-operator sessions. It owns the provider-neutral control vocabulary for execute, inspect, events, interrupt, reset, and explicit indeterminate resolution. Model work still enters through `ctx.physicalOperators`; only trusted adapters and management consumers use `ctx.residentOperators` directly.

The provider is the only state writer. A resident session is keyed by stable operator id plus canonical workspace, accepts one turn at a time, and never automatically replays an indeterminate command. This package owns no daemon, SQLite database, product SDK, scheduler, queue, tmux pane, TaskGraph, or research state.

## Contract

`execute()` accepts a caller-generated durable command id, operator id, workspace, content blocks, an optional bounded display-only task label, optional model/effort preference, and cancellation signal. The label is not the prompt and is exposed only so reconnecting user interfaces can identify work without persisting raw task content. The Provider resolves omitted profile fields against its live product catalog and locks the effective profile to the Session. An explicitly authorized retry may name one already-abandoned indeterminate command; it must use a new command id. `list()`, `inspect()`, `inspectTurn()`, `readEvents()`, `interrupt()`, `reset()`, and `resolveIndeterminate()` are management operations for trusted plugins and CLI consumers.

The lifecycle, health, reason, receipt, event, model catalog, effective profile, and artifact-reference types are provider-neutral. Session snapshots include the locked model/effort and selection source beside the latest durable turn summary and structured event, while `inspectTurn()` recovers the current or settled receipt result after a client restart. `reset` uses optimistic state revision and clears the native-session association and effective profile. It never deletes product history or artifacts.

## Model Experience

Indirectly, through the physical-operator Consumer. Resident results expose only a session id and state revision in addition to the ordinary bounded result.

#### KV Cache effect

No direct invalidation; the physical-operator Consumer owns its request schema.

## Known Limitations and Deferred Work

- Human write takeover and control leases are not part of protocol version 3.
- A durable Jobs projection and affinity scheduler are intentionally separate consumers.
- Version 3 is local-provider oriented; remote transports and Windows named pipes are deferred.
