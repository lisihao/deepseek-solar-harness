# 持久能力的界面归能力插件所有

[English](2026-08-25-durable-surfaces-belong-to-capability-plugins.md) | 中文

DSH Server 是 Resident 物理算子会话和持久编排 Run 的唯一权威，Desktop、浏览器和手机客户端只是该权威的投影。因此，能力界面归能力包所有，而不应放在 Desktop 产品插件内部。

`@deepseek-ai/dsh-ui-orchestration` 与 `@deepseek-ai/dsh-ui-physical-operator` 都是双面插件。Host 半面注册经过认证的 HTTP 投影，Client 半面注册普通 Cordis 插槽。Resident Bundle 挂载自己的 UI 包，Orchestration Bundle 已挂载自己的 UI 包，所以纯 Server profile 不需要导入 Electron 或 Desktop 代码，也能在 boot manifest 中发布两个浏览器模块。Desktop 现在只贡献产品品牌与原生外壳行为。

所有通用 Client HTTP 界面统一使用 `ctx.connection.request`。Connection Service 会附加与主要远程传输相同的内存态 Bearer，因此功能插件不导入凭据存储，也不需要知道页面是本地模式还是 frontend-only 模式。Host 路由共享 `authorizeRemoteRequest`：严格的 loopback 请求可在本机读取，非 loopback 请求必须通过 Remote Auth Bearer。Resident 投影保持只读；任务执行和持久状态修改仍由既有 Resident 与 Orchestration Service 持有。

这个拆分让本地 Desktop、Mac mini Server 和远程浏览器客户端使用同一张包图。客户端断线只会卸载自己的插槽贡献，不能停止 daemon、结算 Run 或创建第二个状态写者。Server-only 组合测试必须在不挂载 Desktop 插件的情况下证明两个 API 与两个 boot-manifest 模块都存在。
