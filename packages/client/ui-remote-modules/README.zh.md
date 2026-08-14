# @deepseek-ai/dsh-client-ui-remote-modules

[English](README.md) | 中文

**Remote Modules** 是一个可安装、按需启用的双端 Web 插件，可在 Harness 左侧栏中嵌入任意数量由用户配置的 Web 应用。一个插件配置行接受 `instances` 数组；每一项都是独立启动的实例，拥有自己的名称、顺序、目标网页地址和本机中继。点击入口后，面板用 iframe 显示目标应用本身，而非健康状态。插件不会调用、归一化或展示服务健康接口。[Agent Note](../../../.agents/notes/implemented/feature/2026-08-13-mac-mini-remote-sidebar-modules.md)负责这项架构决策。

本包声明了可安装 bundle，并保持默认禁用：

```sh
dsh plugin --profile web add @deepseek-ai/dsh-client-ui-remote-modules
```

在 profile patch 中启用并配置 `ui-remote-modules` 行。[`examples/mac-mini-modules/cordis.yml`](../../../examples/mac-mini-modules/cordis.yml)是可直接运行的 MacBook 示例：

```yaml
- id: ui-remote-modules
  disabled: false
  config:
    instances:
      - id: genesispod
        label: GenesisPod
        url: http://127.0.0.1:13000/
        relayPort: 3000
        order: 100
      - id: thunder-omlx
        label: ThunderOMLX
        url: http://127.0.0.1:18002/admin/
        relayPort: 18102
        order: 200
```

插件启动后，打开**设置 → 插件 → 远程模块**即可新增、编辑、删除或重排实例。编辑器会把完整 `instances` 数组写入 Harness 用户设置文档，其中的值覆盖 profile 配置行。回环中继监听器在启动时创建，因此保存后需重启 Harness 才会生效。

| 配置 | 含义 |
|---|---|
| `instances` | 非空数组；每一项都是一个独立启动的网页实例。 |
| `instances[].id` | 唯一的 kebab-case 实例键。 |
| `instances[].label` | 侧栏按钮与对话框名称。 |
| `instances[].url` | 完整 HTTP(S) 目标网页；支持路径、查询和片段，拒绝内嵌凭据及主动 URL scheme。 |
| `instances[].relayPort` | 回环中继端口；`0` 使用临时端口。如果目标按 Origin 保存登录状态，应配置稳定的非零端口。 |
| `instances[].order` | 纵向整数顺序，默认 `100`。 |

## 运行边界

每个实例都会启动一个仅监听本机、目标固定的中继。所有路径始终落在唯一配置的 origin 上，因此它不是开放代理。中继保留目标 HTML、JavaScript、CSS、Cookie、重定向、方法、流式响应与 WebSocket upgrade；它只移除 `X-Frame-Options` 和 CSP 的 `frame-ancestors` 指令，因为这两项会阻止部署者授权的应用显示在 Harness 中，其余 CSP 指令保持不变。Host 只在 `/remote-webpages/v1/instances` 发布实例清单；React 随后直接在 iframe 中加载各中继地址。

对于 Mac mini 回环服务，SSH 仍由部署负责。示例要求 `13000 → Mac mini:3000` 访问 GenesisPod 前端，并要求 `18002 → Mac mini:8002` 访问 ThunderOMLX。GenesisPod 中继刻意使用 `localhost:3000`，其浏览器代码的固定 API Origin 还要求 `localhost:3001 → Mac mini:3001` 与 `localhost:4000 → Mac mini:4000`。所有 SSH 监听端口和中继端口都应只绑定 MacBook 回环地址。

稳定的中继端口会在 Harness 重启后保持浏览器 Origin 不变，从而让服务自己的 Cookie 和 local storage 继续有效。认证仍完全归目标应用所有；插件不收集也不保存目标凭据。

## Model Experience

无。网页只在浏览器中渲染，不会把内容、状态或凭据加入模型请求。

#### KV Cache effect

无；本包既不组装也不发送 provider 请求。

## 已知限制与后续工作

- **受信任配置**——目标 URL 是部署者控制的配置。如果移除某个不可信站点的反嵌入策略会违背其安全意图，就不要把实例指向该站点。
- **仅限本机显示**——中继地址绑定 `127.0.0.1`，浏览器必须与 Harness 运行在同一台 Mac 上。远程浏览器发布需要另行设计带认证的权限边界。
- **兼容性归目标应用所有**——硬编码绝对 API origin、Service Worker、OAuth 重定向白名单和第三方 Cookie 策略仍是被嵌入应用的属性，可能需要目标侧部署配置。
- **SSH 生命周期归部署所有**——本包不会创建、认证或重连 SSH 隧道。
- **配置重启后生效**——设置编辑器会立即保存，但目标网页和中继监听端口只在 Harness 重启后切换。
