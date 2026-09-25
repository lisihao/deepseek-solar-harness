# Agent Note: 将回环权威绑定到服务器观测的 TCP 对端

Status: implemented

[English](2026-08-26-peer-bound-loopback-authority.md) | 中文

## 问题

浏览器信任栅栏通过验证 Host 与 Origin 阻止 DNS rebinding，但任意 HTTP 客户端都能自行填写这些头。若把回环 Host 当成本机所有者认证，远程对端就能发送 `Host: localhost:3080` 并触达仅限本机的行为。node 到 Fetch 的桥接还会丢弃 `socket.remoteAddress`，导致共享 RPC 处理器无法区分真正的回环连接与伪造头。Typert interceptor 会在 API Proxy fallback 之前认领端点，因此只在 fallback 中认证无法覆盖完整 `/api` 路径。

## 决策

Host 与 Origin 继续负责可达性和浏览器混淆代理防御。本机所有者权威同时要求回环 Host 与 Node 服务器观测到的回环 TCP 对端。HTTP bridge 将 `socket.remoteAddress` 作为内部 `FetchRequestContext` 传递，RPC 分发再把它复制到 `ConnectionRpcRequestContext`；这两个值都不来自请求头。

共享 `/api` 路由会在 Typert interception 或 API Proxy fallback 之前认证每个非回环对端。Remote Sync 关闭时拒绝非回环请求；启用时要求有效的 Remote Auth bearer。Pocket 凭据仍只允许显式的读取与响应操作。Remote Auth 和 Remote Sync 专用通道保留各自的端点检查，包括绑定对端的本地配对签发与 bearer 保护的管理操作。`trustedHosts` 只允许服务权威通过 rebinding 栅栏，绝不认证客户端。

## 曾考虑的替代方案

- **保留只看 Host 的本地判定。** 否决，因为 Host 对重绑定浏览器不可伪造，但 curl、代理与自定义客户端可以完全控制它。
- **只在 API Proxy fallback 中认证。** 否决，因为已注册的 Typert interceptor 会在 fallback 之前认领请求，从而留下未认证路径。
- **只依赖回环监听。** 否决，因为 Server 产品支持经过认证的远程 Frontend 与隧道；网络可达性变化后，授权规则仍必须正确。

## 后果

- 远程对端发送回环 Host 时，会在应用分发前收到 401 或 403；真正的回环对端保留本机所有者行为。
- 直接连接的远程 Frontend 会在 API 与事件请求中携带短期 bearer。经过认证的回环隧道在 Server 看来仍是本地连接。
- 调用共享 Fetch handler 的载体适配器必须提供服务器观测到的对端地址；地址缺失时，本机所有者检查会关闭失败。
- 回归覆盖分别验证 API Proxy、Typert interception、配对签发、Remote Sync、仅回环 RPC 与 WebSocket upgrade 路径。
