# Agent Note: 持久能力的界面归能力插件所有

Status: implemented

[English](2026-08-25-durable-surfaces-belong-to-capability-plugins.md) | 中文

## 问题

DSH Server 是 Resident 物理算子 Session 和持久编排 Run 的唯一权威，但它们的浏览器面板与 Resident HTTP 投影位于 Desktop 产品插件中。因此，纯 Server profile 虽能运行 daemon，却不会发布浏览器模块和 `/api/resident-operators`；frontend-only 浏览器也必须依赖 Electron 所属代码才能观察这些能力。

## 决策

`@deepseek-ai/dsh-ui-orchestration` 与 `@deepseek-ai/dsh-ui-physical-operator` 都采用双面能力插件结构。Host face 注册经过认证的有界 HTTP 投影，Client face 注册普通 Cordis 插槽。Resident Bundle 与 Orchestration Bundle 挂载对应 UI 包，使纯 Server、本地 Desktop 与远程 frontend 客户端共用一张包图，不导入 Electron 代码。

通用 Client HTTP 界面使用 `ctx.connection.request`，由它附加与主要远程传输相同的内存态 Bearer。Host 路由共享 `authorizeRemoteRequest`：严格的 loopback 请求可在本机通过，非 loopback 请求必须携带 Remote Auth Bearer。Resident 投影保持只提供 GET；持久变更继续归既有 Resident 与 Orchestration Service 所有。

## 后果

- Desktop 只拥有产品品牌与原生外壳行为，不再复制通用 Resident、路由和编排界面。
- Client 断线只会卸载自己的插槽贡献，不能停止 daemon、结算 Run 或创建另一个状态写者。
- 纯 Server 组合必须在不挂载 Desktop 插件时证明两个 API 与两个 boot-manifest 模块都存在。
- 第一条远程纵切通过刷新有界快照工作；基于 cursor 的实时事件流仍后置。

## 曾考虑的替代方案

**将界面继续留在 Desktop。** 否决，因为 Server 与手机／浏览器客户端会依赖 Electron 产品包，而且纯 Server 会继续缺失必要投影。

**增加独立远程 Dashboard 应用。** 否决，因为这会复制现有 Cordis Client 组合，创建另一张 UI 包图，而不是复用能力所属 face。
