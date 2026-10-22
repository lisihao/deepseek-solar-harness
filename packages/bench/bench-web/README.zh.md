# @deepseek-ai/dsh-bench-web

[English](README.md) | 中文

benchmark 能力的 Consumer：在 Host Web 服务器（`ctx.webServer`）上提供一个只读 HTTP API，列出 `ctx.benchRuntime` 的实验账本，并返回单个实验的记录及其分析；另有一个展示这些数据的 Desktop 设置页。它不启动任何运行，也不读取运行器账本根目录以外的任何内容。

## 路由

| 路由 | 响应体 |
|---|---|
| `GET /api/bench/experiments` | `{ experiments, unreadable }`：每个可读账本一项，含 `id`、`suite`、`variants`、`repetitions`、`runs` 和 `lastEndedAt`（第一次运行前为 `null`）；文件读取失败的账本各一项，含 `id` 和 `message` |
| `GET /api/bench/experiments/<id>` | `{ experiment, records, analysis }`，其中 `analysis` 是用本插件配置调用 `analyzeExperiment` 的结果 |

请求的授权方式与其他 Host 面板相同：要么是 `Host` 和 `Origin` 都为回环地址的回环请求，要么是已配对设备通过 `ctx.remoteAuth` 校验的 bearer token。未授权的请求返回 `401 UNAUTHORIZED`；没有挂载 `remoteAuth` 服务时返回 `503 REMOTE_AUTH_UNAVAILABLE`。其他路径返回 `404 NOT_FOUND`，其他方法返回 `405 METHOD_NOT_ALLOWED`，账本读取失败返回 `500 READ_FAILED`。所有响应都带 `Cache-Control: no-store`。

## 设置页

客户端部分注册一个 `settings.section` 页面（id `benchmarks`，标签 **基准测试**，排在任务模板之后），通过 `ctx.connection.request` 读取上述路由。页面默认打开最近有运行的实验；用胶囊按钮切换实验，**刷新** 会重新加载列表和当前实验。对当前实验，页面展示：

- **与基线对比** — 每个 variant 的结论、成功率的配对差值及其区间，以及每个任务的成本差和耗时差；结论为 `unreliable` 时改为列出双方的无法测量运行比例。
- **各 variant** — 运行数、成功率、至少一次通过与每次都通过的比例、无法测量比例，以及每次运行的平均成本和耗时。
- **时间花在哪里** — 每个 variant 已测量时间中模型、工具和 harness 各占的比例。
- **成功率与成本** — 成功率对每次运行平均成本；Pareto 前沿上的 variant 高亮显示。
- **各任务通过率** — 任务 × variant 的通过率，variant 没有运行过的任务会标出。
- **重复运行之间结果不一致** — 每个 variant 的不稳定任务（如有）。

读取失败的账本及其错误列在选择器上方。文案来自 `settings.benchmarks` 字典，提供英文和中文。

## 配置

`analysis` 是对每个返回的实验使用的分析设置（[`dsh-bench-runner`](../bench-runner/README.md#analysis)）；省略的键取默认值：`confidence` 0.95、`resamples` 2000、`seed` 1、`margin` 0.05、`minTasks` 10、`invalidTolerance` 0.1。

```yaml
- id: bench-web
  name: '@deepseek-ai/dsh-bench-web'
```

Host 部分注入 `benchRuntime` 和 `webServer`；客户端部分注入 `slots`、`locale` 和 `connection`。

## 模型体验

无，因为这些路由只向受信任的 Host 客户端提供账本数据和分析结果，不注册任何 prompt、工具、schema 或会话事件。

#### KV Cache 影响

无；本包从不组装或发送 provider 请求。

## 已知局限与延后工作

- **不能控制运行** — 还不能通过 HTTP 启动或取消实验。启动路由只能接受配置目录中的实验 id，并且必须先确认成本预估，因为如果请求可以指定 patch 或命令，已配对设备就能借此执行代码。
- **详情响应体没有上限** — `GET /api/bench/experiments/<id>` 会返回全部记录，大小随实验规模增长。
