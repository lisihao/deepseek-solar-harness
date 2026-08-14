# Agent Note：可配置远程网页模块

状态：已实现

[English](2026-08-13-mac-mini-remote-sidebar-modules.md) | 中文

## 问题

DeepSeek Harness 需要一个简单、可安装且能启动多个独立配置实例的插件。每个实例都要出现在左侧栏，并打开部署者指定的目标网页本身。GenesisPod 与 ThunderOMLX 是首个部署值，但这两个服务都不应进入包契约。健康摘要、服务专用 API 适配器以及两个硬编码按钮都不符合这个需求。

具体的 MacBook 部署通过 SSH 转发访问仅绑定 Mac mini 回环地址的服务。ThunderOMLX 允许 frame，但 GenesisPod 同时返回 `X-Frame-Options: SAMEORIGIN` 和 CSP `frame-ancestors 'self'`，所以即使两个进程都在同一台机器上，直接跨 Origin 的 iframe 仍会被浏览器阻止。

## 决策

**由一个可安装的双端插件管理配置实例数组。** `@deepseek-ai/dsh-client-ui-remote-modules` 声明自己的默认禁用 bundle 行。该行的 `instances` 数组就是多实例边界：每一项拥有唯一 id、名称、完整 HTTP(S) 目标 URL、中继端口和顺序。实例配置完全通用，包内没有 GenesisPod 或 ThunderOMLX 分支。

**每个实例拥有一个目标固定的回环中继。** Host 为每个实例启动一个绑定 `127.0.0.1` 的中继。进入的路径、方法、请求体、Cookie、重定向、流式响应和 WebSocket upgrade 始终落在唯一配置的目标 origin 上，因此它不是开放代理。中继移除 `X-Frame-Options` 以及 CSP 中唯一的 `frame-ancestors` 指令，使部署者授权的网页可以显示在 Harness 中；其余安全策略和网页字节保持不变。配置稳定中继端口后，Harness 重启前后的浏览器 Origin、Cookie 与 local storage 都能保持。

**浏览器展示目标应用，而不是对它的观测。** Host 在 `/remote-webpages/v1/instances` 发布 `no-store` 实例清单。Client controller 验证清单后写入根作用域 `defineStore`。可叠加的 `sidebar.footer.action` slot 只有一个 occupant，它把动态实例渲染为纵向条目。打开条目时恰好创建一个指向该实例中继 URL 的 iframe，并提供重新加载、新窗口打开和关闭控件。实现中不存在健康路由、归一化服务快照或服务专用面板。

**插件拥有持久化的多实例配置界面。** Host 在用户设置服务中注册 `ui-remote-modules`，把存储的 `instances` 数组叠加在 profile 配置行之上。浏览器在**设置 → 插件**下贡献独立的**远程模块**标签页，可对 id、名称、目标 URL、中继端口与侧栏顺序执行新增、编辑、删除、重排、放弃、重置和保存。Host 配置 API 显式开放这个命名空间。由于中继监听器与稳定浏览器 Origin 在进程启动时创建，其 descriptor 标记为 `restart` 生效；编辑器会在用户保存前说明这一时序。

**SSH 与目标认证归部署所有。** 插件既不创建 SSH，也不采集应用凭据。MacBook 示例转发 GenesisPod 前端和 ThunderOMLX 页面入口，而服务仍绑定 Mac mini 回环地址。目标应用自己的 OAuth、local storage、Cookie、绝对 API 端口与登录身份仍全部留在各目标应用内部。

## 考虑过的替代方案

**保留服务专用原生健康面板。** 拒绝，因为它展示的是运维摘要而不是两个服务本身，而且把首个部署硬编码进一个本应复用的插件。

**不经中继直接 iframe 目标。** 拒绝，因为真实 GenesisPod 前端禁止跨 Origin frame，这会在必需部署中直接复现浏览器级失败。

**在 Harness Origin 下提供带路径前缀的反向代理。** 拒绝，因为通用应用常使用 `/_next/*` 这类绝对资源和 API 路径，透明改写子路径非常脆弱。每实例独立回环 Origin 能保留目标的根路径语义。

**每个浏览器实例创建一条 Cordis loader 行。** 本版拒绝，因为 client module 启动清单按包名去重，重复行不会创建重复的浏览器插件 fiber。包自己拥有的 `instances` 数组提供了明确且可测试的多实例契约，不需要修改全局启动语义。

## 测试

聚焦 Host 测试固定 URL 与标识验证、重复项拒绝、存储配置优先级与重启元数据、多中继生命周期、目标路径与查询转发、完整 HTML 传递、Cookie 保留、反 frame header 移除、清单 method gate 和销毁。Client 测试固定动态清单加载、单一可叠加 slot occupant、本地化配置标签注册、完整实例校验与持久化、纵向多条目渲染、真实 iframe URL、重新加载、新窗口打开和关闭行为。

一个无密钥真实组合浏览器场景用两个本地目标服务启动组装后的 Web 应用。GenesisPod fixture 会刻意发送与部署服务相同的反 frame header，并加载外部脚本。浏览器测试证明 iframe 内可见目标标题且脚本确实执行，然后再打开独立的 ThunderOMLX 服务 UI 与已填充的远程模块配置标签。测试还断言纵向几何关系，并确认旧健康面板文案不存在。

## 结果

首个部署可以配置 GenesisPod 和 ThunderOMLX，后续部署也可在不改代码的情况下新增、删除、重排或重命名任意网页实例。插件明确把运行时信任边界扩大到部署者配置的 Web 应用，因此部署者必须只配置受信任目标。回环中继限制了网络暴露，但目标专用认证、硬编码 API Origin、Service Worker 和 OAuth 重定向策略仍可能需要在包外做部署处理。
