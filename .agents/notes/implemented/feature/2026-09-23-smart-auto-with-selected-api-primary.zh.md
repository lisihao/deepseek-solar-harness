# Agent Note：选中 API 主模型时保持智能协作生效

状态：已实现

[English](2026-09-23-smart-auto-with-selected-api-primary.md) | 中文

## 问题

Desktop 总会安装模型选择，因此每个请求都带有已选主模型。[ChatGPT Web 协作](../../rejected/feature/2026-09-23-chatgpt-web-coordination.md)变更引入的主模型归属规则，在 Smart Auto 评估已选 API 主模型之前就已返回。因此 Smart Auto 在 Desktop 中从不把可识别的工作路由到物理算子；它唯一的自动路径只在未安装模型选择时运行，而路由测试恰好使用这条路径。`taskgraph-candidate` 决策只是一条无人读取的 ignorable 日志事件，模型从未收到构建该决策所描述 TaskGraph 的请求。任何 180 字符及以上的请求都被视为可并行，所以一篇长粘贴文档会被标记为 TaskGraph 候选。

## 决策

`auto` 策略对已选 API 主模型和未安装选择的请求采用同一套决策。带有明确并行或多角色模式的请求成为 TaskGraph 候选，可识别的实现或分析工作针对该请求路由到一个有界物理算子，其余工作留在主模型。已选的 Codex、Claude Code 或 ChatGPT Web 主模型永远不会被替换，`direct`、`codex`、`claude-code` 与 `chatgpt-web` 策略保留已选主模型规则。

TaskGraph 候选的第一次路由决策会追加一条插件来源的用户消息，要求协调者通过 `orchestration` 工具启动 TaskGraph，或用一句话说明该请求为何没有独立分支。该消息进入日志，因此模型可见输入仍可重建。当 Agent 没有 `orchestration` 工具或 Debate 接管 Session 时不追加。请求长度不再把工作标记为可并行。

## 备选方案

**保留被动候选并修改设置名称。** 这样诚实，但所选模式除提示词外等同于 `direct`，不是用户所选择的协作。

**只依靠系统提示指引让主模型自行决定。** SMART AUTO 段落已经要求模型做这个决定，而实际观察到的 Desktop 会话中模型选择了不协作。把逐请求指令绑定到已记录的路由决策，是让分类真正可执行的最小改动。

## 后果

- 在 `auto` 且 DeepSeek API 为主模型时，可识别的编码工作交给 Codex、分析工作交给 Claude Code，并沿用现有的 Claude 到 Codex 回退；下一个请求回到主模型。
- 路由测试覆盖安装模型选择路径下的算子派发、TaskGraph 指令与长单任务文本。
- 梁神预设 Session 的首个请求仍只放行用户直接消息，因此无法收到 TaskGraph 指令。
