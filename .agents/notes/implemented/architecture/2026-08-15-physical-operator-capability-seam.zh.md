# Agent Note: 将物理算子抽取为 DSH capability seam

Status: implemented

[English](2026-08-15-physical-operator-capability-seam.md) | 中文

## 问题

AI4Research 包含有价值的物理算子概念，但若把整个项目作为一个 DSH Bundle 接入，就会保留过大的业务边界，并在 harness 内形成第二套编排权威。现有物理算子实现还把稳定算子身份与 Solar 形态的 TaskGraph、文件收件箱、lease、graph/gate 状态修改以及大型只读迁移目录混在一起。直接复制该 runtime，会让 DSH 在执行底座重新设计前就依赖历史状态和现有实现问题。

同时，DSH 确实需要一种无缝方式，让 agent 与插件发现物理能力、调用和取消执行、观察容量，并能在不改变模型约定的情况下替换后端执行产品。

## 决策

只抽取稳定能力边界，不移植 AI4Research runtime，并在边界后支持两种显式执行生命周期：

1. `@deepseek-ai/dsh-physical-operator` 负责 `ctx.physicalOperators`、规范化的 `ephemeral | resident` 模式发现、快速失败容量、Provider 调用前生成的 execution identity、类型化错误与成对生命周期事件。缺省仍为 `ephemeral`；不支持的模式明确失败，不回退。
2. `@deepseek-ai/dsh-resident-operator` 增加与 Provider 无关的 `ctx.residentOperators` 控制 seam。Session 由算子 ID、规范化工作区与调用方拥有的 lane 共同确定，只允许一个 active turn，并为可信方提供管理操作；不同 lane 可以并发执行，不共享原生产品 thread。模型仍只能通过 physical-operator Consumer 执行。
3. `@deepseek-ai/dsh-resident-operator-local` 运行独立、仅属主可访问的 Unix-socket daemon，作为 Session/Receipt/Lease/Event/Artifact 的唯一写者。Command identity 与 canonical request hash 分离：相同重放返回同一 Receipt，内容改变则冲突；崩溃变为 `indeterminate`；获授权的重试使用新 ID，并唯一关联已 abandon 的旧 Receipt。
4. 原生产品连续性保持权威。Claude Code 使用官方 Agent SDK 的持久 Session 与 resume；Codex 使用固定 app-server schema 的非临时 thread start/resume。两者都在当前 CLI、版本、协议与原生订阅资格无法证明时默认拒绝，且只接收凭据清理后的环境，不提供 API fallback。
5. `@deepseek-ai/dsh-physical-operator-resident` 在现有 ephemeral subagent 与 Resident seam 之间路由同一稳定 ID。`@deepseek-ai/dsh-tool-physical-operator` 仍是唯一模型 Consumer，并根据实时 descriptor/tag/mode 目录注册动态选择指引，而不是引入隐藏分类器；`@deepseek-ai/dsh-resident-operators` 则提供 opt-in composition Bundle。
6. Consumer 持有每个 Session 一份已记录的路由策略：`auto | direct | codex | claude-code`。未配置的 Session 使用 `auto`，它会把可并行的复杂工作留在主 Agent 轮次，由 [TaskGraph 原生智能协作](../feature/2026-08-20-taskgraph-smart-collaboration.md)处理，并直接派发有界算子工作。`/operator` 修改持久事件；Session 投影向客户端提供同一值，使 Desktop 能在模型选择旁显示独立的执行策略选择器，而不会把两者混为一谈。直接宿主 dispatch 是单 step 覆盖：它记录被替换的主模型配置，在 HMR 或进程恢复后的下一条未匹配消息中恢复该配置，并且在 assistant message 已交付该 dispatch 后不能再次提供结果。

Provider、路由器与 Consumer 依赖 Service Definition，而不依赖彼此实现。DSH/HMR 释放只断开客户端，不终止 daemon；daemon 正常停止会排空已准入 turn。Tmux 只是可选的只读事件观察器，不是任务传输或权威。DSH Session、Jobs、Web UI 与 terminal pane 可投影有界状态，但不拥有原生产品 Session 或 Resident Receipt。

本次抽取不复制 AI4Research Python daemon、调度器、TaskGraph、状态库、文件收件箱、算子目录、persona、Gate、Evidence schema 或业务流程；也不修改 Solar 仓库或生成态 DSH runtime。

## 考虑过的替代方案

- **把 AI4Research 作为一个 DSH Bundle 安装**：否决，因为它把整个应用作为插件边界，并携带物理算子调用不需要的编排和状态权威。
- **原样移植现有 Python `operator_runtime` 与 `operatord`**：否决，因为其 Solar 形态的持久化、TaskGraph 与 mailbox 把领域权威和可复用 daemon 机制混在一起。
- **把 Codex 与 Claude Code 分别暴露为物理工具**：否决，因为产品选择会泄露到模型约定，每增加一个执行后端都会改变 schema 与 prompt。
- **只使用通用 `subagent` 工具，不建立领域 seam**：否决，因为它没有稳定物理算子身份、可用性或容量约定，也没有未来类型化物理结果的边界。
- **仅在用户明确点名 Codex 或 Claude Code 时委派**：否决，因为这会把实现词汇变成使用前提，并让原本可用的执行 seam 在缺省体验中几乎闲置。
- **把 Codex 和 Claude Code 显示成主聊天模型**：否决，因为它们是订阅支持的执行产品，具有独立原生会话、生命周期、Receipt 与结果；将其作为 LLM route 会错误表达权威边界。
- **永久保持一个 Claude/Codex CLI 进程，或用 tmux 作为控制面**：否决，因为连续性权威是产品原生 Session/thread identity，而不是终端进程寿命或屏幕文本。
- **使用 DSH Jobs 作为持久权威**：否决，因为当前 Jobs 不能跨 DSH 重启；未来可由 external durable Job Provider 投影 Resident turn。
- **立即加入排队、人工写接管、亲和调度或远程算子池**：后置；Resident 协议是本地、快速失败、每 lane 单 turn、automation 控制。

## 后果

DSH 现在既保持原有一次性行为，又在不修改 Core 的前提下增加 opt-in 持久控制面。Daemon 负责 SQLite WAL 状态、仅属主可访问的本地 IPC、内容寻址大结果、恢复、有界结构化观察、严格产品资格与 prompt/凭据安全诊断。Session 投影会暴露最新 turn 与事件，`inspectTurn()` 能在客户端重启后恢复活动或已结算 Receipt，产品 Driver 则发布不包含 transcript 的有界进度阶段。公共 execution ID 同时作为持久 command ID，因此传输重试不会产生第二次产品调用。

新增状态也带来明确运维责任：产品和协议版本是固定资格输入；强制终止可能需要显式处置 indeterminate；状态只向前迁移；产品原生权限仍是权威，不继承 DSH 文件沙箱。人工写接管、排队与公平性、亲和调度、durable Jobs 投影、远程传输、类型化物理 schema、provenance 与 actor-host 迁移仍后置，且必须以独立 seam 或版本化契约接入。

智能自动是主动策略，但不是新的不透明路由权威：可见的主模型依据当前请求和实时 descriptor 作出决定，所选策略则被记录并可检查。因此它改善缺省体验，但不宣称确定性最优路由；训练式排序与成本/容量优化仍属后置，多算子 DAG 调度则归属已链接的 orchestration 决策。

单 step 覆盖避免 Resident 连续性变成聊天模型权威。连续的已路由任务会获得不同 dispatch 与 command identity，只有被中断且尚未交付的 dispatch 才复用 Receipt。无法满足委派条件的短追问会回到主模型，而不是重放最近一次已结算的 Resident 输出。

Electron 打包不会改变 daemon 权威。Electron 宿主仅在 child-only RunAsNode 模式下重新进入启用了 fuse 的自身可执行文件，以启动同一个 standalone daemon entry；daemon 会在任何产品 Driver 进程启动前移除该标记。这样 DSH/HMR 生命周期、daemon 生命周期与 Claude/Codex 产品生命周期继续分离，Desktop shell 不会成为第二个控制面。

## 验证

- 单元、协议、Loader composition、HMR 所有权、Receipt 冲突与恢复、Artifact、脱敏、符号链接、interrupt/reset 和 Unix-WebSocket transport 测试均通过。仓库完整测试达到 13,457 项通过；剩余 app-boot/SDK 超时失败可在本变更外复现，而本次触及的 catalog 与 ACP 用例单独运行通过。
- MacBook 上 Claude Code 与 Codex 都以原生订阅产品通过资格审查，且 API-key 环境变量已移除。独立 DSH 客户端分别恢复同一原生 Claude Session 与 Codex thread；两者在 Resident daemon 重启后仍保留随机 nonce。Codex 中断后 Session 仍可 inspect，带 revision 门禁的 reset 只移除关联，不删除原生历史。
- 全新沙箱 profile 通过 `dsh plugin` 安装预构建 Bundle，`--dump-config` 显示双模式路由，随后可完整移除 composition layer。Packed-import 验证发现并修复了带 hash daemon chunk 的发布白名单与 Claude Agent SDK peer 闭包问题。
- Codex daemon transport 会在仅属主可访问的 Unix socket 上执行真实 WebSocket upgrade。真实 canary 在发布前拒绝了先前把 NDJSON 直接接到 `proxy` 的错误假设。
- Electron bootstrap 聚焦测试证明：当前宿主环境不被修改、detached Electron 子进程收到 RunAsNode、daemon 与产品环境会不区分大小写地移除该标记。打包后 `.app` 的真实验收属于 Desktop 发布门禁，不由 daemon 单元测试代替。
- 路由回归测试先交付一次 Claude 结果，再重新挂载 Consumer，并验证短追问只调用一次主适配器，不启动或重放第二次 Claude 请求。持久 dispatch 会保留用于恢复的主模型配置。
- Mac mini 尚不满足 canary 准入：Claude Code 报告未登录订阅；Codex launcher 因 Homebrew `simdjson` 动态库缺失而损坏；standalone daemon 尚未安装；DSH runtime 也未部署。默认 profile 没有修改。
