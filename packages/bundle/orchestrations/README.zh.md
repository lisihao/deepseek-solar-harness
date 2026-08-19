# @deepseek-ai/dsh-orchestrations

[English](README.md) | 中文

用于持久化 TaskGraph 编译、调度、模型入口和 Web／Desktop 投影的可选组合包。本地提供方启动或重连 `dsh-orchestratord`；禁用该组合包只断开 DSH，不删除 Run、产物、Receipt 或 Resident 产品 Session。

部署还必须挂载 Resident Physical Operators。编排 daemon 只选择使用原生订阅态的 Resident Claude Code 或 Codex 执行，绝不增加 API fallback。

## Model Experience

间接产生影响：通过一个 `orchestration` 工具及其稳定的复杂任务策略段落呈现。

#### KV Cache effect

启用该组合包会向部署提示词增加编排工具 schema 和稳定策略。

## Known Limitations and Deferred Work

- 本组合包面向 Web／Desktop composition，因为人工控制投影需要 `ctx.webServer`。
- 语义 Intent 分类、检索式 Context 编译、生产 Capsule 目录与轮次内热插拔仍属于独立提供方工作。
