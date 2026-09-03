# @deepseek-ai/dsh-ego-lite-browser

[English](README.md) | 中文

可装卸的 Ego Lite 浏览器 Bundle。它组合三个彼此解耦的角色：

- `@deepseek-ai/dsh-browser`：通用 `ctx.browser` Service Definition。
- `@deepseek-ai/dsh-browser-ego-lite`：Ego Lite Provider。
- `@deepseek-ai/dsh-tool-browser`：闭合计划的模型 Consumer。

其他 DSH 插件只注入 `browser`，不依赖 Ego Lite 包。替换 Provider 不需要修改 Consumer。Bundle 不携带或重新分发 Ego Lite 浏览器；用户必须单独安装并完成其本机引导。

## 模型体验

### 挂载的浏览器 Consumer

#### 模型看到什么

Bundle 本身不贡献任何模型文字。挂载后会增加由 [`@deepseek-ai/dsh-tool-browser`](../../browser/tool-browser/README.md) 持有的稳定浏览器策略和闭合 `browser` 工具 schema；Service Definition 与 Ego Lite Provider 对模型保持不可见。

#### Token 影响

启用 Bundle 会增加一个固定策略段落、一个固定工具 schema，并在每次浏览器调用后增加一个由 Provider 限制的结果。

#### KV Cache 影响

挂载的策略和 schema 在各轮次间保持稳定。启用、禁用或修改 Browser Consumer 会使组装后的提示词从其插入点开始失去缓存命中。

## 已知限制与延期工作

- **Ego Lite 仍是外部前提** — Bundle 不重新分发浏览器，也不负责完成本机应用引导。
- **模型工具只开放可移植 v1 子集** — 当前 Workspace 选择、保证新建标签页、原生页面列表、截图和控制权移交仍不对模型开放。
