# physical-operator/ — physical operator capability family

English | [中文](README.zh.md)

This family exposes deployment-defined physical operators without importing the AI4Research scheduler, TaskGraph, file inbox, state store, or operator catalog. Stable operator identity is independent of the execution product behind it.

| Package | Role | Context key |
|---|---|---|
| [`physical-operator/`](physical-operator/README.md) | Service Definition for discovery, admission, and lifecycle | `ctx.physicalOperators` |
| [`physical-operator-subagent/`](physical-operator-subagent/README.md) | Service Provider mapping stable ids to existing subagent providers | registers on `ctx.physicalOperators` |
| [`resident-operator/`](resident-operator/README.md) | Persistent Session, Receipt, and event Service Definition | `ctx.residentOperators` |
| [`resident-operator-local/`](resident-operator-local/README.md) | Unix-socket daemon client and native subscription drivers | provides `ctx.residentOperators` |
| [`tool-physical-operator/`](tool-physical-operator/README.md) | Consumer exposing `physical_operator` to the model | registers on `ctx.tools` |
| [`ui-physical-operator/`](ui-physical-operator/README.md) | Authenticated Host projection and reusable browser controls | Host route + Client slots |

The first Service Provider reuses the existing subagent execution products. Deployments can map one operator to `codex` and another to `claude-code` without changing the model-facing tool or the Service Definition. A future native, remote, or laboratory provider can implement the same service contract.

See the [physical operator capability seam Agent Note](../../.agents/notes/implemented/architecture/2026-08-15-physical-operator-capability-seam.md).
