# Agent Note：狗窝成员以阵容角色辩论

Status: implemented

[English](2026-10-09-kennel-debate.md) | 中文

## 问题

Debate 的阵容跑在主实例自己的 Codex 和 Claude Code 算子上，而狗窝一次只能把一条消息发给一个成员。成员之间无法就一个问题互相辩论。目标方向是成员既能接活，也能互相辩论、评论和审核对方的工作。

## 决定

狗窝会话里的用户消息可以启动一场阵容槽位由成员担任的 Debate。[调度器](../../../../packages/orchestration/ui-gouzi/README.md)为每个至少有三个已启用成员在可用入口上持有的项目提供一个 `debate` 候选，点名某个成员的消息不会得到它。只有用户要求多个成员一起辩论、讨论或评审同一个问题时，AI 才会像选择其他候选一样按身份选择它。

角色按注册表顺序分配：靠前的成员依次担任建议者、证伪者，有第四个成员时担任证据审计者，最后一个成员担任裁判。至少需要三个成员，这样裁判不会参与辩论。每个成员运行能够服务其固定模型的入口，没有固定模型时运行第一个可用入口，使用固定的模型或该入口 catalog 的默认模型。默认模型由 daemon 以 `GouziOperatorCapability.defaultModel` 报告，因为 Host 进程看不到成员的远程 catalog。

调度器不了解 Debate 策略。[`debate-orchestration`](../../../../packages/orchestration/debate-orchestration/README.md) 把它注册为 `debate` [协作类型](../architecture/2026-10-09-kennel-collaboration-kinds.md)：它提供候选，分配角色，用 `defaultDebateBudget` 推导普通的三轮预算，启动 Debate，并在后台批准，因为批准会在各轮结算后才返回。共用的人设、轮次协议、收敛规则和预算移到了 `@deepseek-ai/dsh-debate`，工具和狗窝使用同一份。

每一轮的 Graph 都带着[接收者集合](../architecture/2026-10-08-gouzi-recipient-sets.md)准入，集合来自成员当前的 generation。daemon 随后逐个成员检查可用性、工作区和授权，把成员与其他算子混用的轮次会被拒绝。

## 考虑过的替代方案

**让面向模型的 `debate` 工具挑选成员。** 狗窝消息被调度器消费，不会到达总管，所以工具在这里没有调用者，还会把成员选择交给模型。

**让狗窝插件导入 `@deepseek-ai/dsh-debate`。** 狗窝插件会依赖 Debate 策略，清单也会变化。服务把策略留在 Debate 的包里。

**允许两个成员。** 裁判就得是辩论者之一。

## 后果

进展以本会话的 TaskGraph Run 显示在房间里，并归属到各成员，同时显示在 Debate 面板中，不会流式写入聊天。用户暂时不能选择成员或角色，角色也不使用成员自己的角色模板。没有任何可用入口提供其固定模型的成员会被排除，合格成员少于三个时不提供 Debate。成员还可以通过 `review` 类型评审彼此已完成的工作。远程主机上真实的 Codex 和 Claude Code catalog 尚未在此验证。
