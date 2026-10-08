# Agent Note：一个 Run 可以绑定一组狗子成员

Status: implemented

[English](2026-10-08-gouzi-recipient-sets.md) | 中文

## 问题

为狗窝准入的 TaskGraph Run 带有一个 `gouziRecipient`：一个成员、它的 generation 和它的执行入口。daemon 把每个节点固定到这些入口，授权发放也拒绝其他成员。节点分别运行在不同成员上的 Graph，例如由成员担任角色的 Debate，或一个成员审核另一个成员的结果，无法以 Host 确认的绑定准入。不带接收者而直接写成员算子，会跳过 generation 和可用性检查，而这些检查正是绑定的意义。

## 决定

[`OrchestrationAdmissionTraceV1`](../../../../docs/subsystems/orchestration.md) 增加 `gouziRecipients`，即至少两个互不相同的成员的集合，每个成员有自己的 generation 和执行入口。单数字段仍是单个成员的形式。一个 Run 带有其中之一，不会同时带有两者，也没有两个成员共用同一入口，所以一个绑定只有一种编码。`admissionGouziRecipients` 把任一形式读成列表，daemon、授权发放、房间和调度器都通过它读取。

[daemon](../../../../packages/orchestration/orchestration-local/README.md) 先检查线路格式，然后在编译时和启动前检查：每个节点只使用各成员入口的并集且没有 fallback，每个成员都是当前且可用的，并且都持有该 Graph 的工作区。目录快照要求所有成员都在本机，只有所有成员都是远程时才跳过本地目录检查。授权发放找到发放成员自己的接收者，并对它执行单数形式的检查，所以没有列出某个成员的集合不能用来在该成员上运行。

此前写入的记录只带单数字段，读取方式不变。Graph 使用哪些成员以及 Graph 本身，仍由生产者决定；狗窝调度器目前仍为每条消息准入一个成员。

## 考虑过的替代方案

**把 `gouziRecipient` 改成数组。** 所有已存储记录和读取单数字段的旧读取方都会改变形状，只有一个成员的 Run 也会有两种写法。

**只靠节点算子绑定成员。** 没有接收者时就是这样，它会跳过 generation、可用性和工作区检查。

**每个成员一个 Run，由调用方拼接。** Debate 或审核需要一个在成员节点之间有依赖的 Graph，多个独立 Run 无法表达。

## 后果

目前还没有生产者准入集合，计划中的生产者是 Debate 阵容和成员审核。旧构建不认识复数字段，所以降级后不会对已有 Run 强制执行接收者集合；握手让构建与其 daemon 配对，避免两个构建同时共用一个状态目录。集合里的每个成员必须持有同一个工作区路径，这在单机上是自然的，跨主机时是一项约束。已绑定的 Run 与单个成员一样，保持 RLM 和 Autonomous 关闭。
