# @deepseek-ai/dsh-tool-browser

[English](README.md) | 中文

`ctx.browser` 的模型侧 Consumer。它把模型输入限制在闭合、版本化的 `BrowserRunPlanV1`，不暴露 Provider 的命令行、原生 tab/target/ref，也不把 `browser-js-v1` 任意程序面开放给模型。

模型可见的计划同时限制在默认 Ego Lite v1.2.5 Provider 能保证实现的能力内：选择 `named` 或 `existing` 工作区，`open` 只能使用 `reuse: "exact-url"`，需要选择已经打开的页面时使用带 URL 匹配的 `select-page`。`workspace: { kind: "current" }`、`open` 的 `reuse: "never"` 和 `pages` 操作会刻意从这个 schema 中排除。Ego Lite 无法通过公开辅助 API 识别当前任务空间，无法保证不复用地新建标签页，也无法把原生 target id 导出为可移植的页面键。Consumer 会在调用 `ctx.browser` 之前拒绝这些计划，因此模型不会再收到一个 schema 合法、但在随附 Provider 中必然失败的请求。

其他可信插件应直接注入 `browser` 并调用 `ctx.browser`；它们不需要、也不得依赖 Ego Lite Provider。模型工具支持打开/选择页面、导航、语义快照、定位、点击、填写、读取、等待和完成 Workspace。截图和控制权移交仍保留在可信插件 API。

遇到用户接管或 Workspace 失效时，底层 Provider 的稳定错误直接上浮；Consumer 不会自动重试、夺回控制权或重建任务。

## 模型体验

### 浏览器策略提示词

#### 模型看到什么

只要 `browser` 工具可用，Consumer 就会增加以下稳定策略段落：

##### 浏览器策略原文

```markdown
Use the browser tool when a task requires interacting with a real webpage, especially one that benefits from the user's existing browser login. Submit one ordered portable plan with the fewest necessary operations. Use a named workspace (createIfMissing true when needed) or an existing workspace id; the default Ego Lite browser cannot identify a current workspace. For open, use reuse:"exact-url"; reuse:"never" is not available. Do not request pages, because provider-native tab ids are not portable; use select-page with a URL match, then page-info or snapshot. Prefer semantic snapshots and role/label/text locators over CSS. Reuse a named workspace only when continuity matters. Never assume a click or form submission succeeded: read the resulting state in the same plan. If the browser reports user control or an inactive workspace, stop and report it; do not retry, take control, or recreate the task automatically.
```

#### Token 影响

挂载该 Consumer 时，策略会为每次组装请求增加一个固定提示词段落。

#### KV Cache 影响

该策略在各轮次间保持稳定。修改其措辞会使组装后提示词从本段开始失去缓存命中。

### `browser` 工具 schema 与结果

#### 模型看到什么

模型会收到[生成的工具目录](../../../docs/tool-catalog.md#deepseek-aidsh-tool-browser)中记录的闭合 `browser` 工具 schema。它只能看到命名或既有 Workspace、精确 URL 打开/复用、可移植页面别名、类型化语义操作，以及纯 JSON 结果或稳定错误。

#### Token 影响

工具 schema 形成固定请求成本。每次调用追加一个工具调用和一个由 Provider 限制的结果，其大小取决于请求的操作和返回的页面状态。

#### KV Cache 影响

Schema 在各轮次间保持稳定，而每次调用结果都是 Session 特有内容，会扩展未缓存后缀。Schema 变更会使组装请求从工具定义插入点开始失去缓存命中。

## 已知限制与延期工作

- **模型表面刻意比 `ctx.browser` 更窄** — 本 Consumer 不提供 `current` Workspace 选择、`reuse: "never"` 的 `open`、原生页面列表、截图和控制权移交。
- **恢复必须显式进行** — 用户接管和 Workspace 失效错误会停止计划；Consumer 不会重试、夺回控制权或重建任务。
