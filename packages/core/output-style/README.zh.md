# dsh-output-style

[English](README.md) | 中文

DeepSeek Harness 的可组合、可卸载回答排版指引插件。它只向 `ctx.systemPrompt` 贡献一个有序段；不会改写模型输出、追加伪造的 Session 消息，也不会拦截 agent loop。

默认策略要求排版服从答案逻辑：先给结果；多部分内容使用简短标题；并列事项使用列表；重复字段比较使用表格；代码使用围栏代码块；避免原始 HTML、内部 ID 和挤成一段的长文本。问候和简单的一句话问题仍直接、简洁；用户明确指定的格式始终优先。

## Cordis 接口面

- 插件名：`output-style`
- 注入：`ctx.systemPrompt`
- 提示词段：`output-style:response`，顺序 `25`
- 卸载后立即移除该提示词段。

Complete persona 会按设计替换全部附加提示词段。希望采用本策略的 complete preset 必须显式组合 `ANCHORED_STANDARD_PERSONA` 或 `OUTPUT_STYLE_GUIDANCE`；随附的 Anchored Standard preset 已这样处理。原始 Minimal preset 仍是精确提示词例外。

## 模型体验

该指引是稳定、可审计的模型输入，不会在生成后篡改回答。不能依赖提示词遵从性的领域界面仍由确定性渲染器负责；例如 Debate 会根据结构化状态渲染名册、楼层、主张和生命周期。
