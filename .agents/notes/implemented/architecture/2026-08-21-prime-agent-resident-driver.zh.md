# Agent Note：将 Prime Agent 实现为独立 Resident Driver

Status: implemented

[English](2026-08-21-prime-agent-resident-driver.md) | 中文

## 问题

DSH 已经拥有持久的 Claude Code、Codex 物理算子和持久化全局 TaskGraph Scheduler。Prime Agent 提供有价值的 RLM 递归、多 Agent 探索与综合能力，但如果把它作为另一个全局 Planner 安装，就会产生彼此竞争的调度、receipt、重试、scope 和验收权威。把 Prime 专用代码塞进 Resident daemon 或 Desktop 也会耦合产品发布，并阻止其他产品 Driver 复用同一边界。

## 决策

Prime Agent 作为独立包实现公开 Resident 产品 Driver SPI。`@deepseek-ai/dsh-resident-operator-local` 在 detached daemon 中加载已配置的 Driver factory，并通过 Resident 协议 v6 中的规范化 Driver 模块 manifest 对客户端进行隔离。Resident Bundle 按模块名接线 Prime 包；daemon、物理路由器、编排 Scheduler、模型 Consumer 和 Desktop 都不导入 Prime 实现内部。

首发 Provider ID 为 `prime-agent`。它核验精确的 Prime Agent 0.7.4，要求用户 ChatGPT 订阅提供的 `openai-codex` OAuth，拒绝 API-key 回退，通过公开 JSONL RPC 读取订阅模型目录，并借助现有 Resident Session/Receipt 存储持久化 Prime 原生 Session ID。DSH 负责全局 TaskGraph、scope、execution ID、重试、审批与验收。Prime 每次只接收一个已封存节点任务，只能执行有界节点内递归；Driver 明确排除 Prime 全局工作流细化。

Prime 仅支持 resident。省略执行模式仍保留全局 ephemeral 缺省，因此 Prime 会明确失败，而不是静默选择其他产品或模式。用户显式选择优先。智能路由与编排器会为递归、RLM、多 Agent 探索、综合、研究和长周期节点工作选择 Prime；Claude Code 与 Codex 保留既有分析与实现路由。

## 验证

Driver 测试使用严格的伪 JSONL RPC 产品，证明 ESM 包发现、精确版本与 OAuth 资格、API 环境清理、权威前缀传递、原生 Session 连续性和中止行为。Resident 协议测试证明独立 Driver 加载和 manifest 隔离。物理路由器测试证明仅 resident 模式的准入。编排测试证明有界递归节点会选择 Prime，同时 DSH Graph 仍是权威。Desktop 打包验证要求安装运行时同时包含 Driver 入口和 Prime CLI bundle。

## 考虑过的替代方案

**让 Prime Agent 成为 DSH 全局 Planner。** 不采纳，因为两个持久 Scheduler 可能独立重试、修改工作并宣称完成。

**把 Prime 直接嵌入 Resident daemon。** 不采纳，因为每次 Prime 发布都会改变 daemon 实现，而且第三方 Driver 无法获得稳定扩展边界。

**使用 ACP 而不是 Prime JSONL RPC。** 本次不采纳，因为公开 JSONL RPC 提供持久恢复所需的原生 Session 状态和本 Driver 使用的有界命令集。

**提供 API 凭据回退。** 不采纳，因为该产品的物理算子契约使用用户订阅，资格缺失时必须明确失败。

## 后果

Prime 可以通过 Bundle composition 加入或移除，不改变 DSH Core 或 Scheduler。daemon 跨 Desktop/HMR 重启继续持有 Session、Receipt、lease、event 和 Artifact 权威。Prime 登录仍是在 Prime 自身完成的显式外部资格步骤。版本或 Driver 集变化会令旧 daemon 不兼容，并触发有序退出和重启，而不是形成含糊的混合 composition。turn 内 capability checkpoint 热插拔仍不支持；当前 Provider 只接受派发前和下一 turn 注入。
