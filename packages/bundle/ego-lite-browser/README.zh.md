# @deepseek-ai/dsh-ego-lite-browser

[English](README.md) | 中文

可装卸的 Ego Lite 浏览器 Bundle。它组合三个彼此解耦的角色：

- `@deepseek-ai/dsh-browser`：通用 `ctx.browser` Service Definition。
- `@deepseek-ai/dsh-browser-ego-lite`：Ego Lite Provider。
- `@deepseek-ai/dsh-tool-browser`：闭合计划的模型 Consumer。

其他 DSH 插件只注入 `browser`，不依赖 Ego Lite 包。替换 Provider 不需要修改
Consumer。Bundle 不携带或重新分发 Ego Lite 浏览器；用户必须单独安装并完成其
本机引导。
