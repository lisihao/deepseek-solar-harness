# @deepseek-ai/dsh-tool-browser

[English](README.md) | 中文

`ctx.browser` 的模型侧 Consumer。它把模型输入限制在闭合、版本化的
`BrowserRunPlanV1`，不暴露 Provider 的命令行、原生 tab/target/ref，也不把
`browser-js-v1` 任意程序面开放给模型。

模型可见的计划同时限制在默认 Ego Lite v1.2.5 Provider 能保证实现的能力内：
选择 `named` 或 `existing` 工作区，`open` 只能使用 `reuse: "exact-url"`，需要
选择已经打开的页面时使用带 URL 匹配的 `select-page`。`workspace: { kind: "current" }`、
`open` 的 `reuse: "never"` 和 `pages` 操作会刻意从这个 schema 中排除。Ego Lite
无法通过公开辅助 API 识别当前任务空间，无法保证不复用地新建标签页，也无法把
原生 target id 导出为可移植的页面键。Consumer 会在调用 `ctx.browser` 之前拒绝
这些计划，因此模型不会再收到一个 schema 合法、但在随附 Provider 中必然失败的请求。

其他可信插件应直接注入 `browser` 并调用 `ctx.browser`；它们不需要、也不得依赖
Ego Lite Provider。模型工具支持打开/选择页面、导航、语义快照、定位、点击、填写、
读取、等待和完成 Workspace。截图和控制权移交仍保留在可信插件 API。

遇到用户接管或 Workspace 失效时，底层 Provider 的稳定错误直接上浮；Consumer
不会自动重试、夺回控制权或重建任务。
