# Agent Note: Codex turn correlation and a start of unknown outcome

Status: implemented

English | [中文](2026-10-14-codex-turn-correlation-and-unknown-start.zh.md)

## Problem

A resident Codex turn failed with `INVALID_RESULT: subagent-codex: app-server referenced conflicting turns` seconds after it started. The [wire](../../../../packages/subagent/subagent-codex/README.md) took the turn id of the first notification that arrived before the `turn/start` response as the run's turn, and failed when another id followed or the response named a different one. The Resident driver reaches a long-lived Codex app-server, so a notification can belong to another turn of the same thread: an unfinished turn of an earlier connection, or one the server starts itself.

The failure then made things worse. The command was settled as failed, which released the Session, although the native turn had been started and ran for another minute and a half, so the same work could be dispatched again while the first run was still executing. The `reasoning` progress phase had also been reported before `turn/start`, so an "executing" status proved nothing.

## Decision

The `turn/start` response names the run's turn. Notifications that arrive before it are held (at most 512) and read only if they carry that turn id; another turn's notifications are ignored. A tool call or approval that arrives before the response waits for it and is answered only when it names the responded turn; a request for another turn is rejected without failing the run, and a request for another thread still fails it.

A `turn/start` that was sent without a valid response (stream closed, malformed response, interrupted) rejects with `CodexTurnStartUncertainError`, carrying the thread, the baseline turn id captured by `captureBaseline` (the newest turn before `turn/start`, from `thread/turns/list`), and the last 64 frames in receive order: kind, method, thread id, turn id. No task text, tool arguments, or output are kept. A JSON-RPC error answer means the server refused the request, so it is rethrown as an ordinary failure.

The [Resident driver](../../../../packages/physical-operator/resident-operator-local/README.md) answers an unknown start by reconciling, not failing: it opens a fresh connection to the same thread, waits while the newest turn that appeared after the baseline is running (interrupting it once if the Resident turn was interrupted, for at most 20 minutes), and then throws `COMMAND_INDETERMINATE`. The daemon already records that as a receipt that is never replayed, and the Session stays occupied for the whole wait. The `reasoning` phase is reported when the native turn is named.

## Alternatives considered

**Keep the first notification's turn id and ignore later ones.** It would only change which turn is wrong: a stale turn's notification can still arrive first.

**Treat an unknown start as not started and let the caller retry.** The log of the failing run shows the native turn running after DSH had reported failure, so a retry could execute the work twice.

**Adopt the native turn's output.** The turn found after the baseline is probably ours, but "probably" is not enough to attribute output to a command. The reconciliation reports what happened to the native turn and leaves the decision to the person who reads the indeterminate receipt.

**Require `thread/turns/list`.** An older Codex build would stop qualifying. It is optional: without it there is no baseline, and the reconciliation then waits only for a turn that is running.

## Consequences

A run no longer fails because another turn of the thread reported before the response. A start whose response is lost ends as an indeterminate receipt that names the native turn and its final status, and the command cannot be dispatched again by accident; the output of that native turn is not captured and must be read from Codex. The wait can hold a Session for up to 20 minutes.

The conflict that started this was not reproduced against a real Codex: the failing run did not keep the conflicting frames, so which notification arrived first is unconfirmed. The wire now records the frames, so a next occurrence names them. The RPC request id is not in the diagnostic because the shared JSON-RPC transport does not expose it.
