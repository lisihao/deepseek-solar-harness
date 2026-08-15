# Agent Note: 将物理算子抽取为 DSH capability seam

Status: implemented

[English](2026-08-15-physical-operator-capability-seam.md) | 中文

## 问题

AI4Research 包含有价值的物理算子概念，但若把整个项目作为一个 DSH Bundle 接入，就会保留过大的业务边界，并在 harness 内形成第二套编排权威。现有物理算子实现还把稳定算子身份与 Solar 形态的 TaskGraph、文件收件箱、lease、graph/gate 状态修改以及大型只读迁移目录混在一起。直接复制该 runtime，会让 DSH 在执行底座重新设计前就依赖历史状态和现有实现问题。

同时，DSH 确实需要一种无缝方式，让 agent 与插件发现物理能力、调用和取消执行、观察容量，并能在不改变模型约定的情况下替换后端执行产品。

## 决策

只抽取稳定能力边界，不移植 AI4Research runtime。第一个切片遵循仓库的 Service Definition / Service Provider / Consumer 架构：

1. `@deepseek-ai/dsh-physical-operator` 负责 `ctx.physicalOperators`、稳定 ID、描述符、实时可用性、快速失败容量、类型化错误和成对执行生命周期事件。
2. `@deepseek-ai/dsh-physical-operator-subagent` 把稳定 ID 映射到现有 `ctx.subagents` Provider。首批验证的产品映射是 `codex` 与 `claude-code`；两者都只允许订阅套餐，并会在 Provider 未声明“无显式子进程环境的原生账户路径”时默认拒绝。加载映射不会启动任何产品。
3. `@deepseek-ai/dsh-tool-physical-operator` 暴露一个固定的 `physical_operator` 工具，支持 `list` 和前台 `run`。模型选择稳定算子 ID，不会看到 Provider 传输。

三个角色作为独立包和可选 Loader composition 交付，而不是 AI4Research Bundle。Provider 与 Consumer 只依赖 Service Definition，互不 import。已接受的运行可以跨 Provider HMR 继续完成；容量按稳定 ID 保留到运行结束。调用方取消信号经服务传给现有 subagent Provider，后者仍是执行和资源释放责任方。

本次抽取不复制 AI4Research Python 守护进程、调度器、TaskGraph、状态库、文件收件箱、算子目录或业务工作流；也不修改 Solar 仓库或生成态 DSH runtime。未来底座工作可以增加同级 Provider，或有意地升级共享约定，而无需重新导入整个单体。

## 考虑过的替代方案

- **把 AI4Research 作为一个 DSH Bundle 安装**：否决，因为它把整个应用作为插件边界，并携带物理算子调用不需要的编排和状态权威。
- **原样移植现有 Python `operator_runtime` 与 `operatord`**：否决，因为其中 Solar 形态的持久化、lease、TaskGraph 和文件协议正是仍需重新设计的底座。
- **把 Codex 与 Claude Code 分别暴露为物理工具**：否决，因为产品选择会泄露到模型约定，每增加一个执行后端都会改变 schema 与 prompt。
- **只使用通用 `subagent` 工具，不建立领域 seam**：否决，因为它没有稳定物理算子身份、可用性或容量约定，也没有未来类型化物理结果的边界。
- **立即加入队列、路由、receipt 与 artifact schema**：推迟到旧底座问题和所需物理语义明确后；在抽取阶段臆造它们只会再次冻结一个猜测。

## 后果

DSH 现在具备一个小型、可替换的物理算子 capability seam，可以复用已经实现的 Claude Code 与 Codex 产品，无需修改 Core。无密钥 Loader 证据会执行完整的工具到 subagent 路径；第二个真实产品 composition 则在空 `PATH` 下证明两个产品映射均可注册、报告 `native-subscription` 身份验证且保持惰性。单元证据证明缺失声明或 `explicit-environment` 声明会在发现和执行边界被拒绝；宿主真实 canary 继续负责证明当前订阅权益。

这有意只完成底座的第一个切片。选择与评分、持久化 command receipt、持久化与崩溃恢复、队列与公平性、配额或冷却、进度、类型化物理 schema、内容寻址工件、provenance 和 actor-host 迁移仍然推迟。后续设计必须扩展或替换合适的角色，而不是继续膨胀一个单体 Bundle。
