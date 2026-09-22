# @deepseek-ai/dsh-task-template-context

English | [中文](README.zh.md)

Direct Agent Consumer for task prompt templates. It classifies the current user request with deterministic rules, selects through `ctx.taskTemplates`, and appends one sourced user-role instruction whose receipt contains the exact selected content.

## Injection timing

A template is selected once per logical user task — the open Agent turn's originating request, not an arbitrary turn interval or each model-visible step. The sourced message remains in the Session surface and is therefore included in every later stateless model request while that history is retained, without appending another copy. A new user request (a new turn) always receives a new selection. TaskGraph nodes and Debate roles are separate logical tasks and select independently at their dispatch boundary; one-shot and Web operators receive the complete selected context on every independent dispatch.

Tool-loop steps, transport retries, and Resident polling never reselect or append a template. They reuse the logged receipt or the sealed operator-context envelope. Every decision — inject or skip — is also recorded as a log-only, replay-safe `task-template/decided` session event, so a skip is attributable even though it appends no surface message.

Only a live or pending message whose receipt matches the current turn's decision counts as retained context. A child task that receives an unrelated parent template still makes and records its own selection. The package invariant rejects a template message without its matching prior decision, a changed restore receipt, and content that differs from the pinned receipt.

When compaction shadows the injected surface message while the same turn is still open, the exact pinned receipt from that log event is restored once — never a fresh selection — so the model keeps seeing the same instruction the earlier step committed to. A later turn (a new logical task) always re-selects from scratch and never reactivates an earlier task's template. DSH does not use a periodic reinjection timer because a fixed interval can duplicate instructions mid-operation and change behavior without a task boundary.

Inference covers common research, insight-report, architecture, review, planning, coding, writing, frontend, backend, infrastructure, finance, legal, agent-system, output-format, risk, language, and urgency signals. The inferred risk is routing metadata only and never authorizes an action.

## Model Experience

### Task-template instruction

#### What the model sees

The selected method, preferences, and memory are carried in one JSON-framed `dshTaskPromptTemplate` document. The frame states that the current user request and system safety rules have higher precedence.

#### Token effect

One new message per logical task. Stateless APIs resend retained history on later steps, but the message is prefix-cacheable and is not duplicated in the Session. A compaction that shadows the injected message inside the same turn re-appends the identical pinned content exactly once — never a fresh selection — so the model-visible instruction is unchanged even though its underlying surface node moved.

#### KV Cache effect

Append-only at a task boundary. Reselection for a new task changes only the new suffix. A mid-turn compaction restore is also append-only: it adds one message at the current tail rather than rewriting the shadowed range a second time.

## Known Limitations and Deferred Work

- Classification uses a maintained keyword vocabulary; ambiguous tasks may match only broad templates.
- The direct Agent Consumer has no explicit-template picker; programmatic TaskGraph Consumers can seal an explicit template id.
- The post-compaction receipt restore is scoped to the currently open turn; it does not re-anchor guidance for a task resumed after the turn already ended (a `followup` always starts a fresh logical task and a fresh selection, by design).
