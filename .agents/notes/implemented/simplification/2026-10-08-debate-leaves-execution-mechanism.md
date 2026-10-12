# Agent Note: Debate leaves the execution mechanism

Status: implemented

English | [中文](2026-10-08-debate-leaves-execution-mechanism.zh.md)

## Problem

Debate was a Session-wide execution mechanism. Choosing it in the collaboration menu, or running `/debate-mode enabled`, made a host adapter answer every direct message with a streamed roster transcript instead of the Session's primary model, and the physical-operator router stepped aside for it. That made Debate a second way to run a Session beside the kennel. The kennel is where long-lived members take work, and the intended direction is that those members debate, comment on, and review each other's work, so Debate has to belong to the kennel instead of replacing a Session's model.

## Decision

The execution mechanism selector offers automatic, standard, and RLM. The Debate option, the `/debate-mode` command, the `debateExecutionPreferences` projection, the `dsh-debate-host` model adapter, its two Agent hooks, the streamed transcript, and the router's yield to an enabled Debate are removed. Standard now means RLM is disabled. A Session that saved an enabled Debate preference simply routes like any other Session.

The Debate engine stays. `ctx.debates`, the local durable Provider, the TaskGraph binding, the `/api/debates` panel, and the model-facing `debate` tool keep their contracts. The [tool](../../../../packages/orchestration/tool-debate/README.md) starts a Debate only in a kennel Session, approves it in the same call, and still lists, inspects, and controls runs in any Session.

Released data stays readable. `debate/preferences` and `debate/dispatch` were always written as ignorable events, so a log that contains them loads under the persistence rule for unknown ignorable events, and a contract test pins that. The request-route recovery in the API proxy keeps skipping `dsh-debate-host/debate`, which an older Session may still log. `debate/admission` keeps its declaration because the tool still writes it.

## Alternatives considered

**Hide the option and keep the command.** The command would keep the Session-wide takeover reachable and keep the two hooks and the transcript code alive for a mode the product no longer offers.

**Delete the Debate packages.** Persisted Debate runs, the panel, and the tool's trace projection are still used, and the kennel needs the same durable run, budget, and approval machinery.

**Keep the tool gated by the removed preference.** The default was `disabled`, so with no way to change it the tool could never start a run.

## Consequences

Until kennel members fill the roster, a Debate started from the kennel uses the fixed default roster of Codex and Claude Code operators. Nothing streams a Debate into the chat any more; its progress shows in the Debate panel and in `debate/trace` facts. Assigning roster slots to kennel members needs a TaskGraph that can name more than one member, because a run admits one `gouziRecipient` today. That, and members commenting on and reviewing each other's results, are separate changes.
