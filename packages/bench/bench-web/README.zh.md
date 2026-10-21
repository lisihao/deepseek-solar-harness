# @deepseek-ai/dsh-bench-web

[English](README.md) | 中文

benchmark 能力的 Consumer：在 Host Web 服务器（`ctx.webServer`）上提供一个只读 HTTP API，列出 `ctx.benchRuntime` 的实验账本，并返回单个实验的记录及其分析。它不启动任何运行，也不读取运行器账本根目录以外的任何内容。

## 路由

| 路由 | 响应体 |
|---|---|
| `GET /api/bench/experiments` | `{ experiments }`：每个账本一项，含 `id`、`suite`、`variants`、`repetitions`、`runs` 和 `lastEndedAt`（第一次运行前为 `null`） |
| `GET /api/bench/experiments/<id>` | `{ experiment, records, analysis }`，其中 `analysis` 是用本插件配置调用 `analyzeExperiment` 的结果 |

请求的授权方式与其他 Host 面板相同：要么是 `Host` 和 `Origin` 都为回环地址的回环请求，要么是已配对设备通过 `ctx.remoteAuth` 校验的 bearer token。未授权的请求返回 `401 UNAUTHORIZED`；没有挂载 `remoteAuth` 服务时返回 `503 REMOTE_AUTH_UNAVAILABLE`。其他路径返回 `404 NOT_FOUND`，其他方法返回 `405 METHOD_NOT_ALLOWED`，账本读取失败返回 `500 READ_FAILED`。所有响应都带 `Cache-Control: no-store`。

## 配置

配置项就是对每个返回的实验所使用的分析设置（[`dsh-bench-runner`](../bench-runner/README.md#analysis)）。

| 键 | 默认值 |
|---|---|
| `confidence` | `0.95`（`0.9`、`0.95`、`0.99` 之一） |
| `resamples` | `2000` |
| `seed` | `1` |
| `margin` | `0.05` |
| `minTasks` | `10` |
| `invalidTolerance` | `0.1` |

```yaml
- id: bench-web
  name: '@deepseek-ai/dsh-bench-web'
```

注入 `benchRuntime` 和 `webServer`。

## 模型体验

无，因为这些路由只向受信任的 Host 客户端提供账本数据和分析结果，不注册任何 prompt、工具、schema 或会话事件。

#### KV Cache 影响

无；本包从不组装或发送 provider 请求。

## 已知局限与延后工作

- **还没有客户端面板** — 这些路由还没有对应的 Desktop 视图；面板随本包的客户端部分一起提供。
- **不能控制运行** — 还不能通过 HTTP 启动或取消实验。启动路由只能接受配置目录中的实验 id，并且必须先确认成本预估，因为如果请求可以指定 patch 或命令，已配对设备就能借此执行代码。
- **详情响应体没有上限** — `GET /api/bench/experiments/<id>` 会返回全部记录，大小随实验规模增长。
