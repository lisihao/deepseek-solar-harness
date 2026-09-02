# @deepseek-ai/dsh-tool-browser

[English](README.md) | 中文

`ctx.browser` 的模型侧 Consumer。它把模型输入限制在闭合、版本化的
`BrowserRunPlanV1`，不暴露 Provider 的命令行、原生 tab/target/ref，也不把
`browser-js-v1` 任意程序面开放给模型。

其他可信插件应直接注入 `browser` 并调用 `ctx.browser`；它们不需要、也不得依赖
Ego Lite Provider。模型工具支持打开/选择页面、导航、语义快照、定位、点击、填写、
读取、等待和完成 Workspace。截图和控制权移交仍保留在可信插件 API。

遇到用户接管或 Workspace 失效时，底层 Provider 的稳定错误直接上浮；Consumer
不会自动重试、夺回控制权或重建任务。
