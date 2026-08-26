# @deepseek-ai/dsh-client-connection

[English](README.md) | 中文

协议消费层：客户端插件的 apply 会挂载 `ctx.connection`（共享 API 客户端 + 当前页面的 loopback 状态 + 可观察且按 generation 生效的 `hostDescription` + 单消费方流循环启动器）；导出表层携带协议约定类型、`AbstractApiClient` 抽象，以及循环的 sink／配置类型。每次就绪握手成功后，都会在 `onConnected` 之前发布完整的 `host.describe` 值；generation 失效或显式 stop 会清空它，因此原生能力消费者不会保留已经断线的判断。浏览器载体以 HTTP POST 发送 unary／respond，并为 `events.mux` 与 `events.host` 各开一条只下行的 WebSocket；进程内载体满足同一双流抽象。Host half 持有唯一 `/api` route 及其 Fetch bridge；已注册的 Typert interceptor 会先认领自己的 Remote endpoint，未认领请求再回退 API Proxy。Loopback hostname 判定逻辑留在包内部：`/api` Host fence 与 WebSocket upgrade 会直接使用它，其他客户端插件则消费派生的 `ctx.connection.isLoopback` 状态。node 半侧将可达性与权威分开：Host 和 Origin 必须通过浏览器信任栅栏；本机所有者权威还要求服务器观测到的 TCP 对端与 Host 都是回环；非回环对端必须在进入任何 API Proxy 或 Typert interceptor 之前用 Remote Auth bearer 完成认证。`trustedHosts` 绝不认证调用方；Remote Sync 关闭时，所有非回环 API 与事件请求都会被拒绝。平台载体与 ConnectionController 循环属于包内部；apply 负责选择并驱动它们。下行边界见 [WebSocket 下行载体 Agent Note](../../../.agents/notes/implemented/architecture/2026-08-04-websocket-downlink-carrier.md)。

## /api 浏览器信任栅栏

node 半侧在桥接或 upgrade 前守卫 `/api` 下的每个入口（`src/api-request-trust.ts`）。每个请求——无论是否带浏览器标记——`Host` 都必须是回环地址权威，或与某个 `trustedHosts` 条目匹配：带端口的 `host:port` 条目精确匹配，不带端口的条目匹配任意端口，两侧均经 WHATWG 归一化后比较（DNS rebinding 防御）。刻意不为无标记 HTTP 请求开捷径：明文 HTTP 下浏览器的图片与导航读取既不带 `Origin` 也不带 Fetch-Metadata，因此无标记请求仍可能是被重绑页面发起且响应可读的读取。若带标记，`Origin` 必须与 Host 权威相同，显式的 `sec-fetch-site: cross-site` 一律拒绝。不是纯规范 `host[:port]` 权威的 `trustedHosts` 条目会让插件加载明确失败。权威栅栏不能认证非浏览器客户端，因为它们可以自行填写 Host 头。因此，本机所有者权威要求 Node 载体的 `socket.remoteAddress` 与 Host 同为回环；桥接层通过 `FetchRequestContext` 和 `ConnectionRpcRequestContext` 将该地址与调用方可控头分开传递。每个非回环 `/api` 请求都会在共享 Typert 拦截或 API Proxy 回退前完成认证，而 Remote Auth 与 Remote Sync 专用通道各自实施端点 scope。非回环对端伪造 `Host: localhost:3080` 仍属于远程请求，必须提供有效 bearer。决策记录：[浏览器信任栅栏](../../../.agents/notes/implemented/architecture/2026-07-28-api-browser-trust-boundary.md)与[绑定对端的本地权威](../../../.agents/notes/implemented/architecture/2026-08-26-peer-bound-loopback-authority.md)。

## `/api` WebSocket 下行

`/api/events.mux` 与 `/api/events.host` 各接受一条 WebSocket upgrade，并只向浏览器发送对应的 `ServerRequest` 文本消息；客户端不会在这些 socket 上发送业务数据。任一 socket 结束都会使当前 connection generation 失败并重建两条流，连接就绪仍要求两条 socket 均已打开且 `host.describe` HTTP 调用成功。浏览器断开只会结算并释放它自己持有的 pump，不能表现为未处理的 Host rejection。Host teardown 会终止两条 socket、中止各自的 source，并等待 source 清理完成后再返回。普通网络 GET 这些路径会返回 426，不保留 SSE（Server-Sent Events）回退；`toFetchHandler` 的 SSE 编解码只服务进程内同构载体。

## 模型体验

无。协议消费层只在浏览器与主机之间搬运已经组合好的消息；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **History 会恢复未附加的会话**：打开 history 可能创建宿主侧 agent，并增加首次打开的延迟；没有仅从持久化读取的路径。
- **`/api` 桥把每个请求体整体缓冲在内存里**：`maxRequestBodyBytes`（默认 160 MiB，按默认 100 MiB 图片总量上限经 base64 膨胀加信封余量得出）因此同时是单请求的驻留内存上界；要降低它而不缩小图片限额，需要流式请求体路径。
