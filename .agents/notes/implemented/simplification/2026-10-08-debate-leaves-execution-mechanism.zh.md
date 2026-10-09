# Agent Note：Debate 退出执行机制

Status: implemented

[English](2026-10-08-debate-leaves-execution-mechanism.md) | 中文

## 问题

Debate 曾是会话级执行机制。在协作菜单里选它，或执行 `/debate-mode enabled`，宿主适配器就会用流式的阵容讨论记录回答每条直接消息，而不是用会话的主模型，物理算子路由器也会让位。这让 Debate 成了与狗窝并列的第二种运行会话的方式。狗窝是长期成员接活的地方，目标方向是这些成员互相辩论、评论和审核对方的工作，所以 Debate 应当属于狗窝，而不是替换会话的模型。

## 决定

执行机制选择器只提供自动、标准和 RLM。Debate 选项、`/debate-mode` 命令、`debateExecutionPreferences` 投影、`dsh-debate-host` 模型适配器、它的两个 Agent 钩子、流式讨论记录，以及路由器对已启用 Debate 的让位都被移除。标准现在只表示关闭 RLM。保存过已启用 Debate 偏好的会话，路由方式与其他会话相同。

Debate 引擎保留。`ctx.debates`、本地持久化 Provider、TaskGraph 绑定、`/api/debates` 面板和面向模型的 `debate` 工具的契约不变。[工具](../../../../packages/orchestration/tool-debate/README.md)只在狗窝会话中启动 Debate，并在同一次调用中批准，在任何会话中仍可列出、检查和控制 Run。

已发布的数据保持可读。`debate/preferences` 和 `debate/dispatch` 一直以可忽略事件写入，所以包含它们的日志按未知可忽略事件的持久化规则加载，并由一个契约测试固定。API 代理的请求路由恢复继续跳过旧会话可能仍记录的 `dsh-debate-host/debate`。`debate/admission` 保留声明，因为工具仍会写它。

## 考虑过的替代方案

**隐藏选项但保留命令。** 命令会让会话级接管仍可到达，并让两个钩子和讨论记录代码继续为产品已不提供的模式存活。

**删除 Debate 的包。** 已持久化的 Debate Run、面板和工具的 trace 投影仍在使用，狗窝也需要同样的持久化 Run、预算和审批机制。

**让工具继续受已移除的偏好控制。** 默认值是 `disabled`，没有修改途径时工具永远无法启动 Run。

## 后果

在狗窝成员填充阵容之前，从狗窝启动的 Debate 使用固定的默认阵容，即 Codex 和 Claude Code 算子。Debate 不再流式写入聊天，进展显示在 Debate 面板和 `debate/trace` 事实中。把阵容槽位分配给狗窝成员，需要能指定多个成员的 TaskGraph，因为目前一个 Run 只准入一个 `gouziRecipient`。这一项，以及成员互相评论和审核对方的结果，是另外的改动。
