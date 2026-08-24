# Agent Note：兼容 Prime Agent 的 TypeScript Runtime

状态：proposed

[English](2026-08-24-prime-agent-compatible-typescript-runtime.md) | 中文

## 问题

DSH 当前把 RLM 用作一项密封的调度策略：固定展开若干 Resident 回合，再汇总输出。它有实际价值，但不是 Prime Agent v0.8.0 的 Runtime：模型没有持久编程命名空间，不能调用异步 `rlm(...)` 函数，不能在家庭范围内交换消息，也不能通过 Continuous Harness 演化 prompt、memory、skill 和 subagent。

用户要求忠实实现 Prime Agent 原版设计的 TypeScript 版本。忠实度以可观察契约为准，而不是照搬 Python 语法，也不意味着放弃 DSH 的插件架构。

## 一手资料基线

兼容基线固定为 Prime Agent 标签 `v0.8.0`、提交 `8d7deeab5861bf9d77bde3d8511046a5c799818d`，遵循其 MIT 许可证。持续变化的 `main` 不作为契约来源。事实源包括：

- `packages/coding-agent/docs/rlm.md` 与 `docs/rlm-runtime.md`；
- `prime-agent-runtime/src/rlm/harness.py` 与 `test/test_harness.py`；
- `packages/coding-agent/src/core/refinement/refinement.ts`；
- `docs/daemon.md`、`docs/long-running-agents.md` 与 `docs/architecture.md`；
- `packages/coding-agent/test/rlm-ledger.test.ts`。

## 方案

新增能力接缝 `ctx.rlmRuntime`。`ctx.rlmStrategy` 继续只负责策略。全局 DSH TaskGraph 仍是唯一 Run 级调度权威；一个已密封的 TaskGraph 节点可以选择进入由 RLM Runtime 持有的节点内 RLM 树。

模型只看到一个由持久 Node 进程承载的 `typescript_repl` 工具。TypeScript Kernel 预载 `context`、`rlm`、`agentMessage`、`harness`、`goal` 和 `compact`。这是用户明确授权的 IPython 平台替换；生命周期、准入、消息、恢复和 Harness 契约必须保持等价。

## 能力接缝与包拓扑

- `@deepseek-ai/dsh-rlm-runtime`：Service Definition、版本化协议类型、错误和 `ctx.rlmRuntime`。
- `@deepseek-ai/dsh-rlm-runtime-local`：owner-local Provider，负责持久 TypeScript Kernel、子节点注册表、家庭消息、Receipt、快照和恢复。
- `@deepseek-ai/dsh-rlm-strategy`：不变的策略接缝，只决定密封节点是否可使用 RLM 及其预算。
- `@deepseek-ai/dsh-continual-harness` 与 `-local`：原地扩展 prompt、memory、skill、subagent CRUD、版本历史、两阶段 refinement 和 rollback。
- `@deepseek-ai/dsh-orchestration-local`：Consumer，在 ExecutionPlan 密封后创建一个节点内 RLM Root，不再自己实现 RLM 树。
- Resident Claude Code/Codex Provider：模型工具适配层的 Consumer。Claude 使用进程内 Agent SDK MCP；Codex 使用 app-server `thread/start.dynamicTools` 和 `item/tool/call`。

Provider 与 Consumer 只能依赖 Service Definition。Local Provider 可以替换；禁用后普通 TaskGraph 以及 ephemeral/Resident 物理算子不受影响。

## 权威与进程映射

| Prime 权威 | DSH TypeScript 权威 |
| --- | --- |
| daemon supervisor 和 worker | `dsh-orchestratord` 监管节点内 RLM Root；`dsh-resident-operatord` 保留 Claude/Codex 原生会话 |
| Python IPython kernel | 每个 RLM Session 一个持久的 owner-local Node TypeScript Kernel |
| TypeScript Host | `@deepseek-ai/dsh-rlm-runtime-local` |
| child AgentSession | 拥有独立 child session identity 的 Resident 物理算子回合 |
| RLM ledger/session tree | RLM Provider store 与 append-only events，并关联密封 TaskGraph attempt |
| continual harness store | `@deepseek-ai/dsh-continual-harness-local` |
| Agents view | DSH Desktop 的 RLM 树、消息、Kernel、Goal 和 Harness generation 投影 |

TypeScript Kernel 是隔离和生命周期边界，不是安全沙箱；它和 owner daemon 具有相同操作系统权限。DSH scope/effect 准入在派发前完成。

## 忠实度矩阵

| Prime v0.8.0 契约 | DSH 必须具备的行为 |
| --- | --- |
| 持久模型可见 IPython | 持久模型可见 TypeScript REPL；变量跨回合和 compaction 保留 |
| `rlm(...)` 立即准入 | 只返回 `{ rlmChildId, name, sessionDir, model }`，绝不返回 child answer |
| 异步 children | 子回合在密封预算内并发，结果独立报告 |
| parent-scoped registry | 名称在父节点内唯一；list/inspect 跨 Kernel 和 daemon 重启恢复 |
| 有界递归 | 子节点准入前强制 max depth/children/turns |
| A2A 核心家庭消息 | 只允许 parent、sibling、direct child；支持 `auto`、`steer`、`follow_up` |
| child 通过消息/文件返回 | 不设隐藏返回通道；消息和内容寻址 Artifact 必须显式 |
| compaction 保留程序状态 | 模型历史可以压缩，Kernel namespace 和 child registry 必须保留 |
| best-effort 变量快照 | 可序列化变量独立恢复；单个失败要具名，不能丢弃其他变量 |
| prompt/memory/skill/subagent CRUD | 默认 session-local，可选 workspace-global，条目和引用版本化 |
| `/refine` 后台规划、边界应用 | base system prompt 不可变；基于证据的 delta 独立规划，只在回合边界应用 |
| refinement 历史和回滚 | 每次应用记录 before/after/version，并允许显式 rollback |
| daemon continuity | Desktop/client 断开不停止 accepted 工作；以 snapshot + cursor event 重连 |
| 命令不确定性 | 幂等 command receipt；不确定副作用绝不自动重放 |
| Goal 与自主续跑 | 持久 Goal、有界 continuation budget、heartbeat/schedule trigger、明确 stop/block 状态 |
| 使用量归属 | 每个 child/refinement 记录 provider/model/套餐或 API/成本，并归属 parent |

所有行都通过端到端验收前，不得把实现称为 `Prime compatible`。未完成的实现必须标记为 `compatible subset`。

## Runtime 协议

Service Definition 暴露：

- Root 生命周期：`create`、`list`、`inspect`、`executeCell`、`compact`、`interrupt`、`reset`、`readEvents`；
- Child 生命周期：`spawn`、`listChildren`、`inspectChild`、`deleteChild`；
- 消息：`sendMessage`、`readMessages`；
- Goal 与自动化：`setGoal`、`getGoal`、`continueGoal`、`schedule`、`heartbeat`；
- 恢复：`reconcile`、`resolveIndeterminate`。

每个变更请求携带 caller-generated `commandId`、canonical request hash、必要时的 expected revision，以及密封的 TaskGraph execution identity。Accepted 工作不可原地修改。失败重试使用新 command identity；indeterminate 命令必须显式处理。

Kernel 串行执行普通 REPL cell；子调用异步且可以并发。Host 只把结果注入 parent 的 event/message stream，绝不放进 `rlm(...)` 的同步返回值。

## Continuous Harness 语义

Harness entry kind 固定为 `prompt`、`memory`、`skill`、`subagent`；scope 默认 `session`，明确请求后才是 `workspace`。每个条目包含 ID、version、text 或 artifact ref、可选 arguments 和 source path、provenance 与时间。Update/delete 使用乐观并发。

Refinement 分两阶段：

1. `planRefinement` 读取有界 Evidence，生成 proposed delta，不修改 active harness。
2. `applyRefinement` 核对 expected generation，只在 turn boundary 应用 delta。

不可变 base system prompt 不能被覆盖。Rollback 通过新 generation 恢复先前 effective entry set，不改写历史。

## 已考虑的替代方案

- 保留当前 `Promise.all` fan-out 并改名 Prime RLM：拒绝，因为缺少编程面、异步准入、家庭消息、持久化和 Harness 演化。
- 用提示词伪造 Claude/Codex 工具调用：拒绝，因为两者都有真正的 Host 工具（Agent SDK MCP 与 app-server dynamic tools）。
- 把 Prime 的 Python/IPython Runtime 复制进 DSH：拒绝，因为用户明确要求 TypeScript 实现，而且 DSH 已持有 Node daemon 生命周期和插件接缝。
- 允许 RLM Runtime 创建全局 TaskGraph node：拒绝，因为这会形成两个全局调度器，并重复 scope/effect 权威。

## 验收标准

- 模型在 DSH 重启前后执行两个 TypeScript cell，并观察到同一 namespace variable。
- `rlm(...)` 只返回 admission handle，两个 child result 随后通过消息到达。
- Parent、sibling、child 消息成功；非家庭 target 必须 fail closed。
- Child name、depth、budget、receipt 和旧 generation 迟到结果跨 daemon 重启仍被 fencing。
- Harness CRUD、local/global scope、两阶段 refinement、不可变 base prompt、history 和 rollback 端到端通过。
- Compaction 保留 Kernel state；故意不可序列化的变量只独立 degraded。
- 外部 child accepted 后崩溃只能成为 settled 或 indeterminate，绝不能重复 child call。
- 同一 RLM 场景通过 DSH-native DeepSeek、Claude Code 和 Codex 的 Host-tool 接入运行。
- 禁用 RLM Bundle 后，普通非 RLM TaskGraph 行为不变。
- 离线 fixture 覆盖完整矩阵；全部输入稳定后只运行一次最小真实订阅盲测。

## 风险

- Codex dynamic tools 是实验协议且只能在 `thread/start` 提供；Provider 必须固定已资格审查的 schema，工具面变化时创建新的原生 thread。
- Claude/Codex 原生会话是自身 conversation content 权威，DSH 是 RLM topology 和 Receipt 权威；恢复时必须对账，不能复制完整产品历史。
- 只执行隔离函数的 TypeScript 工具不够持久；实现必须证明 lexical state 跨 cell 和重启保存。
- 自动 Harness refinement 可能放大坏 Evidence。Delta 必须小、有 Evidence、受预算约束、可审查、可回滚。
