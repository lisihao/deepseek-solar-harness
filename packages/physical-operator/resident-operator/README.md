# @deepseek-ai/dsh-resident-operator

English | [中文](README.zh.md)

Service Definition for durable resident physical-operator sessions. It owns the provider-neutral control vocabulary for qualification, explicit owner-initiated authentication, execute, inspect, events, interrupt, native history compaction, reset, and explicit indeterminate resolution. Model work still enters through `ctx.physicalOperators`; only trusted adapters and management consumers use `ctx.residentOperators` directly.

The provider is the only state writer. A resident session is keyed by stable operator id, canonical workspace, and caller-owned lane, accepts one turn at a time, and never automatically replays an indeterminate command. Separate lanes can execute concurrently without sharing one native product thread. This package owns no daemon, SQLite database, product SDK, scheduler, queue, tmux pane, TaskGraph, or research state.

## Contract

`execute()` accepts a caller-generated durable command id, operator id, workspace, lane id, content blocks, an optional bounded display-only task label, optional model/effort preference, an optional DSH-assembled system prompt, an optional sealed model-tool bridge, an optional sealed native-tool policy, and cancellation signal. The label is not the prompt and is exposed only so reconnecting user interfaces can identify work without persisting raw task content. The system prompt and bridge let a qualified native-subscription product serve as the current DSH Agent's first-class model while DSH remains the owner of tool scope, guards, approval, logging, and plugin composition. A disabled native-tool policy is part of the canonical Receipt hash and cannot be changed by replay; exposing a model-tool bridge at the same time is invalid. The Provider resolves omitted profile fields against its live product catalog and locks the effective profile to the Session. An explicitly authorized retry may name one already-abandoned indeterminate command; it must use a new command id. `authenticate()` starts a product-owned login flow only after an explicit trusted owner action; it never grants DSH access to the product token. `list()`, `inspect()`, `inspectTurn()`, `readEvents()`, `interrupt()`, `compact()`, `reset()`, and `resolveIndeterminate()` are management operations for trusted plugins and CLI consumers.

The lifecycle, health, reason, receipt, event, model catalog, effective profile, and artifact-reference types are provider-neutral. Session snapshots include the locked model/effort and selection source beside the latest durable turn summary and structured event, while `inspectTurn()` recovers the current or settled receipt result after a client restart. `compact()` uses an independent durable command receipt plus optimistic state revision, requires an idle Session with native history, and preserves its native identity. An uncertain post-dispatch outcome becomes `COMMAND_INDETERMINATE` and cannot be replayed automatically. `reset` clears the native-session association and effective profile. Neither operation deletes product history or artifacts.

Drivers may additionally emit `ResidentObservation` through the execution callback. The only persistable variants are public output, tool start/completion, approval required, and usage updates; phase remains a separate coarse progress signal. The contract deliberately has no thinking, raw prompt, system prompt, tool input/output, stderr, environment, credential, or full-transcript variant.

## Model Experience

Indirectly, through the physical-operator Consumer. Resident results expose only a session id and state revision in addition to the ordinary bounded result.

#### KV Cache effect

No direct invalidation; the physical-operator Consumer owns its request schema.

## Known Limitations and Deferred Work

- Protocol version 11 adds sealed native-tool policy; human write takeover and control leases remain deferred.
- A durable Jobs projection and affinity scheduler are intentionally separate consumers.
- Version 11 is local-provider oriented; remote transports and Windows named pipes are deferred.
