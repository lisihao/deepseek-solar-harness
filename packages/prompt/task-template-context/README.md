# @deepseek-ai/dsh-task-template-context

English | [中文](README.zh.md)

Direct Agent Consumer for task prompt templates. It classifies the current user request with deterministic rules, selects through `ctx.taskTemplates`, and appends one sourced user-role instruction whose receipt contains the exact selected content.

## Injection timing

A template is selected once per logical user task, not on an arbitrary turn interval. The sourced message remains in the Session surface and is therefore included in every later stateless model request while that history is retained, without appending another copy. A new user request receives a new selection. TaskGraph nodes and Debate roles are separate logical tasks and select independently at their dispatch boundary; one-shot and Web operators receive the complete selected context on every independent dispatch.

Tool-loop steps, transport retries, and Resident polling never reselect or append a template. They reuse the logged receipt or the sealed operator-context envelope. Compaction may replace the earlier message with a summary; DSH does not use a periodic reinjection timer because a fixed interval can duplicate instructions mid-operation and change behavior without a task boundary.

Inference covers common research, insight-report, architecture, review, planning, coding, writing, frontend, backend, infrastructure, finance, legal, agent-system, output-format, risk, language, and urgency signals. The inferred risk is routing metadata only and never authorizes an action.

## Model Experience

#### What the model sees

The selected method, preferences, and memory are carried in one JSON-framed `dshTaskPromptTemplate` document. The frame states that the current user request and system safety rules have higher precedence.

#### Token effect

One new message per logical task. Stateless APIs resend retained history on later steps, but the message is prefix-cacheable and is not duplicated in the Session.

#### KV Cache effect

Append-only at a task boundary. Reselection for a new task changes only the new suffix.

## Known Limitations and Deferred Work

- Classification uses a maintained keyword vocabulary; ambiguous tasks may match only broad templates.
- The direct Agent Consumer has no explicit-template picker; programmatic TaskGraph Consumers can seal an explicit template id.
- Compaction relies on its summary to preserve still-relevant guidance; there is no receipt-aware post-compaction re-anchor yet.
