# @deepseek-ai/dsh-physical-operator-resident

[English](README.md) | 中文

为同一个稳定物理算子 ID 提供双模式路由。省略模式或显式选择 `ephemeral` 时，继续使用现有一次性 subagent Provider；显式选择 `resident` 时，通过 `ctx.residentOperators` 执行，并把物理执行 ID 直接用作持久 command receipt 身份。

本包只负责路由，不保存 Session、Receipt、prompt、结果、调度状态、TaskGraph 或产品凭据。

## 配置与路由

每条映射声明稳定物理 `id`、现有 `ephemeralProvider`、可选 `residentProvider`、展示信息及共享 `maxConcurrency`。未配置 `residentProvider` 时只发布 `ephemeral`；配置后发布两种模式。可用性按本次请求的模式检查：ephemeral 订阅声明缺失不能再错误阻塞已通过资格审查的 Resident 执行。空字段、重复 ID、不可用订阅声明、缺失工作区和不支持的模式都会明确失败，不会自动降级。

Ephemeral 分支调用 `ctx.subagents`；Resident 分支只调用 `ctx.residentOperators` Service Definition，转发有界任务摘要以及可选、Provider 中立的模型/强度偏好，但不 import 本地 daemon Provider。因此 Provider 与 Consumer 可在 capability seam 后独立替换。

## Model Experience

Indirectly, through `physical_operator`, which lists supported modes and returns bounded output plus opaque continuity metadata.

#### KV Cache effect

The added optional `mode` field changes the tool schema once when this Consumer version is deployed.

## Known Limitations and Deferred Work

- 两种模式共享同一稳定算子 ID 的容量；协议 v3 不排队。
- 稳定算子层只汇总可用性；Resident 执行时仍会再次严格校验产品资格。
- 模型调用方不能使用 Resident 管理接口；这些接口只供可信插件和 CLI 使用。
