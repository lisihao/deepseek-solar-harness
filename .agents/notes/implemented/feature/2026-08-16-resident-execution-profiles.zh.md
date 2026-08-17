# Agent Note: Lock native execution profiles to Resident Sessions

Status: implemented

[English](2026-08-16-resident-execution-profiles.md) | 中文

## Problem

Resident Claude Code 与 Codex turn 会继承各产品的本机默认模型和推理设置。DSH 既不能显示实际选择，也不能把它保存为持久 Session 契约，因此恢复后的 Session 可能因用户配置或产品默认值变化而改变行为。单一硬编码目录也会过期，并错误表达订阅账户实际可用的能力。

## Decision

Physical-operator 请求携带可选、提供方无关的模型与推理强度偏好。Resident daemon 从已通过资格审查的原生订阅产品读取实时模型目录，校验显式字段，以透明的任务分类策略补全省略字段，并在产品执行前把完整有效 profile 保存到“算子加 realpath 工作区”Session。后续 turn 全部复用该 profile。不同 profile 会返回 `EXECUTION_PROFILE_CONFLICT`，直到带乐观并发门禁的 idle reset 清除原生关联和 profile。

Claude Code 目录发现使用 Agent SDK 控制通道，不提交模型 prompt。Codex 目录发现使用 app-server `model/list`。Claude 执行传入 SDK `model`、`effort`，并在所选模型声明支持时启用 adaptive thinking。Codex 在线程 start/resume 时传入 `model`，并在每个 `turn/start` 传入 `model` 与 `effort`。两者仍只允许原生订阅登录态，并保留现有版本与协议资格门禁。

模型与强度偏好以 ignorable DSH Session event 和浏览器 projection 保存。Host dispatch 把折叠后的偏好复制到持久 dispatch 记录，因此重连复用完全相同的已准入请求。Daemon 只记录解析后的 profile、来源（`smart-auto`、`mixed` 或 `manual`）与规范请求 hash；prompt 与原生 transcript 仍不进入 profile store。

## Catalog and automatic selection

Provider 状态包含原生产品当前模型条目、支持的强度、默认强度、可用时的解析后模型别名，以及 adaptive-thinking 能力。Smart Auto 只在内存中把当前 prompt 分类为 quick、standard、complex 或 extreme。它根据产品声明的稳定 ID 与描述选择快、均衡或旗舰条目，再选取最近的受支持强度。手动模型或强度只覆盖对应维度；所有解析值仍须通过实时目录校验。

## Alternatives considered

**永久继承每个 CLI 配置**——否决，因为 DSH 无法显示或持久复现实际执行 profile，而且本机默认值漂移会改变恢复语义。

**发布静态 Claude 与 Codex 模型列表**——否决，因为产品版本、订阅权限、别名和支持的强度会独立于 DSH 变化。

**把模型与强度纳入 Session 身份**——否决，因为这会为同一算子/工作区创建并行原生 Session，削弱现有连续性契约。显式 reset 是改变 profile 的可见边界。

**允许每个 turn 静默改变 profile**——否决，因为原生上下文连续性将不再代表稳定执行行为，而且重试可能使用不同于已接收 receipt 的模型执行。

## Consequences

Desktop 与其他可信客户端可以显示实时选择和 daemon 确认的有效 profile。Smart Auto 无需用户在普通 prompt 中点名产品或模型，手动偏好则保持持久且可安全重连。资格审查增加一次有界的原生目录控制请求；profile 变化需要显式 reset，它会建立新原生关联，同时保留旧产品历史和产物。SQLite schema v2 对 schema v1 做增量迁移；现有 Session 会在下一次已准入 turn 获取 profile。
