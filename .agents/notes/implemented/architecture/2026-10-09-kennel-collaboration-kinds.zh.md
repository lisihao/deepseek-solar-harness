# Agent Note：狗窝协作类型

Status: implemented

[English](2026-10-09-kennel-collaboration-kinds.md) | 中文

## 问题

成员一次接一个任务，而狗窝还需要他们互相辩论、评论和审核彼此的工作。Debate 是按名字写死在调度器里的：它有自己的候选模块、两个会话事件和提示中的一句话。每增加一种协作方式，调度器、会话事件词汇表和不变量伴随插件里都要做同样的修改，调度器也要了解每一种策略。

## 决策

调度器自己提供工作和控制候选，把其他所有协作方式都当作注册到 `ctx.kennelCollaborations` 的**协作类型**。服务定义和类型的契约在 `@deepseek-ai/dsh-orchestration` 中；[`ui-gouzi`](../../../../packages/orchestration/ui-gouzi/README.md) 提供注册表并使用它；每个类型是一个在 `ctx.effect` 中注册自己的插件。

类型有名称、`guidance` 句子、`offer(facts)` 和 `start(request)`。`facts` 包含成员、他们的执行入口、本会话按新到旧排列的 Run，以及用户点名的成员。调度器把每个提供了候选的类型的 `guidance` 加进选择指令，并记录两个通用事件：启动前的 `kennel/dispatch-collaboration`，和启动后带有各成员分工的 `kennel/dispatch-collaboration-admitted`。两者都是 `ignorable`。

候选 id 必须写明提供候选所依赖的一切。Host 不给类型单独的确认步骤：它在记录之前和启动之前，用新的 facts 再次调用 `offer`，并拒绝 id 已不再提供的选择。所以类型不会漏掉对成员、入口、模型或对象的复查。Host 还拥有资源限制并随请求传入，类型不需要自己的限制。`bindKennelMember` 和 `qualifiedKennelMembers` 让类型使用与调度器处理工作时相同的入口和模型规则。

目前有两个类型。`debate`（[`debate-orchestration`](../../../../packages/orchestration/debate-orchestration/README.md)）是之前的[狗窝辩论](../feature/2026-10-09-kennel-debate.md)，移到了这个接口后面。`review`（[`kennel-review`](../../../../packages/orchestration/kennel-review/README.md)）提供一个已完成的狗窝任务，让其他成员以只读文件权限阅读它，并要求给出结论和意见。评审是一个普通的 TaskGraph Run，每个评审人一个节点，所以房间、授权和调度都已适用。做过这个任务的成员不会评审它；点名某个成员的消息会让该成员成为唯一的评审人。

## 考虑过的替代方案

**一个带 mode 字段的通用协作。** Debate 和评审在阵容、图和预算上都不同；mode 字段会把它们的策略放进共享代码，每个新类型都要修改它。

**每个类型一个独立服务（`kennelDebates`、`kennelReviews`）。** 调度器要写明每个服务和事件，这正是本笔记要消除的问题。

**每个类型一个确认方法。** 每个类型都要重复 `offer` 已做的检查，漏掉一项就会让工作在已变化的成员上启动。

## 后果

增加一种协作方式只需要一个注入 `kennelCollaborations` 并注册类型的插件；调度器和事件词汇表都不用改。模型读取的候选 JSON 会随类型增长，受调度器输入上限约束。类型名全局唯一，`work`、`control` 和 `clarify` 为保留名。随包提供的类型只在挂载其包的地方可用；Desktop 在下次封装包输入时才会得到 `kennel-review`。评审结论是文本；目前没有任何代码把它当作裁决、重新打开任务或要求作者回复。
