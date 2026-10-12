# Agent Note: Keep Smart Collaboration active with a selected API primary

Status: implemented

English | [中文](2026-09-23-smart-auto-with-selected-api-primary.zh.md)

## Problem

Desktop always installs a model selection, so every request carries a selected primary model. The primary-ownership rule from the [ChatGPT Web coordination](../../rejected/feature/2026-09-23-chatgpt-web-coordination.md) change returned before Smart Auto evaluated a selected API primary. Smart Auto therefore never routed recognized work to a physical operator in Desktop; its only automatic path ran without an installed selection, the path its routing test used. A `taskgraph-candidate` decision was an ignorable log event that nothing read, so the model received no request to build the TaskGraph that the decision described. Any request of 180 or more characters counted as parallel, so a long pasted document was labeled a TaskGraph candidate.

## Decision

The `auto` policy applies one decision to a selected API primary and to a request without a selection. A request with an explicit parallel or multi-role pattern becomes a TaskGraph candidate, recognized implementation or analysis work routes to one bounded physical operator for that request, and other work stays on the primary. A selected Codex, Claude Code, or ChatGPT Web primary is never replaced, and the `direct`, `codex`, `claude-code`, and `chatgpt-web` policies keep the selected-primary rules.

The first routing decision of a TaskGraph candidate appends one plugin-sourced user message asking the coordinator to start the TaskGraph through the `orchestration` tool, or to say in one sentence why the request has no independent branches. The message enters the log, so the model-visible input stays reconstructable. It is omitted when the agent has no `orchestration` tool or when Debate owns the Session. Request length no longer marks work as parallel.

## Alternatives considered

**Keep the passive candidate and relabel the setting.** This is honest but leaves the selected mode equivalent to `direct` apart from prompt text, which is not the collaboration the user selected.

**Let the primary decide from system-prompt guidance alone.** The SMART AUTO section already asks for that decision, and the observed Desktop session showed the model declining to collaborate. A per-request instruction tied to a logged routing decision is the smallest change that makes the classification actionable.

## Consequences

- With `auto` and a DeepSeek API primary, recognized coding work runs on Codex and recognized analysis on Claude Code, with the existing Claude-to-Codex fallback; the next request returns to the primary.
- Routing tests cover the installed-selection path for operator dispatch, TaskGraph instruction, and long single-task text.
- The first request of a LiangShen-preset Session still admits only direct user messages, so it cannot receive the TaskGraph instruction.
