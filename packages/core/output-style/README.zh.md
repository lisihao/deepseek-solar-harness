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

## Model Experience

### Response presentation system prompt

#### What the model sees

普通组合会在 identity 和 persona 后收到下方稳定的 `output-style:response` 段。Complete persona 会替换附加段，因此必须显式组合同一个导出指引；Anchored Standard 已这样处理。该策略始终是可审计的模型输入，不会在生成后篡改回答。

##### Default response guidance

```markdown
Output style:
- For analysis, plans, comparisons, implementation work, or any multi-part answer, lead with the conclusion or result. Use short descriptive headings and one blank line between sections. Use lists for parallel items, tables only for repeated comparisons, and fenced code blocks for code or structured payloads.
- Make hierarchy, ordering, and visual formatting mirror the reasoning. Keep user-facing output free of raw HTML, internal IDs, or run-on unstructured text unless the user explicitly asks for diagnostics or an exact format.
- For greetings and simple one-line questions, answer directly and briefly. Follow an explicit user-requested format over these defaults.
```

#### Token effect

只要最终 persona 不是 complete，每次请求就包含一次固定指引；显式组合它的 complete persona 也只携带一次等价文本。

#### KV Cache effect

只要段文本与顺序不变，前缀即可稳定复用。加载、卸载或编辑该段会从第一个变化的 system-prompt token 起令缓存失效。

## 已知限制与后续工作

- 模型指引不能保证所有 Provider 都精确遵循排版要求；Debate、轨迹等确定性界面仍必须直接渲染结构化状态。
- 原始 Minimal preset 为保持精确兼容契约，按设计不加载这段指引。
