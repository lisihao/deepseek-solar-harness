# Agent Note: Prime Agent compatible TypeScript runtime

Status: proposed

English | [中文](2026-08-24-prime-agent-compatible-typescript-runtime.zh.md)

## Problem

DSH currently uses the name RLM for a sealed scheduling policy that fans out a fixed number of Resident turns and synthesizes their outputs. That implementation is useful, but it is not the Prime Agent v0.8.0 runtime: the model has no persistent programming namespace, cannot call an asynchronous `rlm(...)` function, cannot exchange family-scoped messages, and cannot evolve prompts, memories, skills, or subagents through a continual harness.

The user requested a faithful TypeScript implementation of the original Prime Agent design. Fidelity is defined by observable contracts, not by copying Python syntax or replacing DSH's plugin architecture.

## Primary-source baseline

The compatibility baseline is Prime Agent tag `v0.8.0`, commit `8d7deeab5861bf9d77bde3d8511046a5c799818d`, under its MIT license. Moving `main` is not a contract source. The source-of-truth files are:

- `packages/coding-agent/docs/rlm.md` and `docs/rlm-runtime.md`;
- `prime-agent-runtime/src/rlm/harness.py` and `test/test_harness.py`;
- `packages/coding-agent/src/core/refinement/refinement.ts`;
- `docs/daemon.md`, `docs/long-running-agents.md`, and `docs/architecture.md`;
- `packages/coding-agent/test/rlm-ledger.test.ts`.

## Proposal

Add a capability seam named `ctx.rlmRuntime`. Keep `ctx.rlmStrategy` as policy only. The global DSH TaskGraph remains the sole run-level scheduler; one sealed TaskGraph node may opt into a node-local RLM tree owned by the RLM runtime.

The model-facing programming surface is one `typescript_repl` tool backed by a persistent Node process. The TypeScript kernel preloads `context`, `rlm`, `agentMessage`, `harness`, `goal`, and `compact`. This is the user-authorized platform substitution for Prime's IPython kernel; all lifecycle, admission, messaging, recovery, and harness contracts remain equivalent.

## Explicit fidelity modes

The user-facing modes have distinct sealed semantics. Explicit `RLM` selects `prime-strict`: a child without overrides inherits the exact parent operator/model, reasoning profile, model-tool bridge, managed Skill catalog, retry authority, and sealed capability/context references. Prime v0.8.0's `rlm(task, options)` surface accepts only `name`, `model`, and `thinking`; unknown option names fail before child admission. `Smart Auto` selects `dsh-optimized` and may seal a lower-cost qualified child model. `Standard` does not create an RLM root. Cost optimization therefore cannot silently alter the semantics of an explicitly requested Prime-compatible run.

## Capability seam and package topology

- `@deepseek-ai/dsh-rlm-runtime`: Service Definition, versioned protocol types, errors, and `ctx.rlmRuntime`.
- `@deepseek-ai/dsh-rlm-runtime-local`: owner-local Provider, persistent TypeScript kernels, child registry, family messaging, receipts, snapshots, and recovery.
- `@deepseek-ai/dsh-rlm-strategy`: unchanged policy seam that decides whether a sealed node may use RLM and supplies limits.
- `@deepseek-ai/dsh-continual-harness` and `-local`: extended in place with prompt, memory, skill, and subagent CRUD, version history, two-phase refinement, and rollback.
- `@deepseek-ai/dsh-orchestration-local`: Consumer that starts one node-local RLM root after sealing an ExecutionPlan. It does not implement the RLM tree itself.
- Resident Claude Code and Codex Providers: Consumers of the model-facing tool adapter. Claude uses an in-process Agent SDK MCP server; Codex uses app-server `thread/start.dynamicTools` and `item/tool/call`.

Provider and Consumer packages depend only on the Service Definition. The local Provider is replaceable, and disabling it leaves ordinary TaskGraph and ephemeral/Resident physical operators unchanged.

## Authority and process mapping

| Prime authority | DSH TypeScript authority |
| --- | --- |
| daemon supervisor and worker | `dsh-orchestratord` supervises node-local RLM roots; `dsh-resident-operatord` retains native Claude/Codex sessions |
| Python IPython kernel | one persistent owner-local Node TypeScript kernel per RLM session |
| TypeScript Host | `@deepseek-ai/dsh-rlm-runtime-local` |
| child AgentSession | Resident physical-operator turn with a distinct child session identity |
| RLM ledger/session tree | RLM Provider store and append-only events, linked to the sealed TaskGraph attempt |
| continual harness store | `@deepseek-ai/dsh-continual-harness-local` |
| Agents view | DSH Desktop RLM tree, messages, kernel, goals, and harness generation projection |

The TypeScript kernel is an isolation and lifecycle boundary, not a security sandbox. It runs with the same operating-system permissions as the owning daemon. DSH scope/effect admission occurs before dispatch.

## Fidelity matrix

| Prime v0.8.0 contract | Required DSH behavior |
| --- | --- |
| persistent model-facing IPython | persistent model-facing TypeScript REPL; variables survive turns and compaction |
| `rlm(...)` admits immediately | returns `{ rlmChildId, name, sessionDir, model }`; never returns the child's answer |
| asynchronous children | child turns execute concurrently up to the sealed budget and report separately |
| parent-scoped registry | names are unique within a parent; list/inspect survive kernel and daemon restart |
| bounded recursion | enforce sealed max depth/children/turns before child admission |
| parent execution inheritance | explicit RLM inherits model, thinking, tools, managed skills, retry authority, and sealed capability context; unknown options fail |
| A2A nuclear-family messaging | parent, sibling, and direct-child targets only; `auto`, `steer`, and `follow_up` modes |
| child response via message/file | no hidden return channel; messages and content-addressed artifacts are explicit |
| compaction preserves program state | model history may compact while kernel namespace and child registry remain |
| best-effort variable snapshot | serializable variables restore independently; failures are named and do not discard other variables |
| prompt/memory/skill/subagent CRUD | session-local by default, optional workspace-global scope, versioned entries and references |
| `/refine` background plan + boundary apply | immutable base prompt; evidence-backed delta is planned separately and applied only at a turn boundary |
| refinement history and rollback | every applied delta records before/after/version and can roll back explicitly |
| daemon continuity | Desktop/client disconnect does not stop accepted work; reconnect uses snapshot plus cursor events |
| command uncertainty | idempotent command receipts; uncertain side effects are never automatically replayed |
| goals and autonomous continuation | persistent goal, bounded continuation budget, heartbeat/schedule trigger, explicit stop/block states |
| usage attribution | every child and refinement records provider/model/subscription-or-API/cost usage against its parent |

No implementation may be described as `Prime compatible` until every row has an end-to-end acceptance test. Partial rows must be labeled `compatible subset`.

## Runtime protocol

The Service Definition exposes:

- root lifecycle: `create`, `list`, `inspect`, `executeCell`, `compact`, `interrupt`, `reset`, `readEvents`;
- child lifecycle: `spawn`, `listChildren`, `inspectChild`, `deleteChild`;
- messaging: `sendMessage`, `readMessages`;
- goals and automation: `setGoal`, `getGoal`, `continueGoal`, `schedule`, `heartbeat`;
- recovery: `reconcile`, `resolveIndeterminate`.

Each mutating request carries a caller-generated `commandId`, canonical request hash, expected revision where applicable, and a sealed TaskGraph execution identity. Accepted work cannot be modified in place. A failed retry uses a new command identity; an indeterminate command requires explicit resolution.

The kernel serializes ordinary REPL cells. Child calls are asynchronous and may run concurrently. The host injects results into the parent's event/message stream, never into the synchronous return value of `rlm(...)`.

## Continuous Harness semantics

Harness entries have kinds `prompt`, `memory`, `skill`, and `subagent`; scope is `session` by default or `workspace` when explicitly requested. Each entry carries an ID, version, text or artifact reference, optional arguments and source path, provenance, and timestamps. Update and delete are optimistic-concurrency operations.

Refinement has two phases:

1. `planRefinement` reads bounded evidence and produces a proposed delta without mutating the active harness.
2. `applyRefinement` verifies the expected generation and applies the delta at a turn boundary.

The immutable base system prompt cannot be overwritten. Rollback creates a new generation that restores an earlier effective entry set; it does not rewrite history.

## Alternatives considered

- Keep the current `Promise.all` branch fan-out and rename it Prime RLM: rejected because it lacks the programming surface, asynchronous admission, family messaging, persistence, and harness evolution.
- Use prompt-encoded pseudo tool calls for Claude/Codex: rejected because both products expose genuine host tools (Agent SDK MCP and app-server dynamic tools).
- Copy Prime's Python/IPython runtime into DSH: rejected because the user explicitly requested a TypeScript implementation and DSH already owns Node daemon lifecycle and plugin seams.
- Let the RLM runtime create global TaskGraph nodes: rejected because it would create two global schedulers and duplicate scope/effect authority.

## Acceptance criteria

- A model executes two TypeScript cells around a DSH restart and observes the same namespace variable.
- `rlm(...)` returns only an admission handle while two child results arrive later through messages.
- Parent, sibling, and child messaging succeeds; a non-family target fails closed.
- Child names, depth, budget, receipts, and late generation results are fenced across daemon restart.
- Harness CRUD, local/global scope, two-phase refinement, immutable base prompt, history, and rollback pass end to end.
- Compaction preserves kernel state; a deliberately unserializable variable degrades independently.
- A crash after an external child is accepted becomes settled or indeterminate and never duplicates the child call.
- The same RLM scenario runs through DSH-native DeepSeek, Claude Code, and Codex host-tool integrations.
- Ordinary non-RLM TaskGraph execution remains unchanged when the RLM Bundle is disabled.
- Offline fixtures cover the full matrix; only one final minimal real-subscription blind test is run when all inputs are stable.

## Risks

- Codex dynamic tools are experimental and available only at `thread/start`; the Provider must pin the qualified schema and start a fresh native thread when the tool surface changes.
- Claude and Codex native sessions are authoritative for their conversation contents, while DSH owns RLM topology and receipts. Recovery must reconcile both without copying full product history.
- A TypeScript REPL that merely evaluates isolated functions is not persistent enough. The implementation must prove lexical state across cells and restarts.
- Automatic harness refinement can amplify bad evidence. Deltas remain small, evidence-linked, bounded, reviewable, and reversible.
