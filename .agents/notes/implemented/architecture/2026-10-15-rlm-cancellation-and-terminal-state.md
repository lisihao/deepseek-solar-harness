# Agent Note: RLM cancellation scope, permanent delete, and terminal state

Status: implemented

English | [中文](2026-10-15-rlm-cancellation-and-terminal-state.zh.md)

## Problem

An RLM run is a root with children, grandchildren, and later turns, all under one TaskGraph attempt. Three rules decide what a stop, a delete, or a failed turn does to the rest of that tree, and the first implementation had none of them. Every API child and continuation shared the attempt's single abort signal, so interrupting or deleting one child cancelled the root and its siblings. Deleting a child only interrupted the executions that were active at that moment, so a queued message, a due heartbeat, or a dispatch that finished a moment later could start the deleted session again, and the root could report itself drained while it ran. A continuation that failed with partial output, or a later goal or Autonomous turn that succeeded, turned the run into `completed`.

## Decision

**Each execution has its own cancellation.** The first execution of a child follows the execution of the session that spawned it; a later turn of a session follows only the attempt. Cancelling the run or the root aborts the attempt signal, which every execution's signal derives from, so every execution receives the abort request. An execution that was already interrupted, such as one refused after a delete, can receive a second request. A request is not proof that the execution stopped, and the number of abort events is not guaranteed. Interrupting a session reaches that session and what it spawned. A continuation does not follow an earlier interrupted turn, because an interrupt is a request to stop one execution and must not poison the next turn of that session.

**Delete is permanent and separate from interrupt.** `deleteChild` closes the child's subtree and records its command before the first await. A session is closed when it is stopped or an ancestor deleted the chain to it. The state is persisted. Every admission point checks it where the work would start: the message pump, due heartbeat claims, spawn, cell execution, heartbeat creation, sending to or from the session, and `trackExecution`, which interrupts a dispatch that finishes after the delete, refuses it, and keeps it counted until its result settles. `drain` counts executions of deleted descendants that are still running and refused executions that have not ended, and ignores messages queued for a closed session. A rejected interrupt fails the delete command with the first error and leaves the subtree closed; the same command id returns that failure and a new delete command interrupts again. `interrupt` closes nothing.

**A result that is not `completed` ends the execution.** A continuation keeps its own stop reason (`error`, `aborted`, `max-tokens`, `refusal`) and partial output, and so does a root that stops without one. Active goals and Autonomous Mode check one predicate, `rlmResultSucceeded`, before they start another turn and return the result unchanged. The goal stays active and no recovery policy exists; resuming after a failure is an explicit future decision, not a loop branch. Autonomous Mode keeps throwing for `error` and `aborted`, so its retry behavior is unchanged.

`RlmChildExecutionResult.stopReason` is an optional field with the legal values above; without it the stop reason derives from `status`. The runtime state file does not store it; the runtime keeps the last continuation result in memory. The orchestration daemon already wrote the stop reason to the continuation artifact and to the `rlm.<source>.continuation.<status>` and `rlm.execution.settled` run events before this decision, and that is unchanged, so no new persisted field was added.

## Alternatives considered

**Keep one abort signal per attempt and filter by session.** Rejected because an aborted shared signal cannot be un-aborted for one session, so cancelling A would still abort B's in-flight call.

**Let a continuation inherit the interrupted turn of its parent.** Rejected because one interrupt would cancel every later turn of the session. The cost is that a continuation follows only the attempt, which the delete closure makes safe.

**Treat delete as a larger interrupt.** Rejected because a scan of active executions cannot stop work that is admitted afterwards; the closure has to be state that every admission reads.

**Forget a late execution once it was interrupted.** Rejected because an interrupt request does not prove the execution stopped: the root would report its children finished while the execution runs, and no later command could reach it.

**Roll back a delete whose interrupt failed.** Rejected because an interrupt that was delivered cannot be undone. The command records the failure and keeps the subtree closed; whatever is still running stays visible through `drain`.

**Let a goal or Autonomous Mode recover from a failed turn.** Rejected for now: a recovery policy needs its own record of the failure and the recovery, and it must not hide in the continuation loop.

## Consequences

A stop or delete reaches exactly the intended executions, a deleted subtree stays quiet across restarts, and a run no longer turns partial failure into success. The costs: a root that ends in `max-tokens` or `refusal` now fails the run even when a goal could have continued it, and a delete does not interrupt a cell that is already running in the subtree (its spawn, send, and heartbeat calls are refused). A failed interrupt of a deleted subtree has no automatic retry, and the runtime does not prove that an interrupted execution has stopped. Registered and refused executions live in memory, so a restart loses them; reconciling a Resident turn that outlives a daemon restart is not covered.

## Testing

`rlm-runtime-local` and `orchestration-local` tests drive the real daemon, REPL bridge, and model-worker path with keyless fakes for the delete cases (queued message, due heartbeat, late dispatch, restart, failed interrupt, drain) and for goal and Autonomous Mode after a failed turn. The keyless `prime-rlm-delete` snapshot boots the runtime through the production app boot and YAML Loader. The keyless `prime-rlm-terminal` snapshot boots through the same Loader with `autoStart`, so the client starts the production daemon and Resident daemon; only the model provider is replaced, by a loopback server behind `DEEPSEEK_BASE_URL`. The production DeepSeek worker never yields `refusal`, so that snapshot uses `max-tokens`; the `refusal` and `error` cases stay covered by the `daemon.spec` tests. Dynamic gaps: interrupting a later turn of a child, the Resident failure path, and the Autonomous round after a failed message continuation.
