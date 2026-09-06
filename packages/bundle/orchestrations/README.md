# @deepseek-ai/dsh-orchestrations

English | [中文](README.zh.md)

Opt-in bundle for persistent TaskGraph compilation, scheduling, model entry, and Web/Desktop projection. The local Provider starts or reconnects to `dsh-orchestratord`; disabling the bundle disconnects DSH without deleting runs, artifacts, receipts, or Resident product sessions.

The deployment must also mount Resident Physical Operators. The orchestration daemon selects only native-subscription Resident Claude Code or Codex execution and never adds an API fallback.

## Model Experience

Indirectly, through one `orchestration` tool and its stable complex-task policy section.

#### KV Cache effect

Enabling the bundle adds the orchestration tool schema and stable policy to the deployment prompt.

## Known Limitations and Deferred Work

- This bundle targets Web/Desktop compositions because its human control projection requires `ctx.webServer`.
- Semantic Intent classification, retrieval Context compilation, production Capsule catalogs, and in-turn hot swap remain separate Provider work.
