# @deepseek-ai/dsh-resident-operator-prime-agent

[English](README.md) | 中文

这是一个独立 Resident 产品 Driver，把 Prime Agent 暴露为稳定的 `prime-agent` 物理算子。它使用 Prime Agent 0.7.4 的公开 JSONL RPC 模式和用户的 `openai-codex` OAuth 订阅，不提供 API-key 回退。

DSH 继续作为全局 TaskGraph 调度、scope、receipt、重试、审批和验收的唯一权威。Prime 只负责一个持久的节点内 RLM Session 及其有界递归工作。Driver 会在已封存节点任务前加入这一权威边界，并且不调用 Prime 的全局工作流细化能力。

## 配置与语义

本包导出 `createResidentProductDriver()`，由 `@deepseek-ai/dsh-resident-operator-local` 的通用 `driverModules` SPI 加载。它不导入 Resident Bundle、编排 daemon、Desktop 或任一 Consumer。Driver 先核验精确 Prime 版本、确认 `~/.prime/agent/auth.json` 中存在 `openai-codex` OAuth，再读取订阅可见的模型目录；全部通过后才标记为可用。

同一算子、真实工作区和 lane 的 Resident Session 会复用 Prime 原生 Session ID。Prompt 只接受文本。子进程接收已清理凭据的环境和受限递归深度；调用方中止映射到 Prime 公开的 `abort` RPC 命令。产品输出转换为普通 Resident 结果，因此 daemon receipt、lease、持久化与 Artifact 机制无需增加 Prime 专用存储即可生效。

## Model Experience

模型通过 `ctx.physicalOperators` 间接调用。用户可以显式选择 `prime-agent`；Smart Auto 与编排器也可在有界递归、RLM、多 Agent 探索、综合、研究或长周期节点任务中选择它。

#### KV Cache effect

不增加全局 prompt 区段。每个已封存节点任务进入一个 Prime Resident turn。

## Known Limitations and Deferred Work

- 首发只支持 `openai-codex` OAuth 订阅 Provider 和 Prime Agent 0.7.4。
- Prime 登录必须在 Prime Agent 中通过 `/login` 完成；资格通过前，DSH 会明确显示 Provider 不可用。
- Driver 支持派发前和下一 turn 的能力注入，不支持 turn 内 checkpoint 热插拔。
- Prime 只进行节点内递归，不能创建、修改或结算 DSH 全局 TaskGraph。
